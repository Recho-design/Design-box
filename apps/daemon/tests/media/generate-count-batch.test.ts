import fsp from 'node:fs/promises';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { closeDatabase } from '../../src/db.js';
import { startServer } from '../../src/server.js';

/**
 * 直接生图工作台的多图批次:一次请求出 N 张(count > 1),部分失败不连坐。
 *
 * provider 用本机起的一个 OpenAI 兼容桩,而不是 mock `fetch` —— 客户端到 daemon
 * 那一次 HTTP 调用必须走真实链路,否则测不到路由层的编排。
 */
const ONE_BY_ONE_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2uoAAAAASUVORK5CYII=';

describe('media generate count batch', () => {
  let baseUrl = '';
  let server: http.Server | null = null;
  let providerServer: http.Server | null = null;
  /** provider 收到的每个请求体,按到达顺序记录。 */
  let providerBodies: Array<Record<string, unknown>> = [];
  /** 该次调用(1-based 全局序号)是否要让 provider 返回 500。 */
  let shouldFailCall: (callNumber: number) => boolean = () => false;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    providerServer = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
          providerBodies.push(parsed);
        } catch {
          // 记不下就当它没来过;被测路径会因此断言失败。
        }
        if (shouldFailCall(providerBodies.length)) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'slot rejected by the fixture' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: ONE_BY_ONE_PNG_B64 }] }));
      });
    });
    await new Promise<void>((done) => providerServer!.listen(0, '127.0.0.1', () => done()));
    const address = providerServer.address();
    if (!address || typeof address === 'string') throw new Error('provider server has no port');
    const providerUrl = `http://127.0.0.1:${address.port}/v1`;

    // 凭据放进独立目录,不污染同进程里其它套件共享的数据目录。
    const configDir = await fsp.mkdtemp(path.join(tmpdir(), 'od-count-batch-config-'));
    tempDirs.push(configDir);
    vi.stubEnv('OD_MEDIA_CONFIG_DIR', configDir);

    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;

    const configured = await fetch(`${baseUrl}/api/media/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: {
          'custom-image': {
            apiKey: 'count-batch-test-key',
            baseUrl: providerUrl,
            model: 'batch-provider-model',
          },
        },
      }),
    });
    expect(configured.ok, 'the custom-image provider must be configured').toBe(true);
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((done) => server!.close(() => done()));
    if (providerServer) await new Promise<void>((done) => providerServer!.close(() => done()));
    for (const dir of tempDirs.splice(0)) {
      await fsp.rm(dir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
    closeDatabase();
  });

  /** 建一个干净项目,免得上一条用例的文件影响这一条的落盘断言。 */
  async function createProject(): Promise<string> {
    const projectId = `proj-${randomUUID()}`;
    const created = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: `count batch ${projectId}` }),
    });
    expect(created.ok).toBe(true);
    return projectId;
  }

  /** 派发一次生成请求,返回状态码与响应体。 */
  async function generate(
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; payload: any }> {
    const resp = await fetch(`${baseUrl}/api/projects/${projectId}/media/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ surface: 'image', model: 'custom-image', ...body }),
    });
    return { status: resp.status, payload: await resp.json() };
  }

  function projectDir(projectId: string): string {
    return path.join(process.env.OD_DATA_DIR!, 'projects', projectId);
  }

  it('renders one file per slot and answers with the whole batch', async () => {
    const projectId = await createProject();
    providerBodies = [];

    const { status, payload } = await generate(projectId, {
      prompt: 'A set of three matching icons',
      output: 'icon.png',
      count: 3,
      modelOverride: 'workbench-image-model',
    });

    expect(status, JSON.stringify(payload)).toBe(200);
    expect(payload.files.map((file: any) => file.name)).toEqual([
      'icon-1.png',
      'icon-2.png',
      'icon-3.png',
    ]);
    for (const file of payload.files) {
      expect(file.error).toBeUndefined();
      expect(file.size).toBeGreaterThan(0);
      expect(existsSync(path.join(projectDir(projectId), file.name))).toBe(true);
    }
    // 每个槽位一次调用,且请求里的模型名一律是 override,不是配置里的那个。
    expect(providerBodies).toHaveLength(3);
    expect(providerBodies.map((body) => body.model)).toEqual([
      'workbench-image-model',
      'workbench-image-model',
      'workbench-image-model',
    ]);
  }, 60_000);

  it('auto-names the batch from the daemon side when no output is given', async () => {
    const projectId = await createProject();

    const { status, payload } = await generate(projectId, {
      prompt: 'Two unnamed slots',
      count: 2,
    });

    expect(status, JSON.stringify(payload)).toBe(200);
    const names = payload.files.map((file: any) => file.name);
    expect(new Set(names).size, `派生出来的名字撞车了: ${names.join(', ')}`).toBe(2);
    for (const name of names) {
      expect(name).toMatch(/-\d+\.png$/);
      expect(existsSync(path.join(projectDir(projectId), name))).toBe(true);
    }
  }, 60_000);

  it('keeps the single-image response shape and task flow for count 1', async () => {
    const projectId = await createProject();
    providerBodies = [];

    const { status, payload } = await generate(projectId, {
      prompt: 'A single hero image',
      output: 'hero.png',
      // 0 是"没有东西"的非法取值,必须落到一张,而不是空响应。
      count: 0,
    });

    expect(status).toBe(202);
    expect(payload.files).toBeUndefined();
    expect(typeof payload.taskId).toBe('string');

    let snap: any = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const waited = await fetch(`${baseUrl}/api/media/tasks/${payload.taskId}/wait`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timeoutMs: 2_000 }),
      });
      expect(waited.status).toBe(200);
      snap = await waited.json();
      if (snap.status === 'done' || snap.status === 'failed') break;
    }
    expect(snap?.status, JSON.stringify(snap)).toBe('done');
    expect(snap.file.name).toBe('hero.png');
    expect(providerBodies).toHaveLength(1);
    expect(existsSync(path.join(projectDir(projectId), 'hero.png'))).toBe(true);
  }, 60_000);

  it('reports the failed slot beside the images that did land', async () => {
    const projectId = await createProject();
    providerBodies = [];
    // 3 个槽位里让第 2 次 provider 调用失败:必须只剩那一个槽位带错误。
    shouldFailCall = (callNumber) => callNumber === 2;
    try {
      const { status, payload } = await generate(projectId, {
        prompt: 'Three slots, one of them rejected',
        output: 'spot.png',
        count: 3,
      });

      expect(status, JSON.stringify(payload)).toBe(200);
      expect(payload.files).toHaveLength(3);
      const failed = payload.files.filter((file: any) => file.error);
      const landed = payload.files.filter((file: any) => !file.error);
      expect(failed).toHaveLength(1);
      expect(landed).toHaveLength(2);
      expect(failed[0].error.length).toBeGreaterThan(0);
      for (const file of landed) {
        expect(existsSync(path.join(projectDir(projectId), file.name))).toBe(true);
      }
    } finally {
      shouldFailCall = () => false;
    }
  }, 60_000);

  it('fails the request when every slot fails', async () => {
    const projectId = await createProject();
    shouldFailCall = () => true;
    try {
      const { status, payload } = await generate(projectId, {
        prompt: 'Every slot is rejected',
        output: 'doomed.png',
        count: 2,
      });

      expect(status).toBe(502);
      expect(payload.error.code).toBe('MEDIA_GENERATION_FAILED');
      expect(existsSync(path.join(projectDir(projectId), 'doomed-1.png'))).toBe(false);
      expect(existsSync(path.join(projectDir(projectId), 'doomed-2.png'))).toBe(false);
    } finally {
      shouldFailCall = () => false;
    }
  }, 60_000);
});
