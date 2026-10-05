import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PlaygroundHarness } from './playground-harness.js';

/**
 * 回归：默认数据根是 `<projectRoot>/.od`，带一个点号目录段。
 *
 * `res.sendFile(abs)` 没传 `root`，底层的 `send` 就把**整条绝对路径**拆段丢给
 * dotfiles 检查（默认策略 ignore → 404）；路径里的 `.od` 于是把每一张 scratch
 * 卡片都变成"生成了但看不见"。既有套件的数据根是 `os.tmpdir()` 下的 mkdtemp
 * 目录（无点号段），所以这个缺陷在单测里完全隐形。
 *
 * 层次选择：必须在**另一个**数据根上起 daemon——`RUNTIME_DATA_DIR` 在
 * server.ts 模块求值时定死，静态 import 会把数据根钉在 setup.ts 的临时目录里。
 * 所以先拼数据根，再动态 import 夹具。
 */
describe('media playground scratch files under a dot-segment data root', () => {
  let harness: PlaygroundHarness;
  /** 含 `.od` 段的数据根，模拟真实安装（`<projectRoot>/.od`）。 */
  let dataRoot: string;
  let tempRoot: string;
  const originalDataDir = process.env.OD_DATA_DIR;

  beforeAll(async () => {
    tempRoot = await fsp.mkdtemp(path.join(tmpdir(), 'od-playground-dotfiles-'));
    dataRoot = path.join(tempRoot, '.od');
    // 动态 import 之前设好：server.ts 在模块求值时读 OD_DATA_DIR 得到 RUNTIME_DATA_DIR。
    process.env.OD_DATA_DIR = dataRoot;
    const { startPlaygroundHarness } = await import('./playground-harness.js');
    harness = await startPlaygroundHarness();
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.close();
    if (originalDataDir === undefined) delete process.env.OD_DATA_DIR;
    else process.env.OD_DATA_DIR = originalDataDir;
    if (tempRoot) await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('serves a scratch artifact even though the data root contains a dot directory', async () => {
    // 夹具自检：数据根真的带点号段，否则这条用例会因为"没有缺陷"而通过。
    expect(path.basename(dataRoot)).toBe('.od');

    const generated = await fetch(`${harness.baseUrl}/api/media/playground/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        surface: 'image',
        model: 'custom-image',
        modelOverride: 'playground-model',
        prompt: 'A scratch hero image under .od',
      }),
    });
    const payload = await generated.json() as any;
    expect(generated.status, JSON.stringify(payload)).toBe(200);
    expect(payload.status).toBe('done');
    expect(payload.files[0].error).toBeUndefined();
    // 生成侧本来就正常：字节确实落在含点号段的数据根里。
    expect(existsSync(path.join(dataRoot, 'media-playground', payload.files[0].name))).toBe(true);

    const served = await fetch(
      `${harness.baseUrl}/api/media/playground/files/${payload.id}/0`,
    );
    expect(
      served.status,
      'a dot-segment data root must not turn scratch artifacts into 404s',
    ).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect((await served.arrayBuffer()).byteLength).toBeGreaterThan(0);
  }, 60_000);
});
