/**
 * Thin wrapper over @anthropic-ai/sdk. Minimal analog of
 * packages/providers/src/index.ts in the reference repo.
 *
 * Runs in the browser with dangerouslyAllowBrowser — this is a BYOK local-
 * first tool, so the key is the user's and never leaves their machine. If
 * you later move to a server-hosted build, drop that flag and proxy through
 * your own backend.
 */
import Anthropic from '@anthropic-ai/sdk';
import { effectiveMaxTokens } from '../state/maxTokens';
import type { AppConfig, ChatMessage } from '../types';
import { streamMessageAnthropicProxy } from './anthropic-compatible';
import type { ProxyContext } from './api-proxy';
import { streamMessageGoogle } from './google-compatible';
import { isOpenAICompatible, streamMessageOpenAI } from './openai-compatible';
import { usesAnthropicProxy } from '../utils/apiProtocol';

// Re-export for convenience
export { isOpenAICompatible } from './openai-compatible';

export interface StreamHandlers {
  onDelta: (textDelta: string) => void;
  onDone: (fullText: string) => void;
  onError: (err: Error) => void;
}

export function makeClient(cfg: AppConfig): Anthropic {
  return new Anthropic({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl || undefined,
    dangerouslyAllowBrowser: true,
  });
}

export async function streamMessage(
  cfg: AppConfig,
  system: string,
  history: ChatMessage[],
  signal: AbortSignal,
  handlers: StreamHandlers,
  // The Anthropic branch reads `context.projectId` so the daemon-side
  // `generate_image` tool can write into the active project's folder, and so
  // image attachments resolve into content blocks. Other branches accept and
  // ignore it — keeping the signature uniform means the single call site in
  // ProjectView passes the same shape regardless of protocol.
  context?: ProxyContext,
): Promise<void> {
  // Prefer the explicit Settings protocol; keep the legacy heuristic as a
  // fallback for configs saved before apiProtocol existed.
  if (cfg.apiProtocol === 'google') {
    return streamMessageGoogle(cfg, system, history, signal, handlers);
  }
  // `openai`, `deepseek`, `xai` and `custom` all speak OpenAI-compatible
  // chat-completions, so they share one client and differ only in the base
  // URL the daemon proxy forwards to.
  if (
    cfg.apiProtocol === 'openai'
    || cfg.apiProtocol === 'deepseek'
    || cfg.apiProtocol === 'xai'
    || cfg.apiProtocol === 'custom'
    || (!cfg.apiProtocol && isOpenAICompatible(cfg.model, cfg.baseUrl))
  ) {
    return streamMessageOpenAI(cfg, system, history, signal, handlers);
  }

  if (usesAnthropicProxy(cfg)) {
    return streamMessageAnthropicProxy(cfg, system, history, signal, handlers, context);
  }

  if (!cfg.apiKey) {
    handlers.onError(new Error('Missing API key — open Settings and paste one in.'));
    return;
  }

  const client = makeClient(cfg);
  let acc = '';

  try {
    const stream = client.messages.stream(
      {
        model: cfg.model,
        max_tokens: effectiveMaxTokens(cfg),
        system,
        messages: history.map((m) => ({ role: m.role, content: m.content })),
      },
      { signal },
    );

    stream.on('text', (delta) => {
      acc += delta;
      handlers.onDelta(delta);
    });

    await stream.finalMessage();
    handlers.onDone(acc);
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    handlers.onError(err instanceof Error ? err : new Error(String(err)));
  }
}
