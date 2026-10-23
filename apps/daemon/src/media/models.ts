// Daemon-side mirror of src/media/models.ts. The two files are kept in sync by hand — any model added to
// src/media/models.ts must be added here too. Drift is enforced by
// `node scripts/verify-media-models.mjs` (also exposed as
// `npm run verify:media-models`); CI should call it before publish so
// the moment one side adds a model and the other doesn't, the build
// fails with a precise diff.

export type MediaSurface = 'image' | 'video';

export type MediaProvider = {
  id: string;
  label: string;
  hint: string;
  integrated: boolean;
  defaultBaseUrl?: string;
  docsUrl?: string;
  credentialsRequired?: boolean;
  settingsVisible?: boolean;
  /** Whether Settings offers a "fetch models" button hitting the provider's OpenAI-compatible GET /models. */
  supportsModelFetch?: boolean;
  supportsCustomModel?: boolean;
  customModelPlaceholder?: string;
};

export type MediaModel = {
  id: string;
  label: string;
  hint: string;
  provider: string;
  caps: string[];
  /**
   * 原生 mask 局部重绘能力：渲染器会把 mask 作为 multipart `mask` 字段发往
   * OpenAI `/images/edits`（黑底白笔迹 PNG，白 = 待编辑区域）。
   *
   * **这个字段跟着实现走，不跟着厂商宣传走**：目前只有 gpt-image 族有这条通路
   * （openai 槽位的 renderOpenAIImage）。grok 的 image API 在 daemon 里只接了
   * `/images/generations`，nanobanana 走 generateContent，两者都没有 mask 通路，
   * 因此不标 —— 工作台据此返回 400 `MASK_UNSUPPORTED`，而不是静默丢掉 mask
   * 出一张「没按涂抹区域改」的图。
   */
  inpaintMask?: boolean;
  default?: boolean;
};

export const MEDIA_PROVIDERS: MediaProvider[] = [
  { id: 'openai', label: 'OpenAI', hint: 'gpt-image-2 / dall-e-3', integrated: true, defaultBaseUrl: 'https://api.openai.com/v1', supportsModelFetch: true },
  { id: 'grok', label: 'xAI Grok Imagine', hint: 'grok-imagine — image + video with native audio', integrated: true, defaultBaseUrl: 'https://api.x.ai/v1', supportsModelFetch: true },
  { id: 'hyperframes', label: 'HyperFrames', hint: 'Local HTML -> MP4 renderer', integrated: true, credentialsRequired: false, settingsVisible: false },
  { id: 'nanobanana', label: 'Nano Banana', hint: 'Uses Google’s official API by default. You can also configure a custom gateway.', integrated: true, defaultBaseUrl: 'https://generativelanguage.googleapis.com', supportsModelFetch: true, supportsCustomModel: true },
  { id: 'vertex', label: 'Vertex Express', hint: 'Google Vertex AI Express mode — Gemini image models with a plain API key.', integrated: true, defaultBaseUrl: 'https://aiplatform.googleapis.com', docsUrl: 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/express-mode/overview', supportsModelFetch: false, supportsCustomModel: true },
  { id: 'stub', label: 'Stub (placeholder)', hint: 'Deterministic local placeholder bytes', integrated: true },
];

export const IMAGE_MODELS: MediaModel[] = [
  { id: 'gpt-image-2', label: 'gpt-image-2', hint: 'OpenAI · 4K, native multimodal', provider: 'openai', caps: ['t2i', 'i2i', 'inpaint'], inpaintMask: true, default: true },
  { id: 'gpt-image-1.5', label: 'gpt-image-1.5', hint: 'OpenAI · 4× faster than gpt-image-1', provider: 'openai', caps: ['t2i', 'i2i', 'inpaint'], inpaintMask: true },
  { id: 'gpt-image-1', label: 'gpt-image-1', hint: 'OpenAI · ChatGPT native', provider: 'openai', caps: ['t2i', 'i2i', 'inpaint'], inpaintMask: true },
  { id: 'gpt-image-1-mini', label: 'gpt-image-1-mini', hint: 'OpenAI · low-cost variant', provider: 'openai', caps: ['t2i', 'i2i'] },
  { id: 'dall-e-3', label: 'dall-e-3', hint: 'OpenAI · classic', provider: 'openai', caps: ['t2i'] },
  { id: 'dall-e-2', label: 'dall-e-2', hint: 'OpenAI · legacy', provider: 'openai', caps: ['t2i'] },

  { id: 'grok-imagine-image', label: 'grok-imagine-image', hint: 'xAI · 2K text-to-image', provider: 'grok', caps: ['t2i'], default: true },

  { id: 'gemini-3.1-flash-image-preview', label: 'nano-banana-2', hint: 'Nano Banana · text-to-image', provider: 'nanobanana', caps: ['t2i'] },

  { id: 'gemini-2.5-flash-image', label: 'gemini-2.5-flash-image', hint: 'Vertex Express · Gemini 2.5 Flash Image (t2i + i2i)', provider: 'vertex', caps: ['t2i', 'i2i'] },
  { id: 'gemini-3-pro-image', label: 'gemini-3-pro-image', hint: 'Vertex Express · Gemini 3 Pro Image (t2i + i2i)', provider: 'vertex', caps: ['t2i', 'i2i'] },
];

export const VIDEO_MODELS: MediaModel[] = [
  { id: 'grok-imagine-video', label: 'grok-imagine-video', hint: 'xAI · 720p t2v + i2v + native audio', provider: 'grok', caps: ['t2v', 'i2v', 'audio'], default: true },

  { id: 'hyperframes-html', label: 'hyperframes-html', hint: 'HyperFrames · local HTML renderer', provider: 'hyperframes', caps: ['t2v'] },
];

export const MEDIA_ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4'];
export const VIDEO_LENGTHS_SEC = [3, 5, 8, 10, 15, 30];

const MEDIA_MODEL_ALIASES: Readonly<Record<string, string>> = {
  // 阶段1 「媒体默认 provider 切离 vela」起，产品简写不再落到 OpenDesign
  // Cloud：nano-banana 系列改指本地 Google Nano Banana provider（自带
  // API key），Codex 时代的历史 id 改指 OpenAI BYOK 的同名模型，这样既有
  // 项目元数据仍能解析，又不会把用户带回云端托管路由。
  'nano-banana': 'gemini-3.1-flash-image-preview',
  'nano-banana-2': 'gemini-3.1-flash-image-preview',
  // `nano-banana-2-lite` 只有 vela 云实现、没有本地等价物，故意不再登记别名：
  // 它保持原样解析，因而不在注册表里 → 直接不可用，而不是兜底到别的模型。
  'codex-gpt-image-2': 'gpt-image-2',
};

/**
 * 阶段2 摘除 Vela 媒体链路后，所有已注册模型直通。
 */
export function isMediaModelOffered(_model: MediaModel): boolean {
  return true;
}

/**
 * 阶段2 摘除 Vela 媒体链路后，所有已注册 provider 直通。
 */
export function isMediaProviderOffered(_provider: MediaProvider): boolean {
  return true;
}

/**
 * 组装某个 surface 的可选模型列表：先按 surface 取全集，再剔除不再暴露的
 * provider。
 *
 * `/api/media/models` 与媒体生成提示词都经它取列表，保证"选择器里看不到"
 * 与"提示词里不出现"出自同一条规则。
 */
export function offeredModelsForSurface(surface: MediaSurface): MediaModel[] {
  return modelsForSurface(surface).filter(isMediaModelOffered);
}

export function canonicalMediaModelId(id: string): string {
  return MEDIA_MODEL_ALIASES[id] ?? id;
}

export function findMediaModel(id: string): MediaModel | null {
  const all = [...IMAGE_MODELS, ...VIDEO_MODELS];
  const canonicalId = canonicalMediaModelId(id);
  return all.find((m) => m.id === canonicalId) || null;
}

export function findProvider(id: string): MediaProvider | null {
  return MEDIA_PROVIDERS.find((p) => p.id === id) || null;
}

/**
 * 该目录模型能否接受画笔 mask（`PlaygroundGenerateRequest.maskImage`）。
 *
 * 判定点只有一个：模型上的 `inpaintMask` 能力位。它跟着**实现**走——只有
 * openai 槽位里走 `/images/edits` multipart 的 gpt-image 族标了它，因此
 * nanobanana / grok 带 mask 的请求会在路由层拿到 400 `mask_unsupported`，
 * 而不是在渲染器里被静默忽略。
 */
export function modelSupportsInpaintMask(modelId: string): boolean {
  return findMediaModel(modelId)?.inpaintMask === true;
}

/** 支持画笔 mask 的 image 模型 id（错误文案与诊断共用，避免手抄一份列表）。 */
export function inpaintMaskModelIds(): string[] {
  return IMAGE_MODELS.filter((m) => m.inpaintMask === true).map((m) => m.id);
}

export function modelsForSurface(surface: MediaSurface): MediaModel[] {
  if (surface === 'image') return IMAGE_MODELS;
  if (surface === 'video') return VIDEO_MODELS;
  return [];
}
