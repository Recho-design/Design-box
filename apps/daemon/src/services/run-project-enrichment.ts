// Local, user-visible side effect of a completed AI-optimize run.
//
// A deep-enrichment (AI optimize) run rewrites a project's design-system
// metadata; when that run succeeds the project has to record that the
// refinement landed. This used to hang off the run-analytics lifecycle, which
// is why it silently vanished whenever analytics was unconfigured. It is a
// product fact, not a telemetry fact, so it lives on its own here and is
// installed for every physical Run through the internal run-creation service.
//
// Nothing here may throw into the caller: a failed bookkeeping flag must never
// change the Run outcome.

import { getProject, updateProject } from '../db.js';
import { runResultFromStatus } from '../run-result.js';
import {
  toProjectRecord,
  type ChatRun,
  type ProjectRecord,
  type TerminalRunStatus,
} from '../runtimes/chat-run-records.js';

/** A project that owns a design system, or was imported as one, is enrichable. */
function isProjectEnrichableDesignSystem(project: ProjectRecord): boolean {
  if (typeof project.designSystemId === 'string' && project.designSystemId.length > 0) {
    return true;
  }
  const metadata = project.metadata;
  return metadata?.importedFrom === 'brand-extraction' || metadata?.importedFrom === 'design-system';
}

export interface RunProjectEnrichmentDeps {
  db: Parameters<typeof getProject>[0];
  runs: {
    wait(run: ChatRun): Promise<TerminalRunStatus>;
  };
}

/**
 * The request body a physical Run was composed from. It is the only thing a
 * local run observer needs, and it is supplied explicitly so a new daemon
 * caller cannot silently drop the Run's own facts.
 */
export interface PhysicalRunStartFacts {
  body: Record<string, unknown>;
}

function analyticsHintsOf(body: Record<string, unknown>): Record<string, unknown> {
  const hints = body.analyticsHints;
  return hints && typeof hints === 'object' && !Array.isArray(hints)
    ? (hints as Record<string, unknown>)
    : {};
}

/**
 * Mark the project `ai_refined` once an enrichment Run settles successfully.
 *
 * Registered for every physical Run (see internal-run-service); it is a no-op
 * for every Run that did not ask for deep enrichment.
 */
export function installRunProjectEnrichment(input: {
  deps: RunProjectEnrichmentDeps;
  run: ChatRun;
  facts: PhysicalRunStartFacts;
}): void {
  const { deps, run, facts } = input;
  const hints = analyticsHintsOf(facts.body);
  if (hints.dsEnrichment !== true) return;
  const projectId = typeof facts.body.projectId === 'string' ? facts.body.projectId : null;
  if (!projectId) return;

  // Best-effort flag: a failed metadata refresh must not fail run completion,
  // and the trailing `.catch` already absorbs anything this callback throws.
  deps.runs
    .wait(run)
    .then((status: TerminalRunStatus) => {
      if (runResultFromStatus(status.status) !== 'success') return;
      const project = toProjectRecord(getProject(deps.db, projectId));
      if (!project || !isProjectEnrichableDesignSystem(project)) return;
      updateProject(deps.db, projectId, {
        metadata: {
          ...(project.metadata ?? {}),
          enrichmentStatus: 'ai_refined',
          enrichmentCompletedAt: Date.now(),
        },
      });
    })
    .catch(() => {});
}
