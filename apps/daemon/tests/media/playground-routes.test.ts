import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db.js';
import { insertPlaygroundGeneration } from '../../src/media/playground-store.js';
import {
  createProject,
  importFolderProject,
  playgroundDir,
  playgroundUploadsDir,
  startPlaygroundHarness,
  type PlaygroundHarness,
} from './playground-harness.js';

/**
 * Playground 的生成 / 列表 / 文件 / 删除端点（daemon HTTP 边界）。
 *
 * 层次选择：路由级 `startServer` + 本机 provider 桩。落盘目录、命名、per-slot
 * 结果、同源守卫都只有在真实 HTTP 边界上才能被观察到。
 */
describe('media playground routes', () => {
  let harness: PlaygroundHarness;

  beforeAll(async () => {
    harness = await startPlaygroundHarness();
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  });

  afterEach(() => {
    harness.failCalls(() => false);
    harness.delayProvider(0);
  });

  function url(requestPath: string): string {
    return `${harness.baseUrl}${requestPath}`;
  }

  /**
   * 裸 HTTP 请求：`fetch` 不允许设置 `Host` 这类禁止头，而端点级同源守卫只能靠
   * 伪造 Host 才够得着（见下面那条用例）。
   */
  async function rawRequest(
    method: string,
    requestPath: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    const target = new URL(url(requestPath));
    return await new Promise((done, fail) => {
      const request = http.request(
        {
          host: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method,
          headers,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => done({ status: res.statusCode ?? 0, body }));
        },
      );
      request.on('error', fail);
      request.end();
    });
  }

  // `payload: any` 与同目录的 generate-count-batch.test.ts 一致：成功是 DTO 行，
  // 失败是嵌套信封，两种形状在同一条断言里混用，测试里如实放宽。
  async function generate(body: Record<string, unknown>): Promise<{ status: number; payload: any }> {
    const response = await fetch(url('/api/media/playground/generate'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ surface: 'image', model: 'custom-image', ...body }),
    });
    return { status: response.status, payload: await response.json() };
  }

  async function listGenerations(
    query = '',
  ): Promise<{ status: number; payload: any }> {
    const response = await fetch(url(`/api/media/playground/generations${query}`));
    return { status: response.status, payload: await response.json() };
  }

  it('lands a scratch artifact at the playground root and answers with the row', async () => {
    harness.providerBodies.length = 0;
    const { status, payload } = await generate({
      prompt: 'A scratch hero image',
      modelOverride: 'playground-model',
      count: 2,
    });

    expect(status, JSON.stringify(payload)).toBe(200);
    expect(payload.targetProjectId).toBeNull();
    expect(payload.status).toBe('done');
    expect(typeof payload.createdAt).toBe('number');
    expect(payload.params).toMatchObject({ count: 2 });
    expect(payload.files.map((file: any) => file.name)).toEqual([
      `${payload.id}-1.png`,
      `${payload.id}-2.png`,
    ]);
    for (const file of payload.files) {
      expect(file.error).toBeUndefined();
      // 产物在 Playground **根**目录，不是 uploads/。
      expect(existsSync(path.join(playgroundDir(), file.name))).toBe(true);
      expect(file.size).toBeGreaterThan(0);
    }
    expect(harness.providerBodies).toHaveLength(2);
    // 行已 settle，列表里能看到同一行。
    const listed = await listGenerations('?target=scratch');
    expect(listed.payload.generations.map((row: any) => row.id)).toContain(payload.id);
  }, 60_000);

  it('writes a project-target artifact into the imported folder', async () => {
    const { projectId, baseDir } = await importFolderProject(harness.baseUrl);
    const { status, payload } = await generate({
      prompt: 'A project hero image',
      modelOverride: 'playground-model',
      targetProjectId: projectId,
    });

    expect(status, JSON.stringify(payload)).toBe(200);
    expect(payload.targetProjectId).toBe(projectId);
    expect(payload.files).toHaveLength(1);
    const name = payload.files[0].name;
    // 导入型项目的真实工作区是 metadata.baseDir —— 落 .od/projects/<id> 时
    // Design Files 根本看不到它。
    expect(existsSync(path.join(baseDir, name))).toBe(true);
    expect(existsSync(path.join(process.env.OD_DATA_DIR!, 'projects', projectId, name))).toBe(false);
  }, 60_000);

  it('reports a failed slot beside the slots that landed', async () => {
    harness.providerBodies.length = 0;
    // 槽位是**并行**跑的（generateMediaBatch 用 allSettled），所以"第几个槽位
    // 失败"本身不确定：夹具说请求到达顺序的第 2 个 500，断言因此只钉住"恰好一槽
    // 失败、其余照常落地"，不去钉失败的是哪一槽。
    harness.failCalls((callNumber) => callNumber === 2);
    const { status, payload } = await generate({
      prompt: 'Three slots, one rejected',
      modelOverride: 'playground-model',
      count: 3,
    });

    expect(status, JSON.stringify(payload)).toBe(200);
    expect(payload.files).toHaveLength(3);
    // 文件名按槽位顺序，与槽位是否失败无关。
    expect(payload.files.map((file: any) => file.name)).toEqual([
      `${payload.id}-1.png`,
      `${payload.id}-2.png`,
      `${payload.id}-3.png`,
    ]);
    const failed = payload.files.filter((file: any) => file.error);
    const landed = payload.files.filter((file: any) => !file.error);
    expect(failed).toHaveLength(1);
    expect(landed).toHaveLength(2);
    expect(failed[0].error).toContain('slot rejected by the fixture');
    // 失败槽位没有留下文件，成功槽位两个都在盘上。
    expect(existsSync(path.join(playgroundDir(), failed[0].name))).toBe(false);
    for (const file of landed) {
      expect(existsSync(path.join(playgroundDir(), file.name))).toBe(true);
    }
    // 行与响应同构：历史里留下的就是同一份 per-slot 结果。
    const listed = await listGenerations('?target=scratch&limit=5');
    const row = listed.payload.generations.find((entry: any) => entry.id === payload.id);
    expect(row).toMatchObject({
      id: payload.id,
      status: 'done',
      files: payload.files,
    });
  }, 60_000);

  it('records an all-slots-failed row as failed and still answers with it', async () => {
    harness.failCalls(() => true);
    const { status, payload } = await generate({
      prompt: 'Every slot is rejected',
      modelOverride: 'playground-model',
      count: 2,
    });

    expect(status, JSON.stringify(payload)).toBe(200);
    expect(payload.status).toBe('failed');
    expect(payload.error).toContain('slot rejected by the fixture');
    expect(payload.files.every((file: any) => file.error)).toBe(true);
    expect(existsSync(path.join(playgroundDir(), `${payload.id}-1.png`))).toBe(false);
  }, 60_000);

  it('keeps concurrent same-millisecond generations from overwriting each other', async () => {
    harness.providerBodies.length = 0;
    const [first, second] = await Promise.all([
      generate({ prompt: 'Concurrent A', modelOverride: 'playground-model' }),
      generate({ prompt: 'Concurrent B', modelOverride: 'playground-model' }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const names = [first.payload.files[0].name, second.payload.files[0].name];
    expect(new Set(names).size, `名字撞车了: ${names.join(', ')}`).toBe(2);
    // 名字从 generation id 派生，所以构造上就不可能撞。
    expect(names[0]).toBe(`${first.payload.id}-1.png`);
    expect(names[1]).toBe(`${second.payload.id}-1.png`);
    for (const name of names) {
      expect(existsSync(path.join(playgroundDir(), name))).toBe(true);
    }
  }, 60_000);

  it('resolves a previous artifact and an upload as reference images', async () => {
    harness.providerBodies.length = 0;
    const first = await generate({ prompt: 'Reference source', modelOverride: 'playground-model' });
    expect(first.status).toBe(200);
    const artifactName = first.payload.files[0].name;

    harness.providerBodies.length = 0;
    const second = await generate({
      prompt: 'Edit the reference',
      modelOverride: 'playground-model',
      images: [artifactName],
    });
    expect(second.status, JSON.stringify(second.payload)).toBe(200);
    expect(second.payload.files[0].error).toBeUndefined();
    // 参考图被解析成 data URL 随请求发出（i2i 走 edits 端点）。
    const sent = harness.providerBodies[0] as { images?: Array<{ image_url?: string }> };
    expect(Array.isArray(sent.images)).toBe(true);
    expect(sent.images?.[0]?.image_url).toMatch(/^data:image\/png;base64,/);
  }, 60_000);

  it('refuses a reference image outside the target directory', async () => {
    const { status, payload } = await generate({
      prompt: 'Escape attempt',
      modelOverride: 'playground-model',
      images: ['../../../etc/passwd.png'],
    });

    expect(status, JSON.stringify(payload)).toBe(200);
    expect(payload.status).toBe('failed');
    expect(payload.files[0].error).toContain('outside the allowed directory');
  }, 60_000);

  it('serves a scratch artifact with immutable caching and refuses everything else', async () => {
    const generated = await generate({ prompt: 'Servable', modelOverride: 'playground-model' });
    const generationId = generated.payload.id;

    const served = await fetch(url(`/api/media/playground/files/${generationId}/0`));
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(served.headers.get('content-disposition')).toContain('inline');
    expect((await served.arrayBuffer()).byteLength).toBeGreaterThan(0);

    expect((await fetch(url(`/api/media/playground/files/${generationId}/1`))).status).toBe(404);
    expect((await fetch(url(`/api/media/playground/files/${generationId}/x`))).status).toBe(404);
    expect((await fetch(url('/api/media/playground/files/missing/0'))).status).toBe(404);

    // 项目行不走这条读取路径。
    const { projectId } = await importFolderProject(harness.baseUrl);
    const projectGeneration = await generate({
      prompt: 'Project artifact',
      modelOverride: 'playground-model',
      targetProjectId: projectId,
    });
    const refused = await fetch(
      url(`/api/media/playground/files/${projectGeneration.payload.id}/0`),
    );
    expect(refused.status).toBe(403);
    expect((await refused.json() as any).error.code).toBe('FORBIDDEN');
  }, 60_000);

  it('refuses a recorded file name that escapes the playground directory', async () => {
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required by the daemon test harness');
    const db = openDatabase(process.cwd(), { dataDir });
    const row = insertPlaygroundGeneration(db, {
      id: 'gen-traversal',
      targetProjectId: null,
      surface: 'image',
      model: 'custom-image',
      status: 'done',
      files: [{ name: path.join('..', '..', 'etc', 'passwd.png') }],
    });

    const response = await fetch(url(`/api/media/playground/files/${row.id}/0`));
    expect(response.status).toBe(403);
    expect((await response.json() as any).error.code).toBe('FORBIDDEN');
  }, 60_000);

  it('lists newest first, filters by target and follows the compound cursor', async () => {
    const all = await listGenerations('?limit=200');
    expect(all.status).toBe(200);
    const ids = all.payload.generations.map((row: any) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let index = 1; index < all.payload.generations.length; index += 1) {
      const previous = all.payload.generations[index - 1];
      const current = all.payload.generations[index];
      expect(
        previous.createdAt > current.createdAt
        || (previous.createdAt === current.createdAt && previous.id > current.id),
      ).toBe(true);
    }

    const firstPage = await listGenerations('?limit=1');
    expect(firstPage.payload.generations).toHaveLength(1);
    expect(typeof firstPage.payload.nextBefore).toBe('string');
    const secondPage = await listGenerations(
      `?limit=1&before=${encodeURIComponent(firstPage.payload.nextBefore)}`,
    );
    expect(secondPage.payload.generations[0].id).not.toBe(firstPage.payload.generations[0].id);

    expect((await listGenerations('?before=nonsense')).status).toBe(400);
    expect((await listGenerations('?target=')).status).toBe(200);
  }, 60_000);

  it('hides a running row from deletion and settles it afterwards', async () => {
    const { projectId } = await importFolderProject(harness.baseUrl);
    harness.delayProvider(500);
    const pending = generate({ prompt: 'Slow generation', modelOverride: 'playground-model' });

    const running = await waitForRunningRow();
    const refused = await fetch(
      url(`/api/media/playground/generations/${running.id}`),
      { method: 'DELETE' },
    );
    expect(refused.status).toBe(409);
    expect((await refused.json() as any).error.code).toBe('GENERATION_RUNNING');

    // 转存同样拒绝：行还没 settle 时复制出去，会得到一份"不知道成没成"的副本。
    const refusedTransfer = await fetch(
      url(`/api/media/playground/generations/${running.id}/transfer`),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId }),
      },
    );
    expect(refusedTransfer.status).toBe(409);
    expect((await refusedTransfer.json() as any).error.code).toBe('GENERATION_RUNNING');

    const settled = await pending;
    expect(settled.status).toBe(200);
    expect(settled.payload.id).toBe(running.id);
    expect(settled.payload.status).toBe('done');
  }, 60_000);

  it('deletes a row together with its scratch artifact', async () => {
    const generated = await generate({ prompt: 'Doomed', modelOverride: 'playground-model' });
    const name = generated.payload.files[0].name;
    const abs = path.join(playgroundDir(), name);
    expect(existsSync(abs)).toBe(true);

    const deleted = await fetch(url(`/api/media/playground/generations/${generated.payload.id}`), {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ ok: true });
    expect(existsSync(abs)).toBe(false);

    const listed = await listGenerations('?target=scratch&limit=200');
    expect(listed.payload.generations.map((row: any) => row.id)).not.toContain(
      generated.payload.id,
    );
    expect(
      (await fetch(url(`/api/media/playground/generations/${generated.payload.id}`), {
        method: 'DELETE',
      })).status,
    ).toBe(404);
  }, 60_000);

  /** 六个端点，供同源守卫的两条用例共用。 */
  const guardedEndpoints: Array<[string, string, RequestInit]> = [
    ['POST', '/api/media/playground/generate', { body: '{}' }],
    // 空 body：daemon 全局的 express.json 排在来源中间件之前，一段畸形 JSON 会先
    // 撞上 400，测不到守卫本身。
    ['POST', '/api/media/playground/uploads', {}],
    ['GET', '/api/media/playground/generations', {}],
    ['GET', '/api/media/playground/files/anything/0', {}],
    ['POST', '/api/media/playground/generations/anything/transfer', { body: '{}' }],
    ['DELETE', '/api/media/playground/generations/anything', {}],
  ];

  it('rejects a browser cross-origin request on every endpoint', async () => {
    const headers = { origin: 'http://evil.example' };

    for (const [method, requestPath, init] of guardedEndpoints) {
      const response = await fetch(url(requestPath), {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        ...init,
      });
      expect(response.status, `${method} ${requestPath}`).toBe(403);
      const payload = await response.json() as { error?: unknown };
      // 这一层由全局 `/api` 来源中间件回答，它的信封是历史形状（`error` 为
      // 字符串）；端点自己的守卫在后面一条用例里单独验证。
      expect(payload.error, `${method} ${requestPath}`).toBeTruthy();
    }
  }, 60_000);

  it('guards every endpoint itself, not just the /api origin middleware', async () => {
    // 没有 Origin 头的请求会穿过全局中间件（它只拦浏览器来源），所以这一条落在
    // 端点自己的 `isLocalSameOrigin` 上：伪造一个非本机 Host 就会被它拦住，而且
    // 回的是嵌套信封——CLI 的退出码分类靠它拿 code。
    for (const [method, requestPath] of guardedEndpoints) {
      const response = await rawRequest(method, requestPath, {
        host: 'evil.example',
        'content-type': 'application/json',
      });
      expect(response.status, `${method} ${requestPath}`).toBe(403);
      expect(JSON.parse(response.body).error.code, `${method} ${requestPath}`)
        .toBe('FORBIDDEN');
    }
  }, 60_000);

  it('validates the generate request at the boundary', async () => {
    const cases: Array<Record<string, unknown>> = [
      { prompt: 'x', surface: 'video' },
      { prompt: 'x', model: 'some-other-model' },
      { prompt: '   ' },
      { prompt: 'x', images: ['ok.png', 42] },
    ];
    for (const body of cases) {
      const response = await fetch(url('/api/media/playground/generate'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ surface: 'image', model: 'custom-image', ...body }),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await response.json() as any).error?.code).toBe('BAD_REQUEST');
    }

    const missingProject = await generate({ prompt: 'x', targetProjectId: 'no-such-project' });
    expect(missingProject.status).toBe(400);
    expect(missingProject.payload.error.code).toBe('PROJECT_NOT_FOUND');
  }, 60_000);

  it('keeps the scratch directory layout to artifacts plus uploads/', async () => {
    // 这一条是"落点只有两个"的守卫：产物在 Playground 根、参考图在 uploads/，
    // 不该有第三种位置（例如 cwd 兜底写出的文件）。
    await fsp.mkdir(playgroundUploadsDir(), { recursive: true });
    const generated = await generate({ prompt: 'Layout', modelOverride: 'playground-model' });
    const entries = await fsp.readdir(playgroundDir(), { withFileTypes: true });
    const names = entries.map((entry) => entry.name);
    expect(names).toContain(`${generated.payload.id}-1.png`);
    expect(entries.every((entry) => entry.isFile() || entry.name === 'uploads')).toBe(true);
  }, 60_000);

  /** 轮询到第一张 `running` 卡片出现（provider 被夹具拖慢时它必然存在）。 */
  async function waitForRunningRow(timeoutMs = 10_000): Promise<{ id: string }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const listed = await listGenerations('?target=scratch&limit=5');
      const running = (listed.payload.generations ?? []).find(
        (row: any) => row.status === 'running',
      );
      if (running) return running;
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error('no running generation row appeared');
  }
});
