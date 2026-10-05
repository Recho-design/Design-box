import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase } from '../../src/db.js';
import {
  getPlaygroundGeneration,
  insertPlaygroundGeneration,
} from '../../src/media/playground-store.js';
import { startServer } from '../../src/server.js';
import {
  ONE_BY_ONE_GIF_B64,
  createProject,
  importFolderProject,
  multipartBody,
  playgroundUploadsDir,
  startPlaygroundHarness,
  type PlaygroundHarness,
} from './playground-harness.js';

/**
 * 参考图上传、scratch → 项目转存，以及 daemon 启动时的 `running` 清扫。
 */
describe('media playground uploads and transfer', () => {
  let harness: PlaygroundHarness;

  beforeAll(async () => {
    harness = await startPlaygroundHarness();
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  });

  function url(requestPath: string): string {
    return `${harness.baseUrl}${requestPath}`;
  }

  // `payload: any` 与同目录的 generate-count-batch.test.ts 一致：成功是 DTO 行，
  // 失败是嵌套信封，两种形状在同一条断言里混用，测试里如实放宽。
  async function upload(
    fileName: string,
    bytes: Buffer,
    targetProjectId?: string,
  ): Promise<{ status: number; payload: any }> {
    const form = multipartBody(
      fileName,
      bytes,
      targetProjectId ? { targetProjectId } : {},
    );
    const response = await fetch(url('/api/media/playground/uploads'), {
      method: 'POST',
      headers: { 'content-type': form.contentType },
      body: form.body,
    });
    return { status: response.status, payload: await response.json() };
  }

  async function generate(
    body: Record<string, unknown>,
  ): Promise<{ status: number; payload: any }> {
    const response = await fetch(url('/api/media/playground/generate'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ surface: 'image', model: 'custom-image', ...body }),
    });
    return { status: response.status, payload: await response.json() };
  }

  it('accepts a real image, sanitizes the name and keeps the magic-derived extension', async () => {
    const gif = Buffer.from(ONE_BY_ONE_GIF_B64, 'base64');
    // 名字里带路径分隔符与空格：净化后必须只剩一个安全的 basename，扩展名以
    // 字节为准（这里其实是 GIF 字节，名字却一个扩展名都没给）。
    const { status, payload } = await upload('..\\..\\odd name', gif);

    expect(status, JSON.stringify(payload)).toBe(201);
    expect(payload.name.startsWith('uploads/')).toBe(true);
    const relative = payload.name.slice('uploads/'.length);
    expect(relative).not.toContain('/');
    expect(relative).not.toContain('\\');
    expect(relative.endsWith('.gif')).toBe(true);
    expect(existsSync(path.join(playgroundUploadsDir(), relative))).toBe(true);
  }, 60_000);

  it('rejects bytes that are not a known image format', async () => {
    const { status, payload } = await upload('notes.png', Buffer.from('just some text, not an image'));

    // 未知魔数一律拒绝，绝不落成默认的 .png（sniffImageExt 的默认分支）。
    expect(status, JSON.stringify(payload)).toBe(415);
    expect(payload.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  }, 60_000);

  it('rejects a reference image above the 16MB read limit', async () => {
    const tooBig = Buffer.alloc(16 * 1024 * 1024 + 1);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(tooBig);

    const { status, payload } = await upload('huge.png', tooBig);

    expect(status, JSON.stringify(payload)).toBe(413);
    expect(payload.error.code).toBe('PAYLOAD_TOO_LARGE');
  }, 120_000);

  it('uploads into a project target and reports a root-relative reference', async () => {
    const { projectId, baseDir } = await importFolderProject(harness.baseUrl);
    const png = Buffer.from(ONE_BY_ONE_GIF_B64, 'base64');

    const { status, payload } = await upload('ref image', png, projectId);
    expect(status, JSON.stringify(payload)).toBe(201);
    // 项目目标的引用名就是项目根下的相对路径（没有 uploads/ 前缀），因为生成
    // 时是按同一个根解析参考图的。
    expect(payload.name).toMatch(/^ref-image[\w.-]*\.gif$/);
    expect(existsSync(path.join(baseDir, payload.name))).toBe(true);

    harness.providerBodies.length = 0;
    const generated = await generate({
      prompt: 'Use the uploaded reference',
      modelOverride: 'playground-model',
      targetProjectId: projectId,
      images: [payload.name],
    });
    expect(generated.status, JSON.stringify(generated.payload)).toBe(200);
    expect(generated.payload.files[0].error).toBeUndefined();
  }, 60_000);

  it('refuses an upload aimed at a project that is not there', async () => {
    const png = Buffer.from(ONE_BY_ONE_GIF_B64, 'base64');
    const { status, payload } = await upload('orphan', png, 'no-such-project');

    // 项目不存在就是 400（generate 同理），而且一个字节都不落盘：目标解析失败在
    // 写文件之前。
    expect(status, JSON.stringify(payload)).toBe(400);
    expect(payload.error.code).toBe('PROJECT_NOT_FOUND');
    const written = await fsp.readdir(playgroundUploadsDir()).catch(() => []);
    expect(written.filter((name) => name.startsWith('orphan'))).toEqual([]);
  }, 60_000);

  it('resolves a scratch upload as a reference image', async () => {
    const png = Buffer.from(ONE_BY_ONE_GIF_B64, 'base64');
    const uploaded = await upload('scratch ref', png);
    expect(uploaded.status).toBe(201);

    harness.providerBodies.length = 0;
    const generated = await generate({
      prompt: 'Iterate from a scratch upload',
      modelOverride: 'playground-model',
      images: [uploaded.payload.name],
    });
    expect(generated.status, JSON.stringify(generated.payload)).toBe(200);
    expect(generated.payload.files[0].error).toBeUndefined();
  }, 60_000);

  it('transfers into the imported project, dedupes collisions and stays idempotent', async () => {
    const { projectId, baseDir } = await importFolderProject(harness.baseUrl);
    const generated = await generate({
      prompt: 'Transfer me',
      modelOverride: 'playground-model',
      count: 2,
    });
    expect(generated.status).toBe(200);
    const generationId = generated.payload.id;
    // 目的目录里先占住第一个产物的名字：转存不许静默覆盖。
    await fsp.writeFile(path.join(baseDir, `${generationId}-1.png`), 'occupied by the user');

    const first = await fetch(url(`/api/media/playground/generations/${generationId}/transfer`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    expect(first.status).toBe(200);
    const firstPayload = await first.json() as any;
    expect(firstPayload.transferredFiles).toEqual([
      `${generationId}-1-1.png`,
      `${generationId}-2.png`,
    ]);
    for (const name of firstPayload.transferredFiles) {
      expect(existsSync(path.join(baseDir, name))).toBe(true);
    }
    expect(await fsp.readFile(path.join(baseDir, `${generationId}-1.png`), 'utf8'))
      .toBe('occupied by the user');
    // scratch 原件保留。
    expect(
      existsSync(path.join(path.dirname(playgroundUploadsDir()), `${generationId}-1.png`)),
    ).toBe(true);

    // 重复转存同一项目：幂等，不再复制出 `-1` 副本。
    const again = await fetch(url(`/api/media/playground/generations/${generationId}/transfer`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    expect(again.status).toBe(200);
    const againPayload = await again.json() as any;
    expect(againPayload.transferredFiles).toEqual(firstPayload.transferredFiles);
    expect(againPayload.generation.params.transfers).toEqual([
      { projectId, files: firstPayload.transferredFiles },
    ]);
  }, 60_000);

  it('refuses to transfer a row without artifacts and an unknown project', async () => {
    harness.failCalls(() => true);
    const failed = await generate({ prompt: 'Nothing landed', modelOverride: 'playground-model' });
    harness.failCalls(() => false);
    const { projectId } = await importFolderProject(harness.baseUrl);

    const noFiles = await fetch(
      url(`/api/media/playground/generations/${failed.payload.id}/transfer`),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId }),
      },
    );
    expect(noFiles.status).toBe(400);

    const unknownProject = await fetch(url('/api/media/playground/generations/missing/transfer'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    expect(unknownProject.status).toBe(404);

    const good = await generate({ prompt: 'Transfer target', modelOverride: 'playground-model' });
    const missingProject = await fetch(
      url(`/api/media/playground/generations/${good.payload.id}/transfer`),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 'no-such-project' }),
      },
    );
    expect(missingProject.status).toBe(404);
    expect((await missingProject.json() as any).error.code).toBe('PROJECT_NOT_FOUND');
  }, 60_000);

  it('leaves the project copy alone when a transferred row is deleted', async () => {
    const { projectId, baseDir } = await importFolderProject(harness.baseUrl);
    const generated = await generate({ prompt: 'Copy survives', modelOverride: 'playground-model' });
    const transferred = await fetch(
      url(`/api/media/playground/generations/${generated.payload.id}/transfer`),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId }),
      },
    );
    const copied = (await transferred.json() as any).transferredFiles[0];

    const deleted = await fetch(
      url(`/api/media/playground/generations/${generated.payload.id}`),
      { method: 'DELETE' },
    );
    expect(deleted.status).toBe(200);
    // 转存副本在项目里不受影响（删的是历史行与 scratch 产物）。
    expect(existsSync(path.join(baseDir, copied))).toBe(true);
    expect(
      existsSync(path.join(path.dirname(playgroundUploadsDir()), `${generated.payload.id}-1.png`)),
    ).toBe(false);
  }, 60_000);

  it('lands a plain project target inside the projects directory', async () => {
    const projectId = await createProject(harness.baseUrl, 'plain');
    const generated = await generate({
      prompt: 'Plain project target',
      modelOverride: 'playground-model',
      targetProjectId: projectId,
    });
    expect(generated.status).toBe(200);
    expect(
      existsSync(
        path.join(process.env.OD_DATA_DIR!, 'projects', projectId, generated.payload.files[0].name),
      ),
    ).toBe(true);
  }, 60_000);

  // 放在最后：它要在同一个进程里再起一个 daemon（registrar 的启动清扫只在那
  // 一刻发生），并且收尾时会关掉共享的 SQLite 连接。
  it('sweeps rows left running by a previous daemon process', async () => {
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required by the daemon test harness');
    const db = openDatabase(process.cwd(), { dataDir });
    const interrupted = insertPlaygroundGeneration(db, {
      id: `gen-${Date.now()}-interrupted`,
      targetProjectId: null,
      surface: 'image',
      model: 'custom-image',
      status: 'running',
      files: [],
    });
    expect(getPlaygroundGeneration(db, interrupted.id)?.status).toBe('running');

    // 启动即清扫：没有进程会再改写这一行，留着就是一张永远转圈的卡片。
    const started = (await startServer({ port: 0, returnServer: true })) as {
      server: http.Server;
    };
    await new Promise<void>((done) => started.server.close(() => done()));

    expect(getPlaygroundGeneration(db, interrupted.id)).toMatchObject({
      status: 'failed',
      error: 'generation interrupted by daemon restart',
    });
    closeDatabase();
  }, 60_000);
});
