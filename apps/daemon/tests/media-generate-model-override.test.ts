// Gap-fill spec — `od media generate` must accept --model-override <model>.
//
// AGENTS.md (Capability exposure / UI-CLI dual-track) + apps/daemon/AGENTS.md
// (CLI and Surface Parity): a user-facing capability reachable from the web UI
// must be reachable from `od` too.
//
// The direct-image workbench (apps/web ImageWorkbench) posts
// {"model":"custom-image","modelOverride":"<the model the endpoint serves>"},
// and handleGenerate already forwards modelOverride to the renderer, where it
// wins over the provider config and the catalog alias. The CLI had no such flag
// and never wrote the field, so a user who filled Base URL + API key in
// Settings → Media but left the provider model empty could render from the UI
// and still get "Custom Image API model required" (exit 4) from the CLI.
//
// Live end-to-end: spawn the real src/cli.ts against a fake daemon that records
// the POST body, and assert the flag reached the media/generate endpoint.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const daemonRoot = fileURLToPath(new URL('..', import.meta.url));
const cliEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

let server: http.Server | undefined;
let baseUrl = '';
let seen: Array<{ url: string; body: string }> = [];

beforeEach(async () => {
  seen = [];
  server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', body });
      if (req.method === 'POST' && (req.url ?? '').includes('/media/generate')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ taskId: 'task-1', status: 'queued' }));
        return;
      }
      if ((req.url ?? '').includes('/media/tasks/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'done', file: { name: 'out.png', size: 3 } }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

async function runCli(extraArgs: string[]): Promise<void> {
  const args = [
    'media', 'generate',
    '--surface', 'image',
    '--model', 'custom-image',
    '--prompt', 'A geometric poster',
    '--daemon-url', baseUrl,
    ...extraArgs,
  ];
  const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
      cwd: daemonRoot,
      env: { ...process.env, OD_PROJECT_ID: 'p1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ code: exitCode ?? -1, stderr }));
  });
  // The fake daemon resolves both /media/generate and the /media/tasks poll, so
  // the CLI must run the whole flow to a clean exit (exit 2 here would mean the
  // flag was rejected as unknown before any POST).
  expect(code, `od media generate exited ${code}; stderr:\n${stderr}`).toBe(0);
}

function lastGenerateBody(): Record<string, unknown> {
  const gen = seen.find((r) => r.url.includes('/media/generate'));
  expect(gen, 'media/generate was called').toBeTruthy();
  return JSON.parse(gen!.body);
}

describe('od media generate --model-override', () => {
  it('passes the endpoint model through as body.modelOverride', async () => {
    await runCli(['--model-override', 'endpoint-served-model']);

    const sent = lastGenerateBody();
    // The catalog placeholder stays in `model`; the endpoint's own wire name
    // travels separately, exactly as the workbench sends it.
    expect(sent.model).toBe('custom-image');
    expect(sent.modelOverride).toBe('endpoint-served-model');
  });

  it('omits modelOverride when the flag is not given', async () => {
    await runCli([]);

    const sent = lastGenerateBody();
    expect(sent).not.toHaveProperty('modelOverride');
  });
});
