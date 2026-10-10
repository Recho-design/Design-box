import type { ApiProtocol, ProviderModelOption } from '../types';

export type ProviderModelsCache = Record<string, ProviderModelOption[]>;

function fingerprintSecret(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${value.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * Cache key for one `/api/provider/models` discovery result. The key names the
 * credentialed endpoint the list belongs to, so two protocols that share a
 * base URL never read each other's catalogue.
 *
 * There is no `apiVersion` component any more: none of the six protocols sends
 * an api-version query param (see `packages/contracts/src/api/providerModels.ts`).
 */
export function providerModelsCacheKey(
  protocol: ApiProtocol,
  baseUrl: string,
  apiKey: string,
): string {
  return [
    protocol,
    baseUrl.trim().replace(/\/+$/, ''),
    fingerprintSecret(apiKey.trim()),
  ].join('\n');
}

/**
 * Normalize a live `/api/provider/models` response into dropdown options.
 *
 * This deliberately takes **only** the fetched list: the pickers no longer
 * merge a hand-curated suggestion table on top, because that advertised model
 * ids the user's own key could not necessarily reach. An empty result means
 * "we could not fetch" and the caller shows the empty-state hint instead.
 */
export function mergeProviderModelOptions(
  fetchedModels: readonly ProviderModelOption[],
): ProviderModelOption[] {
  const seen = new Set<string>();
  const out: ProviderModelOption[] = [];
  for (const model of fetchedModels) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...model, id, label: model.label.trim() || id });
  }
  return out;
}
