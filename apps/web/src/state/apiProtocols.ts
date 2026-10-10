// Shared metadata for the six API protocols the BYOK pickers offer.
//
// Originally these tables lived inline in `SettingsDialog.tsx`. The
// memory-extraction picker needs the exact same lists (so it can mirror
// the chat picker's protocol tabs / API key placeholders) — extracting
// them here keeps the two pickers from drifting apart whenever someone
// adds a new quick-fill provider.
//
// There is deliberately **no suggested-model table**: model drop-downs show
// only what `/api/provider/models` actually returns (see
// `components/providerModelsCache.ts`), plus whatever the user types by
// hand. A curated static list used to live here and made the pickers
// advertise models the daemon could not necessarily reach.

import type { ApiProtocol } from '../types';

// "Fast / cheap" model recommendation for each protocol. Used by the
// memory extractor's auto-mode pill ("we'll quietly run gpt-4o-mini on
// your OpenAI key") and by anyone else who needs a one-pick default
// that prioritises latency + cost over reasoning depth.
//
// Kept in sync with the daemon's `PROVIDER_DEFAULTS` in
// `apps/daemon/src/memory-llm.ts` — `custom` has no default at all, so it
// carries an empty string and callers must treat it as "user must pick".
export const FAST_MODEL_BY_PROTOCOL: Record<ApiProtocol, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o-mini',
  google: 'gemini-3.5-flash',
  deepseek: 'deepseek-chat',
  xai: 'grok-4',
  custom: '',
};

export const API_PROTOCOL_TABS: ReadonlyArray<{
  id: ApiProtocol;
  title: string;
}> = [
  { id: 'anthropic', title: 'Anthropic' },
  { id: 'openai', title: 'OpenAI' },
  { id: 'google', title: 'Google Gemini' },
  { id: 'deepseek', title: 'DeepSeek' },
  { id: 'xai', title: 'xAI' },
  { id: 'custom', title: 'Custom' },
];

export const API_PROTOCOL_LABELS: Record<ApiProtocol, string> = {
  anthropic: 'Anthropic API',
  openai: 'OpenAI API',
  google: 'Google Gemini',
  deepseek: 'DeepSeek API',
  xai: 'xAI API',
  custom: 'Custom (OpenAI-compatible)',
};

export const API_KEY_PLACEHOLDERS: Record<ApiProtocol, string> = {
  anthropic: 'sk-ant-...',
  openai: 'sk-...',
  google: 'AIza... or AQ....',
  deepseek: 'sk-...',
  xai: 'xai-...',
  custom: 'API key',
};

// Default base URL the daemon assumes when the user leaves the field
// blank. Kept here so the BYOK form can render it as a placeholder
// hint and keep the two surfaces (form vs. daemon) in sync. `custom` is
// deliberately empty: an OpenAI-compatible endpoint with no canonical
// origin, so the user must type one.
export const DEFAULT_BASE_URL_BY_PROTOCOL: Record<ApiProtocol, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  deepseek: 'https://api.deepseek.com',
  xai: 'https://api.x.ai/v1',
  custom: '',
};
