import { readMaskedConfig } from './config.js';
import { offeredModelsForSurface } from './models.js';

/**
 * 解析「缺省 image 模型」：`POST /api/media/playground/generate` 不带 `model`
 * 时用哪一个目录 id。
 *
 * 规则（与 web 工作台的选择器同源，不另立一套）：
 *   1. 按 `offeredModelsForSurface('image')` 的**目录序**遍历（不是按 provider
 *      名的字典序，也不是按用户配置顺序）；
 *   2. 第一个 `configured === true` 的模型胜出——环境变量 key、本地存下的 key、
 *      或借来的凭据（codex-auth 的 OpenAI 借用 key / xAI OAuth，见 #1277）；
 *   3. 一个都不满足 → `null`（调用方据此报「未配置任何媒体提供商」，而不是随便
 *      挑一个必然失败的模型）。
 *
 * **`baseUrl` 非空不算可用**（2026-10-13 修订）：openai / grok / nanobanana 三个
 * image renderer 在没有 key 时一律直接抛错，所以 baseUrl-only 的 provider 被选成
 * 默认只会产出一张失败卡片（`status: failed` + no credential），还会按目录序
 * **遮蔽**排在它后面、真正配了 key 的 provider。baseUrl 仍然照常参与实际调用
 * （自建网关的地址就是要用它），只是不再作为「这个 provider 可用」的判据。
 *
 * 用途：外部编码代理（Claude Code / Cursor / 裸 HTTP 循环）不需要先读目录、
 * 也不需要知道 `gpt-image-2` 这类 id 就能出图；CLI 的 `od media playground
 * generate` 与 MCP 的 `generate_image` 省略 `--model` / `model` 时都走这里。
 */
export async function resolveDefaultImageModelId(
  projectRoot: string,
): Promise<string | null> {
  const config = await readMaskedConfig(projectRoot);
  for (const model of offeredModelsForSurface('image')) {
    const provider = config.providers[model.provider];
    if (provider?.configured === true) return model.id;
  }
  return null;
}
