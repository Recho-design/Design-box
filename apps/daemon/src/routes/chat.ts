import type { Express } from 'express';
import type { RouteDeps } from '../server-context.js';
import {
  buildMaxCompletionTokensParam,
  buildOpenAIChatTokenParam,
  isAzureOpenAIHostname,
  isUnsupportedMaxTokensError,
} from '../integrations/openai-chat-token-params.js';
import { projectKindToTracking } from '../runtimes/run-failure-vocabulary.js';
import { proxyDispatcherRequestInit, validateUserProviderBaseUrl } from '../connectionTest.js';
import { isKnownReasoningEffort, resolveModelForServiceTier } from '../runtimes/models.js';
import { proxyEnvFromPrefs } from '../runtimes/env.js';
import { googleStreamGenerateContentUrl } from '../integrations/google-models.js';
import { createRoleMarkerGuard } from '../role-marker-guard.js';
import { authorizeReasoningEgress, sendReasoningEgressDenial } from '../reasoning-egress.js';

// The six chat protocols this daemon speaks. `anthropic` and `google` are
// native wires; `openai`, `deepseek`, `xai` and `custom` all run the same
// OpenAI-compatible code path and differ only in default base URL (`custom`
// has none — the caller must always supply one). Kept inline (not imported as
// a runtime value, since the contract type is type-only) so a stale client
// can't push an unknown protocol into the proxy/connection-test routes.
const CHAT_PROTOCOLS: ReadonlySet<string> = new Set([
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'xai',
  'custom',
]);
const CHAT_PROTOCOL_LIST = 'anthropic|openai|google|deepseek|xai|custom';

// The OpenAI-compatible family `POST /api/proxy/openai/stream` actually
// serves. `anthropic` and `google` are excluded on purpose: each has its own
// route because its wire is different, and a caller that claimed one of them
// here would only mislabel the run. Add a protocol here when it joins the
// family — the fallback below is `openai`, so a missed entry degrades into
// today's hard-coded label rather than into a wrong one.
const OPENAI_COMPATIBLE_PROTOCOLS: ReadonlySet<string> = new Set([
  'openai',
  'deepseek',
  'xai',
  'custom',
]);

// The provider name the reasoning-egress check reasons about is the user's
// configured protocol, not the route's wire. Older callers omit it.
function proxyProtocolForEgress(value: unknown): string {
  return typeof value === 'string' && OPENAI_COMPATIBLE_PROTOCOLS.has(value)
    ? value
    : 'openai';
}

export interface RegisterChatRoutesDeps extends RouteDeps<'db' | 'design' | 'http' | 'chat' | 'agents' | 'critique' | 'validation' | 'lifecycle' | 'paths' | 'appConfig'> {}

export function registerChatRoutes(app: Express, ctx: RegisterChatRoutesDeps) {
  const { db, design } = ctx;
  const { sendApiError, createSseResponse } = ctx.http;
  const { readAppConfig } = ctx.appConfig;
  const { testProviderConnection, testAgentConnection, getAgentDef, isKnownModel, isKnownServiceTier, sanitizeCustomModel, listProviderModels } = ctx.agents;
  const {
    handleCritiqueArtifact,
    handleCritiqueInterrupt,
    critiqueArtifactsRoot,
    critiqueResponseCapBytes,
    critiqueRunRegistry,
  } = ctx.critique;
  const rejectProxyPluginContext = (body: Record<string, unknown>, res: any) => {
    if (
      (typeof body.pluginId === 'string' && body.pluginId.trim().length > 0) ||
      (
        typeof body.appliedPluginSnapshotId === 'string' &&
        body.appliedPluginSnapshotId.trim().length > 0
      )
    ) {
      sendApiError(
        res,
        409,
        'PLUGIN_REQUIRES_DAEMON',
        'Plugin runs must go through POST /api/runs so the daemon can resolve and pin the applied plugin snapshot.',
      );
      return true;
    }
    return false;
  };

  // Run lifecycle routes live in `routes/runs.ts`; this file owns feedback,
  // connection tests, critique handoff, and provider proxy routes.

  // Receives the user's thumbs-up/down (+ reason codes) for an assistant turn.
  // Web persists the feedback itself via PUT /messages/:id — the rating is a
  // message property, not a daemon concern. This endpoint used to exist as the
  // daemon's single network egress for forwarding ratings; with that outlet
  // gone there is nothing left to relay, so the route keeps its contract
  // and answers `skipped_no_sink` without doing network work.
  app.post('/api/runs/:id/feedback', async (req, res) => {
    const runId = req.params.id;
    const body = (req.body ?? {}) as Partial<{
      rating: 'positive' | 'negative';
      reasonCodes: string[];
      hasCustomReason: boolean;
      customReason: string;
    }> & Record<string, unknown>;
    if (!runId) {
      return sendApiError(res, 400, 'INVALID_RUN_ID', 'runId missing');
    }
    const callerOwnedContextFields = [
      'projectId',
      'conversationId',
      'assistantMessageId',
    ].filter((field) => Object.prototype.hasOwnProperty.call(body, field));
    if (callerOwnedContextFields.length > 0) {
      return sendApiError(
        res,
        400,
        'INVALID_FEEDBACK_CONTEXT',
        'feedback project, conversation, and message identity are derived from the run',
      );
    }
    if (body.rating !== 'positive' && body.rating !== 'negative') {
      return sendApiError(res, 400, 'INVALID_RATING', 'rating must be positive or negative');
    }
    const run = design.runs.get(runId);
    if (!run || typeof run.projectId !== 'string' || !run.projectId) {
      return sendApiError(res, 404, 'NOT_FOUND', 'run not found');
    }
    res.status(202).json({ status: 'skipped_no_sink' });
  });

  // ---- Connection tests (single-shot JSON; no SSE) ------------------------
  // Settings dialog uses these to verify a config works without sending a
  // real chat. Always return HTTP 200 with `ok: false` on upstream-caused
  // failures so the web layer can render a categorized inline status without
  // unwrapping nested error envelopes; real 4xx/5xx here mean a malformed
  // request or daemon bug.
  app.post('/api/provider/models', async (req, res) => {
    const controller = new AbortController();
    const abortIfRequestAborted = () => {
      if ((req.aborted || !req.complete) && !res.writableEnded) {
        controller.abort();
      }
    };
    const abortIfResponseClosed = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.on('close', abortIfRequestAborted);
    res.on('close', abortIfResponseClosed);
    const body = req.body || {};
    const protocol = body.protocol;
    if (typeof protocol !== 'string' || !CHAT_PROTOCOLS.has(protocol)) {
      return sendApiError(
        res,
        400,
        'BAD_REQUEST',
        `protocol must be one of ${CHAT_PROTOCOL_LIST}`,
      );
    }
    // Every chat protocol needs a key to hit its /models endpoint. A custom
    // OpenAI-compatible endpoint additionally has no default base URL, so the
    // user must always supply one (same requirement shape as openai).
    if (
      typeof body.baseUrl !== 'string' ||
      typeof body.apiKey !== 'string' ||
      !body.baseUrl.trim() ||
      !body.apiKey.trim()
    ) {
      return sendApiError(
        res,
        400,
        'BAD_REQUEST',
        'baseUrl and apiKey are required',
      );
    }
    const reasoningDenial = authorizeReasoningEgress({
      policy: body.reasoningExecution,
      routeKind: 'provider_models',
      provider: protocol,
      resolvedBaseUrl: body.baseUrl,
    });
    if (reasoningDenial) return sendReasoningEgressDenial(res, reasoningDenial);
    try {
      const proxyDispatcher = proxyDispatcherRequestInit();
      try {
        const result = await listProviderModels({
          protocol,
          baseUrl: body.baseUrl,
          apiKey: body.apiKey,
          signal: controller.signal,
          requestInit: proxyDispatcher.requestInit,
        });
        return res.json(result);
      } finally {
        await proxyDispatcher.close();
      }
    } catch (err: any) {
      console.warn(
        `[provider:models] uncaught: ${err instanceof Error ? err.message : String(err)}`,
      );
      return sendApiError(res, 500, 'INTERNAL', 'Provider model discovery failed');
    } finally {
      req.off('close', abortIfRequestAborted);
      res.off('close', abortIfResponseClosed);
    }
  });

  app.post('/api/test/connection', async (req, res) => {
    const controller = new AbortController();
    const abortIfRequestAborted = () => {
      if ((req.aborted || !req.complete) && !res.writableEnded) {
        controller.abort();
      }
    };
    const abortIfResponseClosed = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.on('close', abortIfRequestAborted);
    res.on('close', abortIfResponseClosed);
    const body = req.body || {};
    try {
      if (body.mode === 'provider') {
        const protocol = body.protocol;
        if (typeof protocol !== 'string' || !CHAT_PROTOCOLS.has(protocol)) {
          return sendApiError(
            res,
            400,
            'BAD_REQUEST',
            `protocol must be one of ${CHAT_PROTOCOL_LIST}`,
          );
        }
        if (
          typeof body.baseUrl !== 'string' ||
          typeof body.apiKey !== 'string' ||
          typeof body.model !== 'string' ||
          !body.baseUrl.trim() ||
          !body.apiKey.trim() ||
          !body.model.trim()
        ) {
          return sendApiError(
            res,
            400,
            'BAD_REQUEST',
            'baseUrl, apiKey, and model are required',
          );
        }
        const reasoningDenial = authorizeReasoningEgress({
          policy: body.reasoningExecution,
          routeKind: 'connection_test',
          provider: protocol,
          resolvedBaseUrl: body.baseUrl,
          model: body.model,
        });
        if (reasoningDenial) return sendReasoningEgressDenial(res, reasoningDenial);
        try {
          const result = await testProviderConnection({
            protocol,
            baseUrl: body.baseUrl,
            apiKey: body.apiKey,
            model: body.model,
            signal: controller.signal,
          });
          return res.json(result);
        } catch (err: any) {
          console.warn(
            `[test:provider] uncaught: ${err instanceof Error ? err.message : String(err)}`,
          );
          return sendApiError(res, 500, 'INTERNAL', 'Connection test failed');
        }
      }

      if (body.mode === 'agent') {
        if (typeof body.agentId !== 'string' || !body.agentId.trim()) {
          return sendApiError(res, 400, 'BAD_REQUEST', 'agentId is required');
        }
        try {
          const def = getAgentDef(body.agentId);
          const testStart = Date.now();
          const appConfig = await readAppConfig(ctx.paths.RUNTIME_DATA_DIR).catch(() => ({}));
          const configuredModel =
            def && typeof appConfig.agentModels?.[def.id]?.model === 'string'
              ? appConfig.agentModels[def.id].model
              : undefined;
          const requestedModel =
            typeof body.model === 'string' ? body.model : configuredModel;
          let safeModel =
            def && typeof requestedModel === 'string'
              ? isKnownModel(def, requestedModel)
                ? requestedModel
                : sanitizeCustomModel(requestedModel)
              : undefined;
          if (def && typeof body.model === 'string' && body.model.trim() && !safeModel) {
            return res.json({
              ok: false,
              kind: 'invalid_model_id',
              latencyMs: Date.now() - testStart,
              model: body.model.trim(),
              agentName: def.name,
              detail: 'Invalid custom model id. Use a model id that starts with a letter or number and contains no spaces.',
            });
          }
          const safeReasoning =
            def &&
            typeof body.reasoning === 'string' &&
            isKnownReasoningEffort(def, safeModel, body.reasoning)
              ? body.reasoning
              : undefined;
          safeModel = def
            ? resolveModelForServiceTier(
                def,
                safeModel,
                typeof body.serviceTier === 'string' ? body.serviceTier : null,
              ) ?? undefined
            : safeModel;
          const safeServiceTier =
            def &&
            typeof body.serviceTier === 'string' &&
            isKnownServiceTier(def, safeModel, body.serviceTier)
              ? body.serviceTier
              : undefined;
          const result = await testAgentConnection({
            agentId: body.agentId,
            model: safeModel ?? undefined,
            reasoning: safeReasoning,
            serviceTier: safeServiceTier,
            agentCliEnv:
              body.agentCliEnv && typeof body.agentCliEnv === 'object'
                ? body.agentCliEnv
                : undefined,
            proxyEnv: proxyEnvFromPrefs(appConfig.proxyPrefs),
            signal: controller.signal,
          });
          return res.json(result);
        } catch (err: any) {
          console.warn(
            `[test:agent] uncaught: ${err instanceof Error ? err.message : String(err)}`,
          );
          return sendApiError(res, 500, 'INTERNAL', 'Agent test failed');
        }
      }

      return sendApiError(
        res,
        400,
        'BAD_REQUEST',
        'mode must be one of provider|agent',
      );
    } finally {
      req.off('close', abortIfRequestAborted);
      res.off('close', abortIfResponseClosed);
    }
  });

  // ---- Critique Theater endpoints (Phase 6) --------------------------------

  // POST /api/projects/:projectId/critique/:runId/interrupt
  // Cascades an AbortController to the in-flight orchestrator for the given run.
  const critiqueInterruptHandler =
    handleCritiqueInterrupt(db, critiqueRunRegistry);
  app.post(
    '/api/projects/:projectId/critique/:runId/interrupt',
    async (req, res) => {
      critiqueInterruptHandler(req, res);
    },
  );

  // GET /api/projects/:projectId/critique/:runId/artifact
  // Streams the SHIP <ARTIFACT> body the orchestrator persisted, with
  // mime derived from the file extension on disk. Cross-project leak
  // guard mirrors the interrupt route. The web layer fetches this as
  // the logical artifact handle so it never sees daemon paths.
  //
  // Response cap is threaded from cfg.parserMaxBlockBytes so a row that
  // the orchestrator + writer accepted is always retrievable.
  const critiqueArtifactHandler = handleCritiqueArtifact(db, {
    artifactsRoot: critiqueArtifactsRoot,
    responseCapBytes: critiqueResponseCapBytes,
  });
  app.get(
    '/api/projects/:projectId/critique/:runId/artifact',
    async (req, res) => {
      await critiqueArtifactHandler(req, res);
    },
  );

  // ---- API Proxy (SSE) for API-compatible endpoints ------------------------
  // Browser → daemon → external API. Avoids CORS issues with third-party
  // providers. This keeps BYOK setup zero-config for local users at the cost of
  // one local streaming hop through the daemon.

  const redactAuthTokens = (text: string) =>
    text.replace(/Bearer [A-Za-z0-9_\-.+/=]+/g, 'Bearer [REDACTED]');

  // DNS-aware wrapper. The sync `validateBaseUrl` only inspects the literal
  // hostname string, so a public DNS name pointing at an internal address
  // (`internal.example.com → 10.0.0.5`) still passes. We delegate to
  // `validateUserProviderBaseUrl` here so every proxy/stream handler runs the
  // same resolved-IP check before issuing the upstream request.
  const validateExternalApiBaseUrl = (baseUrl: string) => {
    return validateUserProviderBaseUrl(baseUrl);
  };

  const proxyErrorCode = (status: number) => {
    if (status === 401) return 'UNAUTHORIZED';
    if (status === 403) return 'FORBIDDEN';
    if (status === 404) return 'NOT_FOUND';
    if (status === 429) return 'RATE_LIMITED';
    return 'UPSTREAM_UNAVAILABLE';
  };

  const sendProxyError = (sse: any, message: string, init: any = {}) => {
    sse.send('error', {
      message,
      error: {
        code: init.code || 'UPSTREAM_UNAVAILABLE',
        message,
        ...(init.details === undefined ? {} : { details: init.details }),
        ...(init.retryable === undefined ? {} : { retryable: init.retryable }),
      },
    });
  };

  const appendVersionedApiPath = (baseUrl: string, path: string) => {
    const url = new URL(baseUrl);
    // `URL.pathname` setter normalizes an empty string back to "/", so
    // we work in a local string to detect the no-path and no-version
    // cases.
    const trimmed = url.pathname.replace(/\/+$/, '');
    // Auto-inject `/v1` whenever the supplied path doesn't already
    // contain a `/vN` segment. This handles all four preset shapes:
    //   bare host                            → /v1/<route>            (api.openai.com, api.anthropic.com)
    //   ends in /vN                          → no inject              (api.openai.com/v1, /v1)
    //   /vN sub-path                         → no inject              (api.deepinfra.com/v1/openai, openrouter.ai/api/v1)
    //   non-versioned compat sub-path        → /v1/<route>            (api.deepseek.com/anthropic, api.minimax.io/anthropic)
    // Previously the check was end-of-path only, which broke the
    // /v1/openai sub-path case. A naive "non-empty path → respect"
    // would break the /anthropic sub-path case. Matching `/vN` as a
    // segment anywhere in the path threads both correctly.
    url.pathname = /\/v\d+(\/|$)/.test(trimmed)
      ? `${trimmed}${path}`
      : `${trimmed}/v1${path}`;
    return url.toString();
  };

  const collectSseFrame = (frame: string) => {
    const lines = frame.replace(/\r/g, '').split('\n');
    const dataLines = [];
    let event = 'message';
    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith('data:')) continue;
      let value = line.slice(5);
      if (value.startsWith(' ')) value = value.slice(1);
      dataLines.push(value);
    }
    const payload = dataLines.join('\n');
    if (!payload) return { event, payload: '', data: null };
    if (payload === '[DONE]') return { event, payload, data: null };
    try {
      return { event, payload, data: JSON.parse(payload) };
    } catch {
      return { event, payload, data: null };
    }
  };

  const streamUpstreamSse = async (response: any, onFrame: any) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) break;
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (await onFrame(collectSseFrame(frame))) {
          // Fire-and-forget cancel: awaiting hangs on some response-stream
          // implementations (notably Response built from Uint8Array body,
          // exposed by tests/proxy-routes.test.ts mock bodies whose tee'd
          // cancel() never resolves). The cancel signal is a hint; we're
          // already returning from the function, so we don't gain anything
          // by blocking on it.
          void reader.cancel().catch(() => {});
          return;
        }
      }
    }

    const tail = buffer.trim();
    if (tail) await onFrame(collectSseFrame(tail));
  };

  const streamUpstreamNdjson = async (response: any, onFrame: any) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        try {
          const data = JSON.parse(line);
          if (await onFrame({ data })) {
            // See note in streamUpstreamSse — fire-and-forget cancel.
            void reader.cancel().catch(() => {});
            return;
          }
        } catch {
          // Ignore malformed provider keepalive lines.
        }
      }
    }

    const tail = buffer.trim();
    if (tail) {
      try {
        const data = JSON.parse(tail);
        await onFrame({ data });
      } catch {
        // Ignore malformed provider tail data.
      }
    }
  };

  const extractOpenAIText = (data: any) => {
    const choices = data?.choices;
    if (!Array.isArray(choices) || choices.length === 0) return '';
    const first = choices[0];
    if (typeof first?.delta?.content === 'string') return first.delta.content;
    if (typeof first?.text === 'string') return first.text;
    return '';
  };

  const extractStreamErrorMessage = (data: any) => {
    const err = data?.error;
    if (!err) return '';
    if (typeof err === 'string') return err;
    if (typeof err?.message === 'string') return err.message;
    try {
      return JSON.stringify(err);
    } catch {
      return 'unspecified provider error';
    }
  };

  const extractGeminiText = (data: any) => {
    const candidates = data?.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return '';
    const parts = candidates[0]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map((part) => part?.text).filter((text) => typeof text === 'string').join('');
  };

  const benignGeminiFinishReasons = new Set(['', 'STOP', 'MAX_TOKENS', 'FINISH_REASON_UNSPECIFIED']);
  const extractGeminiBlockMessage = (data: any) => {
    const feedback = data?.promptFeedback;
    if (typeof feedback?.blockReason === 'string' && feedback.blockReason) {
      const tail = typeof feedback.blockReasonMessage === 'string' && feedback.blockReasonMessage
        ? ` — ${feedback.blockReasonMessage}`
        : '';
      return `Gemini blocked the prompt (${feedback.blockReason})${tail}.`;
    }
    const candidates = data?.candidates;
    if (!Array.isArray(candidates)) return '';
    for (const candidate of candidates) {
      const reason = candidate?.finishReason;
      if (typeof reason !== 'string' || benignGeminiFinishReasons.has(reason)) continue;
      const tail = typeof candidate?.finishMessage === 'string' && candidate.finishMessage
        ? ` — ${candidate.finishMessage}`
        : '';
      return `Gemini stopped the response (${reason})${tail}.`;
    }
    return '';
  };

  // Per-request role-marker guard for BYOK proxy streams (#3247).
  function createDeltaGuard(sse: any) {
    const guard = createRoleMarkerGuard('proxy');
    return {
      sendDelta(text: string) {
        if (guard.contaminated || !text) return;
        const safe = guard.feedText(text);
        if (safe.length > 0) {
          sse.send('delta', { delta: safe });
        }
        if (guard.contaminated) {
          const warn = guard.warningEvent();
          const markerText = warn?.marker ?? '## user';
          sse.send('delta', {
            delta: `\n\n---\n⚠️ **Security warning:** The model attempted to emit a fabricated role marker (\`${markerText}\`). Response was truncated to prevent unauthorized instruction injection. See issue #3247.\n`,
          });
        }
      },
      get contaminated() { 
        return guard.contaminated; 
      },
    };
  }

  // ---- Reusable base-chat streamers (text only — no tool loop) -------------
  // The native /api/proxy/{anthropic,google}/stream routes share this:
  // only the resolved url + headers differ, so the wire/SSE handling lives
  // here once.

  const buildAnthropicChatPayload = (
    model: string,
    systemPrompt: unknown,
    messages: unknown,
    maxTokens: unknown,
  ) => {
    const payload: any = {
      model,
      max_tokens:
        typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 8192,
      messages: Array.isArray(messages) ? messages : [],
      stream: true,
    };
    if (typeof systemPrompt === 'string' && systemPrompt) {
      payload.system = systemPrompt;
    }
    return payload;
  };

  // A BYOK proxy stream must unwind when the client disconnects (Stop or a
  // closed tab); otherwise the upstream completion keeps streaming and
  // billing after the user is gone. Every upstream fetch below carries this
  // signal. Mirrors the AbortController wiring already used by
  // `/api/provider/models` and `/api/test/connection`.
  const clientDisconnectSignal = (res: any, req?: any): AbortSignal => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.on('close', abort);
    if (req) req.on('close', abort);
    return controller.signal;
  };

  const runAnthropicChatStream = async (
    res: any,
    opts: { url: string; headers: Record<string, string>; payload: any; logTag: string },
  ) => {
    const sse = createSseResponse(res);
    let proxyDispatcher: ReturnType<typeof proxyDispatcherRequestInit> | null = null;
    try {
      proxyDispatcher = proxyDispatcherRequestInit();
      const signal = clientDisconnectSignal(res);
      sse.send('start', { model: opts.payload?.model });
      const response = await fetch(opts.url, {
        ...proxyDispatcher.requestInit,
        signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...opts.headers },
        body: JSON.stringify(opts.payload),
        redirect: 'error',
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[${opts.logTag}] upstream error: ${response.status} ${redactAuthTokens(errorText)}`,
        );
        sendProxyError(sse, `Upstream error: ${response.status}`, {
          code: proxyErrorCode(response.status),
          details: errorText,
          retryable: response.status === 429 || response.status >= 500,
        });
        return sse.end();
      }

      let ended = false;
      const guard = createDeltaGuard(sse);
      await streamUpstreamSse(response, ({ event, data }: any) => {
        if (!data) return false;
        if (event === 'error' || data.type === 'error') {
          const message = data.error?.message || data.message || 'Anthropic upstream error';
          sendProxyError(sse, message, { details: data });
          ended = true;
          return true;
        }
        if (event === 'content_block_delta' && typeof data.delta?.text === 'string') {
          guard.sendDelta(data.delta.text);
          if (guard.contaminated) {
            sse.send('end', {});
            ended = true;
            return true;
          }
        }
        if (event === 'message_stop') {
          sse.send('end', {});
          ended = true;
          return true;
        }
        return false;
      });
      if (!ended) sse.send('end', {});
      sse.end();
    } catch (err: any) {
      console.error(`[${opts.logTag}] internal error: ${err.message}`);
      sendProxyError(sse, err.message, { code: 'INTERNAL_ERROR' });
      sse.end();
    } finally {
      await proxyDispatcher?.close();
    }
  };

  const buildGeminiChatPayload = (
    systemPrompt: unknown,
    messages: unknown,
    maxTokens: unknown,
  ) => {
    const contents = (Array.isArray(messages) ? messages : []).map((message: any) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    }));
    const payload: any = {
      contents,
      generationConfig: {
        maxOutputTokens:
          typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 8192,
      },
    };
    if (typeof systemPrompt === 'string' && systemPrompt) {
      payload.systemInstruction = { parts: [{ text: systemPrompt }] };
    }
    return payload;
  };

  const runGeminiChatStream = async (
    res: any,
    opts: { url: string; headers: Record<string, string>; payload: any; model: string; logTag: string },
  ) => {
    const sse = createSseResponse(res);
    let proxyDispatcher: ReturnType<typeof proxyDispatcherRequestInit> | null = null;
    try {
      proxyDispatcher = proxyDispatcherRequestInit();
      const signal = clientDisconnectSignal(res);
      sse.send('start', { model: opts.model });
      const response = await fetch(opts.url, {
        ...proxyDispatcher.requestInit,
        signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...opts.headers },
        body: JSON.stringify(opts.payload),
        redirect: 'error',
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[${opts.logTag}] upstream error: ${response.status} ${redactAuthTokens(errorText)}`,
        );
        sendProxyError(sse, `Upstream error: ${response.status}`, {
          code: proxyErrorCode(response.status),
          details: errorText,
          retryable: response.status === 429 || response.status >= 500,
        });
        return sse.end();
      }

      let ended = false;
      const guard = createDeltaGuard(sse);
      await streamUpstreamSse(response, ({ data }: any) => {
        if (!data) return false;
        const streamError = extractStreamErrorMessage(data);
        if (streamError) {
          sendProxyError(sse, `Gemini error: ${streamError}`, { details: data });
          ended = true;
          return true;
        }
        const delta = extractGeminiText(data);
        if (delta) {
          guard.sendDelta(delta);
          if (guard.contaminated) {
            sse.send('end', {});
            ended = true;
            return true;
          }
        }
        const blockMessage = extractGeminiBlockMessage(data);
        if (blockMessage) {
          sendProxyError(sse, blockMessage, { details: data });
          ended = true;
          return true;
        }
        return false;
      });
      if (!ended) sse.send('end', {});
      sse.end();
    } catch (err: any) {
      console.error(`[${opts.logTag}] internal error: ${err.message}`);
      sendProxyError(sse, err.message, { code: 'INTERNAL_ERROR' });
      sse.end();
    } finally {
      await proxyDispatcher?.close();
    }
  };

  app.post('/api/proxy/anthropic/stream', async (req, res) => {
    /** @type {Partial<ProxyStreamRequest>} */
    const proxyBody = req.body || {};
    if (rejectProxyPluginContext(proxyBody, res)) return;
    const { baseUrl, apiKey, model, systemPrompt, messages, maxTokens } =
      proxyBody;
    if (!baseUrl || !apiKey || !model) {
      return sendApiError(
        res,
        400,
        'BAD_REQUEST',
        'baseUrl, apiKey, and model are required',
      );
    }

    const validated = await validateExternalApiBaseUrl(baseUrl);
    if (validated.error) {
      return sendApiError(
        res,
        validated.forbidden ? 403 : 400,
        validated.forbidden ? 'FORBIDDEN' : 'BAD_REQUEST',
        validated.error,
      );
    }
    const reasoningDenial = authorizeReasoningEgress({
      policy: proxyBody.reasoningExecution,
      routeKind: 'proxy',
      provider: 'anthropic',
      resolvedBaseUrl: baseUrl,
      model,
    });
    if (reasoningDenial) return sendReasoningEgressDenial(res, reasoningDenial);

    const url = appendVersionedApiPath(baseUrl, '/messages');
    console.log(
      `[proxy:anthropic] ${req.method} ${validated.parsed!.hostname} model=${model}`,
    );

    return runAnthropicChatStream(res, {
      url,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload: buildAnthropicChatPayload(model, systemPrompt, messages, maxTokens),
      logTag: 'proxy:anthropic',
    });
  });

  app.post('/api/proxy/openai/stream', async (req, res) => {
    /** @type {Partial<ProxyStreamRequest>} */
    const proxyBody = req.body || {};
    if (rejectProxyPluginContext(proxyBody, res)) return;
    const { baseUrl, apiKey, model, systemPrompt, messages, maxTokens } =
      proxyBody;
    if (!baseUrl || !apiKey || !model) {
      return sendApiError(
        res,
        400,
        'BAD_REQUEST',
        'baseUrl, apiKey, and model are required',
      );
    }

    const validated = await validateExternalApiBaseUrl(baseUrl);
    if (validated.error) {
      return sendApiError(
        res,
        validated.forbidden ? 403 : 400,
        validated.forbidden ? 'FORBIDDEN' : 'BAD_REQUEST',
        validated.error,
      );
    }
    const reasoningDenial = authorizeReasoningEgress({
      policy: proxyBody.reasoningExecution,
      routeKind: 'proxy',
      // Four protocols share this OpenAI-compatible route (openai, deepseek,
      // xai, custom — see `ApiProtocol` in apps/web). The path cannot tell them
      // apart, so the caller states which one it is; hard-coding 'openai' here
      // attributed every deepseek/xai/custom run to OpenAI and normalized their
      // model ids as OpenAI's. Absent protocol (older client) keeps 'openai'.
      provider: proxyProtocolForEgress(proxyBody.protocol),
      resolvedBaseUrl: baseUrl,
      model,
    });
    if (reasoningDenial) return sendReasoningEgressDenial(res, reasoningDenial);

    const url = appendVersionedApiPath(baseUrl, '/chat/completions');
    console.log(
      `[proxy:openai] ${req.method} ${validated.parsed!.hostname} model=${model}`,
    );

    const payloadMessages = Array.isArray(messages) ? [...messages] : [];
    if (typeof systemPrompt === 'string' && systemPrompt) {
      payloadMessages.unshift({ role: 'system', content: systemPrompt });
    }

    const effectiveMaxTokens =
      typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 8192;
    const payload: any = {
      model,
      messages: payloadMessages,
      ...buildOpenAIChatTokenParam(model, effectiveMaxTokens),
      stream: true,
    };
    const retryPayload = {
      model,
      messages: payloadMessages,
      ...buildMaxCompletionTokensParam(effectiveMaxTokens),
      stream: true,
    };
    const canRetryUnsupportedMaxTokens = isAzureOpenAIHostname(
      validated.parsed!.hostname,
    );

    const sse = createSseResponse(res);
    let proxyDispatcher: ReturnType<typeof proxyDispatcherRequestInit> | null = null;
    try {
      proxyDispatcher = proxyDispatcherRequestInit();
      const signal = clientDisconnectSignal(res);
      sse.send('start', { model });
      const requestInit = {
        ...proxyDispatcher.requestInit,
        signal,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...(validated.parsed!.hostname === 'openrouter.ai' ? {
            'X-Title': 'OpenDesign',
          } : {}),
        },
        redirect: 'error' as const,
      };
      let response = await fetch(url, {
        ...requestInit,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        let errorText = await response.text();
        if (
          canRetryUnsupportedMaxTokens &&
          response.status === 400 &&
          isUnsupportedMaxTokensError(errorText)
        ) {
          console.warn(
            `[proxy:openai] retrying Azure-hosted request with max_completion_tokens model=${model}`,
          );
          response = await fetch(url, {
            ...requestInit,
            body: JSON.stringify(retryPayload),
          });
          errorText = response.ok ? '' : await response.text();
        }
        if (!response.ok) {
          console.error(
            `[proxy:openai] upstream error: ${response.status} ${redactAuthTokens(errorText)}`,
          );
          sendProxyError(sse, `Upstream error: ${response.status}`, {
            code: proxyErrorCode(response.status),
            details: errorText,
            retryable: response.status === 429 || response.status >= 500,
          });
          return sse.end();
        }
      }

      let ended = false;
      const guard = createDeltaGuard(sse);
      await streamUpstreamSse(response, ({ payload, data }: any) => {
        if (payload === '[DONE]') {
          sse.send('end', {});
          ended = true;
          return true;
        }
        if (!data) return false;
        const streamError = extractStreamErrorMessage(data);
        if (streamError) {
          sendProxyError(sse, `Provider error: ${streamError}`, { details: data });
          ended = true;
          return true;
        }
        const delta = extractOpenAIText(data);
        if (delta) { 
          guard.sendDelta(delta); 
          if (guard.contaminated) { 
            sse.send('end', {}); 
            ended = true; 
            return true; 
          } 
        }
        return false;
      });
      if (!ended) sse.send('end', {});
      sse.end();
    } catch (err: any) {
      console.error(`[proxy:openai] internal error: ${err.message}`);
      sendProxyError(sse, err.message, { code: 'INTERNAL_ERROR' });
      sse.end();
    } finally {
      await proxyDispatcher?.close();
    }
  });

  app.post('/api/proxy/google/stream', async (req, res) => {
    /** @type {Partial<ProxyStreamRequest>} */
    const proxyBody = req.body || {};
    if (rejectProxyPluginContext(proxyBody, res)) return;
    const { baseUrl, apiKey, model, systemPrompt, messages, maxTokens } = proxyBody;
    if (!apiKey || !model) {
      return sendApiError(
        res,
        400,
        'BAD_REQUEST',
        'apiKey and model are required',
      );
    }

    const effectiveBaseUrl = baseUrl || 'https://generativelanguage.googleapis.com';
    const validated = await validateExternalApiBaseUrl(effectiveBaseUrl);
    if (validated.error) {
      return sendApiError(
        res,
        validated.forbidden ? 403 : 400,
        validated.forbidden ? 'FORBIDDEN' : 'BAD_REQUEST',
        validated.error,
      );
    }
    const reasoningDenial = authorizeReasoningEgress({
      policy: proxyBody.reasoningExecution,
      routeKind: 'proxy',
      provider: 'google',
      resolvedBaseUrl: effectiveBaseUrl,
      model,
    });
    if (reasoningDenial) return sendReasoningEgressDenial(res, reasoningDenial);

    const url = googleStreamGenerateContentUrl(effectiveBaseUrl, model);
    console.log(
      `[proxy:google] ${req.method} ${validated.parsed!.hostname} model=${model}`,
    );

    return runGeminiChatStream(res, {
      url,
      headers: { 'x-goog-api-key': apiKey },
      payload: buildGeminiChatPayload(systemPrompt, messages, maxTokens),
      model,
      logTag: 'proxy:google',
    });
  });

  app.post('/api/proxy/:provider/stream', (req, res) => {
    const proxyBody = req.body || {};
    const provider = typeof req.params.provider === 'string' ? req.params.provider : 'unknown';
    const reasoningDenial = authorizeReasoningEgress({
      policy: proxyBody.reasoningExecution,
      routeKind: 'proxy',
      provider,
      resolvedBaseUrl: typeof proxyBody.baseUrl === 'string' ? proxyBody.baseUrl : undefined,
      model: typeof proxyBody.model === 'string' ? proxyBody.model : undefined,
    });
    if (reasoningDenial) return sendReasoningEgressDenial(res, reasoningDenial);
    return sendApiError(res, 404, 'NOT_FOUND', 'unknown proxy provider');
  });

}
