import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  deleteProject,
  insertProject,
  openDatabase,
} from '../../src/db.js';
import {
  deletePlaygroundGeneration,
  formatPlaygroundCursor,
  getPlaygroundGeneration,
  insertPlaygroundGeneration,
  listPlaygroundGenerations,
  migrateMediaPlaygroundGenerations,
  parsePlaygroundCursor,
  sweepRunningPlaygroundGenerations,
  toPlaygroundGeneration,
  updatePlaygroundGeneration,
} from '../../src/media/playground-store.js';

/**
 * `media_playground_generations` 的行级 CRUD 与启动清扫。
 *
 * 这一层刻意不走 HTTP：游标谓词、同毫秒 tie-break、级联删除这些事只有在直接
 * 读写行的时候才看得清楚。
 */
type TestDb = ReturnType<typeof openDatabase>;

let db: TestDb;

function openTestDb(): TestDb {
  const dataDir = process.env.OD_DATA_DIR;
  if (!dataDir) throw new Error('OD_DATA_DIR is required by the daemon test harness');
  return openDatabase(process.cwd(), { dataDir });
}

function insertScratch(overrides: Record<string, unknown> = {}) {
  return insertPlaygroundGeneration(db, {
    id: `gen-${randomUUID()}`,
    targetProjectId: null,
    surface: 'image',
    model: 'custom-image',
    modelOverride: 'fixture-model',
    prompt: 'a fixture prompt',
    params: { count: 1, aspect: '1:1' },
    status: 'running',
    files: [],
    ...overrides,
  });
}

describe('playground-store', () => {
  beforeEach(() => {
    db = openTestDb();
    // 同一个 vitest 进程共用一份数据目录，所以每条用例从空表开始。
    db.exec('DELETE FROM media_playground_generations');
  });

  afterAll(() => {
    closeDatabase();
  });

  it('creates the table idempotently and round-trips a row', () => {
    migrateMediaPlaygroundGenerations(db);
    migrateMediaPlaygroundGenerations(db);

    const row = insertScratch({
      files: [{ name: 'gen-1.png', size: 12, mime: 'image/png' }],
      status: 'done',
      params: { count: 2, aspect: '16:9', quality: 'high' },
    });
    expect(row.status).toBe('done');
    expect(getPlaygroundGeneration(db, row.id)).toMatchObject({
      id: row.id,
      targetProjectId: null,
      surface: 'image',
      model: 'custom-image',
      modelOverride: 'fixture-model',
      prompt: 'a fixture prompt',
      status: 'done',
      files: [{ name: 'gen-1.png', size: 12, mime: 'image/png' }],
      params: { count: 2, aspect: '16:9', quality: 'high' },
    });

    // 协议 DTO 不含内部 updatedAt。
    expect(toPlaygroundGeneration(row)).not.toHaveProperty('updatedAt');
  });

  it('updates a running row into its terminal state with per-slot failures', () => {
    const row = insertScratch();
    expect(row.status).toBe('running');

    const failed = updatePlaygroundGeneration(db, row.id, {
      status: 'failed',
      files: [{ name: 'gen-1.png', error: 'slot rejected' }],
      error: 'slot rejected',
    });
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'slot rejected',
      files: [{ name: 'gen-1.png', error: 'slot rejected' }],
    });
    // 未知 id 是 null，不是抛错：路由把它当成 404。
    expect(updatePlaygroundGeneration(db, 'missing', { status: 'done' })).toBeNull();
    expect(getPlaygroundGeneration(db, 'missing')).toBeNull();
  });

  it('sweeps rows left running by a previous process', () => {
    const running = insertScratch();
    const done = insertScratch({ status: 'done' });

    expect(sweepRunningPlaygroundGenerations(db)).toBe(1);
    expect(getPlaygroundGeneration(db, running.id)).toMatchObject({
      status: 'failed',
      error: 'generation interrupted by daemon restart',
    });
    expect(getPlaygroundGeneration(db, done.id)?.status).toBe('done');
    // 第二次没有可清扫的行。
    expect(sweepRunningPlaygroundGenerations(db)).toBe(0);
  });

  it('orders newest first and pages by the (createdAt, id) cursor without gaps', () => {
    const stamp = Date.now();
    // 四行同一毫秒：单靠 created_at 排序时它们可以换位，翻页就会漏或重。
    const ids = ['gen-d', 'gen-c', 'gen-b', 'gen-a'].map((suffix) => {
      insertScratch({ id: suffix, createdAt: stamp });
      return suffix;
    });

    const first = listPlaygroundGenerations(db, { limit: 2 });
    expect(first.records.map((row) => row.id)).toEqual(['gen-d', 'gen-c']);
    expect(first.nextBefore).toBe(formatPlaygroundCursor({ createdAt: stamp, id: 'gen-c' }));

    const second = listPlaygroundGenerations(db, {
      limit: 2,
      before: first.nextBefore,
    });
    expect(second.records.map((row) => row.id)).toEqual(['gen-b', 'gen-a']);
    expect(second.nextBefore).toBeNull();

    const seen = [...first.records, ...second.records].map((row) => row.id);
    expect(new Set(seen).size).toBe(ids.length);
  });

  it('filters by target: undefined is everything, null is scratch only', () => {
    const projectId = `project-${randomUUID()}`;
    const now = Date.now();
    insertProject(db, {
      id: projectId,
      name: 'playground target',
      createdAt: now,
      updatedAt: now,
    });
    insertScratch({ createdAt: now - 3 });
    insertScratch({ targetProjectId: projectId, createdAt: now - 2 });
    insertScratch({ createdAt: now - 1 });

    expect(listPlaygroundGenerations(db, { limit: 10 }).records).toHaveLength(3);
    expect(
      listPlaygroundGenerations(db, { limit: 10, targetProjectId: null }).records,
    ).toHaveLength(2);
    expect(
      listPlaygroundGenerations(db, { limit: 10, targetProjectId: projectId }).records,
    ).toMatchObject([{ targetProjectId: projectId }]);
  });

  it('cascades a deleted project to its rows and leaves scratch rows alone', () => {
    const projectId = `project-${randomUUID()}`;
    const now = Date.now();
    insertProject(db, { id: projectId, name: 'cascade', createdAt: now, updatedAt: now });
    const projectRow = insertScratch({ targetProjectId: projectId });
    const scratchRow = insertScratch();

    deleteProject(db, projectId);

    expect(getPlaygroundGeneration(db, projectRow.id)).toBeNull();
    expect(getPlaygroundGeneration(db, scratchRow.id)).not.toBeNull();
  });

  it('deletes one row without touching its siblings', () => {
    const keep = insertScratch();
    const drop = insertScratch();
    deletePlaygroundGeneration(db, drop.id);
    expect(getPlaygroundGeneration(db, drop.id)).toBeNull();
    expect(getPlaygroundGeneration(db, keep.id)).not.toBeNull();
  });

  it('parses only well-formed cursors', () => {
    expect(parsePlaygroundCursor('1700000000000:gen-a')).toEqual({
      createdAt: 1700000000000,
      id: 'gen-a',
    });
    expect(parsePlaygroundCursor('gen-a')).toBeNull();
    expect(parsePlaygroundCursor(':gen-a')).toBeNull();
    expect(parsePlaygroundCursor('abc:gen-a')).toBeNull();
    expect(parsePlaygroundCursor(undefined)).toBeNull();
    expect(parsePlaygroundCursor(42)).toBeNull();
  });

  it('drops unknown shapes instead of leaking them back through the API', () => {
    const row = insertScratch();
    db.prepare(
      `UPDATE media_playground_generations
          SET files_json = ?, params_json = ?, status = 'done'
        WHERE id = ?`,
    ).run(
      JSON.stringify(['not-an-object', { noName: true }, { name: 'ok.png', size: 'big' }]),
      JSON.stringify({ aspect: 7, count: 'many', transfers: [{ files: ['x.png'] }] }),
      row.id,
    );

    const reloaded = getPlaygroundGeneration(db, row.id);
    expect(reloaded?.files).toEqual([{ name: 'ok.png' }]);
    expect(reloaded?.params).toEqual({});
  });
});
