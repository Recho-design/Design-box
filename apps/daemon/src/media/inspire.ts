/**
 * 「灵感拓展」（media inspire）的 daemon 侧文本转译。
 *
 * 输入一段可选的基础描述 + 若干条抽象思路 id，调一个文本 LLM 把思路具象化
 * 为可直接用于图像生成的中文提示词。凭据解析沿用 media config 的
 * `resolveProviderConfig`（与生图同一个来源），调用形状照抄
 * `memory-llm.ts` 的 callOpenAI / callAnthropic / callGoogle。
 *
 * 这里不产出图片，也不落盘——纯函数式的一次远端调用。
 */

import {
  getInspireIdeaById,
  type InspireTranslateRequest,
  type InspireTranslateResponse,
} from '@open-design/contracts';
import { resolveProviderConfig } from './config.js';

/** 单次文本 LLM 调用的超时；转译是短任务，30 秒足够覆盖慢 provider。 */
const TEXT_LLM_TIMEOUT_MS = 30_000;

/**
 * 请求体校验失败（ideaIds 缺失 / 为空 / 含未知 id）。
 * `unknownIds` 由路由层拿来逐个报给调用方。
 */
class InspireRequestError extends Error {
  readonly unknownIds: string[];

  constructor(message: string, unknownIds: string[]) {
    super(message);
    this.name = 'InspireRequestError';
    this.unknownIds = unknownIds;
  }
}

/**
 * 没有任何可用文本 LLM 凭据（media config 无 openai key，环境变量也没有）。
 * 这是配置问题而非上游故障，路由层按 409 INSPIRE_LLM_UNAVAILABLE 回应。
 */
class InspireUnavailableError extends Error {
  constructor() {
    super('未配置可用的文本模型（Settings → Media 的 OpenAI 条目需有 apiKey，或设置 ANTHROPIC_API_KEY / GOOGLE_API_KEY）');
    this.name = 'InspireUnavailableError';
  }
}

/**
 * 上游 LLM 调用失败（非 2xx、网络错误、返回为空）。
 * 携带 `upstream`（openai / anthropic / google），路由层转 502。
 */
class InspireUpstreamError extends Error {
  readonly upstream: string;

  constructor(upstream: string, message: string) {
    super(`${upstream}: ${message}`);
    this.name = 'InspireUpstreamError';
    this.upstream = upstream;
  }
}

/**
 * 把思路翻译为可执行提示词的 system prompt。原文即接口的一部分——
 * 融合为一张图、不罗列条目、只输出提示词本身，都是前端与 CLI 共同依赖的行为。
 */
const INSPIRE_SYSTEM_PROMPT =
  '你是图像提示词专家。用户会给你一段基础描述（可能缺失）以及若干条抽象的设计变换思路。保留基础描述中的主体、动作与场景，把每条思路具象化为光线、色调、构图、材质、镜头等可执行的视觉元素，写成一段可直接用于图像生成的中文提示词。给出多条思路时融合为一张图的统一方案，思路冲突时自行调和取平衡，不要罗列条目。若已有参考图，侧重风格与氛围，不要重复描述参考图已有的构图。只输出最终提示词本身，不要任何多余话术、编号或说明，200 字以内。';

/** 校验请求体，并拼出发给文本 LLM 的 system / user 两条消息。 */
function buildInspireMessages(input: InspireTranslateRequest): {
  system: string;
  user: string;
} {
  // ideaIds 是唯一契约校验：至少一条，且每条都必须能在素材库里查到。
  // 未知 id 全部收集后一次性报出，而不是遇到第一个就停——前端一次就能改全。
  if (!Array.isArray(input.ideaIds) || input.ideaIds.length === 0) {
    throw new InspireRequestError('ideaIds must be a non-empty array of idea ids', []);
  }
  const unknownIds = [...new Set(input.ideaIds.filter((id) => !getInspireIdeaById(id)))];
  if (unknownIds.length > 0) {
    throw new InspireRequestError(
      `unknown idea ids: ${unknownIds.join(', ')}`,
      unknownIds,
    );
  }

  const lines: string[] = [];
  // prompt 为空（undefined / 空白）时省略基础描述行，此时扩展完全由思路驱动。
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (prompt) lines.push(`基础描述：${prompt}`);
  lines.push('变换思路：');
  for (const id of input.ideaIds) {
    const idea = getInspireIdeaById(id)!;
    lines.push(`- ${idea.label}：${idea.hint}`);
  }
  // 有参考图的场合 model 只负责风格与氛围，构图由参考图说了算。
  if (input.hasImage) lines.push('(已有参考图：侧重风格与氛围)');
  return { system: INSPIRE_SYSTEM_PROMPT, user: lines.join('\n') };
}

/** 照抄 memory-llm 的版本化路径拼接：baseUrl 已含 /vN 段时不重复拼 /v1。 */
function appendVersionedApiPath(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl);
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = /\/v\d+(\/|$)/.test(pathname) ? `${pathname}${suffix}` : `${pathname}/v1${suffix}`;
  return url.toString();
}

/** 上游非 2xx 时统一抛错，响应片段截断译文长度以防泄漏大段调试文本。 */
async function throwUpstreamHttpError(
  upstream: string,
  resp: Response,
): Promise<never> {
  const fragment = (await resp.text().catch(() => '')).slice(0, 300);
  throw new InspireUpstreamError(
    upstream,
    `HTTP ${resp.status}${fragment ? `: ${fragment}` : ''}`,
  );
}

/** 返回文本 trim 后为空同样视为上游错误——空提示词没有可用性。 */
function requireInspireText(upstream: string, text: string): string {
  const prompt = text.trim();
  if (!prompt) {
    throw new InspireUpstreamError(upstream, 'LLM returned an empty prompt');
  }
  return prompt;
}

/** ① media config 的 openai 条目（OpenAI 兼容 chat/completions 协议）。 */
async function callInspireOpenAI(projectRoot: string, system: string, user: string): Promise<string> {
  const provider = await resolveProviderConfig(projectRoot, 'openai');
  if (!provider.apiKey) return '';
  let resp: Response;
  try {
    resp = await fetch(
      appendVersionedApiPath(provider.baseUrl || 'https://api.openai.com/v1', '/chat/completions'),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model: provider.model || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(TEXT_LLM_TIMEOUT_MS),
      },
    );
  } catch (err) {
    throw new InspireUpstreamError('openai', err instanceof Error ? err.message : String(err));
  }
  if (!resp.ok) await throwUpstreamHttpError('openai', resp);
  const json: any = await resp.json();
  return requireInspireText('openai', String(json?.choices?.[0]?.message?.content ?? ''));
}

/** ② ANTHROPIC_API_KEY（Anthropic messages 协议，抓第一个 text block）。 */
async function callInspireAnthropic(system: string, user: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return '';
  let resp: Response;
  try {
    resp = await fetch(appendVersionedApiPath('https://api.anthropic.com/v1', '/messages'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-latest',
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(TEXT_LLM_TIMEOUT_MS),
    });
  } catch (err) {
    throw new InspireUpstreamError('anthropic', err instanceof Error ? err.message : String(err));
  }
  if (!resp.ok) await throwUpstreamHttpError('anthropic', resp);
  const json: any = await resp.json();
  const block = (Array.isArray(json?.content) ? json.content : []).find((b: any) => b?.type === 'text');
  return requireInspireText('anthropic', String(block?.text ?? ''));
}

/** ③ GOOGLE_API_KEY（Gemini generateContent，把各 part 的 text 拼接回来）。 */
async function callInspireGoogle(system: string, user: string): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return '';
  let resp: Response;
  try {
    resp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { role: 'system', parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
        }),
        signal: AbortSignal.timeout(TEXT_LLM_TIMEOUT_MS),
      },
    );
  } catch (err) {
    throw new InspireUpstreamError('google', err instanceof Error ? err.message : String(err));
  }
  if (!resp.ok) await throwUpstreamHttpError('google', resp);
  const json: any = await resp.json();
  const parts = json?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('')
    : '';
  return requireInspireText('google', text);
}

export interface InspireErrorCodes {
  isInspireRequestError: boolean;
  isInspireUnavailableError: boolean;
}

/**
 * 把 Inspire 内部错误翻译成路由层关心的三个判定：400 / 409 / 502。
 *
 * 用结构化对象而不是让路由层 import 错误类，routes/media.ts 只需要
 * 这一份判断；同类错误在这里统一升级为 502 语义。
 */
export function classifyInspireError(err: unknown): InspireErrorCodes {
  return {
    isInspireRequestError: err instanceof InspireRequestError,
    isInspireUnavailableError: err instanceof InspireUnavailableError,
  };
}

/**
 * 运行一次「灵感拓展」转译：思路 id → 中文图像提示词。
 *
 * @param input 请求体（prompt 可空，ideaIds 必须非空且全部合法）
 * @param projectRoot 项目根，用于解析 media config 的 openai 凭据
 * @returns 转译后的中文提示词
 */
export async function runInspireTranslate(
  input: InspireTranslateRequest,
  projectRoot: string,
): Promise<InspireTranslateResponse> {
  const { system, user } = buildInspireMessages(input);
  // 优先级即回退链：openai（media config，与生图共用凭据）→ 环境变量级
  // anthropic → google → 都没有时按「未配置」409。前两级返回空串表示
  // "没配凭据"，交给下一级；一旦有凭据，失败就是上游失败，不再回退。
  const prompt =
    (await callInspireOpenAI(projectRoot, system, user))
    || (await callInspireAnthropic(system, user))
    || (await callInspireGoogle(system, user));
  if (!prompt) throw new InspireUnavailableError();
  return { prompt };
}
