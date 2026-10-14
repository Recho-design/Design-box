// Local run/failure vocabulary.
//
// These unions used to live in `@open-design/contracts/analytics`, which was
// the wire schema for the removed product-analytics pipeline. The values
// themselves are not telemetry: the failure card, the retry policy, the
// diagnostic bundle and the admission gate all read them, so the daemon owns
// its own copy instead of depending on a contract module that no longer exists.
//
// Keep this file free of I/O and of any delivery concern.

import { HYPERFRAMES_VIDEO_MODEL } from '@open-design/contracts';

export type RunResult = 'success' | 'failed' | 'cancelled';

export type RunCancelOrigin =
  | 'user_stop'
  | 'project_cleanup'
  | 'daemon_shutdown'
  | 'unknown';

export type RunTerminalTrigger =
  | RunCancelOrigin
  | 'first_output_deadline'
  | 'inactivity_watchdog'
  // The ACP bridge's own per-stage watchdog gave up waiting for the agent's
  // next JSON-RPC line. Distinct from `inactivity_watchdog` (the outer
  // chat-run clock) because the two have different budgets and different
  // blind spots, and because the ACP path ends the child itself — the run
  // then carries the CHILD's exit code (typically AGENT_EXIT_130), which
  // reads like a user interrupt unless this trigger says otherwise.
  | 'acp_stage_timeout'
  | 'daemon_restart';

export type RunFailureCategory =
  | 'auth'
  | 'rate_limit'
  | 'insufficient_balance'
  | 'entitlement_required'
  | 'model_unavailable'
  | 'prompt_too_large'
  | 'upstream_unavailable'
  | 'timeout'
  | 'empty_output'
  | 'tool_error'
  | 'process_exit'
  | 'user_cancel'
  | 'unknown';

export type RunFailureDetail =
  | 'auth_required'
  | 'stale_profile'
  | 'refresh_token_reused'
  | 'missing_api_key'
  | 'invalid_api_key'
  | 'hard_quota'
  // A rolling per-model usage window (vela's 5-hour `model_limit_exceeded`)
  // that resets on its own at a known instant. Distinct from `hard_quota`:
  // nothing was charged, nothing needs topping up, and the same request
  // succeeds once the window rolls over — so it stays retryable and must not
  // be counted as a quota exhaustion in reliability reporting.
  | 'model_window_limit'
  // Vela membership policy concurrency is temporarily full. The upstream
  // reset instant makes this waitable, but it is deliberately non-retryable
  // for automation so the daemon cannot create an immediate retry storm.
  | 'membership_concurrency_limit'
  | 'workspace_credits_exhausted'
  | 'rate_limit_429'
  | 'amr_insufficient_balance'
  | 'amr_tier_upgrade_required'
  | 'model_not_found'
  | 'model_not_supported'
  | 'model_disabled'
  | 'local_model_not_loaded'
  | 'cli_version_incompatible'
  | 'prompt_too_large'
  | 'request_too_large'
  | 'attachment_media_type_unsupported'
  | 'tool_schema_invalid'
  | 'prompt_tokenization_failed'
  | 'provider_resource_not_found'
  | 'upstream_5xx'
  | 'upstream_client_error'
  | 'region_not_supported'
  | 'stream_disconnected'
  | 'network_error'
  | 'provider_high_demand'
  | 'provider_routing_error'
  | 'inactivity_timeout'
  | 'timeout'
  | 'empty_output'
  | 'tool_error'
  | 'plugin_artifact_missing'
  | 'cli_not_installed'
  | 'bundled_binary_missing'
  | 'host_policy_block'
  | 'local_storage_failure'
  | 'certificate_failure'
  | 'proxy_configuration'
  | 'network_configuration'
  | 'git_bash_missing'
  | 'agent_config_invalid'
  | 'spawn_failed'
  | 'spawn_enoexec'
  | 'spawn_ebadf'
  | 'spawn_eperm'
  | 'stdin_write_eof'
  | 'agent_protocol_error'
  | 'acp_frame_too_large'
  | 'session_resume_expired'
  | 'fabricated_role_marker'
  | 'permission_request_not_found'
  | 'signal_killed'
  | 'process_crashed'
  | 'cpu_unsupported'
  // Risk control suspended the account (vela returns JSON-RPC -32600 with
  // `data.kind: "account_suspended"`, `retryable: false`). Named because
  // retrying is guaranteed to fail the same way: without this it lands in
  // `fatal_rpc_error` and the card offers a Retry the user can only burn on.
  | 'account_suspended'
  | 'interrupted'
  | 'exit_code'
  | 'terminated_unknown'
  | 'stream_error'
  | 'exit_nonzero'
  | 'fatal_rpc_error'
  | 'continuation_incomplete'
  | 'execution_failed'
  | 'user_cancelled'
  | 'unknown';

export type RunFailureStage =
  | 'preflight'
  | 'spawn'
  | 'session_init'
  | 'model_select'
  | 'prompt_send'
  | 'first_token_wait'
  | 'tool_execution'
  | 'tool_outstanding'
  | 'post_tool_resume'
  | 'artifact_write'
  | 'child_close'
  | 'finalize';

export type RunFailureMechanism =
  | 'policy_rejection'
  | 'provider_rejection'
  | 'model_route_unavailable'
  | 'invalid_model_selection'
  | 'protocol_violation'
  | 'frame_too_large'
  | 'startup_readiness_timeout'
  | 'first_output_deadline'
  | 'acp_response_deadline'
  | 'post_tool_resume_timeout'
  | 'tool_execution_failure'
  | 'child_exit'
  | 'stream_idle_timeout'
  | 'empty_completion'
  | 'transport_failure'
  | 'unknown';

export type RunFailureDomain =
  | 'client_product'
  | 'client_environment'
  | 'provider_control_plane'
  | 'policy_admission'
  | 'cross_boundary'
  | 'unknown';

export type RunEvidenceLevel =
  | 'structured_error'
  | 'structured_code'
  | 'protocol_error'
  | 'lifecycle_signal'
  | 'stderr_fallback'
  | 'close_reason'
  | 'legacy_text'
  | 'unknown';

export type RunRepairOwner =
  | 'open_design'
  | 'client_environment'
  | 'provider_owner'
  | 'policy_owner'
  | 'shared_boundary'
  | 'unknown';

export type RunPolicyReason =
  | 'model_window_limit'
  | 'membership_concurrency_limit'
  | 'hard_quota'
  | 'workspace_credits_exhausted'
  | 'amr_insufficient_balance'
  | 'amr_tier_upgrade_required'
  | 'entitlement_required'
  | 'none';

export type RunAdmissionStatus =
  | 'admitted'
  | 'rejected_policy'
  | 'unknown';

export type RunAdmissionPhase = 'before_execution' | 'during_execution' | 'unknown';

export type FirstModelEventType =
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_use'
  | 'artifact';

export type RunFailureUserAction =
  | 'retry'
  | 'login'
  | 'recharge'
  | 'upgrade'
  | 'switch_model'
  | 'reduce_context'
  | 'install_cli'
  | 'fix_config'
  | 'none';

export type ProjectKind =
  | 'prototype'
  | 'web_clone'
  | 'live_artifact'
  | 'wireframe'
  | 'mobile'
  | 'slide_deck'
  | 'template'
  | 'document'
  | 'other'
  | 'image'
  | 'video'
  | 'hyperframes'
  | 'audio'
  | 'brand'
  | 'orbit'
  | 'design_system';

export type ByokProviderId =
  | 'anthropic'
  | 'openai'
  | 'azure_openai'
  | 'google_gemini'
  | 'ollama_cloud'
  | 'deepseek'
  | 'xai'
  | 'custom';

export type CliProviderId =
  | 'claude_code'
  | 'codex_cli'
  | 'gemini_cli'
  | 'opencode'
  | 'byok_opencode'
  | 'grok_build'
  | 'antigravity'
  | 'deepseek'
  | 'deepseek_harness'
  | 'other';

export type RunLifecyclePhase =
  | 'queued'
  | 'prompt_build'
  | 'launch_preflight'
  | 'process_spawn'
  | 'stdin_write'
  | 'runtime_init'
  | 'first_token_wait'
  | 'stream_output'
  | 'tool_execution'
  | 'artifact_write'
  | 'finalize'
  | 'complete'
  | 'unknown';

export type RunPhaseTimingStatus = 'complete' | 'partial' | 'missing';

export type ArtifactWriteStatus = 'none' | 'started' | 'completed' | 'failed';

export type ArtifactWriteSource =
  | 'write_tool'
  | 'live_artifact'
  | 'design_system_file'
  | 'artifact_event'
  | 'unknown';

export type RunRetryStrategy = 'same_run_transient' | 'native_session_continue';

export type RunRetrySuppressedReason =
  | 'not_failed'
  | 'not_retryable'
  | 'unsupported_category'
  | 'non_retryable_category'
  | 'unsafe_failure_stage'
  | 'missing_failure_signal'
  | 'hard_quota'
  | 'attempt_limit_reached'
  | 'cancel_requested'
  | 'user_visible_output_seen'
  | 'tool_call_seen'
  | 'artifact_write_seen'
  | 'live_artifact_seen';

export type RuntimeType = 'byok' | 'local_cli' | 'none';

// Daemon agent id (apps/daemon/src/agents.ts) -> provider id. An agent absent
// from the table is reported as `other` rather than dropped.
const AGENT_ID_TO_CLI_PROVIDER: ReadonlyMap<string, CliProviderId> = new Map([
  ['claude', 'claude_code'],
  ['codex', 'codex_cli'],
  ['gemini', 'gemini_cli'],
  ['opencode', 'opencode'],
  ['grok-build', 'grok_build'],
  ['antigravity', 'antigravity'],
  ['byok-opencode', 'byok_opencode'],
  ['deepseek', 'deepseek'],
  ['deepseek-harness', 'deepseek_harness'],
]);

export function agentIdToTracking(agentId: string | null | undefined): CliProviderId {
  return (agentId == null ? undefined : AGENT_ID_TO_CLI_PROVIDER.get(agentId)) ?? 'other';
}

// BYOK api protocol -> provider id. A protocol outside the table — including a
// known but unsupported one such as `bedrock` — returns null, which every
// caller reads as "outside the catalogue".
const BYOK_PROTOCOL_TO_PROVIDER: ReadonlyMap<string, ByokProviderId> = new Map([
  ['anthropic', 'anthropic'],
  ['openai', 'openai'],
  ['google', 'google_gemini'],
  ['google_gemini', 'google_gemini'],
  ['deepseek', 'deepseek'],
  ['xai', 'xai'],
  ['custom', 'custom'],
]);

export function byokProtocolToTracking(
  protocol: string | null | undefined,
): ByokProviderId | null {
  return (protocol == null ? undefined : BYOK_PROTOCOL_TO_PROVIDER.get(protocol)) ?? null;
}


// Discriminators read off a project's persisted `metadata` to split the coarse
// product `kind` into a finer project kind.
interface ProjectKindTrackingHints {
  fidelity?: string | null | undefined;
  intent?: string | null | undefined;
  platform?: string | null | undefined;
  platformTargets?: readonly string[] | null | undefined;
}

function isMobileSurface(hints: ProjectKindTrackingHints | undefined): boolean {
  const mobile = (target: string | null | undefined): boolean =>
    target === 'mobile-ios' || target === 'mobile-android';
  if (mobile(hints?.platform)) return true;
  return (hints?.platformTargets ?? []).some(mobile);
}

export function projectKindToTracking(
  kind: string | null | undefined,
  videoModel?: string | null,
  hints?: ProjectKindTrackingHints,
): ProjectKind | null {
  switch (kind) {
    case 'prototype':
      // Prototype subtypes share `kind: 'prototype'` but carry a distinguishing
      // metadata field. Precedence (a prototype matching several): web_clone >
      // live_artifact > wireframe > mobile, then plain prototype.
      if (hints?.intent === 'web-clone') return 'web_clone';
      if (hints?.intent === 'live-artifact') return 'live_artifact';
      if (hints?.fidelity === 'wireframe') return 'wireframe';
      if (isMobileSurface(hints)) return 'mobile';
      return 'prototype';
    case 'deck':
      return 'slide_deck';
    case 'template':
      return 'template';
    case 'other':
      // Documents (resumes / reports / PDFs) ride the generic `other` kind but
      // tag `intent: 'document'` so they split out of catch-all `other`.
      return hints?.intent === 'document' ? 'document' : 'other';
    case 'image':
      return 'image';
    case 'video':
      // HyperFrames rides on the `video` kind; the local-render engine is the
      // only thing that distinguishes it, so route on videoModel here.
      return videoModel === HYPERFRAMES_VIDEO_MODEL ? 'hyperframes' : 'video';
    case 'audio':
      return 'audio';
    case 'brand':
      return 'brand';
    case 'orbit':
      return 'orbit';
    case 'live-artifact':
    case 'live_artifact':
      return 'live_artifact';
    case 'web-clone':
    case 'web_clone':
      return 'web_clone';
    default:
      return null;
  }
}

// Convenience wrapper: derive the project kind straight from a project's
// persisted metadata, forwarding the subtype discriminators so prototype/other
// projects resolve to their finer kind.
export function projectKindFromMetadataToTracking(
  metadata:
    | {
        kind?: string | null;
        videoModel?: string | null;
        fidelity?: string | null;
        intent?: string | null;
        platform?: string | null;
        platformTargets?: readonly string[] | null;
      }
    | null
    | undefined,
): ProjectKind | null {
  return projectKindToTracking(metadata?.kind, metadata?.videoModel, {
    fidelity: metadata?.fidelity,
    intent: metadata?.intent,
    platform: metadata?.platform,
    platformTargets: metadata?.platformTargets,
  });
}
