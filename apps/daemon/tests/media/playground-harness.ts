import fsp from 'node:fs/promises';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

import { closeDatabase } from '../../src/db.js';
import { startServer } from '../../src/server.js';

/**
 * Playground 路由级测试的共用夹具：一个真的 daemon + 一个本机的 OpenAI 兼容
 * provider 桩。
 *
 * provider 必须是真 HTTP 而不是 mock `fetch`：客户端到 daemon 那一次、daemon
 * 到 provider 那一次，两条链路都要真的跑过，否则测不到路由层的编排（落盘目录、
 * 命名、per-slot 结果）。
 */

/** 1×1 PNG。 */
export const ONE_BY_ONE_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2uoAAAAASUVORK5CYII=';

/** 1×1 GIF（另一张真图，用于"参考图来自上一轮产物"的链路）。 */
export const ONE_BY_ONE_GIF_B64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export interface PlaygroundHarness {
  baseUrl: string;
  /** provider 收到的每个请求体，按到达顺序。 */
  providerBodies: Array<Record<string, unknown>>;
  /** 让第 N 次（1-based）provider 调用失败。 */
  failCalls(rule: (callNumber: number) => boolean): void;
  /** 每次 provider 调用前的延迟，用来观察进行中的 `running` 行。 */
  delayProvider(ms: number): void;
  close(): Promise<void>;
}

export async function startPlaygroundHarness(): Promise<PlaygroundHarness> {
  let shouldFailCall: (callNumber: number) => boolean = () => false;
  let providerDelayMs = 0;
  const providerBodies: Array<Record<string, unknown>> = [];
  const tempDirs: string[] = [];

  const providerServer = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      void respond(req, res, body);
    });
  });

  async function respond(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string,
  ): Promise<void> {
    providerBodies.push(safeParse(body));
    if (providerDelayMs > 0) {
      await new Promise((done) => setTimeout(done, providerDelayMs));
    }
    if (shouldFailCall(providerBodies.length)) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'slot rejected by the fixture' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: ONE_BY_ONE_PNG_B64 }] }));
  }

  await new Promise<void>((done) => providerServer.listen(0, '127.0.0.1', () => done()));
  const address = providerServer.address();
  if (!address || typeof address === 'string') throw new Error('provider server has no port');

  // 凭据落在独立目录，不污染同进程里其它套件共享的数据目录。
  const configDir = await fsp.mkdtemp(path.join(tmpdir(), 'od-playground-config-'));
  tempDirs.push(configDir);
  vi.stubEnv('OD_MEDIA_CONFIG_DIR', configDir);

  const started = (await startServer({ port: 0, returnServer: true })) as {
    url: string;
    server: http.Server;
  };
  const configured = await fetch(`${started.url}/api/media/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providers: {
        'custom-image': {
          apiKey: 'playground-test-key',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          model: 'playground-provider-model',
        },
      },
    }),
  });
  if (!configured.ok) throw new Error('the custom-image provider must be configurable');

  return {
    baseUrl: started.url,
    providerBodies,
    failCalls(rule) {
      shouldFailCall = rule;
    },
    delayProvider(ms) {
      providerDelayMs = ms;
    },
    async close() {
      await new Promise<void>((done) => started.server.close(() => done()));
      await new Promise<void>((done) => providerServer.close(() => done()));
      for (const dir of tempDirs.splice(0)) {
        await fsp.rm(dir, { recursive: true, force: true });
      }
      vi.unstubAllEnvs();
      closeDatabase();
    },
  };
}

/** 建一个普通（非导入型）项目，返回它的 id。 */
export async function createProject(baseUrl: string, name = 'playground'): Promise<string> {
  const projectId = `proj-${randomUUID()}`;
  const created = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: projectId, name: `${name} ${projectId}` }),
  });
  if (!created.ok) throw new Error(`project create failed: ${created.status}`);
  return projectId;
}

/** 导入一个真实的本地文件夹，返回项目 id 与它的 `metadata.baseDir`。 */
export async function importFolderProject(
  baseUrl: string,
): Promise<{ projectId: string; baseDir: string }> {
  const baseDir = await fsp.mkdtemp(path.join(tmpdir(), 'od-playground-folder-'));
  const response = await fetch(`${baseUrl}/api/import/folder`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseDir }),
  });
  if (!response.ok) throw new Error(`folder import failed: ${response.status}`);
  const body = (await response.json()) as {
    project: { id: string; metadata?: { baseDir?: string } };
  };
  const stored = body.project.metadata?.baseDir;
  if (!stored) throw new Error('folder import did not store metadata.baseDir');
  return { projectId: body.project.id, baseDir: stored };
}

/** scratch 产物目录：与 daemon 的派生规则一致（RUNTIME_DATA_DIR/media-playground）。 */
export function playgroundDir(): string {
  return path.join(process.env.OD_DATA_DIR!, 'media-playground');
}

export function playgroundUploadsDir(): string {
  return path.join(playgroundDir(), 'uploads');
}

export function projectDir(projectId: string): string {
  return path.join(process.env.OD_DATA_DIR!, 'projects', projectId);
}

/** 构造一个 multipart 请求体（daemon 侧用 multer 解析，字段名固定 `file`）。 */
export function multipartBody(
  fileName: string,
  bytes: Buffer,
  fields: Record<string, string> = {},
): { body: Buffer; contentType: string } {
  const boundary = `----odplayground${randomUUID().replace(/-/g, '')}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n',
  ));
  parts.push(bytes);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function safeParse(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return {};
  }
}
