import type { ConnectionTestKind, ConnectionTestProtocol } from './connectionTest';
import type { ReasoningExecutionRequestFields } from './reasoningExecution';
import type { AgentModelOption } from './registry';

export type ProviderModelsKind =
  | ConnectionTestKind
  | 'no_models'
  | 'unsupported_protocol';

export interface ProviderModelsRequest extends ReasoningExecutionRequestFields {
  protocol: ConnectionTestProtocol;
  baseUrl: string;
  apiKey: string;
  // Retained for shape compatibility with existing callers; the daemon no
  // longer branches on it for any protocol.
  apiVersion?: string;
}

export type ProviderModelOption = AgentModelOption;

export interface ProviderModelsResponse {
  ok: boolean;
  kind: ProviderModelsKind;
  latencyMs: number;
  models?: ProviderModelOption[];
  status?: number;
  detail?: string;
}
