/**
 * One-shot backfill of pre-fix bundled `capabilities_granted` rows.
 *
 * Before `resolveCapabilitiesGranted` (trust.ts) learned to widen `bundled`
 * grants with the manifest's required set, the bundled boot walker registered
 * every bundled plugin on the restricted floor — `['prompt:inject']` — even
 * when the manifest required `pipeline:*`, `fs:read`, `subprocess`, … Nothing
 * enforced that floor at run time, so the only effect was a persisted record
 * that disagreed with what the plugin actually does; it is still copied into
 * every applied snapshot, exported into portable manifests (`export.ts`) and
 * reported by the trust API.
 *
 * The walker now resolves grants correctly, but it deliberately PRESERVES the
 * persisted set for an already-installed row and only widens it with
 * capabilities the manifest newly requires (`bundled.ts`, `newlyRequiredCapabilities`).
 * That is what keeps user revocations alive across reboots — revocation is
 * stored by REMOVING entries, and there is no tombstone column — but it also
 * means a row written by a pre-fix daemon never heals on its own: for an
 * unchanged manifest the diff is empty, so the gap is carried forward forever.
 *
 * This pass is the one-time repair, by product decision: for bundled rows, the
 * manifest requirement set is authoritative, and a revocation recorded against
 * a pre-fix row is accepted as lost. Guessing row-by-row whether a missing
 * entry was "never granted" or "revoked" was the alternative and it cannot be
 * made safe — both answers corrupt data (resurrect a revocation, or overwrite
 * a real one). Resetting to the manifest set is at least deterministic and
 * matches what the plugin actually runs with. Rows registered AFTER this pass
 * lands never reach this path: the walker writes the resolved set for a fresh
 * row and preserves it afterwards, so a revocation from here on survives.
 *
 * Scope, deliberately narrow:
 *
 *   - `source_kind = 'bundled'` only, the walker's own predicate. Trusted /
 *     marketplace / user rows keep their persisted grants untouched, so their
 *     revocations stay effective.
 *   - Only `capabilities_granted` is written. `manifest_json`, `trust` and
 *     `updated_at` are left alone — a backfill is not a content change, and
 *     `updated_at` drives the Community gallery's "Newest" sort, which the
 *     walker already works to keep stable across reboots.
 *   - A row whose `manifest_json` is missing or fails schema validation is
 *     SKIPPED, never narrowed to the bare floor: an unreadable manifest must
 *     not be read as "requires nothing". The walker re-registers such a row
 *     from disk on this same boot when its folder still ships a parseable
 *     manifest, which takes the fresh-registration path.
 *
 * Run-once semantics use the daemon's existing maintenance-pass marker
 * (`daemon_maintenance_passes`, see `hasCompletedDaemonMaintenancePass`), not
 * a new mechanism. The heal and the marker commit in ONE transaction, so a
 * boot that dies mid-pass leaves the table exactly as it was and the next boot
 * retries; a boot that completes leaves the marker behind and every later boot
 * is a no-op. That marker is also what makes the pass idempotent in the only
 * way that matters here: once it has run, a capability the user revokes
 * afterwards is never re-granted by a later restart.
 */

import type Database from 'better-sqlite3';
import { PluginManifestSchema, type PluginManifest } from '@open-design/contracts';

import {
  hasCompletedDaemonMaintenancePass,
  recordCompletedDaemonMaintenancePass,
} from '../db.js';
import { resolveCapabilitiesGranted } from './trust.js';

type SqliteDb = Database.Database;

/** Completion-marker name; bump the suffix if the resolution rule ever changes. */
export const BUNDLED_CAPABILITY_GRANT_BACKFILL_PASS = 'bundled-plugin-capability-grant-backfill-v1';

export interface BundledCapabilityGrantBackfillReport {
  /** A previous pass already completed; the table was not scanned. */
  alreadyCompleted: boolean;
  /** Every examined row is now either healed, already correct, or a deliberate skip. */
  completed: boolean;
  /** Bundled rows read. */
  examined: number;
  /** Rows whose persisted set disagreed with the manifest and were rewritten. */
  healed: number;
  /** Rows whose persisted set already matched the manifest requirement. */
  unchanged: number;
  /** Rows with no stored manifest; left for the boot walker to re-register. */
  skippedNoManifest: number;
  /** Rows whose stored manifest failed validation; left exactly as they were. */
  skippedInvalidManifest: number;
  /** Rows that threw while being healed. Left untouched; the pass is retried. */
  errors: number;
  /** Ids rewritten by this pass, for the boot log. */
  healedIds: string[];
}

export interface BundledCapabilityGrantBackfillOptions {
  db: SqliteDb;
  /** Rescan even when a completed pass is on record (diagnostics, probes). */
  ignoreCompletionMarker?: boolean;
  logger?: (message: string) => void;
}

interface BundledGrantRow {
  id: string;
  capabilitiesGranted: string | null;
  manifestJson: string | null;
}

function emptyReport(): BundledCapabilityGrantBackfillReport {
  return {
    alreadyCompleted: false,
    completed: false,
    examined: 0,
    healed: 0,
    unchanged: 0,
    skippedNoManifest: 0,
    skippedInvalidManifest: 0,
    errors: 0,
    healedIds: [],
  };
}

function parseGranted(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

/** The row's stored manifest, or a reason it cannot be trusted as a requirement source. */
function parseStoredManifest(
  raw: string | null,
): { ok: true; manifest: PluginManifest } | { ok: false; reason: 'missing' | 'invalid' } {
  if (!raw || raw.trim() === '') return { ok: false, reason: 'missing' };
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  // A row with no usable manifest at all is "missing"; anything that looks like
  // a manifest but does not validate is "invalid". Both are skipped, but the
  // distinction is what tells an operator reading the boot log whether the boot
  // walker is about to re-register the row from disk (missing) or whether the
  // stored manifest itself is broken (invalid).
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, reason: 'missing' };
  }
  const parsed = PluginManifestSchema.safeParse(candidate);
  return parsed.success ? { ok: true, manifest: parsed.data } : { ok: false, reason: 'invalid' };
}

function sameSet(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  for (const entry of b) if (!left.has(entry)) return false;
  return true;
}

/**
 * Heal every bundled row whose persisted grants disagree with its manifest.
 *
 * One transaction for the whole pass, so "healed" and "marked complete" are
 * never observed apart. Synchronous on purpose: the pass is bounded by the
 * bundled catalog (a few hundred rows of a few hundred bytes) and runs during
 * startup before the HTTP listener exists, so there is nothing to interleave
 * with and paging would only widen the crash window.
 */
export function runBundledCapabilityGrantBackfill(
  options: BundledCapabilityGrantBackfillOptions,
): BundledCapabilityGrantBackfillReport {
  const { db } = options;
  const report = emptyReport();
  const log = options.logger ?? ((message: string) => console.warn(message));

  if (!db.open) return report;
  if (
    !options.ignoreCompletionMarker
    && hasCompletedDaemonMaintenancePass(db, BUNDLED_CAPABILITY_GRANT_BACKFILL_PASS)
  ) {
    return { ...report, alreadyCompleted: true, completed: true };
  }

  const rows = db
    .prepare(
      `SELECT id, capabilities_granted AS capabilitiesGranted, manifest_json AS manifestJson
         FROM installed_plugins
        WHERE source_kind = 'bundled'
        ORDER BY id ASC`,
    )
    .all() as BundledGrantRow[];

  if (rows.length === 0) {
    // Nothing installed yet: this install has no pre-fix rows to repair. The
    // marker is still recorded — the walker registers the catalog immediately
    // after this pass on the same boot, and those rows are fresh registrations
    // that already carry the resolved set.
    recordCompletedDaemonMaintenancePass(db, BUNDLED_CAPABILITY_GRANT_BACKFILL_PASS);
    return { ...report, completed: true };
  }

  const update = db.prepare(
    `UPDATE installed_plugins
        SET capabilities_granted = ?
      WHERE id = ? AND source_kind = 'bundled'`,
  );

  const heal = db.transaction((): BundledCapabilityGrantBackfillReport => {
    for (const row of rows) {
      report.examined += 1;
      try {
        const stored = parseStoredManifest(row.manifestJson);
        if (!stored.ok) {
          if (stored.reason === 'missing') report.skippedNoManifest += 1;
          else report.skippedInvalidManifest += 1;
          continue;
        }
        // `bundled` is the tier the walker registers these rows under, and the
        // one whose resolution includes the manifest's requirement set.
        const desired = resolveCapabilitiesGranted({ manifest: stored.manifest, trust: 'bundled' });
        const current = parseGranted(row.capabilitiesGranted);
        if (sameSet(current, desired)) {
          report.unchanged += 1;
          continue;
        }
        update.run(JSON.stringify(desired), row.id);
        report.healed += 1;
        report.healedIds.push(row.id);
      } catch (error) {
        report.errors += 1;
        log(`[plugins] capability-grant backfill failed for ${row.id}: ${String(error)}`);
      }
    }
    // The marker is written only when every row was examined without error.
    // A row that threw is retried on the next boot rather than blocking the
    // repairs that succeeded: the desired set is a pure function of the stored
    // manifest, so a partial pass simply converges on the retry (rows healed
    // this time read back as `unchanged`). What the marker must never do is
    // record completion over a row that was never examined — that row would
    // then keep its pre-fix floor forever.
    if (report.errors === 0) {
      recordCompletedDaemonMaintenancePass(db, BUNDLED_CAPABILITY_GRANT_BACKFILL_PASS);
    }
    report.completed = report.errors === 0;
    return report;
  }).immediate();

  if (report.healed > 0 || report.errors > 0) {
    log(
      `[plugins] capability-grant backfill${report.completed ? '' : ' (incomplete)'}: `
      + `healed=${report.healed}/${report.examined} unchanged=${report.unchanged} `
      + `skippedNoManifest=${report.skippedNoManifest} `
      + `skippedInvalidManifest=${report.skippedInvalidManifest} errors=${report.errors}`,
    );
  }

  return heal;
}
