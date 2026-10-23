import fsp from 'node:fs/promises';

import { imageSize } from '../brands/imagery-fallback.js';
import { errorText } from './generate-media-batch.js';
import { resolveWithinBase } from './playground-files.js';

/**
 * 画笔局部重绘（原生 mask）的两块规则：mask 的字节级校验，以及
 * `/images/edits` 的 multipart 组装。
 *
 * 单独成文件是因为这套规则只有这里会写错，值得一眼读完：mask 必须是 PNG、必须与
 * 底图同像素尺寸、多图 part 用重复的 `image[]`。`media/index.ts` 只负责在
 * 「有 mask」时改走这条通路。
 */

/** 参与尺寸校验的一份图片字节。`label` 是错误文案里的自称。 */
export interface MaskSubjectImage {
  label: string;
  bytes: Buffer;
}

/** multipart 的一个文件 part：上游只看字节与 mime，文件名仅作展示。 */
export interface MaskFormImage {
  fileName: string;
  mime: string;
  bytes: Buffer;
}

/** 派发前预检的失败形状（路由原样转成 400 信封）。 */
export interface InpaintMaskFailure {
  status: number;
  code: 'mask_invalid';
  message: string;
}

function maskInvalid(message: string): InpaintMaskFailure {
  return { status: 400, code: 'mask_invalid', message };
}

/**
 * mask 必须是黑底白笔迹的 PNG，且与**底图**（`images[0]`）同像素尺寸。
 *
 * 这是尺寸/格式规则的唯一判定点：路由的派发前预检与 openai 渲染器都调它，
 * 两边不会各自漂移。不符合就抛错——**刻意不缩放**，因为「上游替我们缩放
 * mask」会让用户拿到一张改错区域的图，而那张图看起来是成功的。
 */
export function assertInpaintMaskUsable(
  mask: MaskSubjectImage,
  primary: MaskSubjectImage,
): void {
  if (!isPng(mask.bytes)) {
    throw new Error(`${mask.label} must be a PNG (black background, white brush strokes)`);
  }
  const maskSize = imageSize(mask.bytes);
  if (!maskSize) throw new Error(`${mask.label} has no readable pixel size`);
  const primarySize = imageSize(primary.bytes);
  if (!primarySize) throw new Error(`${primary.label} has no readable pixel size`);
  if (maskSize.w !== primarySize.w || maskSize.h !== primarySize.h) {
    throw new Error(
      `${mask.label} is ${maskSize.w}x${maskSize.h} but ${primary.label} is `
      + `${primarySize.w}x${primarySize.h}; the mask must be exported at the image's exact `
      + 'pixel size (nothing is scaled for you)',
    );
  }
}

/**
 * 派发前的 mask 预检：文件在目标目录内、可读、是黑底白笔迹 PNG，且与 `images[0]`
 * 同像素尺寸。返回 null = 通过。
 *
 * 与渲染器里的 {@link assertInpaintMaskUsable} 是同一条判定，这里只是把它翻成
 * 结构化错误，好在**花用户的钱之前**停下来（也让工作台拿到 `mask_invalid` 而不
 * 是一张失败卡片）。
 */
export async function validateInpaintMask(input: {
  /** 目标基目录（生成时解析参考图的同一个根）。 */
  baseDir: string;
  maskImage: string;
  primaryImage: string;
}): Promise<InpaintMaskFailure | null> {
  const mask = await readSubject(input.baseDir, input.maskImage, 'maskImage');
  if ('failure' in mask) return mask.failure;
  const primary = await readSubject(input.baseDir, input.primaryImage, 'image');
  if ('failure' in primary) return primary.failure;
  try {
    assertInpaintMaskUsable(
      { label: `maskImage "${input.maskImage}"`, bytes: mask.bytes },
      { label: `image "${input.primaryImage}"`, bytes: primary.bytes },
    );
  } catch (err) {
    return maskInvalid(errorText(err));
  }
  return null;
}

/**
 * 组装 `POST /images/edits` 的 multipart 请求体（原生 mask 局部重绘）。
 *
 * 字段映射**不另写一套**：`fields` 就是 JSON 路径产出的那份请求体
 * （`buildOpenAIImageBody`），除了 `images`（在这里变成文件 part）之外原样搬成
 * 表单字段，所以 size / quality / n / background 的档位语义只有一处实现。
 *
 * 多图的字段名用重复的 `image[]`：OpenAI 官方 Create image edit 的多图示例即
 * `-F "image[]=@a.png" -F "image[]=@b.png"`（本仓 `skills/hatch-pet` 的脚本也
 * 是同形）。`mask` 只作用于**第一张**图，所以底图必须排在最前。
 */
export function buildInpaintEditForm(input: {
  fields: Record<string, unknown>;
  images: MaskFormImage[];
  mask: MaskFormImage;
}): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(input.fields)) {
    if (key === 'images') continue;
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === 'string' ? value : String(value));
  }
  for (const image of input.images) {
    form.append('image[]', blobOf(image), image.fileName);
  }
  form.append('mask', blobOf(input.mask), input.mask.fileName);
  return form;
}

/** `image_url` 里的 data URL 还原成字节：multipart part 要的是原始字节。 */
export function bytesFromDataUrl(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Buffer.from(base64, 'base64');
}

function blobOf(image: MaskFormImage): Blob {
  return new Blob([image.bytes], { type: image.mime });
}

function isPng(bytes: Buffer): boolean {
  return (
    bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  );
}

/**
 * 读目标目录内的一张图片；越界与不存在都变成可读的 400 失败。
 *
 * 越界判定复用 `resolveWithinBase`（Playground 文件层的同一条规则），所以 mask
 * 引用既不能跳出目标目录，也不会绕过上传时的净化命名。
 */
async function readSubject(
  baseDir: string,
  rel: string,
  label: string,
): Promise<{ bytes: Buffer } | { failure: InpaintMaskFailure }> {
  const abs = resolveWithinBase(baseDir, rel);
  if (!abs) {
    return { failure: maskInvalid(`${label} "${rel}" resolves outside the target directory`) };
  }
  try {
    return { bytes: await fsp.readFile(abs) };
  } catch {
    return { failure: maskInvalid(`${label} not found: ${rel}`) };
  }
}
