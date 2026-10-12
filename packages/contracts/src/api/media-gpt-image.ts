/**
 * GPT 源生图（`gpt-image-*`）的共享参数模型。
 *
 * 放在 contracts 里是因为两侧都要用它、且必须用同一份：web 的生成工作台要按
 * 用户选的档位显示/禁用选项，daemon 的 `renderOpenAIImage` 要把同一组档位翻成
 * 上游请求体里的 `size` / `quality`。纯 TS 数学：不碰 Node、不碰网络、不做 I/O，
 * 也不认识任何 provider 配置——因此这里没有「取默认值」的余地，缺省就是缺省。
 *
 * wire 语义只有一条，两个档位都具体（不是 `'auto'`、不是缺省）时才算得出
 * `size`；任一档是 `'auto'`/缺省就返回 `undefined`，让模型自己决定输出尺寸。
 * 换句话说：**返回值 undefined = 请求体里不要出现 size 字段**，不是「用默认
 * 尺寸代替」。这条规则的理由是计费——档位差价由用户承担，宿主不该替他挑一个。
 *
 * `gpt-image-1` 与 `gpt-image-1-mini` 只支持 1K，且不支持 `xhigh` / `max` 质量
 * 档；`gpt-image-1.5`、`gpt-image-2` 及以上（含用户在工作台里手填的
 * `gpt-image-2.5` 这类覆盖名）支持全档。分档判据看**请求真正要发的模型名**，
 * 所以它可能是 `modelOverride`，而不是目录 id。
 */

/** 工作台提供的比例档位；顺序即 UI 顺序。 */
export const GPT_IMAGE_ASPECTS = ['1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4', '21:9'] as const;

/** 分辨率档；`'auto'` = 不指定，由模型决定。 */
export const GPT_IMAGE_RESOLUTIONS = ['auto', '1K', '2K', '4K'] as const;

/** 质量档；`'auto'` = 不指定，由模型决定。`xhigh` / `max` 只有 1.5 及以上的族支持。 */
export const GPT_IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type GptImageAspect = (typeof GPT_IMAGE_ASPECTS)[number];
export type GptImageResolution = (typeof GPT_IMAGE_RESOLUTIONS)[number];
export type GptImageQuality = (typeof GPT_IMAGE_QUALITIES)[number];

/** 能算出具体尺寸的三档；`'auto'` 不在其中。 */
type SizeTier = '1K' | '2K' | '4K';

const GPT_IMAGE_PREFIX = 'gpt-image-';
/** 尺寸一律是 16 的倍数，且单边不超过 3840。 */
const SIZE_MULTIPLE = 16;
const MAX_EDGE = 3840;
/** 上游不接受比 3:1 更长的画幅。 */
const MAX_ASPECT_RATIO = 3;
const MIN_PIXELS = 655_360;
const MAX_PIXELS = 8_294_400;

/**
 * 每档的像素预算上限（在该预算内取总像素最大的合法尺寸）。
 * 1K = 1024×1536，2K = 2048×2048，4K = 8_294_400（上游上限）。
 */
const TIER_PIXEL_BUDGET: Record<SizeTier, number> = {
  '1K': 1_572_864,
  '2K': 4_194_304,
  '4K': MAX_PIXELS,
};

/**
 * 常用比例直接用预设，不走像素预算计算：算出来的「最大合法尺寸」往往不是官方
 * 示例尺寸（例如 16:9 会算出 1728×960 而不是 1280×720），用户看到的会是怪数。
 */
const COMMON_SIZE_PRESETS: Record<SizeTier, Record<GptImageAspect, string>> = {
  '1K': {
    '1:1': '1024x1024',
    '3:2': '1536x1024',
    '2:3': '1024x1536',
    '16:9': '1280x720',
    '9:16': '720x1280',
    '4:3': '1024x768',
    '3:4': '768x1024',
    '21:9': '1280x544',
  },
  '2K': {
    '1:1': '2048x2048',
    '3:2': '2160x1440',
    '2:3': '1440x2160',
    '16:9': '2560x1440',
    '9:16': '1440x2560',
    '4:3': '2048x1536',
    '3:4': '1536x2048',
    '21:9': '2560x1088',
  },
  '4K': {
    '1:1': '2880x2880',
    '3:2': '3456x2304',
    '2:3': '2304x3456',
    '16:9': '3840x2160',
    '9:16': '2160x3840',
    '4:3': '3200x2400',
    '3:4': '2400x3200',
    '21:9': '3840x1600',
  },
};

/** 命中预设的比例必须是精确的整数比，误差容限只用于预算计算那条路。 */
const MAX_RATIO_ERROR = 0.01;

/** 是否是 `gpt-image-*` 族的模型名（前缀判据，不查目录）。 */
export function isGptImageModel(name: string): boolean {
  return typeof name === 'string' && name.startsWith(GPT_IMAGE_PREFIX);
}

/**
 * 取 `gpt-image-` 之后的版本号；读不出来返回 null。
 *
 * `gpt-image-1-mini` → 1（后缀不影响版本），`gpt-image-2.5` → 2.5。
 * 非数字后缀（用户用目录别名指向自家部署）读不出来，调用方按「最新族」处理：
 * 拿不准时给全档，比给旧族的窄档更容易让用户用上他真正配置的模型。
 */
function gptImageVersion(name: string): number | null {
  const match = /^(\d+(?:\.\d+)?)/.exec(name.slice(GPT_IMAGE_PREFIX.length));
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isFinite(version) ? version : null;
}

/**
 * 该模型是否支持 1K/2K/4K 全档。
 *
 * 只有 gpt-image-1 与 gpt-image-1-mini 是「仅 1K」的旧档，其余（1.5、2 及以上）
 * 都是全档。非 gpt-image 族一律 false —— 这个能力位对它们没有意义。
 */
export function gptImageSupportsTiers(name: string): boolean {
  if (!isGptImageModel(name)) return false;
  const version = gptImageVersion(name);
  if (version === null) return true;
  return version >= 1.5;
}

/** 该模型是否支持 `xhigh` / `max` 质量档；判据与大方 {@link gptImageSupportsTiers} 一致。 */
export function gptImageSupportsXhighMax(name: string): boolean {
  return gptImageSupportsTiers(name);
}

/**
 * gpt-image 族的质量收口：web 工作台（`submitQualityFor` 场景）与 daemon
 * 渲染器（构造请求体）共用这一份，两侧的判据必须永远相同。
 *
 * 只有 `GPT_IMAGE_QUALITIES` 里的档位才发得出去：表外值（旧存量卡上的
 * `'standard'` 是 dall-e 时代的词汇）上游只会回 400；`xhigh` / `max` 只有
 * 1.5 及以上的族支持。判据看**目录 id**（PR #1309 的约定），不是 wire 名。
 * 两种情况下都按「用户没要求」处理（返回 undefined = 不发 quality 字段），
 * 而不是替用户换一个档 —— 换档就是替他改计费档。
 */
export function gptImageQualityFor(
  catalogModel: string,
  requested: string | undefined,
): string | undefined {
  if (!requested || requested === 'auto') return undefined;
  if (!(GPT_IMAGE_QUALITIES as readonly string[]).includes(requested)) return undefined;
  if ((requested === 'xhigh' || requested === 'max') && !gptImageSupportsXhighMax(catalogModel)) {
    return undefined;
  }
  return requested;
}

/** 解析 `16:9` / `1.5:1` 这类比例；读不出来返回 null。 */
function parseAspectRatio(aspect: string): { width: number; height: number } | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)\s*$/.exec(aspect);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * 具体的比例档：`'auto'`、空白、缺省都不算具体，读不出比例串也不算。
 * 这条判据就是「两档都具体才传 size」里比例那一半。
 */
function concreteAspect(aspect: string | undefined): { width: number; height: number } | null {
  if (typeof aspect !== 'string') return null;
  const trimmed = aspect.trim();
  if (!trimmed || trimmed === 'auto') return null;
  return parseAspectRatio(trimmed);
}

/** 具体且受支持的分辨率档；`'auto'`、空白、缺省、未知取值都收口到 undefined。 */
function concreteTier(resolution: string | undefined): SizeTier | null {
  if (typeof resolution !== 'string') return null;
  const trimmed = resolution.trim().toUpperCase();
  if (trimmed === '1K' || trimmed === '2K' || trimmed === '4K') return trimmed;
  return null;
}

/** 命中预设表需要精确的整数比：`3:2` 命中，`1.5:1`（= 3:2）不命中。 */
function presetAspectKey(ratio: { width: number; height: number }): GptImageAspect | null {
  if (!Number.isInteger(ratio.width) || !Number.isInteger(ratio.height)) return null;
  const key = `${ratio.width}:${ratio.height}`;
  return key in COMMON_SIZE_PRESETS['1K'] ? key as GptImageAspect : null;
}

/**
 * gpt-image-1 / gpt-image-1-mini 只有 1K 一档，比例按横竖映射到三个官方尺寸。
 * 调用方传 2K/4K 也收口到这一档——这两族根本没有更大的尺寸可选，报错不如降档。
 */
function gptImage1KSize(ratio: { width: number; height: number }): string {
  if (ratio.width === ratio.height) return '1024x1024';
  return ratio.width > ratio.height ? '1536x1024' : '1024x1536';
}

/** 把值对齐到 16 的倍数（下限 16），与预算算法里 floor/ceil 两个候选共用。 */
function multipleOf16(value: number, mode: 'floor' | 'ceil'): number {
  const scaled = mode === 'floor' ? Math.floor(value / SIZE_MULTIPLE) : Math.ceil(value / SIZE_MULTIPLE);
  return Math.max(SIZE_MULTIPLE, scaled * SIZE_MULTIPLE);
}

/**
 * 不在预设表里的比例：在该档像素预算内、满足全部上游约束（16 的倍数、单边
 * ≤3840、长短边比 ≤3:1、总像素在 655360–8294400）的前提下，取总像素最大且
 * 比例误差 ≤1% 的尺寸。找不到就是算不出来，调用方按「不发 size」处理。
 */
function sizeFromPixelBudget(tier: SizeTier, ratio: { width: number; height: number }): string | undefined {
  const targetRatio = ratio.width / ratio.height;
  const budget = TIER_PIXEL_BUDGET[tier];
  let best: { width: number; height: number; pixels: number } | null = null;
  for (let width = SIZE_MULTIPLE; width <= MAX_EDGE; width += SIZE_MULTIPLE) {
    const idealHeight = width / targetRatio;
    for (const height of [multipleOf16(idealHeight, 'floor'), multipleOf16(idealHeight, 'ceil')]) {
      if (height > MAX_EDGE) continue;
      const pixels = width * height;
      if (pixels > budget || pixels < MIN_PIXELS) continue;
      if (Math.max(width / height, height / width) > MAX_ASPECT_RATIO) continue;
      if (Math.abs(width / height - targetRatio) / targetRatio > MAX_RATIO_ERROR) continue;
      if (!best || pixels > best.pixels) best = { width, height, pixels };
    }
  }
  return best ? `${best.width}x${best.height}` : undefined;
}

/**
 * 把「比例 + 分辨率」翻成上游要的 `size` 字符串。
 *
 * 返回 `undefined` 表示**请求体里不要带 size**（任一档为 `'auto'`/缺省/算不出来），
 * 不是「用某个默认尺寸代替」。
 *
 * dall-e 族没有档位概念，但它们不支持 `'auto'`：dall-e-3 落在
 * 1024x1024 / 1792x1024 / 1024x1792 三档，dall-e-2 恒 1024x1024，所以它们的返回值
 * 与档位无关。未知模型一并返回 `undefined`。
 */
export function gptImageSizeFor(
  model: string,
  aspect: string | undefined,
  resolution: string | undefined,
): string | undefined {
  if (model === 'dall-e-3') {
    if (aspect === '16:9') return '1792x1024';
    if (aspect === '9:16') return '1024x1792';
    return '1024x1024';
  }
  if (model === 'dall-e-2') return '1024x1024';
  if (!isGptImageModel(model)) return undefined;

  const ratio = concreteAspect(aspect);
  const tier = concreteTier(resolution);
  if (!ratio || !tier) return undefined;
  if (!gptImageSupportsTiers(model)) return gptImage1KSize(ratio);

  const presetKey = presetAspectKey(ratio);
  if (presetKey) return COMMON_SIZE_PRESETS[tier][presetKey];
  return sizeFromPixelBudget(tier, ratio);
}
