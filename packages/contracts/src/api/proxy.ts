import type { ReasoningExecutionRequestFields } from './reasoningExecution';

export type ProxyMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type ProxyMessageContent =
  | string
  | Array<ProxyTextContentBlock | ProxyImageContentBlock>;

export interface ProxyTextContentBlock {
  type: 'text';
  text: string;
}

export interface ProxyImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
}

export interface ProxyMessage {
  role: ProxyMessageRole;
  content: ProxyMessageContent;
}

export interface ProxyStreamRequest extends ReasoningExecutionRequestFields {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
  messages: ProxyMessage[];
  // Caps the upstream completion length. Defaults to 8192 when unset so
  // pre-existing clients keep their old behavior.
  maxTokens?: number;
  // Retained for shape compatibility with existing callers; the daemon no
  // longer branches on it for any proxy protocol.
  apiVersion?: string;
  // Which BYOK protocol the caller is really speaking (`ApiProtocol` in
  // apps/web). One OpenAI-compatible route carries several of them — openai,
  // deepseek, xai, custom all POST to `/api/proxy/openai/stream` — and the
  // reasoning-egress check needs the real one to label the run and to pick the
  // right model-id normalization. Absent/unknown means the route's own
  // protocol, so an older client keeps today's behavior.
  protocol?: string;
}

export interface ProxyStreamStartPayload {
  model?: string;
}

export interface ProxyStreamDeltaPayload {
  delta: string;
}

export interface ProxyStreamEndPayload {
  code?: number;
}
