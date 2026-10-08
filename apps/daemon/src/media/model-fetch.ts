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

// Mirrors renderCustomOpenAIImage (media/index.ts), which omits the
// Authorization header and lets keyless local endpoints answer. Without this
// the same provider would generate images without a key but refuse to list its
// models, so the two entry points would disagree about whether it has
// credentials at all.
const KEYLESS_MODEL_FETCH_PROVIDERS = new Set(['custom-image']);

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
  // except the keyless-generation family above: there the request goes out
  // without an Authorization header and the upstream answers 401 by itself if
  // it does want a key.
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
