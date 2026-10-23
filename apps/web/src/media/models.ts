/**
 * Single source of truth for the media-generation model registry.
 *
 * Both the frontend (NewProjectPanel model pickers, Settings dialog
 * provider list, Home media composer) and the daemon (od media generate
 * dispatcher) consume this registry. When you add a model entry here, the
 * picker shows it, the daemon can dispatch to it, and the Settings dialog
 * knows which API keys are needed.
 *
 * `apps/daemon/src/media/models.ts` is a hand-maintained mirror of this
 * file — the daemon avoids a TS toolchain at runtime. The two are kept in
 * sync by hand; drift is enforced by `node scripts/verify-media-models.mjs`
 * (`pnpm verify:media-models`), which compares the image / video model id
 * lists and the numeric length tables. Any model added here must be added
 * there too.
 *
 * The catalogue is the six providers the daemon actually ships a client
 * for (openai / grok / hyperframes / nanobanana / vertex / stub). The audio surface (music / speech / sfx) is gone: `MEDIA_SURFACES`
 * in `@open-design/contracts` is image + video only, `ProjectMetadata` no
 * longer carries the `audio*` fields, and the daemon has no audio
 * dispatcher to honour them.
 */

import type { MediaAspect } from '../types';

/**
 * Provider identifier — used both as a grouping key in the picker and as
 * the lookup key for API-credentials in `AppConfig.mediaProviders`. New
 * providers must be added to {@link MEDIA_PROVIDERS} below.
 */
export type MediaProviderId =
  | 'openai'
  | 'grok'
  | 'hyperframes'
  | 'nanobanana'
  | 'vertex'
  | 'stub';

export interface MediaProvider {
  id: MediaProviderId;
  /** Display name shown in Settings + ModelPicker headers. */
  label: string;
  /** Short marketing-style sub-label. */
  hint: string;
  /** Whether the daemon ships a real integration for this provider. */
  integrated: boolean;
  /** Whether the provider needs user-supplied credentials. */
  credentialsRequired?: boolean;
  /** Whether the provider should appear in Settings -> Media. */
  settingsVisible?: boolean;
  /** Default base URL the daemon hits when no override is configured. */
  defaultBaseUrl?: string;
  /** Documentation URL for getting an API key. */
  docsUrl?: string;
  /** Whether Settings should expose a custom model override field. */
  supportsCustomModel?: boolean;
  /** Placeholder text for custom model override fields in Settings. */
  customModelPlaceholder?: string;
  /** Whether Settings offers a "fetch models" button hitting the provider's OpenAI-compatible GET /models. */
  supportsModelFetch?: boolean;
}

/**
 * Catalogue of providers. The Settings dialog renders one section per
 * entry that is not `settingsVisible: false`; the new-project model
 * picker uses {@link integrated} to flag cards that will silently fall
 * back to a stub if the user hasn't configured a key.
 *
 * Hidden-but-integrated members:
 * - `hyperframes` — a local HTML -> MP4 renderer. There is nothing to
 *   configure, so it never gets a Settings card.
 * - `stub` — the daemon's deterministic offline fixture provider.
 */
export const MEDIA_PROVIDERS: MediaProvider[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    hint: 'gpt-image-2 / dall-e-3',
    integrated: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    docsUrl: 'https://platform.openai.com/api-keys',
    supportsModelFetch: true,
  },
  {
    id: 'grok',
    label: 'xAI Grok Imagine',
    hint: 'grok-imagine — image + video with native audio',
    integrated: true,
    defaultBaseUrl: 'https://api.x.ai/v1',
    docsUrl: 'https://docs.x.ai/developers/model-capabilities/video/generation',
    supportsModelFetch: true,
  },
  {
    id: 'hyperframes',
    label: 'HyperFrames',
    hint: 'Local HTML -> MP4 renderer',
    integrated: true,
    credentialsRequired: false,
    settingsVisible: false,
    docsUrl: 'https://hyperframes.heygen.com',
  },
  {
    id: 'nanobanana',
    label: 'Nano Banana',
    hint: 'Uses Google’s official API by default. You can also configure a custom gateway.',
    integrated: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/api-key',
    supportsCustomModel: true,
    supportsModelFetch: true,
  },
  {
    id: 'vertex',
    label: 'Vertex Express',
    hint: 'Google Vertex AI Express mode — Gemini image models with a plain API key.',
    integrated: true,
    defaultBaseUrl: 'https://aiplatform.googleapis.com',
    docsUrl: 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/express-mode/overview',
    supportsModelFetch: false,
    supportsCustomModel: true,
  },
  {
    id: 'stub',
    label: 'Stub (placeholder)',
    hint: 'Deterministic local placeholder bytes',
    integrated: true,
    // Internal fixture provider used by the daemon for deterministic
    // tests / offline demos. Hidden from Settings the same way
    // HyperFrames is — end users have nothing to configure here, and
    // exposing it pollutes the provider list.
    settingsVisible: false,
  },
];

export interface MediaModel {
  /** Stable ID used in metadata.imageModel / videoModel. */
  id: string;
  /** Short label shown in pickers. */
  label: string;
  /** Vendor / context hint shown under the label. */
  hint: string;
  /** Provider this model is dispatched through. */
  provider: MediaProviderId;
  /**
   * Capabilities the agent may rely on when planning. Used downstream by
   * the dispatcher to decide which provider call to make.
   */
  caps?: string[];
  /**
   * 原生 mask 局部重绘能力（画笔涂抹区域 + 指令 → 局部重绘）：只有标了它的
   * 模型能接受 `PlaygroundGenerateRequest.maskImage`，daemon 会把 mask 作为
   * `/images/edits` 的 multipart `mask` 字段发出去。
   *
   * 这个字段跟着 daemon 的实现走，不跟着厂商宣传走：目前只有 gpt-image 族有这条
   * 通路（openai 槽位）。grok 的 image API 只接了 `/images/generations`，
   * nanobanana 走 generateContent，两者都没有 mask 通路，因此不标——画笔 UI 据此
   * 禁用/提示「当前模型不支持画笔局部重绘」，而不是让请求落到 daemon 才拿到
   * `mask_unsupported`。两侧注册表（`apps/daemon/src/media/models.ts`）必须同步。
   */
  inpaintMask?: boolean;
  /** Marks the default-checked card per surface in the picker. */
  default?: boolean;
}

/** Image generation models. */
export const IMAGE_MODELS: MediaModel[] = [
  // OpenAI — fully integrated path.
  {
    id: 'gpt-image-2',
    label: 'gpt-image-2',
    hint: 'OpenAI · 4K, native multimodal',
    provider: 'openai',
    caps: ['t2i', 'i2i', 'inpaint'],
    inpaintMask: true,
    default: true,
  },
  {
    id: 'gpt-image-1.5',
    label: 'gpt-image-1.5',
    hint: 'OpenAI · 4× faster than gpt-image-1',
    provider: 'openai',
    caps: ['t2i', 'i2i', 'inpaint'],
    inpaintMask: true,
  },
  {
    id: 'gpt-image-1',
    label: 'gpt-image-1',
    hint: 'OpenAI · ChatGPT native',
    provider: 'openai',
    caps: ['t2i', 'i2i', 'inpaint'],
    inpaintMask: true,
  },
  {
    id: 'gpt-image-1-mini',
    label: 'gpt-image-1-mini',
    hint: 'OpenAI · low-cost variant',
    provider: 'openai',
    caps: ['t2i', 'i2i'],
  },
  {
    id: 'dall-e-3',
    label: 'dall-e-3',
    hint: 'OpenAI · classic',
    provider: 'openai',
    caps: ['t2i'],
  },
  {
    id: 'dall-e-2',
    label: 'dall-e-2',
    hint: 'OpenAI · legacy',
    provider: 'openai',
    caps: ['t2i'],
  },

  // xAI Grok Imagine — text-to-image (1k/2k, 11+ aspect ratios).
  {
    id: 'grok-imagine-image',
    label: 'grok-imagine-image',
    hint: 'xAI · 2K text-to-image',
    provider: 'grok',
    caps: ['t2i'],
    default: true,
  },

  // Nano Banana — Google-compatible generateContent image path.
  {
    id: 'gemini-3.1-flash-image-preview',
    label: 'nano-banana-2',
    hint: 'Nano Banana · text-to-image',
    provider: 'nanobanana',
    caps: ['t2i'],
  },

  // Vertex Express — API-key-only direct access to Vertex's
  // generateContent image path (publishers/google/models). Only the two
  // models verified against the live endpoint are registered;
  // gemini-3.1-flash-image-preview 404s there and is deliberately absent.
  {
    id: 'gemini-2.5-flash-image',
    label: 'gemini-2.5-flash-image',
    hint: 'Vertex Express · Gemini 2.5 Flash Image (t2i + i2i)',
    provider: 'vertex',
    caps: ['t2i', 'i2i'],
  },
  {
    id: 'gemini-3-pro-image',
    label: 'gemini-3-pro-image',
    hint: 'Vertex Express · Gemini 3 Pro Image (t2i + i2i)',
    provider: 'vertex',
    caps: ['t2i', 'i2i'],
  },
];

/** Video generation models. */
export const VIDEO_MODELS: MediaModel[] = [
  // xAI Grok Imagine — 720p t2v + i2v with natively generated audio.
  {
    id: 'grok-imagine-video',
    label: 'grok-imagine-video',
    hint: 'xAI · 720p t2v + i2v + native audio',
    provider: 'grok',
    caps: ['t2v', 'i2v', 'audio'],
    default: true,
  },

  // HyperFrames — local HTML -> MP4 renderer.
  {
    id: 'hyperframes-html',
    label: 'hyperframes-html',
    hint: 'HyperFrames · local HTML renderer',
    provider: 'hyperframes',
    caps: ['t2v'],
  },
];

export const MEDIA_ASPECTS: MediaAspect[] = ['1:1', '16:9', '9:16', '4:3', '3:4'];

export const VIDEO_LENGTHS_SEC: number[] = [3, 5, 8, 10, 15, 30];

export const DEFAULT_IMAGE_MODEL =
  IMAGE_MODELS.find((m) => m.default)?.id ?? IMAGE_MODELS[0]!.id;
export const DEFAULT_VIDEO_MODEL =
  VIDEO_MODELS.find((m) => m.default)?.id ?? VIDEO_MODELS[0]!.id;

/**
 * Legacy product ids the pickers and saved project metadata may still
 * carry. `nano-banana` / `nano-banana-2` used to resolve to the removed
 * OpenDesign Cloud route; they now point at the local Google Nano Banana
 * provider (which brings its own API key), while the Codex-era
 * `codex-gpt-image-2` id points at OpenAI BYOK, so an existing project's
 * metadata still resolves without dragging the user back onto a managed
 * cloud route.
 *
 * `nano-banana-2-lite` deliberately has no local equivalent and is NOT
 * registered: it stays unavailable rather than silently falling back to a
 * different model.
 */
const MEDIA_MODEL_ALIASES: Readonly<Record<string, string>> = {
  'nano-banana': 'gemini-3.1-flash-image-preview',
  'nano-banana-2': 'gemini-3.1-flash-image-preview',
  'codex-gpt-image-2': 'gpt-image-2',
};

export function canonicalMediaModelId(id: string): string {
  return MEDIA_MODEL_ALIASES[id] ?? id;
}

/**
 * A prompt template recommends a model family; it is not an explicit BYOK
 * provider choice. Template ids therefore travel through the alias table
 * (like every other id), so an existing project's metadata keeps resolving.
 */
export function imageModelIdForPromptTemplate(id: string): string {
  return canonicalMediaModelId(id.trim());
}

/**
 * Look up a model record across both surfaces by ID. Returns null if the
 * agent passes an unknown model — the dispatcher rejects with a clear
 * error so the agent re-plans instead of silently falling back.
 */
export function findMediaModel(id: string): MediaModel | null {
  const all: MediaModel[] = [...IMAGE_MODELS, ...VIDEO_MODELS];
  const canonicalId = canonicalMediaModelId(id);
  return all.find((m) => m.id === canonicalId) ?? null;
}

export function findProvider(id: MediaProviderId): MediaProvider | null {
  return MEDIA_PROVIDERS.find((p) => p.id === id) ?? null;
}

/**
 * Resolve the provider that owns a model id, or undefined for an unknown id.
 */
export function mediaModelProviderId(id: string): MediaProviderId | undefined {
  return findMediaModel(id)?.provider;
}

/**
 * 该目录模型能否接受画笔 mask（`PlaygroundGenerateRequest.maskImage`）。
 *
 * 与 daemon 侧同名函数是同一判定（`inpaintMask === true`）：画笔 UI 用它决定
 * 是否允许打开局部重绘，daemon 用同一份能力位回答 400 `mask_unsupported`，
 * 两侧因此不会出现「UI 允许、后端拒绝」。
 */
export function modelSupportsInpaintMask(id: string): boolean {
  return findMediaModel(id)?.inpaintMask === true;
}

/** All model IDs grouped by surface, used for prompt-side disclosure. */
export function modelIdsBySurface(): {
  image: string[];
  video: string[];
} {
  return {
    image: IMAGE_MODELS.map((m) => m.id),
    video: VIDEO_MODELS.map((m) => m.id),
  };
}

/**
 * Group a flat list of {@link MediaModel} by provider while preserving
 * the catalogue order. Used by the picker to render section headers.
 */
export function groupByProvider(models: MediaModel[]): Array<{
  provider: MediaProvider;
  models: MediaModel[];
}> {
  const order: MediaProviderId[] = [];
  const map = new Map<MediaProviderId, MediaModel[]>();
  for (const m of models) {
    if (!map.has(m.provider)) {
      order.push(m.provider);
      map.set(m.provider, []);
    }
    map.get(m.provider)!.push(m);
  }
  return order
    .map((id) => {
      const provider = findProvider(id);
      const list = map.get(id) ?? [];
      return provider ? { provider, models: list } : null;
    })
    .filter((entry): entry is { provider: MediaProvider; models: MediaModel[] } => entry != null);
}
