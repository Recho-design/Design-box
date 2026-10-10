import type { AppConfigPrefs, ProxyPrefs } from '@open-design/contracts';
import { MEDIA_PROVIDERS } from '../media/models';
import { isOpenAICompatible } from '../providers/openai-compatible';
import type {
  ApiProtocol,
  ApiProtocolConfig,
  AppConfig,
  MediaProviderCredentials,
  NotificationsConfig,
  OrbitConfig,
  PetConfig,
} from '../types';
import {
  DEFAULT_ACCENT_COLOR,
  FORCED_APP_THEME,
  normalizeAccentColor,
  resolveAppTheme,
} from './appearance';
import {
  DEFAULT_FAILURE_SOUND_ID,
  DEFAULT_SUCCESS_SOUND_ID,
} from '../utils/notifications';
import { randomUUID } from '../utils/uuid';

const STORAGE_KEY = 'open-design:config';
const CONFIG_MIGRATION_VERSION = 3;
// Accent values that were the SHIPPED DEFAULT in an earlier build and were
// persisted verbatim into every install's config. None of them is offered in
// ACCENT_SWATCHES anymore, so a config still carrying one is a leftover
// default rather than a deliberate choice — the migration resets it to the
// current default. (v2 covered the green era; v3 adds the older brick one,
// which kept long-lived installs off the #5517 accent.) Keep this list in
// sync with the pre-hydration script in app/layout.tsx.
const LEGACY_DEFAULT_ACCENT_COLORS = ['#87ea5c', '#c96442'];
const RETIRED_SECURE_BYOK_KEYS = [
  'byokProfileId',
  'byokCredentialConfigured',
  'byokCredentialTail',
] as const;

// Hatched out of the box, but tucked away — the user has to go through
// either the entry-view "adopt a pet" callout or Settings → Pets to
// summon them. Keeps the workspace quiet for first-run users.
// Completion feedback is useful precisely when a task finishes out of focus,
// so new installs opt in by default. Explicit saved opt-outs still win through
// normalizeNotifications' field merge below.
export const DEFAULT_NOTIFICATIONS: NotificationsConfig = {
  soundEnabled: true,
  successSoundId: DEFAULT_SUCCESS_SOUND_ID,
  failureSoundId: DEFAULT_FAILURE_SOUND_ID,
  desktopEnabled: true,
};

export const DEFAULT_PET: PetConfig = {
  adopted: false,
  enabled: false,
  petId: 'mochi',
  custom: {
    name: 'Buddy',
    glyph: '🦄',
    accent: '#353535',
    greeting: 'Hi! I am here whenever you need me.',
  },
};

export const DEFAULT_ORBIT: OrbitConfig = {
  enabled: false,
  time: '08:00',
  // Ship with the general-purpose Orbit briefing skill pre-selected so a
  // fresh install runs against a real adaptive template instead of the
  // bare built-in prompt. Users can clear it from Settings → Orbit to fall
  // back to the built-in prompt or pick another scenario === 'orbit' skill.
  templateSkillId: 'orbit-general',
};

export const DEFAULT_CONFIG: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  // New configs should be explicit. loadConfig() still detects parsed legacy
  // saved configs that did not have this field and migrates those from their
  // saved baseUrl/model before applying the current migration version.
  apiProtocol: 'anthropic',
  apiVersion: '',
  apiProtocolConfigs: {},
  configMigrationVersion: CONFIG_MIGRATION_VERSION,
  apiProviderBaseUrl: 'https://api.anthropic.com',
  agentId: null,
  skillId: null,
  designSystemId: null,
  onboardingCompleted: false,
  theme: FORCED_APP_THEME,
  accentColor: DEFAULT_ACCENT_COLOR,
  mediaProviders: {},
  composio: {},
  agentModels: {},
  agentCliEnv: {},
  agentCliEnvIntent: {},
  proxyPrefs: { enabled: false, url: '', noProxy: '' },
  pet: DEFAULT_PET,
  notifications: DEFAULT_NOTIFICATIONS,
  orbit: DEFAULT_ORBIT,
  projectLocations: [],
  defaultProjectLocationId: 'default',
  // Telemetry defaults to ON so fresh-install users emit onboarding /
  // ui_click events from the first frame. The disclosure modal still
  // appears after `onboardingCompleted` flips, and Settings → Privacy
  // remains the one-click opt-out. Without these defaults the gate at
  // `daemon/src/analytics.ts` (`if (telemetry?.metrics !== true) return`)
  // dropped every event fired during onboarding because no consent
  // existed yet — observed live on the prerelease.10 QA run, which left
  // zero `page_view pn=onboarding` rows on PostHog despite the user
  // completing the flow.
  telemetry: { metrics: true, content: true },
};

/** Well-known providers with pre-filled base URLs. */
export interface KnownProvider {
  label: string;
  protocol: ApiProtocol;
  baseUrl: string;
  /** Ranked provider-owned preferences, matched against the live account catalogue. */
  preferredModels: string[];
  /** Model ids that OpenDesign previously preselected but the provider retired. */
  retiredModels?: string[];
  /** Optional provider-specific key console link shown in Settings. */
  apiKeyConsoleLink?: { host: string; url: string };
  /** Some local/self-hosted endpoints do not require bearer credentials. */
  requiresApiKey?: boolean;
}

// First-party native providers and local runtime endpoint presets (vLLM).
// DeepSeek exposes both Anthropic-compatible (/v1/messages) and native
// DeepSeek gateways, kept separate so Settings UI can scope quick-fill presets
// and model suggestions to the selected protocol.
// Third-party aggregators and cloud platforms are configured via custom protocol.
//
// Preferred model lists are hand-curated from provider docs/current public
// presets and are reconciled with the live account catalogue before automatic
// selection. They are not a replacement for provider model discovery.
export const KNOWN_PROVIDERS: KnownProvider[] = [
  {
    label: 'Anthropic (Claude)',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    preferredModels: ['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5'],
  },
  {
    label: 'DeepSeek — Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.deepseek.com/anthropic',
    preferredModels: [
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ],
    retiredModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    preferredModels: ['gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'],
  },
  {
    label: 'Google Gemini',
    protocol: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com',
    preferredModels: [
      'gemini-3.5-flash',
      'gemini-3.1-pro-preview',
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ],
  },
  {
    label: 'DeepSeek',
    protocol: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    preferredModels: [
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ],
    retiredModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    label: 'xAI',
    protocol: 'xai',
    baseUrl: 'https://api.x.ai/v1',
    preferredModels: ['grok-4', 'grok-3', 'grok-3-mini'],
  },
  {
    label: 'vLLM',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:8000/v1',
    preferredModels: ['model', 'llama3', 'qwen3'],
    requiresApiKey: false,
  },
];

export function defaultKnownProviderModel(
  provider: Pick<KnownProvider, 'preferredModels'> | null | undefined,
): string {
  return provider?.preferredModels[0]?.trim() ?? '';
}

export interface ByokProviderPresetConfig {
  id: string;
  title: string;
  protocol: ApiProtocol;
  baseUrl: string;
  preferredModels: readonly string[];
}

const BYOK_PROVIDER_PRESET_SPECS = [
  { id: 'anthropic', title: 'Anthropic', providerLabel: 'Anthropic (Claude)' },
  { id: 'openai', title: 'OpenAI', providerLabel: 'OpenAI' },
  { id: 'google-ai-studio', title: 'Google Gemini', providerLabel: 'Google Gemini' },
  { id: 'deepseek', title: 'DeepSeek', providerLabel: 'DeepSeek' },
  { id: 'xai', title: 'xAI', providerLabel: 'xAI' },
  { id: 'vllm', title: 'vLLM', providerLabel: 'vLLM' },
] as const;

export const BYOK_PROVIDER_PRESETS: ReadonlyArray<ByokProviderPresetConfig> =
  BYOK_PROVIDER_PRESET_SPECS.map(({ id, title, providerLabel }) => {
    const provider = KNOWN_PROVIDERS.find((item) => item.label === providerLabel);
    if (!provider) {
      throw new Error(`Missing known provider for BYOK preset: ${providerLabel}`);
    }
    return {
      id,
      title,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      preferredModels: provider.preferredModels,
    };
  });

function normalizePet(input: Partial<PetConfig> | undefined): PetConfig {
  if (!input) return { ...DEFAULT_PET, custom: { ...DEFAULT_PET.custom } };
  // Merge stored values onto defaults so newly-added fields land safely
  // when an older config is rehydrated.
  return {
    ...DEFAULT_PET,
    ...input,
    custom: { ...DEFAULT_PET.custom, ...(input.custom ?? {}) },
  };
}

function normalizeNotifications(
  input: Partial<NotificationsConfig> | undefined,
): NotificationsConfig {
  return { ...DEFAULT_NOTIFICATIONS, ...(input ?? {}) };
}

function normalizeOrbit(input: Partial<OrbitConfig> | undefined): OrbitConfig {
  const time = typeof input?.time === 'string' && isValidOrbitTime(input.time)
    ? input.time
    : DEFAULT_ORBIT.time;
  return { ...DEFAULT_ORBIT, ...(input ?? {}), time };
}

/**
 * 规范化本地存储里的全局代理偏好：字段逐个 coerce，未知形状回退到
 * 关闭态而不是丢弃整键，避免一次坏写入就清掉用户已填的代理地址。
 */
function normalizeProxyPrefs(input: unknown): ProxyPrefs | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  return {
    enabled: raw.enabled === true,
    url: typeof raw.url === 'string' ? raw.url : '',
    noProxy: typeof raw.noProxy === 'string' ? raw.noProxy : '',
  };
}

function isValidOrbitTime(time: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return false;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

// Retired chat protocol: saved configs from builds that still offered AWS
// Bedrock carry `apiProtocol: 'bedrock'` (and sometimes an `apiProtocolConfigs`
// slot for it). Neither is part of `ApiProtocol` any more, so the runtime check
// below is cast rather than typed — it only ever fires on stale localStorage
// data, never on a config this build wrote. The Bedrock *host* is still
// recognised for the same reason: a saved base URL pointing at
// `bedrock-runtime.*.amazonaws.com` must be pulled back to a supported
// protocol instead of being sent to the Anthropic proxy.
function isBedrockRuntimeBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return (
      /^bedrock-runtime(?:-fips)?[.-].*\.amazonaws\.com(?:\.cn)?$/.test(hostname)
      || /^bedrock-runtime(?:-fips)?[.-].*\.api\.aws$/.test(hostname)
    );
  } catch {
    return false;
  }
}

function downgradeUnsupportedChatProtocol(config: AppConfig): boolean {
  const staleProtocol = config.apiProtocol as string | undefined;
  if (staleProtocol !== 'bedrock' && !isBedrockRuntimeBaseUrl(config.baseUrl)) {
    return false;
  }

  config.apiProtocol = DEFAULT_CONFIG.apiProtocol;
  config.apiKey = DEFAULT_CONFIG.apiKey;
  config.apiVersion = DEFAULT_CONFIG.apiVersion;
  config.baseUrl = DEFAULT_CONFIG.baseUrl;
  config.model = DEFAULT_CONFIG.model;
  config.apiProviderBaseUrl = DEFAULT_CONFIG.apiProviderBaseUrl;
  const protocolConfigs = config.apiProtocolConfigs as
    | Record<string, unknown>
    | undefined;
  if (protocolConfigs) delete protocolConfigs.bedrock;
  return true;
}

function inferApiProtocol(model: string, baseUrl: string): ApiProtocol {
  try {
    // `isOpenAICompatible` reads the model id and the origin together, so the
    // four OpenAI-wire protocols (openai / deepseek / xai / custom) all settle
    // on `openai` here and the user re-picks the exact one in Settings. The
    // per-vendor defaults live in `DEFAULT_BASE_URL_BY_PROTOCOL` and in the
    // daemon's own protocol tables.
    return isOpenAICompatible(model, baseUrl) ? 'openai' : 'anthropic';
  } catch {
    // Preserve the rest of the user's settings even if an old saved base URL is
    // malformed enough for URL parsing to throw. Anthropic is the safest default
    // because it matches the original built-in provider.
    return 'anthropic';
  }
}

function migrateRetiredKnownProviderModel(
  protocol: ApiProtocol,
  config: Pick<
    ApiProtocolConfig,
    'baseUrl' | 'model' | 'apiProviderBaseUrl'
  >,
): boolean {
  const provider = KNOWN_PROVIDERS.find((candidate) =>
    candidate.protocol === protocol &&
    (
      candidate.baseUrl === config.apiProviderBaseUrl ||
      candidate.baseUrl === config.baseUrl
    ),
  );
  if (!provider?.retiredModels?.includes(config.model)) return false;
  const replacement = defaultKnownProviderModel(provider);
  if (!replacement || replacement === config.model) return false;
  config.model = replacement;
  return true;
}

export function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        ...DEFAULT_CONFIG,
        pet: normalizePet(DEFAULT_PET),
        notifications: normalizeNotifications(DEFAULT_NOTIFICATIONS),
        orbit: normalizeOrbit(DEFAULT_ORBIT),
      };
    }
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    // Strip daemon-owned privacy fields if a stale localStorage payload
    // still carries them. Older builds wrote these to localStorage; we
    // now treat the daemon as authoritative so the user can rotate /
    // revoke without leaving residue in browser storage.
    for (const key of DAEMON_OWNED_KEYS) {
      delete (parsed as Record<string, unknown>)[key];
    }
    for (const key of RETIRED_SECURE_BYOK_KEYS) {
      delete (parsed as Record<string, unknown>)[key];
    }
    const parsedHasApiProtocol = Object.prototype.hasOwnProperty.call(
      parsed,
      'apiProtocol',
    );
    const merged: AppConfig = {
      ...DEFAULT_CONFIG,
      ...parsed,
      apiProtocolConfigs: { ...(parsed.apiProtocolConfigs ?? {}) },
      mediaProviders: { ...(parsed.mediaProviders ?? {}) },
      composio: { ...(parsed.composio ?? {}) },
      agentModels: { ...(parsed.agentModels ?? {}) },
      agentCliEnv: { ...(parsed.agentCliEnv ?? {}) },
      agentCliEnvIntent: { ...(parsed.agentCliEnvIntent ?? {}) },
      proxyPrefs: normalizeProxyPrefs(parsed.proxyPrefs),
      accentColor: normalizeAccentColor(parsed.accentColor) ?? DEFAULT_CONFIG.accentColor,
      // Coerce on read, not just on default: the theme setting is gone, but
      // 'dark' / 'system' is still on disk in every install that ever used it.
      theme: resolveAppTheme(parsed.theme),
      pet: normalizePet(parsed.pet),
      notifications: normalizeNotifications(parsed.notifications),
      orbit: normalizeOrbit(parsed.orbit),
    };
    // A stored `dark` / `system` theme is dead data now that the app ships
    // light-only. Flag it so the coerced value is written back once and the old
    // preference stops existing on disk, instead of being re-coerced forever.
    let migratedConfig = parsed.theme != null && parsed.theme !== FORCED_APP_THEME;
    const parsedMigrationVersion =
      typeof parsed.configMigrationVersion === 'number'
        ? parsed.configMigrationVersion
        : 0;
    if (parsedMigrationVersion !== CONFIG_MIGRATION_VERSION) {
      // Migration v1: configs saved before apiProtocol existed need an explicit
      // protocol so old OpenAI-compatible endpoints keep routing correctly.
      // This is version-gated instead of only field-gated so a later imported
      // legacy config can be migrated when it is loaded.
      if (parsedMigrationVersion < 1 && !parsedHasApiProtocol) {
        merged.apiProtocol = inferApiProtocol(merged.model, merged.baseUrl);
        // Also set apiProviderBaseUrl so setApiProtocol() can correctly identify
        // whether the user is on a known provider and switch defaults appropriately.
        // null means "custom/unknown provider" so the protocol switch won't override
        // their custom base URL.
        const knownProvider = KNOWN_PROVIDERS.find(
          (p) => p.baseUrl === merged.baseUrl,
        );
        merged.apiProviderBaseUrl = knownProvider?.baseUrl ?? null;
      }

      const persistedAccent = normalizeAccentColor(parsed.accentColor);
      if (persistedAccent != null && LEGACY_DEFAULT_ACCENT_COLORS.includes(persistedAccent)) {
        merged.accentColor = DEFAULT_CONFIG.accentColor;
      }
      merged.configMigrationVersion = CONFIG_MIGRATION_VERSION;
    }

    // Retired provider defaults are data updates rather than config schema
    // changes. Apply them on every read so adding one does not require bumping
    // the migration version, and cover every saved BYOK slot so switching
    // protocols/providers cannot restore a stale id.
    const activeProtocol = merged.apiProtocol ?? inferApiProtocol(
      merged.model,
      merged.baseUrl,
    );
    migratedConfig = migrateRetiredKnownProviderModel(activeProtocol, merged)
      || migratedConfig;
    for (const [protocol, apiConfig] of Object.entries(
      merged.apiProtocolConfigs ?? {},
    )) {
      if (!apiConfig) continue;
      migratedConfig = migrateRetiredKnownProviderModel(
        protocol as ApiProtocol,
        apiConfig,
      ) || migratedConfig;
    }
    for (const [draftKey, draft] of Object.entries(
      merged.byokProviderConfigDrafts ?? {},
    )) {
      const separator = draftKey.indexOf(':');
      if (separator <= 0) continue;
      migratedConfig = migrateRetiredKnownProviderModel(
        draftKey.slice(0, separator) as ApiProtocol,
        draft.apiConfig,
      ) || migratedConfig;
    }

    const downgradedUnsupportedChatProtocol =
      downgradeUnsupportedChatProtocol(merged);

    if (migratedConfig || downgradedUnsupportedChatProtocol) {
      // Best-effort re-persist of the migrated / downgraded config. A localStorage
      // write failure here (quota exceeded, private-mode storage disabled) must not
      // fall through to the outer catch and discard the valid config we just
      // parsed — that would silently reset the user to defaults for the session.
      try {
        saveConfig(merged);
      } catch {
        // keep the parsed config even if it could not be written back
      }
    }

    return merged;
  } catch {
    return {
      ...DEFAULT_CONFIG,
      pet: normalizePet(DEFAULT_PET),
      notifications: normalizeNotifications(DEFAULT_NOTIFICATIONS),
      orbit: normalizeOrbit(DEFAULT_ORBIT),
    };
  }
}

interface PublicComposioConfigResponse {
  configured?: boolean;
  apiKeyTail?: string;
}

interface PublicMediaProviderConfigEntry {
  configured?: boolean;
  source?: string;
  apiKeyTail?: string;
  baseUrl?: string;
  model?: string;
}

interface PublicMediaProviderConfigResponse {
  providers?: Record<string, PublicMediaProviderConfigEntry>;
}

export type DaemonMediaProvidersFetchResult =
  | {
    status: 'ok';
    providers: AppConfig['mediaProviders'];
  }
  | {
    status: 'error';
  };

interface MediaProviderDaemonWriteEntry {
  apiKey?: string;
  preserveApiKey?: boolean;
  baseUrl?: string;
  model?: string;
}

interface MediaProviderDaemonWriteRequest {
  providers: Record<string, MediaProviderDaemonWriteEntry>;
  force: boolean;
}

function hasAnyDaemonManagedMediaProvider(
  providers: Record<string, MediaProviderCredentials> | null | undefined,
): boolean {
  if (!providers) return false;
  return Object.values(providers).some((entry) => isStoredMediaProviderEntryPresent(entry));
}

function hasRecoverableLocalMediaProviderFields(
  entry: MediaProviderCredentials | null | undefined,
): boolean {
  return Boolean(
    entry?.apiKey?.trim()
    || entry?.baseUrl?.trim()
    || entry?.model?.trim(),
  );
}

function isMarkerOnlyMediaProviderEntry(
  entry: MediaProviderCredentials | null | undefined,
): boolean {
  return isStoredMediaProviderEntryPresent(entry)
    && !hasRecoverableLocalMediaProviderFields(entry);
}

export function isStoredMediaProviderEntryPresent(
  entry: MediaProviderCredentials | null | undefined,
): boolean {
  return Boolean(
    entry?.apiKey?.trim()
    || entry?.baseUrl?.trim()
    || entry?.model?.trim()
    || entry?.apiKeyConfigured
    || entry?.apiKeyTail?.trim(),
  );
}

export function isStoredMediaProviderEntryEmpty(
  entry: MediaProviderCredentials | null | undefined,
): boolean {
  return !isStoredMediaProviderEntryPresent(entry);
}

function defaultBaseUrlForProvider(providerId: string): string {
  return MEDIA_PROVIDERS.find((provider) => provider.id === providerId)?.defaultBaseUrl ?? '';
}

export function buildMediaProvidersForDaemonSave(
  currentProviders: Record<string, MediaProviderCredentials> | undefined,
  daemonProviders: Record<string, MediaProviderCredentials> | null | undefined,
  options?: { force?: boolean },
): MediaProviderDaemonWriteRequest {
  const providers: Record<string, MediaProviderDaemonWriteEntry> = {};
  for (const [providerId, currentEntry] of Object.entries(currentProviders ?? {})) {
    const daemonEntry = daemonProviders?.[providerId];
    const apiKey = currentEntry?.apiKey?.trim() ?? '';
    const hasStoredKeyMarker = Boolean(
      currentEntry?.apiKeyTail?.trim()
      || daemonEntry?.apiKeyTail?.trim(),
    );
    const preserveApiKey = !apiKey && Boolean(
      currentEntry?.apiKeyConfigured
      && hasStoredKeyMarker,
    );
    const explicitBaseUrl =
      currentEntry?.baseUrl?.trim()
      || daemonEntry?.baseUrl?.trim()
      || '';
    const model = currentEntry?.model?.trim() || daemonEntry?.model?.trim() || '';
    if (!apiKey && !preserveApiKey && !explicitBaseUrl && !model) continue;
    const baseUrl = explicitBaseUrl || defaultBaseUrlForProvider(providerId);
    providers[providerId] = {
      ...(apiKey ? { apiKey } : {}),
      ...(preserveApiKey ? { preserveApiKey: true } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(model ? { model } : {}),
    };
  }
  return {
    providers,
    force: Boolean(options?.force),
  };
}

export async function fetchComposioConfigFromDaemon(): Promise<AppConfig['composio'] | null> {
  try {
    const response = await fetch('/api/connectors/composio/config');
    if (!response.ok) return null;
    const payload = await response.json() as PublicComposioConfigResponse;
    return {
      apiKey: '',
      apiKeyConfigured: Boolean(payload.configured),
      apiKeyTail: payload.apiKeyTail ?? '',
    };
  } catch {
    return null;
  }
}

export async function fetchMediaProvidersFromDaemon(): Promise<DaemonMediaProvidersFetchResult> {
  try {
    const response = await fetch('/api/media/config');
    if (!response.ok) return { status: 'error' };
    const payload = await response.json() as PublicMediaProviderConfigResponse;
    const rawProviders = payload.providers ?? {};
    const providers: AppConfig['mediaProviders'] = {};
    for (const [providerId, entry] of Object.entries(rawProviders)) {
      providers[providerId] = {
        apiKey: '',
        apiKeyConfigured: Boolean(entry?.configured),
        apiKeyTail: entry?.apiKeyTail ?? '',
        baseUrl: entry?.baseUrl ?? '',
        ...(typeof entry?.source === 'string' && entry.source.trim()
          ? { source: entry.source.trim() }
          : {}),
        ...(typeof entry?.model === 'string' && entry.model.trim()
          ? { model: entry.model.trim() }
          : {}),
      };
    }
    return {
      status: 'ok',
      providers,
    };
  } catch {
    return { status: 'error' };
  }
}

export async function syncComposioConfigToDaemon(
  config: AppConfig['composio'] | undefined,
): Promise<boolean> {
  const apiKey = config?.apiKey ?? '';
  const payload = {
    ...(apiKey.trim() || !config?.apiKeyConfigured ? { apiKey } : {}),
  };
  try {
    const response = await fetch('/api/connectors/composio/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Privacy-sensitive fields the user can revoke. We deliberately keep
// these out of localStorage so the daemon remains the single source of
// truth: clearing app-config.json (or rotating via "Delete my data")
// fully resets the install identity, with no residual cohort key
// silently sitting in browser storage where the user can't see it.
const DAEMON_OWNED_KEYS = new Set<keyof AppConfig>([
  'installationId',
  'telemetry',
  'privacyDecisionAt',
  'allowSilentUpdates',
]);

const AGENT_CLI_SECRET_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
]);

function sanitizeAgentCliEnv(agentCliEnv: AppConfig['agentCliEnv']): AppConfig['agentCliEnv'] {
  if (!agentCliEnv) return agentCliEnv;
  const sanitized: NonNullable<AppConfig['agentCliEnv']> = {};
  for (const [agentId, env] of Object.entries(agentCliEnv)) {
    const safeEnv = Object.fromEntries(
      Object.entries(env ?? {}).filter(([key]) => !AGENT_CLI_SECRET_ENV_KEYS.has(key)),
    );
    sanitized[agentId] = safeEnv;
  }
  return sanitized;
}

export function saveConfig(config: AppConfig): void {
  const sanitized: AppConfig = {
    ...config,
    agentCliEnv: sanitizeAgentCliEnv(config.agentCliEnv),
  };
  for (const key of DAEMON_OWNED_KEYS) {
    delete (sanitized as unknown as Record<string, unknown>)[key];
  }
  for (const key of RETIRED_SECURE_BYOK_KEYS) {
    delete (sanitized as unknown as Record<string, unknown>)[key];
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
}

/**
 * Onboarding completion is a one-way ratchet: once either side of the
 * local/daemon pair has recorded it, the merge keeps it.
 *
 * `onboardingCompleted` is written from two places that settle at different
 * times — localStorage flips the instant the user finishes the flow, while the
 * daemon copy arrives through an asynchronous `PUT /api/app-config` that can
 * lose a race or fail outright. So a daemon read may legitimately still say
 * `false` for a user who is already done, and the reverse (daemon `true`,
 * fresh/cleared localStorage) is equally normal.
 *
 * Letting the daemon's copy win unconditionally is not a cosmetic glitch: the
 * merged config is written straight back to BOTH stores, so a single stale read
 * permanently re-arms the first-run flow and the user meets onboarding on every
 * launch from then on.
 *
 * The one legitimate way back to `false` is the explicit reset (Settings → run
 * setup again), which writes `false` to both stores in the same gesture — so by
 * the time the next merge runs neither side claims completion and the ratchet
 * has nothing to hold. `buildPersistedConfig` applies the same rule on the
 * save path; this is its read-path counterpart.
 */
function ratchetOnboardingCompleted(
  local: AppConfig['onboardingCompleted'],
  daemon: AppConfigPrefs['onboardingCompleted'],
): AppConfig['onboardingCompleted'] {
  if (local === true || daemon === true) return true;
  return daemon != null ? daemon : local;
}

export function mergeDaemonConfig(
  localConfig: AppConfig,
  daemonConfig: AppConfigPrefs | null,
): AppConfig {
  const next = { ...localConfig };
  if (!daemonConfig) return next;

  next.onboardingCompleted = ratchetOnboardingCompleted(
    localConfig.onboardingCompleted,
    daemonConfig.onboardingCompleted,
  );
  if (daemonConfig.agentId !== undefined) {
    next.agentId = daemonConfig.agentId;
  }
  if (daemonConfig.skillId !== undefined) {
    next.skillId = daemonConfig.skillId;
  }
  if (daemonConfig.designSystemId !== undefined) {
    next.designSystemId = daemonConfig.designSystemId;
  }
  if (daemonConfig.agentModels) {
    next.agentModels = {
      ...(next.agentModels ?? {}),
      ...daemonConfig.agentModels,
    };
  }
  next.agentCliEnv = daemonConfig.agentCliEnv ?? {};
  next.agentCliEnvIntent = daemonConfig.agentCliEnvIntent ?? {};
  if (daemonConfig.proxyPrefs !== undefined) {
    next.proxyPrefs = daemonConfig.proxyPrefs ? { ...daemonConfig.proxyPrefs } : undefined;
  }
  if (daemonConfig.disabledSkills !== undefined) {
    next.disabledSkills = daemonConfig.disabledSkills;
  }
  if (daemonConfig.disabledDesignSystems !== undefined) {
    next.disabledDesignSystems = daemonConfig.disabledDesignSystems;
  }
  if (daemonConfig.orbit !== undefined) {
    next.orbit = normalizeOrbit(daemonConfig.orbit);
  }
  if (daemonConfig.installationId !== undefined) {
    next.installationId = daemonConfig.installationId;
  }
  if (daemonConfig.telemetry !== undefined) {
    next.telemetry = { ...daemonConfig.telemetry };
  }
  if (daemonConfig.privacyDecisionAt !== undefined) {
    next.privacyDecisionAt = daemonConfig.privacyDecisionAt;
  } else if (
    daemonConfig.installationId !== undefined ||
    daemonConfig.telemetry !== undefined
  ) {
    // One-shot migration for configs created before privacyDecisionAt
    // existed. If the daemon already has an id or telemetry prefs, the user
    // has resolved the first-run prompt and should not see it again.
    next.privacyDecisionAt = Date.now();
  }
  // Default-on reporting. Unless the user has explicitly opted out
  // (Settings → "Don't share", which persists telemetry.metrics === false
  // together with installationId: null), an install reports with the
  // product's default telemetry channels on and carries a stable
  // installationId. This is the single source of the "Opted out" state:
  // previously an upgraded or never-prompted install could sit with
  // telemetry on but no id (the daemon ships a metrics+content default but
  // never mints an id), which the Settings → Privacy field rendered as
  // "Opted out" even though the user never declined. We mint the id and
  // keep the default channels on so the displayed state matches the product
  // default — the same metrics+content surface the first-run banner's
  // "Share" choice enables (artifactManifest stays off, as it
  // does there).
  // This does NOT override an explicit opt-out: metrics === false short-
  // circuits the whole block, and any channel the user already turned off
  // is preserved via the nullish-coalesce.
  const explicitlyOptedOut = next.telemetry?.metrics === false;
  if (!explicitlyOptedOut && !next.installationId) {
    next.installationId = randomUUID();
    next.telemetry = {
      metrics: true,
      content: next.telemetry?.content ?? true,
      artifactManifest: next.telemetry?.artifactManifest ?? false,
    };
  }
  if (daemonConfig.allowSilentUpdates !== undefined) {
    next.allowSilentUpdates = daemonConfig.allowSilentUpdates;
  } else {
    delete next.allowSilentUpdates;
  }
  if (daemonConfig.customInstructions !== undefined) {
    next.customInstructions = daemonConfig.customInstructions ?? undefined;
  }
  if (daemonConfig.projectLocations !== undefined) {
    next.projectLocations = daemonConfig.projectLocations;
  }
  if (daemonConfig.defaultProjectLocationId !== undefined) {
    next.defaultProjectLocationId = daemonConfig.defaultProjectLocationId ?? 'default';
  }
  return next;
}

export function mergeDaemonMediaProviders(
  localConfig: AppConfig,
  daemonProviders: AppConfig['mediaProviders'] | null,
  options?: {
    preserveLocalProviderIds?: ReadonlySet<string>;
  },
): AppConfig {
  if (daemonProviders == null) {
    return { ...localConfig };
  }

  if (!hasAnyDaemonManagedMediaProvider(daemonProviders)) {
    return {
      ...localConfig,
      mediaProviders: Object.fromEntries(
        Object.entries(localConfig.mediaProviders ?? {}).filter(([, entry]) => !isMarkerOnlyMediaProviderEntry(entry)),
      ),
    };
  }

  const mediaProviders = { ...(localConfig.mediaProviders ?? {}) };
  for (const [providerId, daemonEntry] of Object.entries(daemonProviders ?? {})) {
    if (!isStoredMediaProviderEntryPresent(daemonEntry)) continue;
    const localEntry = mediaProviders[providerId];
    const preserveLocalPendingEdit = Boolean(
      options?.preserveLocalProviderIds?.has(providerId)
      && hasRecoverableLocalMediaProviderFields(localEntry),
    );
    mediaProviders[providerId] = preserveLocalPendingEdit
      ? { ...daemonEntry, ...localEntry }
      : { ...daemonEntry };
  }

  return {
    ...localConfig,
    mediaProviders,
  };
}

export function hasAnyConfiguredProvider(
  providers: Record<string, MediaProviderCredentials> | undefined,
): boolean {
  if (!providers) return false;
  return Object.values(providers).some((entry) => isStoredMediaProviderEntryPresent(entry));
}

export function shouldSyncLocalMediaProvidersToDaemon(
  localProviders: Record<string, MediaProviderCredentials> | undefined,
  daemonProviders: Record<string, MediaProviderCredentials> | null | undefined,
): boolean {
  return daemonProviders != null
    && Object.values(localProviders ?? {}).some((entry) => hasRecoverableLocalMediaProviderFields(entry))
    && !hasAnyDaemonManagedMediaProvider(daemonProviders);
}

export async function syncMediaProvidersToDaemon(
  providers: Record<string, MediaProviderCredentials> | undefined,
  options?: {
    force?: boolean;
    daemonProviders?: Record<string, MediaProviderCredentials> | null;
    throwOnError?: boolean;
  },
): Promise<void> {
  if (!providers) return;
  try {
    const payload = buildMediaProvidersForDaemonSave(
      providers,
      options?.daemonProviders,
      { force: options?.force },
    );
    const response = await fetch('/api/media/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Failed to sync media config (${response.status})`);
  } catch {
    if (options?.throwOnError) throw new Error('Media config save failed');
    // Daemon offline; localStorage keeps the user's copy for the next save.
  }
}

export async function fetchDaemonConfig(): Promise<AppConfigPrefs | null> {
  try {
    const res = await fetch('/api/app-config');
    if (!res.ok) return null;
    const data = await res.json();
    return data?.config ?? null;
  } catch {
    return null;
  }
}

export async function syncConfigToDaemon(
  config: AppConfig,
  options?: {
    throwOnError?: boolean;
    allowOnboardingReset?: boolean;
  },
): Promise<void> {
  const prefs: AppConfigPrefs = {
    ...(config.onboardingCompleted === true
      ? { onboardingCompleted: true }
      : options?.allowOnboardingReset
        ? { onboardingCompleted: false }
        : {}),
    agentId: config.agentId,
    agentModels: config.agentModels,
    agentCliEnv: config.agentCliEnv,
    agentCliEnvIntent: config.agentCliEnvIntent,
    proxyPrefs: config.proxyPrefs,
    skillId: config.skillId,
    designSystemId: config.designSystemId,
    disabledSkills: config.disabledSkills,
    disabledDesignSystems: config.disabledDesignSystems,
    orbit: normalizeOrbit(config.orbit),
    installationId: config.installationId,
    telemetry: config.telemetry,
    privacyDecisionAt: config.privacyDecisionAt,
    allowSilentUpdates: config.allowSilentUpdates,
    customInstructions: config.customInstructions ?? null,
    projectLocations: config.projectLocations ?? [],
    defaultProjectLocationId: config.defaultProjectLocationId ?? 'default',
  };
  try {
    const response = await fetch('/api/app-config', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        ...(prefs.orbit?.workspaceScope
          ? {
              'x-od-workspace-id': prefs.orbit.workspaceScope.workspaceId,
              'x-od-workspace-member-id': prefs.orbit.workspaceScope.workspaceMemberId,
            }
          : {}),
      },
      body: JSON.stringify(prefs),
    });
    if (!response.ok) throw new Error(`Failed to sync app config (${response.status})`);
  } catch (error) {
    if (options?.throwOnError) throw error;
    // Daemon offline; localStorage keeps the user's copy for the next save.
  }
}
