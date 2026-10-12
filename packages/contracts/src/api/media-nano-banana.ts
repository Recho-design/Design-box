/**
 * Nano Banana 源生图（Gemini image 模型族）的共享参数模型。
 *
 * 放在 contracts 的理由与 {@link ./media-gpt-image.ts} 完全相同：web 的生成工作台
 * 要按用户选的档位显示/收口选项，daemon 的 `renderNanoBananaImage` 要把同一组档位
 * 翻成上游 `generationConfig.imageConfig` 里的 `aspectRatio` / `imageSize`，两侧
 * 必须用同一份词表与同一条收口规则。纯 TS：不碰 Node、不碰网络、不做 I/O。
 *
 * wire 语义（与 gpt-image 侧一致）：**返回值 undefined = 请求体里不要出现该字段**，
 * 不是「用某个默认值代替」。缺席由模型自己决定（aspectRatio 缺席模型自选，
 * imageSize 缺省即 Google 文档写明的默认 1K）——档位差价由用户承担，宿主不替他挑档。
 *
 * 词表依据（2026-10-12 核对）：
 *   aspectRatio —— Gemini 3 image 模型全表 10 档：
 *     https://ai.google.dev/gemini-api/docs/image-generation
 *   imageSize —— 1K / 2K / 4K：
 *     Gemini API reference generationConfig.imageConfig.imageSize。
 * gemini-2.5-flash-image 等旧族实际只支持其中子集，这里仍给全表：拿不准时给全档，
 * 比给窄档更容易让用户用上他真正配置的模型（与 gptImageVersion 的判据取向一致），
 * 选了旧族不支持的档位由上游 400 明示，而不是 UI 里静默消失。
 */

/** 工作台提供的比例档位；顺序即 UI 顺序。 */
export const NANO_BANANA_ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const;

/** 能发到上游的具体分辨率档（`'auto'` 不在其中）；UI 词表由它派生，加档只改这一处。 */
const CONCRETE_IMAGE_SIZES = ['1K', '2K', '4K'] as const;

/** 分辨率档；`'auto'` = 不指定，由模型决定（默认 1K）。 */
export const NANO_BANANA_RESOLUTIONS = ['auto', ...CONCRETE_IMAGE_SIZES] as const;

export type NanoBananaAspect = (typeof NANO_BANANA_ASPECTS)[number];
export type NanoBananaResolution = (typeof NANO_BANANA_RESOLUTIONS)[number];

/** 能发到上游的具体分辨率档；`'auto'` 不在其中。 */
type ConcreteImageSize = Exclude<NanoBananaResolution, 'auto'>;

/**
 * 比例收口：web 工作台（提交侧）与 daemon 渲染器（构造请求体）共用。
 *
 * 词表内的值原样返回；`'auto'`、缺省、空白、表外值一律返回 undefined
 * （= `imageConfig` 里不要出现 `aspectRatio`，让模型自己定画幅）。
 */
export function nanoBananaAspectRatioFor(aspect: string | undefined): NanoBananaAspect | undefined {
  if (typeof aspect !== 'string') return undefined;
  const trimmed = aspect.trim();
  if (!trimmed || trimmed === 'auto') return undefined;
  return (NANO_BANANA_ASPECTS as readonly string[]).includes(trimmed)
    ? (trimmed as NanoBananaAspect)
    : undefined;
}

/**
 * 分辨率收口：把工作台的 resolution 档翻成上游 `imageSize`。
 *
 * 具体档（1K/2K/4K）原样返回；`'auto'`、缺省、空白、表外值一律返回 undefined
 * （= 不发 `imageSize`，模型用默认 1K）。大小写不敏感（'2k' 也认）。
 */
export function nanoBananaImageSizeFor(resolution: string | undefined): ConcreteImageSize | undefined {
  if (typeof resolution !== 'string') return undefined;
  const trimmed = resolution.trim().toUpperCase();
  return (CONCRETE_IMAGE_SIZES as readonly string[]).includes(trimmed as ConcreteImageSize)
    ? (trimmed as ConcreteImageSize)
    : undefined;
}
