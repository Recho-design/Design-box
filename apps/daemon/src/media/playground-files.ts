import path from 'node:path';

import { sanitizeName } from '../projects.js';

/**
 * Playground 的文件层小工具：上传校验、命名、路径收口。
 *
 * 单独成文件是为了让路由只做编排，而这些「只有这一处会做错」的规则（魔数白名单、
 * 扩展名以字节为准、越界判定）能被单独读懂。
 */

/**
 * 参考图上传的字节上限，与 `resolveProjectImage` 的 16MB 读取上限对齐。
 *
 * 不对齐就会出现「传得上来、用不进去」：上传收下了，生成时读参考图却因为超限
 * 直接失败（C4）。
 */
export const PLAYGROUND_UPLOAD_MAX_BYTES = 16 * 1024 * 1024;

/** 白名单里的图片格式：`ext` 同时是落盘扩展名与参考图读取能接受的四种之一。 */
export interface DetectedImageFormat {
  ext: string;
  mime: string;
}

/**
 * 按魔数识别上传的图片，未知格式返回 null。
 *
 * 刻意不复用 `sniffImageExt`：那个函数对未知字节**默认返回 `.png`**，于是任意
 * 字节都会被当成 PNG 收下，再在生成时以一张坏图的形式爆炸。这里宁可当场拒绝
 * （C4）。
 */
export function detectImageFormat(bytes: Buffer): DetectedImageFormat | null {
  if (matchesPng(bytes)) return { ext: '.png', mime: 'image/png' };
  if (matchesJpeg(bytes)) return { ext: '.jpg', mime: 'image/jpeg' };
  if (matchesWebp(bytes)) return { ext: '.webp', mime: 'image/webp' };
  if (matchesGif(bytes)) return { ext: '.gif', mime: 'image/gif' };
  return null;
}

/**
 * 上传文件的落盘名：净化原名，扩展名一律以魔数为准。
 *
 * 扩展名不能信原名：参考图读取按扩展名判定 MIME，一个 `ref.txt` 里装着 PNG
 * 字节，只有改名成 `ref.png` 才用得进去。
 */
export function playgroundUploadFileName(originalName: unknown, ext: string): string {
  const safe = sanitizeName(typeof originalName === 'string' ? originalName : '');
  const parsed = path.parse(safe);
  const stem = parsed.name || parsed.base || 'image';
  return `${stem}${ext}`;
}

/**
 * 把基目录下的相对路径收口成绝对路径；越界（`..`、绝对路径、盘符）返回 null。
 *
 * `sanitizeName` 已经把分隔符换成了 `_`，所以正常路径只会是单层 basename 或
 * `uploads/x.png`；这个函数是那道规则之外的**复核**，任何拼出来的路径都必须
 * 过它才允许碰磁盘（§5.3 的第 ③ 条防护）。
 */
export function resolveWithinBase(baseDir: string, relative: string): string | null {
  if (typeof relative !== 'string' || !relative.trim()) return null;
  const base = path.resolve(baseDir);
  const abs = path.resolve(base, relative.trim());
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

function matchesPng(bytes: Buffer): boolean {
  return (
    bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  );
}

function matchesJpeg(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function matchesWebp(bytes: Buffer): boolean {
  return (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  );
}

function matchesGif(bytes: Buffer): boolean {
  if (bytes.length < 6) return false;
  const header = bytes.subarray(0, 6).toString('ascii');
  return header === 'GIF87a' || header === 'GIF89a';
}
