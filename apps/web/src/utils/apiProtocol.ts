import { isOpenAICompatible } from '../providers/openai-compatible';
import { API_PROTOCOL_LABELS } from '../state/apiProtocols';
import type { ApiProtocol, AppConfig } from '../types';
import { API_PROTOCOL_AGENT_IDS } from './byokProvider';

export function apiProtocolLabel(protocol: ApiProtocol | undefined): string {
  return API_PROTOCOL_LABELS[protocol ?? 'anthropic'];
}

export function apiProtocolModelLabel(
  protocol: ApiProtocol | undefined,
  model: string,
): string {
  const label = `${apiProtocolLabel(protocol)} via OpenCode`;
  const trimmed = model.trim();
  return trimmed ? `${label} · ${trimmed}` : label;
}

export function apiProtocolAgentId(protocol: ApiProtocol | undefined): string {
  return API_PROTOCOL_AGENT_IDS[protocol ?? 'anthropic'];
}

/**
 * Every protocol except `anthropic` speaks a non-Anthropic wire, so the
 * Anthropic proxy must never be reached for them. `deepseek` / `xai` /
 * `custom` are OpenAI-compatible by construction and would otherwise fall
 * through to the base-URL heuristic below and be misrouted at the
 * Anthropic proxy whenever the user typed a non-default origin.
 */
const NON_ANTHROPIC_PROTOCOLS: ReadonlySet<ApiProtocol> = new Set<ApiProtocol>([
  'openai',
  'google',
  'deepseek',
  'xai',
  'custom',
]);

export function usesAnthropicProxy(cfg: AppConfig): boolean {
  if (cfg.apiProtocol && NON_ANTHROPIC_PROTOCOLS.has(cfg.apiProtocol)) {
    return false;
  }
  if (!cfg.apiProtocol && isOpenAICompatible(cfg.model, cfg.baseUrl)) {
    return false;
  }
  return Boolean(cfg.baseUrl && cfg.baseUrl !== 'https://api.anthropic.com');
}

export function isAnthropicSupportedImagePath(path: string): boolean {
  const lower = path.toLowerCase();
  return /\.(jpe?g|png|gif|webp)$/.test(lower);
}
