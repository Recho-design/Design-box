// Chat protocol + recovery health.
//
// Two questions that no timing metric can answer:
//
//   client_chat_protocol_anomaly  "The agent produced output. Did the UI it
//                                  was supposed to become actually appear?"
//   client_chat_recovery          "When the connection broke, did we heal?"
//
// Both describe SILENT failures. A question form that fails to parse does
// not throw — it renders as nothing, the user sees a turn that asked them
// nothing, and no exception is captured. A run that finishes without a
// next-step marker looks like a normal turn with a slightly emptier
// footer. These are the defects that reach us as "sometimes it just
// doesn't show the buttons" and cannot be reproduced.
//
// Deduplication matters more here than anywhere else in the chat
// observability surface. Anomalies are detected during RENDER, and a
// React tree re-renders freely: an un-deduped `parse failed` in a message
// that stays on screen would emit on every keystroke in the composer. The
// unit of truth is "this run produced this anomaly once", so that is the
// dedupe key.

export type ChatProtocolAnomaly = string;
export type ChatRecoveryPath = 'run_resume' | 'stream_reconnect' | 'conversation_reload';
export type ChatRecoveryOutcome = 'success' | 'failure' | 'abandoned';

import { pushChatBreadcrumb } from './chat-context';

export function reportChatProtocolAnomaly(_input: {
  anomaly: ChatProtocolAnomaly;
  sourceLength?: number;
  messageCount?: number;
  scope?: string;
}): void {
  // Pure local stub: safety event reporting removed.
}

export function reportChatRecovery(input: {
  path: ChatRecoveryPath;
  outcome: ChatRecoveryOutcome;
  attempt: number;
  durationMs: number;
  errorCode?: string;
  messageCount?: number;
}): void {
  pushChatBreadcrumb(input.path === 'run_resume' ? 'resume' : 'reconnect');
  // Pure local stub: safety event reporting removed.
}

/** Test-only — flush the dedupe set between cases. */
export function __resetChatProtocolForTest(): void {
}
