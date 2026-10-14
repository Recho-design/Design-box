// File-viewer iframe load tracker.
//
// FileViewer is the surface where the user spends the most time looking
// at generated artifacts. iframe load failures don't propagate to the
// outer `window.error` listener — they're trapped inside the frame — so
// the global resource-error observer can't see them.
//
// This helper exposes a single function the FileViewer calls when it
// mounts an iframe; it instruments the element for failure + timeout +
// success and emits scoped events. The same function returns a cleanup
// callback so the caller can remove instrumentation if the iframe is
// reused for a different artifact.

import {
  parsePreviewObservabilityMessage,
  type PreviewObservabilityMessage,
} from '@open-design/contracts/runtime/preview-observability';

function scrubFilePath(path: string): string {
  return path;
}

const LOAD_TIMEOUT_MS = 15000;

const PREVIEW_RESOURCE_TAGS = new Set([
  'script',
  'link',
  'img',
  'iframe',
  'audio',
  'video',
  'source',
  'track',
]);

interface TrackIframeOptions {
  iframe: HTMLIFrameElement;
  artifactId?: string;
  projectId?: string;
  conversationId?: string;
  // Surface label so dashboards can split file-viewer iframes from
  // deck-viewer iframes, comment-mode iframes, etc.
  surface: string;
}

export interface PreviewIframeReportOptions {
  surface: string;
  renderMode: 'url_load' | 'srcdoc';
  artifactId?: string;
  artifactKind?: string;
  projectId?: string;
}

export type PreviewTransportRecoverySignal =
  | 'body_incomplete'
  | 'host_navigation_abort'
  | 'probe_timeout'
  | 'reactivation_unverified';

export interface PreviewTransportDocumentState {
  readyState?: string;
  bodyPresent?: boolean;
  bodyChildCount?: number;
  documentElementChildCount?: number;
}

export interface PreviewTransportRecoveryOptions extends PreviewIframeReportOptions {
  signal: PreviewTransportRecoverySignal;
  activationAcknowledged: boolean;
  documentState?: PreviewTransportDocumentState;
  viewportWidth?: number;
  viewportHeight?: number;
  timeoutMs?: number;
}

interface BufferedPreviewMessage {
  source: MessageEventSource | null;
  data: PreviewObservabilityMessage;
  receivedAt: number;
}

type PreviewMessageSubscriber = (message: BufferedPreviewMessage) => void;

const PREVIEW_MESSAGE_BUFFER_LIMIT = 30;
const PREVIEW_MESSAGE_MAX_AGE_MS = 10_000;
const PREVIEW_REPORT_LIMIT = 20;
const previewMessageBuffer: BufferedPreviewMessage[] = [];
const previewMessageSubscribers = new Set<PreviewMessageSubscriber>();
let previewMessageObserverInstalled = false;
let previewMessageListener: ((event: MessageEvent) => void) | null = null;

// Installed at app boot, before FileViewer's iframes mount. This short buffer
// closes the race where an author script throws synchronously while React is
// still committing the iframe and before the component can subscribe.
export function installPreviewIframeMessageObserver(): () => void {
  if (previewMessageObserverInstalled) return () => undefined;
  if (typeof window === 'undefined') return () => undefined;
  previewMessageObserverInstalled = true;
  previewMessageListener = (event: MessageEvent) => {
    const data = parsePreviewObservabilityMessage(event.data);
    if (!data) return;
    const message = { source: event.source, data, receivedAt: Date.now() };
    if (previewMessageSubscribers.size === 0) {
      previewMessageBuffer.push(message);
      prunePreviewMessageBuffer();
      return;
    }
    for (const subscriber of previewMessageSubscribers) subscriber(message);
  };
  window.addEventListener('message', previewMessageListener);

  return () => {
    if (previewMessageListener) window.removeEventListener('message', previewMessageListener);
    previewMessageListener = null;
    previewMessageObserverInstalled = false;
    previewMessageBuffer.length = 0;
    previewMessageSubscribers.clear();
  };
}

export function subscribePreviewIframeMessages(
  subscriber: PreviewMessageSubscriber,
): () => void {
  previewMessageSubscribers.add(subscriber);
  prunePreviewMessageBuffer();
  const bufferedMessages = previewMessageBuffer.splice(0);
  for (const message of bufferedMessages) subscriber(message);
  return () => previewMessageSubscribers.delete(subscriber);
}

function prunePreviewMessageBuffer(): void {
  const cutoff = Date.now() - PREVIEW_MESSAGE_MAX_AGE_MS;
  while (
    previewMessageBuffer.length > PREVIEW_MESSAGE_BUFFER_LIMIT ||
    (previewMessageBuffer[0]?.receivedAt ?? Infinity) < cutoff
  ) {
    previewMessageBuffer.shift();
  }
}

/**
 * Mirror one deck-stage measurement into the console at warn level.
 *
 * The analytics event answers "how often"; this answers "what happened on this
 * machine". On desktop only warn/error console entries are persisted to
 * `renderer.log` (apps/desktop/src/main/runtime.ts), and that file is one of
 * the sources `od diagnostics export` bundles — so a user who hits the empty
 * deck can hand over an export that already contains the measurement, without
 * having to reproduce it while someone watches.
 *
 * The line is written as one flat, greppable record on purpose: the log is read
 * as text, so a shape that survives `grep deck_stage_unscaled` is worth more
 * than a pretty object that a log tail may truncate.
 */
function logDeckStageMeasurement(measurement: Record<string, unknown>): void {
  if (typeof console === 'undefined' || typeof console.warn !== 'function') return;
  const fields = [
    `stage_kind=${measurement.stage_kind ?? 'n/a'}`,
    `stage_scale=${measurement.stage_scale ?? 'n/a'}`,
    `stage_transform=${measurement.stage_transform ?? 'n/a'}`,
    `stage=${measurement.stage_width ?? 'n/a'}x${measurement.stage_height ?? 'n/a'}`,
    `canvas=${measurement.canvas_width ?? 'n/a'}x${measurement.canvas_height ?? 'n/a'}`,
    `frame=${measurement.viewport_width ?? 'n/a'}x${measurement.viewport_height ?? 'n/a'}`,
    `ready_state=${measurement.ready_state ?? 'n/a'}`,
    `visibility_state=${measurement.visibility_state ?? 'n/a'}`,
    `elapsed_ms=${measurement.elapsed_ms ?? 'n/a'}`,
    `render_mode=${measurement.render_mode ?? 'n/a'}`,
    `surface=${measurement.surface ?? 'n/a'}`,
  ].join(' ');
  console.warn(`[od:preview-observability] deck_stage_unscaled ${fields}`);
}

export function reportPreviewIframeMessage(
  value: unknown,
  options: PreviewIframeReportOptions,
  seen: Set<string> = new Set(),
): boolean {
  const message = parsePreviewObservabilityMessage(value);
  if (!message) return false;

  const sanitizedMessage = sanitizePreviewText(message.message, 500);
  const sanitizedSourceUrl = sanitizePreviewUrl(message.source_url);
  const sanitizedStack = sanitizePreviewText(message.stack, 2_000);
  const sanitizedResourceUrl = sanitizePreviewUrl(message.resource_url);
  const fingerprint = [
    message.event,
    message.name ?? '',
    sanitizedMessage ?? '',
    sanitizedSourceUrl ?? '',
    sanitizedStack ?? '',
    sanitizedResourceUrl ?? '',
  ].join('|');
  if (seen.has(fingerprint) || seen.size >= PREVIEW_REPORT_LIMIT) return false;
  seen.add(fingerprint);

  const common: Record<string, unknown> = {
    surface: options.surface,
    render_mode: options.renderMode,
    artifact_id: options.artifactId,
    artifact_kind: options.artifactKind,
    project_id: options.projectId,
  };

  if (message.event === 'white_screen') {
    return true;
  }

  if (message.event === 'deck_stage_unscaled') {
    const measurement = {
      ...common,
      monitoring_kind: 'stage_scale_collapsed',
      reason: 'stage_scale_collapsed',
      stage_kind: boundedText(message.stage_kind, 32),
      stage_scale: decimalFromPermille(message.stage_scale_permille),
      stage_transform: boundedText(message.stage_transform, 32),
      stage_width: boundedNumber(message.stage_width),
      stage_height: boundedNumber(message.stage_height),
      canvas_width: boundedNumber(message.canvas_width),
      canvas_height: boundedNumber(message.canvas_height),
      viewport_width: boundedNumber(message.viewport_width),
      viewport_height: boundedNumber(message.viewport_height),
      ready_state: boundedText(message.ready_state, 32),
      visibility_state: boundedText(message.visibility_state, 32),
      elapsed_ms: boundedNumber(message.elapsed_ms),
    };
    logDeckStageMeasurement(measurement);
    return true;
  }

  if (message.event === 'resource_error') {
    return true;
  }

  return true;
}

/**
 * Report a host-observed blank preview that the iframe-local paint detector
 * cannot reliably see. In particular, Chromium may execute the injected head
 * bridge and then abort the rest of an about:srcdoc navigation. Recovery
 * replaces that half-document before its five-second white-screen timer can
 * fire, so the host records the transport witness that caused the remount.
 *
 * This deliberately reuses client_preview_white_screen: it is operational
 * safety telemetry, not a new product analytics event. Only bounded state is
 * attached; no authored DOM text or source content leaves the client.
 */
export function reportPreviewTransportRecovery(
  _options: PreviewTransportRecoveryOptions,
): void {
  // Pure local stub: safety event reporting removed.
}

function previewResourceMonitoringKind(value: unknown): string {
  const tag = boundedText(value, 32)?.toLowerCase();
  return `resource_tag:${tag && PREVIEW_RESOURCE_TAGS.has(tag) ? tag : 'other'}`;
}

function boundedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const next = value.trim();
  return next ? next.slice(0, limit) : undefined;
}

/**
 * Turn the wire's integer per-mille scale back into the decimal a human reads.
 * Absent stays absent: a missing measurement must not be reported as 0, which
 * is the value that means "collapsed".
 */
function decimalFromPermille(value: unknown): number | undefined {
  const permille = boundedNumber(value);
  if (permille === undefined) return undefined;
  return permille / 1000;
}

function boundedNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(Math.round(value), 10_000_000));
}

function sanitizePreviewText(value: unknown, limit: number): string | undefined {
  const bounded = boundedText(value, limit);
  if (!bounded) return undefined;
  const pathScrubbed = scrubFilePath(bounded);
  if (typeof pathScrubbed !== 'string') return undefined;
  return pathScrubbed
    .replace(/\b(?:data|blob):[^\s)]+/gi, '[inline-url]')
    .replace(/https?:\/\/[^\s)]+/gi, (raw) => sanitizePreviewUrl(raw) ?? '[url]')
    .slice(0, limit);
}

function sanitizePreviewUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const raw = value.trim();
  if (/^(?:data|blob):/i.test(raw)) return '[inline-url]';
  try {
    const parsed = new URL(raw, typeof window !== 'undefined' ? window.location.href : 'http://localhost');
    return `${parsed.origin}${parsed.pathname}`.slice(0, 500);
  } catch {
    const scrubbed = scrubFilePath(raw);
    return typeof scrubbed === 'string' ? scrubbed.slice(0, 500) : undefined;
  }
}

export function trackIframeLoad(options: TrackIframeOptions): () => void {
  const { iframe, surface } = options;
  const startedAt = performance.now();
  let settled = false;

  const settle = (_event: string, _extras: Record<string, unknown> = {}): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // reportSafetyEvent removed
  };

  const onLoad = (): void => {
    // We don't emit a success event by default — would multiply our
    // ingest cost for the most common case. Just settle the timeout.
    if (settled) return;
    settled = true;
    clearTimeout(timer);
  };

  const onError = (): void => {
    settle('client_iframe_error', { reason: 'error_event' });
  };

  iframe.addEventListener('load', onLoad);
  iframe.addEventListener('error', onError);

  const timer = setTimeout(() => {
    settle('client_iframe_timeout', { timeout_ms: LOAD_TIMEOUT_MS });
  }, LOAD_TIMEOUT_MS);

  return () => {
    clearTimeout(timer);
    iframe.removeEventListener('load', onLoad);
    iframe.removeEventListener('error', onError);
  };
}
