import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// 这个文件在 `tests/media/` 下，比 `tests/*.test.ts` 深一层，所以 `..` 要多走一次
// 才回到 daemon 根（cwd 错了 `tsx` 就解析不到）。
const daemonRoot = fileURLToPath(new URL('../..', import.meta.url));
const cliEntry = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));

/**
 * `od media playground` 的双轨补齐（spec §5.5）。
 *
 * 层次选择：路由级测试已经钉住了六个端点的行为（playground-routes /
 * playground-upload-transfer），这里只回答另一个问题——CLI 那一面**把哪条请求
 * 发出去了**、把响应**印成了什么**。所以夹具是一个记录请求的假 daemon，而不是
 * 真 daemon：真 daemon 只会把"CLI 拼错了参数"藏在一次成功的生成里。
 */

/** CLI 一次调用的结果；`code` 为 0 表示成功。 */
interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RecordedRequest {
  method: string;
  url: string;
  contentType: string;
  body: string;
}

let server: http.Server | undefined;
let baseUrl = '';
let requests: RecordedRequest[] = [];
/** 假 daemon 的 `GET /generations` 回调，各用例按需要摆好历史行。 */
let history: any[] = [];
/** `generate` 的响应行，默认是成功行。 */
let generateRow: any = null;
/** 置为非空时，所有请求都按这个状态与嵌套信封回绝。 */
let refusal: { status: number; body: unknown } | null = null;
let workDir = '';

const ARTIFACT_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

function scratchRow(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'gen-1',
    targetProjectId: null,
    surface: 'image',
    model: 'custom-image',
    modelOverride: 'model-x',
    prompt: 'A geometric poster',
    params: { count: 1 },
    status: 'done',
    files: [{ name: 'gen-1-1.png', size: ARTIFACT_BYTES.length, mime: 'image/png' }],
    createdAt: 1,
    ...overrides,
  };
}

beforeAll(async () => {
  workDir = await fsp.mkdtemp(path.join(tmpdir(), 'od-playground-cli-'));
});

afterAll(async () => {
  await fsp.rm(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
  requests = [];
  history = [scratchRow()];
  generateRow = scratchRow({ params: { count: 2, aspect: '16:9', quality: 'high' } });
  refusal = null;

  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      requests.push({
        method: req.method ?? '',
        url,
        contentType: String(req.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      });

      if (refusal) {
        res.writeHead(refusal.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(refusal.body));
        return;
      }
      if (req.method === 'POST' && url === '/api/media/playground/generate') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(generateRow));
        return;
      }
      if (req.method === 'POST' && url === '/api/media/playground/uploads') {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: 'uploads/ref-1.png' }));
        return;
      }
      if (req.method === 'GET' && url.startsWith('/api/media/playground/generations')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ generations: history, nextBefore: null }));
        return;
      }
      if (req.method === 'GET' && url.startsWith('/api/media/playground/files/')) {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(ARTIFACT_BYTES);
        return;
      }
      if (req.method === 'GET' && url.startsWith('/api/projects/')) {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(ARTIFACT_BYTES);
        return;
      }
      if (req.method === 'POST' && url.endsWith('/transfer')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          generation: history[0],
          transferredFiles: ['gen-1-1.png'],
        }));
        return;
      }
      if (req.method === 'DELETE' && url.startsWith('/api/media/playground/generations/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no such stub route' } }));
    });
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', () => done()));
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((done) => server!.close(() => done()));
  server = undefined;
});

/** 跑真的 `src/cli.ts`（`--daemon-url` 指向上面的假 daemon）。 */
function runCli(args: string[], input?: string): Promise<CliResult> {
  return spawnCli([...args, '--daemon-url', baseUrl], input);
}

/**
 * 不传 `--daemon-url` 的那一面。
 *
 * `runMediaPlayground` 取「第一个不像 flag 的参数」当子命令，而 flag 的**值**也
 * 长得不像 flag——所以想测「没有子命令」就只能真的不给它任何 flag。
 */
function runCliBare(args: string[]): Promise<CliResult> {
  return spawnCli(args);
}

function spawnCli(args: string[], input?: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', cliEntry, 'media', 'playground', ...args],
      {
        cwd: daemonRoot,
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          OD_PROJECT_ID: '',
          OD_WORKSPACE_ID: '',
          OD_WORKSPACE_MEMBER_ID: '',
        },
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      },
    );
    if (input !== undefined) {
      child.stdin!.end(input);
    }
    let stdout = '';
    let stderr = '';
    // `stdio` 是条件数组，类型上 stdout/stderr 可能为 null；这套 spawn 里它们
    // 恒为 pipe。
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk) => (stdout += chunk));
    child.stderr!.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe('od media playground', () => {
  it('posts the documented generate body and prints the full row', async () => {
    const result = await runCli([
      'generate',
      '--project', 'proj-1',
      '--model', 'custom-image',
      '--model-override', 'model-x',
      '--count', '2',
      '--aspect', '16:9',
      '--quality', 'high',
      '--image', 'uploads/a.png',
      '--image', 'uploads/b.png',
      '--prompt-file', '-',
    ], 'A geometric poster');

    expect(result.code, result.stderr).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toBe('/api/media/playground/generate');
    expect(JSON.parse(requests[0]!.body)).toEqual({
      surface: 'image',
      model: 'custom-image',
      prompt: 'A geometric poster',
      targetProjectId: 'proj-1',
      modelOverride: 'model-x',
      aspect: '16:9',
      quality: 'high',
      count: 2,
      images: ['uploads/a.png', 'uploads/b.png'],
    });
    // `--json` 行形状与 HTTP 响应一致：这里就是那一行。
    expect(JSON.parse(result.stdout)).toMatchObject({ id: 'gen-1', status: 'done' });
  }, 60_000);

  it('omits the project for a scratch target and still exits 4 when every slot failed', async () => {
    generateRow = scratchRow({
      status: 'failed',
      error: 'slot rejected by the fixture',
      files: [{ name: 'gen-1-1.png', error: 'slot rejected by the fixture' }],
    });

    const result = await runCli(['generate', '--model', 'custom-image', '--prompt', 'Doomed']);

    expect(JSON.parse(requests[0]!.body).targetProjectId).toBeUndefined();
    // 行照常印出来（含 per-slot 失败），"所以呢"补在退出码与 stderr 上。
    expect(JSON.parse(result.stdout)).toMatchObject({ id: 'gen-1', status: 'failed' });
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stderr).error.code).toBe('MEDIA_GENERATION_FAILED');
  }, 60_000);

  it('rejects a generate with no model or prompt before touching the network', async () => {
    const noModel = await runCli(['generate', '--prompt', 'x']);
    expect(noModel.code).toBe(2);
    expect(noModel.stderr).toContain('--model required');

    const noPrompt = await runCli(['generate', '--model', 'custom-image']);
    expect(noPrompt.code).toBe(2);
    expect(noPrompt.stderr).toContain('--prompt or --prompt-file <path|-> required');

    expect(requests).toHaveLength(0);
  }, 60_000);

  it('uploads local files into the target and prints the reference name', async () => {
    const refA = path.join(workDir, 'ref a.png');
    const refB = path.join(workDir, 'ref-b.png');
    await fsp.writeFile(refA, ARTIFACT_BYTES);
    await fsp.writeFile(refB, ARTIFACT_BYTES);

    const result = await runCli(['upload', refA, refB, '--project', 'proj-1']);

    expect(result.code, result.stderr).toBe(0);
    // 一次请求一个文件：端点契约就是 `{name}`，两个文件就是两行。
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/api/media/playground/uploads');
      expect(request.contentType.startsWith('multipart/form-data; boundary=')).toBe(true);
      expect(request.body).toContain('name="targetProjectId"');
      expect(request.body).toContain('proj-1');
    }
    expect(result.stdout).toBe('uploads/ref-1.png\nuploads/ref-1.png\n');
  }, 60_000);

  it('lists with the documented query and prints one row per generation', async () => {
    history = [scratchRow({ id: 'gen-2', status: 'running', prompt: 'x'.repeat(60) })];

    const asJson = await runCli(['list', '--json', '--limit', '3', '--target', 'scratch']);
    expect(asJson.code, asJson.stderr).toBe(0);
    expect(requests[0]!.url).toBe('/api/media/playground/generations?limit=3&target=scratch');
    expect(JSON.parse(asJson.stdout).generations[0].id).toBe('gen-2');

    requests = [];
    const asTable = await runCli(['list', '--target', 'proj-9']);
    expect(requests[0]!.url).toBe('/api/media/playground/generations?target=proj-9');
    const [id, status, target, files, prompt] = asTable.stdout.trim().split('\t');
    expect({ id, status, target, files }).toEqual({
      id: 'gen-2',
      status: 'running',
      target: 'scratch',
      files: '1',
    });
    // 长 prompt 截断成一行摘要，不把整段提示词倒进终端。
    expect(prompt).toBe(`${'x'.repeat(40)}…`);
  }, 60_000);

  it('downloads a scratch artifact into --out and reports the path', async () => {
    const outDir = await fsp.mkdtemp(path.join(workDir, 'out-'));
    const result = await runCli(['download', 'gen-1', '--out', outDir, '--json']);

    expect(result.code, result.stderr).toBe(0);
    // 先按 id 找回那一行，再取字节：端点面没有 GET /generations/:id。
    expect(requests.map((request) => request.url)).toEqual([
      '/api/media/playground/generations?limit=200',
      '/api/media/playground/files/gen-1/0',
    ]);
    const written = path.join(outDir, 'gen-1-1.png');
    expect(JSON.parse(result.stdout)).toEqual({ path: written });
    await expect(fsp.readFile(written)).resolves.toEqual(ARTIFACT_BYTES);
  }, 60_000);

  it('downloads a project artifact through the project file API', async () => {
    history = [scratchRow({ targetProjectId: 'proj-1' })];
    const outDir = await fsp.mkdtemp(path.join(workDir, 'out-project-'));
    const result = await runCli(['download', 'gen-1', '--out', outDir]);

    expect(result.code, result.stderr).toBe(0);
    // 项目行不能走 playground 的 files 端点（那个端点只服务 scratch）。
    expect(requests[1]!.url).toBe('/api/projects/proj-1/files/gen-1-1.png');
    expect(existsSync(path.join(outDir, 'gen-1-1.png'))).toBe(true);
  }, 60_000);

  it('transfers and deletes with the documented requests', async () => {
    const transferred = await runCli(['transfer', 'gen-1', '--project', 'proj-1']);
    expect(transferred.code, transferred.stderr).toBe(0);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toBe('/api/media/playground/generations/gen-1/transfer');
    expect(JSON.parse(requests[0]!.body)).toEqual({ projectId: 'proj-1' });
    expect(transferred.stdout).toBe('gen-1-1.png\n');

    requests = [];
    const deleted = await runCli(['delete', 'gen-1']);
    expect(deleted.code, deleted.stderr).toBe(0);
    expect(requests[0]!.method).toBe('DELETE');
    expect(requests[0]!.url).toBe('/api/media/playground/generations/gen-1');
    expect(deleted.stdout).toBe('deleted gen-1\n');
  }, 60_000);

  it('classifies a daemon refusal by the nested envelope code and exits 4', async () => {
    refusal = {
      status: 409,
      body: { error: { code: 'GENERATION_RUNNING', message: 'generation gen-1 is still running' } },
    };

    const result = await runCli(['delete', 'gen-1']);

    // 嵌套信封是契约：CLI 的退出码分类靠它拿 code，`{error: string}` 平形状会让
    // 这里退化成笼统的 MEDIA_DISPATCH_FAILED。
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: 'GENERATION_RUNNING' });
  }, 60_000);

  it('prints usage for a missing subcommand and rejects an unknown one', async () => {
    const help = await runCliBare([]);
    expect(help.code, help.stderr).toBe(0);
    expect(help.stdout).toContain('od media playground generate');

    const unknown = await runCliBare(['frobnicate']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('unknown subcommand: od media playground frobnicate');
    expect(requests).toHaveLength(0);
  }, 60_000);
});
