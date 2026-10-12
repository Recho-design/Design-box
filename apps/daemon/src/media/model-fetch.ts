// "Fetch models" for the Settings → Media provider panel.
//
// The browser never calls a provider's model catalogue itself: the API key
// lives in the daemon's media-config and the redirect/SSRF rules belong in one
// place, so the daemon makes the call and returns ids only. Providers opt in
// through `supportsModelFetch`, and the upstream origin always comes from the
// saved config (or the registry default) — never from the request — so this
// cannot be turned into an open proxy by editing a URL parameter.

import { resolveProviderConfig } from './config.js';
import { findProvider } from './models.js';

const MODEL_FETCH_TIMEOUT_MS = 15_000;

// The `openai` slot also carries user-supplied OpenAI-compatible endpoints
// (the former `custom-image` provider's job), and many of those — a local
// gateway, a proxy in front of a keyed upstream — need no Authorization
// header at all. Listing their models must not require a key the endpoint
// does not want: "no key configured" is a configuration the user may hold
// deliberately, not an error this endpoint should invent.
const KEYLESS_MODEL_FETCH_PROVIDERS = new Set(['openai']);

type JsonRecord = Record<string, unknown>;

export interface ProviderModelOption {
  id: string;
}

/**
 * An error the route should turn into `{ error: message }` at `status`.
 *
 * The status travels on the error rather than being re-derived from the
 * message in the route: matching on message text breaks the moment the wording
 * changes, and every failure of this endpoint must leave through the same
 * single-shape envelope (a 4xx/5xx pair with different bodies forces the client
 * to parse errors twice).
 */
function fetchError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object';
}

function readString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * List the model ids a configured provider exposes on its OpenAI-compatible
 * `GET {baseUrl}/models`. Throws with a `status` (400/404/502) when the
 * provider is not fetchable, is missing credentials, or the upstream fails.
 */
export async function fetchProviderModelOptions(
  projectRoot: string,
  providerId: string,
  options: { requestInit?: Pick<RequestInit, 'dispatcher'> } = {},
): Promise<ProviderModelOption[]> {
  const provider = findProvider(providerId);
  if (!provider || !provider.supportsModelFetch) {
    throw fetchError(404, 'model fetch not supported for this provider');
  }

  const credentials = await resolveProviderConfig(projectRoot, providerId);
  // Trailing slashes are stripped so a user-pasted `https://host/v1/` does not
  // produce `//models`, which some gateways route differently.
  const baseUrl = (credentials.baseUrl || provider.defaultBaseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw fetchError(400, `no base URL configured for ${providerId}`);
  }
  // `credentialsRequired: false` is the registry's explicit "this endpoint is
  // keyless"; everything else needs a key before we spend a request on it,
  // except the keyless-listing family above: there the request goes out
  // without an Authorization header and the upstream answers 401 by itself if
  // it does want a key. Note that this exemption is about LISTING only —
  // generation still requires a key (renderOpenAIImage's no-credential error),
  // so an OpenAI-compatible endpoint that serves models but not manifests
  // gets its models listed and a clear error on generation.
  if (
    provider.credentialsRequired !== false
    && !credentials.apiKey
    && !KEYLESS_MODEL_FETCH_PROVIDERS.has(providerId)
  ) {
    throw fetchError(400, `no API key configured for ${providerId}`);
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  // Only send a key when there is one: some keyless gateways reject an empty
  // `Authorization: Bearer ` outright rather than ignoring it.
  if (credentials.apiKey) headers.authorization = `Bearer ${credentials.apiKey}`;

  // nano-banana 的列模型面不止一个，所以它走自己的分支而不是下面那条单端点路径：
  // 官方 Google host 只提供 OpenAI 兼容的列模型端点（`/v1beta/openai/models`
  // ——注意认证仍是 Bearer，与生成用的原生端点吃 `x-goog-api-key` 不同），
  // 而用户自建网关既可能是 OpenAI 兼容代理也可能是 Gemini 原生面，从 URL 上
  // 分辨不出来，两个都要试（见 nanoBananaModelListCandidates）。
  if (providerId === 'nanobanana') {
    const ids = await fetchNanoBananaModelIds(baseUrl, headers, options.requestInit);
    return ids
      // Gemini 回的是全量模型表（文本、embedding 都在里面），而 `imagen-*`
      // 走 predict 而不是 generateContent，本 provider 两个都用不了：只留
      // 名字里带 image 且不是 imagen 的那些。筛完为空是合法结果——上游确实
      // 一个能用的 image 模型都没有时如实回空数组，不编一个模型出来。
      .filter((id) => /image/i.test(id) && !/imagen/i.test(id))
      // 与下面那条路径同一套字母序：两份列表喂的是同一个设置下拉框。
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((id) => ({ id }));
  }

  const resp = await fetch(`${baseUrl}/models`, {
    ...options.requestInit,
    method: 'GET',
    headers,
    // A redirect would carry the Authorization header to whatever host the
    // upstream points at, so treat one as a failure instead of following it.
    redirect: 'error',
    signal: AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw fetchError(502, `upstream models request failed with status ${resp.status}`);
  }

  let payload: unknown;
  try {
    payload = await resp.json();
  } catch {
    // A non-JSON body is the same class of problem as a JSON body in an
    // unknown shape, and gets the same answer.
    throw fetchError(502, 'unexpected upstream response');
  }
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw fetchError(502, 'unexpected upstream response');
  }

  return payload.data
    .map((row) => (isRecord(row) ? readString(row.id) : ''))
    .filter((id) => id.length > 0)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((id) => ({ id }));
}

// nano-banana 的默认 baseUrl 就是 Google 官方 host；用户可以在设置里把它换成
// 自建网关，那里两套列模型面（OpenAI 兼容 / Gemini 原生）都可能出现。
const NANOBANANA_OFFICIAL_HOST = 'generativelanguage.googleapis.com';

/** 把一份上游响应体读成 id 列表；`null` = 「不是这个形状」。 */
type ModelIdParser = (payload: unknown) => string[] | null;

/**
 * 一个「列模型」候选端点：URL + 它该回的形状。
 *
 * 形状跟着 URL 一起走，而不是让调用点在拿到响应后再判一次：nanobanana 的
 * 候选端点分属两套面，解析方式与端点是一一对应的。
 */
interface ModelListCandidate {
  url: string;
  parse: ModelIdParser;
}

/**
 * 按配置的 baseUrl 给出 nano-banana 要试的候选端点，数组顺序即尝试顺序。
 *
 * 官方 Google host 只有 `/v1beta/openai/models` 这一个列模型入口，没有可回退
 * 的第二候选；自建网关则两个都试：先试更常见的 OpenAI 兼容面，再退到 Gemini
 * 原生面（`{base}/models` 在原生面上是 404，而在代理上才是正解）。
 */
function nanoBananaModelListCandidates(baseUrl: string): ModelListCandidate[] {
  if (hostnameOf(baseUrl) === NANOBANANA_OFFICIAL_HOST) {
    return [{ url: `${baseUrl}/v1beta/openai/models`, parse: parseOpenAICompatibleModelIds }];
  }
  return [
    { url: `${baseUrl}/models`, parse: parseOpenAICompatibleModelIds },
    { url: `${baseUrl}/v1beta/models`, parse: parseGeminiModelIds },
  ];
}

/**
 * 依次尝试候选端点，返回第一个成功的列表。
 *
 * 非 2xx、形状不对、网络异常在调用点看来是同一件事——「这个候选没给出答案」，
 * 所以三种情况都继续试下一个；全部失败时抛**最后一步**的错误，错误信封里因此
 * 是最终那次尝试的真实原因，而不是第一个候选的。
 */
async function fetchNanoBananaModelIds(
  baseUrl: string,
  headers: Record<string, string>,
  requestInit?: Pick<RequestInit, 'dispatcher'>,
): Promise<string[]> {
  let lastError: Error & { status: number } = fetchError(502, 'unexpected upstream response');
  for (const candidate of nanoBananaModelListCandidates(baseUrl)) {
    try {
      return await requestModelIds(candidate, headers, requestInit);
    } catch (err) {
      // requestModelIds 只会抛 fetchError，这个收窄是它的调用契约。
      lastError = err as Error & { status: number };
    }
  }
  throw lastError;
}

/**
 * GET 一个候选端点并按它约定的形状取出 id。
 *
 * 四种失败都归一到 `fetchError(502, …)`：它们对调用点是同一个结论（这个候选
 * 没答上话），都必须能促成下一次尝试，而且无论哪一次最终抛出来，都还是这个
 * 端点唯一的错误信封，路由侧不需要按失败类型分叉。
 */
async function requestModelIds(
  candidate: ModelListCandidate,
  headers: Record<string, string>,
  requestInit?: Pick<RequestInit, 'dispatcher'>,
): Promise<string[]> {
  let resp: Response;
  try {
    resp = await fetch(candidate.url, {
      ...requestInit,
      method: 'GET',
      headers,
      // A redirect would carry the Authorization header to whatever host the
      // upstream points at, so treat one as a failure instead of following it.
      redirect: 'error',
      signal: AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    // 网络异常（DNS、连接被拒、超时）在这里就地收成 502 而不是原样上抛：它和
    // 上游回 5xx 对用户是同一件事，且换一个候选端点还可能成功。
    const detail = err instanceof Error ? err.message : String(err);
    throw fetchError(502, `upstream models request failed: ${detail}`);
  }
  if (!resp.ok) {
    throw fetchError(502, `upstream models request failed with status ${resp.status}`);
  }

  let payload: unknown;
  try {
    payload = await resp.json();
  } catch {
    // A non-JSON body is the same class of problem as a JSON body in an
    // unknown shape, and gets the same answer.
    throw fetchError(502, 'unexpected upstream response');
  }
  const ids = candidate.parse(payload);
  // `null` 与空数组不是一回事：空目录是上游的真实回答（照实回空），读不懂的
  // 响应体则是这个候选失败了，值得换下一个端点再试。
  if (!ids) {
    throw fetchError(502, 'unexpected upstream response');
  }
  return ids;
}

/** OpenAI 兼容的列模型形状：`{ data: [{ id }] }`。 */
function parseOpenAICompatibleModelIds(payload: unknown): string[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return null;
  return payload.data
    .map((row) => (isRecord(row) ? readString(row.id) : ''))
    .filter((id) => id.length > 0);
}

/**
 * Gemini 原生的列模型形状：`{ models: [{ name: 'models/<id>' }] }`。
 *
 * name 上的 `models/` 前缀只存在于这个面，剥掉才得到别处通用的裸 id（用户
 * 保存的模型名、以及 `:generateContent` 的 URL 用的都是裸 id）。
 */
function parseGeminiModelIds(payload: unknown): string[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.models)) return null;
  return payload.models
    .map((row) => (isRecord(row) ? readString(row.name).replace(/^models\//, '') : ''))
    .filter((id) => id.length > 0);
}

/** baseUrl 的 host；解析不了（用户手打坏了 URL）时回空串，按「不是官方域」处理。 */
function hostnameOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return '';
  }
}
