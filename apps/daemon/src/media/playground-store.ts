import type Database from 'better-sqlite3';
import type {
  PlaygroundGeneration,
  PlaygroundGenerationFile,
  PlaygroundGenerationParams,
  PlaygroundSurface,
} from '@open-design/contracts';

/**
 * Media Playground 的卡片历史。
 *
 * 为什么不是 `media_tasks`：那张表的 `project_id NOT NULL` + FK，而且终态任务
 * 1 小时就被 GC —— 它是轮询通道，不是历史存储。scratch 生成没有项目行，插不
 * 进去；卡片历史又必须活得比一小时久。所以这里是一张独立的表。
 *
 * 一行 = 一张卡片 = 一次生成（含批次）。批次的部分失败以 per-slot `error`
 * 记在 `files_json` 里，与批次响应同构。
 */

/** 历史行的状态：`running` 行由 dispatch 前插入、settle 后改写。 */
export type PlaygroundGenerationStatus = PlaygroundGeneration['status'];

/** v1 只写这一个 surface；列本身没有约束，为将来的视频留接缝（D6）。 */
const PLAYGROUND_SURFACE: PlaygroundSurface = 'image';

/** 存储层的一行：DTO 之外还带 `updatedAt`（内部排序/清扫用，不上协议）。 */
export interface PlaygroundGenerationRecord extends PlaygroundGeneration {
  updatedAt: number;
}

export interface PlaygroundGenerationInsert {
  id: string;
  targetProjectId?: string | null;
  surface: PlaygroundSurface;
  model: string;
  modelOverride?: string | null;
  prompt?: string;
  params?: PlaygroundGenerationParams;
  status?: PlaygroundGenerationStatus;
  files?: PlaygroundGenerationFile[];
  error?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface PlaygroundGenerationPatch {
  status?: PlaygroundGenerationStatus;
  files?: PlaygroundGenerationFile[];
  error?: string | null;
  params?: PlaygroundGenerationParams;
  updatedAt?: number;
}

export interface PlaygroundGenerationListOptions {
  limit: number;
  /** `'<createdAt>:<id>'` 复合游标；行的二元组严格小于它才入选。 */
  before?: string | null | undefined;
  /** `undefined` = 不过滤；`null` = 只看 scratch；字符串 = 只看该项目。 */
  targetProjectId?: string | null | undefined;
}

export interface PlaygroundGenerationListPage {
  records: PlaygroundGenerationRecord[];
  nextBefore: string | null;
}

interface RawPlaygroundRow {
  id: string;
  targetProjectId: string | null;
  surface: string;
  model: string;
  modelOverride: string | null;
  prompt: string;
  paramsJson: string;
  status: string;
  filesJson: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

const COLS = `
  id,
  target_project_id AS targetProjectId,
  surface,
  model,
  model_override AS modelOverride,
  prompt,
  params_json AS paramsJson,
  status,
  files_json AS filesJson,
  error,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const VALID_STATUSES: ReadonlySet<string> = new Set(['running', 'done', 'failed']);

/**
 * 建表 + 建游标索引。在 `db.ts` 的 `migrateMediaTasks(db)` 旁同点注册。
 *
 * `surface` 刻意**不加 CHECK 约束**（D6 接缝）：将来放开视频时不需要迁移即可
 * 写入新值。`target_project_id` 指回 `projects(id)` 并随项目删除级联——项目没了，
 * 它的历史行也没有意义（scratch 行的 `NULL` 不受影响）。
 */
export function migrateMediaPlaygroundGenerations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_playground_generations (
      id TEXT PRIMARY KEY,
      target_project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      surface TEXT NOT NULL,
      model TEXT NOT NULL,
      model_override TEXT,
      prompt TEXT NOT NULL DEFAULT '',
      params_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK (status IN ('running','done','failed')),
      files_json TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_playground_cursor
      ON media_playground_generations(created_at DESC, id);
  `);
}

/** 插入一行（dispatch 前先落 `running`，API 花费在历史里有痕迹）。 */
export function insertPlaygroundGeneration(
  db: Database.Database,
  input: PlaygroundGenerationInsert,
): PlaygroundGenerationRecord {
  const now = Date.now();
  const status = input.status ?? 'running';
  assertValidStatus(status);
  db.prepare(
    `INSERT INTO media_playground_generations
       (id, target_project_id, surface, model, model_override, prompt, params_json,
        status, files_json, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.targetProjectId ?? null,
    input.surface,
    input.model,
    input.modelOverride ?? null,
    input.prompt ?? '',
    JSON.stringify(input.params ?? {}),
    status,
    JSON.stringify(input.files ?? []),
    input.error ?? null,
    input.createdAt ?? now,
    input.updatedAt ?? now,
  );
  const row = getPlaygroundGeneration(db, input.id);
  if (row === null) throw new Error(`Failed to fetch playground generation after insert: ${input.id}`);
  return row;
}

export function getPlaygroundGeneration(
  db: Database.Database,
  id: string,
): PlaygroundGenerationRecord | null {
  const raw = db
    .prepare(`SELECT ${COLS} FROM media_playground_generations WHERE id = ?`)
    .get(id) as RawPlaygroundRow | undefined;
  return raw ? normalizeRow(raw) : null;
}

export function updatePlaygroundGeneration(
  db: Database.Database,
  id: string,
  patch: PlaygroundGenerationPatch,
): PlaygroundGenerationRecord | null {
  const existing = getPlaygroundGeneration(db, id);
  if (existing === null) return null;
  const status = patch.status ?? existing.status;
  assertValidStatus(status);
  db.prepare(
    `UPDATE media_playground_generations
        SET status = ?, files_json = ?, error = ?, params_json = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    status,
    JSON.stringify(patch.files ?? existing.files),
    'error' in patch ? patch.error ?? null : existing.error ?? null,
    JSON.stringify(patch.params ?? existing.params),
    patch.updatedAt ?? Date.now(),
    id,
  );
  return getPlaygroundGeneration(db, id);
}

/**
 * 倒序（`created_at DESC, id DESC`）取一页。
 *
 * 排序键带上 `id` 是为了同毫秒插入不互踩：`created_at` 单独做键时，同一毫秒的
 * 两行在两次读之间可以换位，游标分页就会漏掉或重复其中一行。`before` 的谓词
 * 是二元组字典序严格小于，正好命中 `(created_at DESC, id)` 索引。
 */
export function listPlaygroundGenerations(
  db: Database.Database,
  options: PlaygroundGenerationListOptions,
): PlaygroundGenerationListPage {
  const limit = Math.max(1, Math.trunc(options.limit));
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.targetProjectId === null) {
    where.push('target_project_id IS NULL');
  } else if (typeof options.targetProjectId === 'string') {
    where.push('target_project_id = ?');
    params.push(options.targetProjectId);
  }
  const cursor = parsePlaygroundCursor(options.before);
  if (cursor) {
    where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  // 多取一行只用来判断"还有没有更早的一页"，返回前丢掉。
  const rows = db
    .prepare(
      `SELECT ${COLS} FROM media_playground_generations
        ${clause}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(...params, limit + 1) as RawPlaygroundRow[];
  const records = rows.slice(0, limit).map(normalizeRow);
  const last = records[records.length - 1];
  const nextBefore =
    rows.length > limit && last ? formatPlaygroundCursor(last) : null;
  return { records, nextBefore };
}

/** 删行。调用方负责先删 scratch 产物文件（见 §5.2「孤儿治理」）。 */
export function deletePlaygroundGeneration(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM media_playground_generations WHERE id = ?`).run(id);
}

/**
 * daemon 启动时的遗留清扫：`running` → `failed`。
 *
 * 同步批次在 HTTP 请求内 settle，所以 daemon 重启后还留在 `running` 的行只可能
 * 是被重启打断的请求 —— 不会有进程再去改写它，留着就是一张永远转圈的卡片。
 * 返回被清扫的行数（调用方只用来打日志）。
 */
export function sweepRunningPlaygroundGenerations(
  db: Database.Database,
  now: number = Date.now(),
): number {
  const message = 'generation interrupted by daemon restart';
  return db
    .prepare(
      `UPDATE media_playground_generations
          SET status = 'failed', error = ?, updated_at = ?
        WHERE status = 'running'`,
    )
    .run(message, now).changes;
}

/** `'<createdAt>:<id>'`；格式非法时返回 null（路由侧转成 400）。 */
export function parsePlaygroundCursor(
  value: unknown,
): { createdAt: number; id: string } | null {
  if (typeof value !== 'string') return null;
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const createdAt = Number(value.slice(0, separator));
  const id = value.slice(separator + 1);
  if (!Number.isInteger(createdAt) || !id) return null;
  return { createdAt, id };
}

export function formatPlaygroundCursor(record: {
  createdAt: number;
  id: string;
}): string {
  return `${record.createdAt}:${record.id}`;
}

/** 行 → 协议 DTO：`updatedAt` 与内部状态不外泄。 */
export function toPlaygroundGeneration(
  record: PlaygroundGenerationRecord,
): PlaygroundGeneration {
  const generation: PlaygroundGeneration = {
    id: record.id,
    targetProjectId: record.targetProjectId,
    surface: record.surface,
    model: record.model,
    prompt: record.prompt,
    params: record.params,
    status: record.status,
    files: record.files,
    createdAt: record.createdAt,
  };
  if (typeof record.modelOverride === 'string') generation.modelOverride = record.modelOverride;
  if (typeof record.error === 'string') generation.error = record.error;
  return generation;
}

function assertValidStatus(status: string): void {
  if (!VALID_STATUSES.has(status)) {
    throw new RangeError(`Invalid playground generation status: "${status}"`);
  }
}

function normalizeRow(raw: RawPlaygroundRow): PlaygroundGenerationRecord {
  return {
    id: raw.id,
    targetProjectId: raw.targetProjectId,
    // 读回时固定按 v1 的唯一取值收口：将来支持视频时这里才会读 raw.surface。
    surface: PLAYGROUND_SURFACE,
    model: raw.model,
    modelOverride: raw.modelOverride,
    prompt: raw.prompt,
    params: normalizeParams(parseJson(raw.paramsJson)),
    status: normalizeStatus(raw.status),
    files: normalizeFiles(parseJson(raw.filesJson)),
    error: raw.error,
    createdAt: Number(raw.createdAt),
    updatedAt: Number(raw.updatedAt),
  };
}

/**
 * JSON / TEXT 列一律在读取时重新校验。
 *
 * 这些值穿过一个 JSON 文本列：手改过的行或更新版本写下的行，不该把本 build
 * 不认识的东西塞回 API 响应里（与 `media/tasks.ts` 的 normalizeError 同一条
 * 理由）。
 */
function normalizeStatus(value: unknown): PlaygroundGenerationStatus {
  return typeof value === 'string' && VALID_STATUSES.has(value)
    ? value as PlaygroundGenerationStatus
    : 'failed';
}

function normalizeParams(value: unknown): PlaygroundGenerationParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const params: PlaygroundGenerationParams = {};
  if (typeof source.aspect === 'string') params.aspect = source.aspect;
  if (typeof source.quality === 'string') params.quality = source.quality;
  if (typeof source.count === 'number') params.count = source.count;
  const transfers = normalizeTransfers(source.transfers);
  if (transfers.length > 0) params.transfers = transfers;
  return params;
}

function normalizeTransfers(
  value: unknown,
): Array<{ projectId: string; files: string[] }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ projectId: string; files: string[] }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.projectId !== 'string' || !record.projectId) continue;
    const files = Array.isArray(record.files)
      ? record.files.filter((file): file is string => typeof file === 'string' && !!file)
      : [];
    out.push({ projectId: record.projectId, files });
  }
  return out;
}

function normalizeFiles(value: unknown): PlaygroundGenerationFile[] {
  if (!Array.isArray(value)) return [];
  const files: PlaygroundGenerationFile[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== 'string' || !record.name) continue;
    const file: PlaygroundGenerationFile = { name: record.name };
    if (typeof record.size === 'number') file.size = record.size;
    if (typeof record.mime === 'string') file.mime = record.mime;
    if (typeof record.error === 'string') file.error = record.error;
    files.push(file);
  }
  return files;
}

function parseJson(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
