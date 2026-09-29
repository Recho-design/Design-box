import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { duplicatePluginExampleIntoProject } from '../src/plugins/duplicate-project.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function makePreviewPlugin(root: string, id = 'duplicate-fixture'): Promise<InstalledPluginRecord> {
  const pluginRoot = path.join(root, id);
  await mkdir(path.join(pluginRoot, 'preview'), { recursive: true });
  await writeFile(
    path.join(pluginRoot, 'preview', 'index.html'),
    '<!doctype html><html><body><h1>Duplicable</h1></body></html>',
    'utf8',
  );
  return {
    id,
    title: 'Duplicate Fixture',
    fsPath: pluginRoot,
    manifest: {
      name: id,
      title: 'Duplicate Fixture',
      od: { preview: { entry: 'preview/index.html' } },
    },
  } as InstalledPluginRecord;
}

describe('plugin project duplication', () => {
  it.skipIf(process.platform === 'win32')(
    'rejects duplicates that would skip a required symlinked file',
    async () => {
      const root = await makeTempRoot('od-plugin-duplicate-helper-');
      const projectsRoot = path.join(root, 'projects');
      const plugin = await makePreviewPlugin(root);
      await writeFile(path.join(plugin.fsPath, 'preview', 'target.txt'), 'asset', 'utf8');
      await symlink('target.txt', path.join(plugin.fsPath, 'preview', 'linked.txt'));

      await expect(
        duplicatePluginExampleIntoProject({
          plugin,
          projectsRoot,
          projectId: 'symlink-project',
          metadata: { kind: 'prototype' },
          assembleExample: (templateHtml) => templateHtml,
        }),
      ).rejects.toMatchObject({
        status: 422,
        code: 'DUPLICATE_COPY_INCOMPLETE',
      });
    },
  );
});
