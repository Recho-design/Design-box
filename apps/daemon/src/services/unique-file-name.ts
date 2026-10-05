import fs from 'node:fs';
import path from 'node:path';

/**
 * 在目标目录里给出一个不冲突的文件名：`poster.png` → `poster-1.png`。
 *
 * 规则只有一条，所以项目上传（design files）与 Media Playground 的转存可以
 * 共用它：净化后的原名优先，撞名才按序号派生，`reserved` 里是同一批里已经
 * 用掉的名字（第二个文件还没落盘，`existsSync` 看不见它）。
 *
 * 调用方负责先 `sanitizeName`：这里只做去重，不做净化。
 */
export function uniqueFileName(
  directory: string,
  safeName: string,
  reserved: Set<string> = new Set(),
): string {
  const parsed = path.parse(safeName);
  const base = parsed.name || parsed.base || 'file';
  const ext = parsed.ext || '';
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = index === 0 ? safeName : `${base}-${index}${ext}`;
    if (reserved.has(candidate)) continue;
    if (directory && fs.existsSync(path.join(directory, candidate))) continue;
    reserved.add(candidate);
    return candidate;
  }
  const fallback = `${base}-${Date.now().toString(36)}${ext}`;
  reserved.add(fallback);
  return fallback;
}
