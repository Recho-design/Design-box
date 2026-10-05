import fsp from 'node:fs/promises';
import path from 'node:path';

import type { Express, Request, Response } from 'express';
import multer from 'multer';
import type {
  PlaygroundDeleteResponse,
  PlaygroundGenerateRequest,
  PlaygroundGenerationFile,
  PlaygroundGenerationListResponse,
  PlaygroundGenerationParams,
  PlaygroundTransferResponse,
  PlaygroundUploadResponse,
} from '@open-design/contracts';

import { defaultMediaExecutionPolicy, mediaPolicyDenial } from '../media/policy.js';
import { errorText, generateMediaBatch } from '../media/generate-media-batch.js';
import {
  captureMediaGenerationResult,
  resolveMediaAnalyticsContext,
} from '../media/generation-analytics.js';
import {
  PLAYGROUND_UPLOAD_MAX_BYTES,
  detectImageFormat,
  playgroundUploadFileName,
  resolveWithinBase,
} from '../media/playground-files.js';
import {
  deletePlaygroundGeneration,
  getPlaygroundGeneration,
  insertPlaygroundGeneration,
  listPlaygroundGenerations,
  parsePlaygroundCursor,
  sweepRunningPlaygroundGenerations,
  toPlaygroundGeneration,
  updatePlaygroundGeneration,
  type PlaygroundGenerationRecord,
} from '../media/playground-store.js';
import { sanitizeName } from '../projects.js';
import { proxyDispatcherRequestInit } from '../connectionTest.js';
import type { RouteDeps } from '../server-context.js';
import { uniqueFileName } from '../services/unique-file-name.js';
import { clampMediaGenerateCount } from './media.js';

/**
 * Media Playground（直接生成工作台 v2）的 HTTP 端点。
 *
 * 它是 `POST /api/media/generate` 的**平行走廊**，不是它的替代：agent 的旧路径
 * 有 media_tasks 轮询、late-file 关联与快照，这里一概不建（无 Run 无消息）。
 * 一次请求 = 一次同步批次 = 一张卡片历史。
 *
 * 六个端点全部带同源守卫：本机 UI/CLI 专属，读路径泄露生成历史与图片同样不
 * 可接受（B2）。错误一律走嵌套信封 `{error:{code,message}}`（含 catch 分支），
 * 因为 CLI 的退出码分类要靠它拿 `code`。
 */

const PLAYGROUND_ROUTE_PREFIX = '/api/media/playground';
const PLAYGROUND_LIST_DEFAULT_LIMIT = 50;
const PLAYGROUND_LIST_MAX_LIMIT = 200;
/**
 * 一次生成的 provider 超时，与既有 generate 端点在同一个量级：长图/大图很慢，
 * 而这里没有 202 + 轮询的退路，超时就是这一行的失败。
 */
const GENERATE_TIMEOUT_MS = 10 * 60 * 1000;
/** 目录名固定，但**根**必须来自注入的 `ctx.paths`（见 registrar 内派生）。 */
const PLAYGROUND_DIR_NAME = 'media-playground';
/** scratch 行没有项目：埋点用一个有界的固定标签，而不是空串或生成 id。 */
const SCRATCH_ANALYTICS_PROJECT = 'scratch';

export interface RegisterMediaPlaygroundRoutesDeps extends RouteDeps<
  'db' | 'design' | 'http' | 'paths' | 'ids' | 'media' | 'appConfig' | 'projectStore' | 'projectFiles'
> {}

/** 目标基目录：scratch 是 Playground 目录，项目是它的**实际**项目根。 */
interface ResolvedTarget {
  projectId: string | null;
  dir: string;
}

type TargetResolution =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; status: number; code: string; message: string };

type RequestFailure = { status: number; code: string; message: string };

/** 一次批次的结果：槽位、成功槽位的元数据，以及 provider 重试摘要。 */
interface BatchOutcome {
  files: PlaygroundGenerationFile[];
  metas: any[];
  providerRequestSummary: any;
}

export function registerMediaPlaygroundRoutes(
  app: Express,
  ctx: RegisterMediaPlaygroundRoutesDeps,
): void {
  const { db, design } = ctx;
  const { sendApiError, isLocalSameOrigin, resolvedPortRef } = ctx.http;
  const { PROJECT_ROOT, PROJECTS_DIR, RUNTIME_DATA_DIR } = ctx.paths;
  const { randomUUID } = ctx.ids;
  const { generateMedia } = ctx.media;
  const { readAppConfig } = ctx.appConfig;
  const { getProject } = ctx.projectStore;
  const { resolveProjectDir } = ctx.projectFiles;
  const getResolvedPort = () => resolvedPortRef.current;

  // 目录在 registrar 内从注入的 `ctx.paths` 派生：禁止模块级常量、禁止直读
  // `OD_DATA_DIR`、禁止 cwd 兜底（根 AGENTS.md 的数据目录契约）。
  const PLAYGROUND_DIR = path.join(RUNTIME_DATA_DIR, PLAYGROUND_DIR_NAME);
  const PLAYGROUND_UPLOADS_DIR = path.join(PLAYGROUND_DIR, 'uploads');

  // 上一次进程留下的 `running` 行只可能是被重启打断的请求：没有任何进程会再
  // 改写它，留着就是一张永远转圈的卡片。
  try {
    const swept = sweepRunningPlaygroundGenerations(db);
    if (swept > 0) console.warn(`[media-playground] swept ${swept} interrupted generation(s)`);
  } catch (err) {
    console.warn('[media-playground] stale running sweep failed', err);
  }

  // 上传落在目标目录（scratch 的 uploads/ 或项目根），所以用内存存储：魔数校验
  // 不过的字节**一个都不落盘**，也就没有"先写再删"的窗口。
  const playgroundUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: PLAYGROUND_UPLOAD_MAX_BYTES, files: 1 },
  });

  const requireSameOrigin = (req: Request, res: Response): boolean => {
    if (isLocalSameOrigin(req, getResolvedPort())) return true;
    sendApiError(
      res,
      403,
      'FORBIDDEN',
      'cross-origin request rejected: the media playground is restricted to the local UI / CLI',
    );
    return false;
  };

  /**
   * 解析落盘目标。项目目标一律走 `resolveProjectDir(PROJECTS_DIR, id, metadata)`：
   * 导入型项目的真实工作区是 `metadata.baseDir`，产物落 `PROJECTS_DIR/<id>` 时
   * Design Files 根本看不到它。
   */
  const resolveTarget = (rawProjectId: unknown, missingProjectStatus: number): TargetResolution => {
    if (rawProjectId === undefined || rawProjectId === null || rawProjectId === '') {
      return { ok: true, target: { projectId: null, dir: PLAYGROUND_DIR } };
    }
    if (typeof rawProjectId !== 'string') {
      return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'targetProjectId must be a string' };
    }
    const project = getProject(db, rawProjectId);
    if (!project) {
      return {
        ok: false,
        status: missingProjectStatus,
        code: 'PROJECT_NOT_FOUND',
        message: `project not found: ${rawProjectId}`,
      };
    }
    try {
      const dir = resolveProjectDir(PROJECTS_DIR, project.id, project.metadata);
      return { ok: true, target: { projectId: project.id, dir } };
    } catch (err) {
      return { ok: false, status: 400, code: 'BAD_REQUEST', message: errorText(err) };
    }
  };

  const sendFailure = (res: Response, failure: RequestFailure): void => {
    sendApiError(res, failure.status, failure.code, failure.message);
  };

  /** Express 5 的 `params` 值可以是数组：路由参数一律当字符串取，取不到就是空串。 */
  const paramOf = (req: Request, name: string): string => {
    const raw = req.params[name];
    return typeof raw === 'string' ? raw : '';
  };

  const sendRunningConflict = (res: Response, id: string): void => {
    sendApiError(res, 409, 'GENERATION_RUNNING', `generation ${id} is still running`, {
      details: { generationId: id },
    });
  };

  // -------------------------------------------------------------------------
  // POST /generate
  // -------------------------------------------------------------------------

  app.post(`${PLAYGROUND_ROUTE_PREFIX}/generate`, async (req, res) => {
    if (!requireSameOrigin(req, res)) return;
    try {
      await handleGenerate(req, res);
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', errorText(err));
    }
  });

  async function handleGenerate(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Partial<PlaygroundGenerateRequest>;
    const failure = validateGenerateRequest(body);
    if (failure) return sendFailure(res, failure);
    const resolution = resolveTarget(body.targetProjectId, 400);
    if (!resolution.ok) return sendFailure(res, resolution);

    const model = body.model as string;
    // 显式按默认媒体策略放行：Playground 没有 Run 级策略可读，但不该**沉默**
    // 绕过它——这里是一次有意的判定，默认策略收紧时会在这一步拦住。
    const denial = mediaPolicyDenial(defaultMediaExecutionPolicy(), { surface: 'image', model });
    if (denial) return void sendApiError(res, 403, denial.code, denial.message);

    const generationId = randomUUID();
    const count = clampMediaGenerateCount(body.count);
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    const modelOverride = typeof body.modelOverride === 'string' && body.modelOverride.trim()
      ? body.modelOverride.trim()
      : null;

    // dispatch **之前**先落 running 行：这一次 API 花费因此在历史里有痕迹，
    // 即使进程中途没了也留下一张失败卡片（下次启动清扫）。
    let record = insertPlaygroundGeneration(db, {
      id: generationId,
      targetProjectId: resolution.target.projectId,
      surface: 'image',
      model,
      modelOverride,
      prompt,
      params: generateParams(body, count),
      status: 'running',
      files: [],
    });

    const startedAt = Date.now();
    const batch = await runBatch({
      req,
      generationId,
      count,
      model,
      modelOverride,
      prompt,
      images: Array.isArray(body.images) ? body.images : undefined,
      body,
      dir: resolution.target.dir,
    });
    const succeeded = batch.metas.length > 0;
    record = updatePlaygroundGeneration(db, generationId, {
      status: succeeded ? 'done' : 'failed',
      files: batch.files,
      error: succeeded ? null : batch.files[0]?.error ?? 'image generation failed',
    }) ?? record;

    // 响应永远是**完整的一行**（含 per-slot 失败）：卡片流拿它刷新，而不是拿
    // 一个错误信封。全部槽位失败也照样 200 —— 那一行的 status 就是 `failed`。
    res.status(200).json(toPlaygroundGeneration(record));
    await captureBatchAnalytics({
      req,
      batch,
      generationId,
      model,
      startedAt,
      projectId: resolution.target.projectId ?? SCRATCH_ANALYTICS_PROJECT,
    });
  }

  /**
   * 一次同步批次：N 个槽位各自一次 provider 调用。
   *
   * 产物名从 generation id 派生（`<genId>-<slot>.png`），构造上就不可能和另一次
   * 生成撞名——`autoOutputName` 的毫秒时间戳在同毫秒并发时会算出同一个路径。
   */
  async function runBatch(input: {
    req: Request;
    generationId: string;
    count: number;
    model: string;
    modelOverride: string | null;
    prompt: string;
    images: string[] | undefined;
    body: Partial<PlaygroundGenerateRequest>;
    dir: string;
  }): Promise<BatchOutcome> {
    let providerRequestSummary: any = null;
    const dispatcher = proxyDispatcherRequestInit(process.env, {
      headersTimeout: GENERATE_TIMEOUT_MS,
      bodyTimeout: GENERATE_TIMEOUT_MS,
    });
    const baseArgs = {
      projectRoot: PROJECT_ROOT,
      projectsRoot: PROJECTS_DIR,
      // 目录由 outputDir 决定；projectId 退化为纯错误上下文（不参与路径）。
      projectId: input.generationId,
      outputDir: input.dir,
      surface: 'image',
      model: input.model,
      modelOverride: input.modelOverride ?? undefined,
      prompt: input.prompt,
      aspect: typeof input.body.aspect === 'string' ? input.body.aspect : undefined,
      quality: typeof input.body.quality === 'string' ? input.body.quality : undefined,
      images: input.images,
      requestInit: dispatcher.requestInit,
      onProviderRequestSettled: (summary: any) => {
        providerRequestSummary = summary;
      },
    };
    const outputNames = Array.from(
      { length: input.count },
      (_, index) => `${input.generationId}-${index + 1}.png`,
    );
    try {
      const batch = await generateMediaBatch(baseArgs, outputNames, generateMedia);
      return { ...batch, providerRequestSummary };
    } finally {
      await dispatcher.close();
    }
  }

  /**
   * 复用 `mediaAnalyticsContext` 的无 Run standalone 身份上报
   * `media_generation_result`：Playground 的生成不能成为观测盲区。
   */
  async function captureBatchAnalytics(input: {
    req: Request;
    batch: BatchOutcome;
    generationId: string;
    model: string;
    startedAt: number;
    projectId: string;
  }): Promise<void> {
    const summary = input.batch.providerRequestSummary;
    if (input.batch.metas.length === 0 || !summary) return;
    try {
      const analyticsContext = await resolveMediaAnalyticsContext({
        req: input.req,
        design,
        readAppConfig,
        runtimeDataDir: RUNTIME_DATA_DIR,
      });
      if (!analyticsContext) return;
      captureMediaGenerationResult(design, {
        analyticsContext,
        durationMs: Date.now() - input.startedAt,
        meta: input.batch.metas[0],
        model: input.model,
        projectId: input.projectId,
        providerRequestSummary: summary,
        surface: 'image',
        taskId: input.generationId,
      });
    } catch {
      // 埋点是 best-effort，绝不能反过来影响生成结局。
    }
  }

  // -------------------------------------------------------------------------
  // POST /uploads
  // -------------------------------------------------------------------------

  app.post(`${PLAYGROUND_ROUTE_PREFIX}/uploads`, (req, res) => {
    if (!requireSameOrigin(req, res)) return;
    playgroundUpload.single('file')(req, res, (err: unknown) => {
      if (err) return sendUploadFailure(res, err);
      void handleUpload(req, res).catch((error: unknown) => {
        sendApiError(res, 500, 'INTERNAL_ERROR', errorText(error));
      });
    });
  });

  async function handleUpload(req: Request, res: Response): Promise<void> {
    const file = (req as Request & { file?: { buffer?: unknown; originalname?: unknown } }).file;
    const bytes = Buffer.isBuffer(file?.buffer) ? file.buffer : null;
    if (!bytes || bytes.length === 0) {
      return void sendApiError(res, 400, 'BAD_REQUEST', 'file is required');
    }
    const format = detectImageFormat(bytes);
    if (!format) {
      return void sendApiError(
        res,
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'unsupported image format: expected png, jpeg, webp, or gif bytes',
      );
    }
    const resolution = resolveTarget(req.body?.targetProjectId, 400);
    if (!resolution.ok) return sendFailure(res, resolution);

    // 参考图永远落在「生成时会解析的那个目录」：scratch 是 uploads/，项目是它的
    // 实际项目根（导入型为 baseDir），两个目标下上传即可用。
    const destDir = resolution.target.projectId === null
      ? PLAYGROUND_UPLOADS_DIR
      : resolution.target.dir;
    await fsp.mkdir(destDir, { recursive: true });
    const fileName = uniqueFileName(
      destDir,
      playgroundUploadFileName(file?.originalname, format.ext),
    );
    await fsp.writeFile(path.join(destDir, fileName), bytes);
    const payload: PlaygroundUploadResponse = {
      name: resolution.target.projectId === null ? `uploads/${fileName}` : fileName,
    };
    res.status(201).json(payload);
  }

  function sendUploadFailure(res: Response, err: unknown): void {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return void sendApiError(
        res,
        413,
        'PAYLOAD_TOO_LARGE',
        `reference image exceeds ${PLAYGROUND_UPLOAD_MAX_BYTES} bytes`,
      );
    }
    sendApiError(res, 400, 'BAD_REQUEST', errorText(err));
  }

  // -------------------------------------------------------------------------
  // GET /generations
  // -------------------------------------------------------------------------

  app.get(`${PLAYGROUND_ROUTE_PREFIX}/generations`, (req, res) => {
    if (!requireSameOrigin(req, res)) return;
    const targetFilter = parseTargetFilter(req.query.target);
    if (targetFilter === INVALID_TARGET) {
      return void sendApiError(res, 400, 'BAD_REQUEST', 'target must be scratch or a project id');
    }
    const before = req.query.before;
    if (before !== undefined && parsePlaygroundCursor(before) === null) {
      return void sendApiError(res, 400, 'BAD_REQUEST', 'before must be a "<createdAt>:<id>" cursor');
    }
    const page = listPlaygroundGenerations(db, {
      limit: parseListLimit(req.query.limit),
      before: typeof before === 'string' ? before : null,
      targetProjectId: targetFilter,
    });
    const payload: PlaygroundGenerationListResponse = {
      generations: page.records.map(toPlaygroundGeneration),
      nextBefore: page.nextBefore,
    };
    res.json(payload);
  });

  // -------------------------------------------------------------------------
  // GET /files/:id/:slot —— 只读 scratch 产物字节
  // -------------------------------------------------------------------------

  app.get(`${PLAYGROUND_ROUTE_PREFIX}/files/:id/:slot`, async (req, res) => {
    if (!requireSameOrigin(req, res)) return;
    try {
      await serveScratchFile(req, res);
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', errorText(err));
    }
  });

  async function serveScratchFile(req: Request, res: Response): Promise<void> {
    const record = getPlaygroundGeneration(db, paramOf(req, 'id'));
    if (!record) return void sendApiError(res, 404, 'NOT_FOUND', 'generation not found');
    // 项目产物走既有的项目文件服务（projectFileUrl）：同一条读路径有两个真相
    // 时，权限判定就会开始漂移。
    if (record.targetProjectId !== null) {
      return void sendApiError(
        res,
        403,
        'FORBIDDEN',
        'project artifacts are served by the project file API, not the media playground',
      );
    }
    const slot = parseSlot(paramOf(req, 'slot'));
    const file = slot === null ? undefined : record.files[slot];
    if (!file || file.error) {
      return void sendApiError(res, 404, 'FILE_NOT_FOUND', 'generation file not found');
    }
    const abs = resolveWithinBase(PLAYGROUND_DIR, file.name);
    if (!abs) {
      return void sendApiError(
        res,
        403,
        'FORBIDDEN',
        'generation file resolves outside the playground directory',
      );
    }
    const info = await fsp.stat(abs).catch(() => null);
    if (!info?.isFile()) {
      return void sendApiError(res, 404, 'FILE_NOT_FOUND', 'generation file not found');
    }
    // 文件名含唯一 genId，内容不可变，所以可以长期强缓存。
    res.setHeader('Content-Type', file.mime || mimeForName(file.name));
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(file.name)}"`);
    // `dotfiles: 'allow'`：`send` 在没有 `root` 时按**整条绝对路径**做 dotfile
    // 检查，而默认数据根就是 `<projectRoot>/.od` —— 用默认策略会让每一张
    // scratch 卡片 404。路径已过 resolveWithinBase 收口，dotfile 规则不是这里
    // 的防线。
    res.sendFile(abs, { dotfiles: 'allow' });
  }

  // -------------------------------------------------------------------------
  // POST /generations/:id/transfer
  // -------------------------------------------------------------------------

  app.post(`${PLAYGROUND_ROUTE_PREFIX}/generations/:id/transfer`, async (req, res) => {
    if (!requireSameOrigin(req, res)) return;
    try {
      await handleTransfer(req, res);
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', errorText(err));
    }
  });

  async function handleTransfer(req: Request, res: Response): Promise<void> {
    const record = getPlaygroundGeneration(db, paramOf(req, 'id'));
    if (!record) return void sendApiError(res, 404, 'NOT_FOUND', 'generation not found');
    if (record.status === 'running') return sendRunningConflict(res, paramOf(req, 'id'));
    const resolution = resolveTarget(req.body?.projectId, 404);
    if (!resolution.ok) return sendFailure(res, resolution);
    const projectId = resolution.target.projectId as string;

    // 幂等：同一项目重复转存直接回既有记录，不再复制出 `-1` 副本。
    const existing = record.params.transfers?.find((entry) => entry.projectId === projectId);
    if (existing) return void res.json(transferPayload(record, existing.files));

    const landed = record.files.filter((file) => !file.error && file.name);
    if (landed.length === 0) {
      return void sendApiError(res, 400, 'BAD_REQUEST', 'generation has no files to transfer');
    }
    const transferred = await copyIntoProject(landed, resolution.target.dir);
    if (transferred.length === 0) {
      return void sendApiError(res, 404, 'FILE_NOT_FOUND', 'no generation files could be read');
    }
    const updated = updatePlaygroundGeneration(db, record.id, {
      params: {
        ...record.params,
        transfers: [...(record.params.transfers ?? []), { projectId, files: transferred }],
      },
    });
    res.json(transferPayload(updated ?? record, transferred));
  }

  /** 复制产物到项目根，逐文件去重命名；单个源文件缺失跳过而不是整体失败。 */
  async function copyIntoProject(
    files: PlaygroundGenerationFile[],
    projectDir: string,
  ): Promise<string[]> {
    await fsp.mkdir(projectDir, { recursive: true });
    const reserved = new Set<string>();
    const landed: string[] = [];
    for (const file of files) {
      const source = resolveWithinBase(PLAYGROUND_DIR, file.name);
      if (!source) continue;
      const safeName = sanitizeName(path.basename(file.name));
      const destName = uniqueFileName(projectDir, safeName, reserved);
      try {
        await fsp.copyFile(source, path.join(projectDir, destName));
        landed.push(destName);
      } catch (err) {
        console.warn(`[media-playground] transfer skipped ${file.name}`, err);
      }
    }
    return landed;
  }

  function transferPayload(
    record: PlaygroundGenerationRecord,
    transferredFiles: string[],
  ): PlaygroundTransferResponse {
    return { generation: toPlaygroundGeneration(record), transferredFiles };
  }

  // -------------------------------------------------------------------------
  // DELETE /generations/:id
  // -------------------------------------------------------------------------

  app.delete(`${PLAYGROUND_ROUTE_PREFIX}/generations/:id`, async (req, res) => {
    if (!requireSameOrigin(req, res)) return;
    try {
      await handleDelete(req, res);
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', errorText(err));
    }
  });

  async function handleDelete(req: Request, res: Response): Promise<void> {
    const record = getPlaygroundGeneration(db, paramOf(req, 'id'));
    if (!record) return void sendApiError(res, 404, 'NOT_FOUND', 'generation not found');
    // running 行不可删（C5）：同步批次在 HTTP 请求内 settle，运行窗口就是请求
    // 窗口；删行会让 settle 的更新落空，渲染器却照常写出孤儿文件。
    if (record.status === 'running') return sendRunningConflict(res, paramOf(req, 'id'));
    // scratch 产物**一律**删除（无论是否转存过；转存副本在项目里不受影响），
    // 不留"不在行里也无入口可删"的永久孤儿。项目行的文件是用户项目里的素材，
    // 删历史行不等于删用户的东西。
    if (record.targetProjectId === null) {
      for (const file of record.files) {
        const abs = resolveWithinBase(PLAYGROUND_DIR, file.name);
        if (abs) await fsp.rm(abs, { force: true }).catch(() => undefined);
      }
    }
    deletePlaygroundGeneration(db, paramOf(req, 'id'));
    const payload: PlaygroundDeleteResponse = { ok: true };
    res.json(payload);
  }
}

/** `target` 查询参数：`undefined` = 不过滤，`null` = 只要 scratch。 */
const INVALID_TARGET = Symbol('invalid-target');

function parseTargetFilter(raw: unknown): string | null | undefined | typeof INVALID_TARGET {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return INVALID_TARGET;
  if (!raw.trim()) return undefined;
  return raw === 'scratch' ? null : raw;
}

function parseListLimit(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return PLAYGROUND_LIST_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), PLAYGROUND_LIST_MAX_LIMIT);
}

/** `slot` 必须是非负整数；非法或越界都由调用方转成 404。 */
function parseSlot(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

/** 校验生成请求；通过时返回 null。 */
function validateGenerateRequest(body: Partial<PlaygroundGenerateRequest>): RequestFailure | null {
  if (body.surface !== 'image') {
    return { status: 400, code: 'BAD_REQUEST', message: 'surface must be image' };
  }
  // v1 固定走 custom-image 通道，实际模型名由 modelOverride 自由指定（D6 接缝）。
  if (body.model !== 'custom-image') {
    return { status: 400, code: 'BAD_REQUEST', message: 'model must be custom-image' };
  }
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return { status: 400, code: 'BAD_REQUEST', message: 'prompt is required' };
  }
  const images = body.images;
  if (images !== undefined && !isImageList(images)) {
    return {
      status: 400,
      code: 'BAD_REQUEST',
      message: 'images must be an array of non-empty strings',
    };
  }
  return null;
}

function isImageList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((image) => typeof image === 'string' && !!image.trim());
}

/** 落进 `params_json` 的请求参数留痕（UI 的"复用"按钮靠它回填）。 */
function generateParams(
  body: Partial<PlaygroundGenerateRequest>,
  count: number,
): PlaygroundGenerationParams {
  const params: PlaygroundGenerationParams = { count };
  if (typeof body.aspect === 'string' && body.aspect) params.aspect = body.aspect;
  if (typeof body.quality === 'string' && body.quality) params.quality = body.quality;
  return params;
}

function mimeForName(name: string): string {
  switch (path.extname(name).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    default: return 'application/octet-stream';
  }
}
