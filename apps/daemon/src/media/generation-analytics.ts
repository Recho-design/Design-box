import type { MediaGenerationResultProps } from '@open-design/contracts';

import type { AnalyticsContext } from '../analytics.js';
import type { ImageGenerationRequestSummary } from './image-generation-retry.js';

/**
 * 媒体生成的埋点身份与结果上报。
 *
 * 从 `routes/media.ts` 的 registrar 闭包里提出来，是因为 Playground 没有 Run：
 * 它必须走**同一套** standalone 身份回退与同一个 `media_generation_result`
 * 事件，否则「本地 UI / CLI 直接生成」会变成一个观测盲区，而两条路径的计数
 * 也就没法相加。
 */

/** 组装 props 需要的、调用方必须给全的那一份入参。 */
export interface MediaGenerationResultInput {
  analyticsContext: AnalyticsContext;
  durationMs: number;
  meta?: { providerError?: string | null; usedStubFallback?: boolean };
  model: string;
  projectId: string;
  providerRequestSummary: ImageGenerationRequestSummary & { providerId: string };
  runId?: string;
  surface: 'image' | 'video';
  taskId: string;
}

/**
 * 解析这次请求的埋点身份，顺序即优先级：
 *
 * 1. 请求自带的浏览器上下文（本地 UI 发起的生成）。
 * 2. 父 Run 的上下文（agent 工具调用）。
 * 3. daemon 自己的安装身份（`od media generate` / Playground 这类无 Run 的
 *    standalone 调用），只在用户显式同意 metrics 之后才返回。
 */
export async function resolveMediaAnalyticsContext(input: {
  req: any;
  design: any;
  runId?: string | undefined;
  readAppConfig: (dataDir: string) => Promise<any>;
  runtimeDataDir: string;
}): Promise<AnalyticsContext | null> {
  const requestContext = input.design.readAnalyticsContext(input.req);
  if (requestContext) return requestContext;

  const runContext = input.runId
    ? input.design.runs.get(input.runId)?.analyticsContext ?? null
    : null;
  if (runContext) return runContext;

  return await standaloneAnalyticsIdentity(input);
}

/**
 * 无 Run 的 daemon 内部身份，与 updater 的回落保持一致。
 *
 * 只有 `telemetry.metrics === true` 且拿到安装 id 时才给身份；`capture()`
 * 在发送前会再查一次同一份同意，这里只是不要凭空造一个身份。
 */
async function standaloneAnalyticsIdentity(input: {
  readAppConfig: (dataDir: string) => Promise<any>;
  runtimeDataDir: string;
}): Promise<AnalyticsContext | null> {
  const appConfig = await input.readAppConfig(input.runtimeDataDir).catch(() => null);
  const installationId =
    appConfig?.telemetry?.metrics === true
    && typeof appConfig.installationId === 'string'
    && appConfig.installationId
      ? appConfig.installationId
      : null;
  if (!installationId) return null;
  return {
    deviceId: installationId,
    sessionId: installationId,
    clientType: 'desktop',
    locale: 'en',
    requestId: null,
  };
}

/**
 * 上报一次 provider 提交的最终结果。best-effort：埋点失败绝不能改变生成结局。
 *
 * `insertId` 用 taskId（Playground 传 generation id）去重，所以同一行历史重复
 * 上报不会变成两个事件。
 */
export function captureMediaGenerationResult(
  design: { analytics: { capture: (input: any) => void }; getAppVersion: () => string },
  input: MediaGenerationResultInput,
): void {
  try {
    design.analytics.capture({
      eventName: 'media_generation_result',
      context: input.analyticsContext,
      appVersion: design.getAppVersion(),
      properties: mediaGenerationResultProps(input),
      insertId: `media_generation_result:${input.taskId}`,
    });
  } catch {
    // Analytics is best-effort and must not change the media task outcome.
  }
}

/** 结果事件的完整 props（不含 prompt / 响应体 / 凭据 / 输出路径）。 */
function mediaGenerationResultProps(
  input: MediaGenerationResultInput,
): MediaGenerationResultProps {
  const summary = input.providerRequestSummary;
  return {
    page_name: 'studio',
    area: 'media_generation',
    project_id: input.projectId,
    task_id: input.taskId,
    ...(input.runId ? { run_id: input.runId } : {}),
    surface: input.surface,
    provider_id: summary.providerId,
    model_id: input.model,
    result: input.meta && !input.meta.providerError && !input.meta.usedStubFallback
      ? 'success'
      : 'failed',
    ...providerRetryProps(summary),
    attempt_count: summary.attemptCount,
    retry_count: summary.retryCount,
    retry_final_result: summary.retryFinalResult,
    duration_ms: Math.max(0, input.durationMs),
    used_stub_fallback: input.meta?.usedStubFallback === true,
  } satisfies MediaGenerationResultProps;
}

/** 只在上游确实给出时才出现的重试/状态字段。 */
function providerRetryProps(
  summary: ImageGenerationRequestSummary & { providerId: string },
): Pick<
  MediaGenerationResultProps,
  | 'initial_response_status'
  | 'response_status'
  | 'retry_reason'
  | 'retry_after_ms'
  | 'retry_delay_ms'
> {
  return {
    ...(summary.initialResponseStatus !== undefined
      ? { initial_response_status: summary.initialResponseStatus }
      : {}),
    ...(summary.responseStatus !== undefined
      ? { response_status: summary.responseStatus }
      : {}),
    ...(summary.retryReason ? { retry_reason: summary.retryReason } : {}),
    ...(summary.retryAfterMs !== undefined
      ? { retry_after_ms: summary.retryAfterMs }
      : {}),
    ...(summary.retryDelayMs !== undefined
      ? { retry_delay_ms: summary.retryDelayMs }
      : {}),
  };
}
