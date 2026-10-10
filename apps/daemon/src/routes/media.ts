import fs from 'node:fs';
import type { Express } from 'express';
import type {
  HyperFramesScaffoldRequest,
  HyperFramesScaffoldResponse,
  MediaExecutionPolicy,
  ProjectFile,
  ProjectMediaTaskFile,
} from '@open-design/contracts';
import type { AnalyticsContext } from '../analytics.js';
import { defaultMediaExecutionPolicy, mediaPolicyDenial } from '../media/policy.js';
import { formatMediaTaskDiagnostic } from '../media/diagnostics.js';
import { fetchProviderModelOptions } from '../media/model-fetch.js';
import { autoOutputName } from '../media/index.js';
import {
  findMediaModel,
  isMediaProviderOffered,
  offeredModelsForSurface,
} from '../media/models.js';
import type { ImageGenerationRequestSummary } from '../media/image-generation-retry.js';
import type { RouteDeps } from '../server-context.js';
import { proxyDispatcherRequestInit } from '../connectionTest.js';
import { isSandboxModeEnabled } from '../sandbox-mode.js';
import { createChatArtifactBlobStore } from '../chat-artifacts/blob-store.js';
import { captureChatArtifactSnapshotFromBytes } from '../chat-artifacts/capture.js';
import { resolveChatArtifactQuota } from '../chat-artifacts/quota.js';
import {
  HYPERFRAMES_SCAFFOLD_TOOL_ENDPOINT,
  MEDIA_TASK_WAIT_TOOL_ENDPOINT,
  type ToolTokenGrant,
} from '../tool-tokens.js';
import { associateLateRunProducedFile } from '../runtimes/run-produced-files.js';
import { scaffoldHyperFramesComposition } from '../media/hyperframes-scaffold.js';
import { assignMediaTaskBatches } from '../media/task-batches.js';
import { generateMediaBatch } from '../media/generate-media-batch.js';
import {
  captureMediaGenerationResult,
  resolveMediaAnalyticsContext,
} from '../media/generation-analytics.js';
import { mediaTaskErrorFromFailure } from '../media/task-error.js';
import { normalizePersistedAutomationWorkspaceScope } from '../automations/workspace-scope.js';
import { applyProxyPrefsToProcess } from '../services/proxy-apply.js';

const LONG_MEDIA_PROXY_TIMEOUT_MS = 10 * 60 * 1000;
const MEDIA_FILE_MTIME_TOLERANCE_MS = 1;
// Upper bound for one direct-image request. Ten images is already a slow,
// expensive provider call; a larger number is a runaway loop, not an intent.
const MEDIA_GENERATE_MAX_COUNT = 10;

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 计算一次生成请求要出几张图，夹取到 [1, 10]。
 *
 * 缺省或非数字一律视为 1:现有调用方都不传 count，"不传"必须继续等于"一张";
 * 而 `count: 0`(或字符串)也不能静默变成空响应。
 */
export function clampMediaGenerateCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(Math.max(Math.trunc(value), 1), MEDIA_GENERATE_MAX_COUNT);
}

/**
 * 派生多图批次里第 N 个文件名:`poster.png` → `poster-2.png`。
 *
 * 每张图必须各占一个文件,名字只能按序号派生:并行调用若各自走自动命名,
 * 同一毫秒会算出同一个路径而互相覆盖。
 */
export function deriveBatchOutputName(base: string, index: number): string {
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  return `${stem}-${index}${ext}`;
}

/**
 * Files a media task's recorded metadata could still be, after the agent moved
 * or renamed it.
 *
 * An in-project move preserves size and mtime, so the pair is a bounded
 * identity witness that needs no filename guessing. The tolerance absorbs a
 * destination filesystem storing fewer sub-millisecond digits than the source;
 * it is deliberately far below any real filesystem's timestamp granularity,
 * because a wider window buys nothing for a move (which preserves the value
 * exactly) and only makes unrelated files collide. A witness that has drifted
 * past it is not a witness, and staying blind beats showing the wrong image.
 *
 * `claimedNames` are files another task has already proven it owns. A witness
 * may never point at one of those: two chat cards showing the same image is
 * the same lie as one card showing a stranger's.
 */
function mediaTaskFileCandidates(
  taskFile: unknown,
  projectFiles: readonly ProjectFile[],
  claimedNames: ReadonlySet<string>,
): ProjectFile[] {
  if (!taskFile || typeof taskFile !== 'object') return [];
  const file = taskFile as Partial<ProjectMediaTaskFile>;
  const name = typeof file.name === 'string' ? file.name.trim() : '';
  if (!name) return [];

  const size = finiteNumber(file.size);
  const mtime = finiteNumber(file.mtime);
  if (size === null || mtime === null) return [];
  const kind = typeof file.kind === 'string' && file.kind ? file.kind : null;
  return projectFiles.filter((candidate) => (
    !claimedNames.has(candidate.name)
    && candidate.size === size
    && Math.abs(candidate.mtime - mtime) <= MEDIA_FILE_MTIME_TOLERANCE_MS
    && (kind === null || candidate.kind === kind)
  ));
}

/**
 * Resolve one media task's generation-time file metadata to the path that is
 * currently registered in the project. Ambiguous matches fail closed so
 * ChatPanel never previews an unrelated file.
 */
export function resolveMediaTaskProjectFile(
  taskFile: unknown,
  projectFiles: ProjectFile[],
  claimedNames: ReadonlySet<string> = new Set(),
): ProjectFile | null {
  if (!taskFile || typeof taskFile !== 'object') return null;
  const file = taskFile as Partial<ProjectMediaTaskFile>;
  const name = typeof file.name === 'string' ? file.name.trim() : '';
  if (!name) return null;

  if (!claimedNames.has(name)) {
    const exact = projectFiles.find((candidate) => candidate.name === name);
    if (exact) return exact;
  }

  const matches = mediaTaskFileCandidates(taskFile, projectFiles, claimedNames);
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Resolve every moved media task against the project at once, so no surviving
 * file is handed to two of them.
 *
 * Per-task uniqueness is not enough: two tasks that recorded the same witness
 * each see exactly one candidate and each would take it. A file that more than
 * one task can claim proves nothing about either, so it is withdrawn from all
 * of them — the same fail-closed rule, applied across tasks instead of within
 * one.
 */
export function resolveMovedMediaTaskFiles(
  candidates: ReadonlyArray<{ taskId: string; file: unknown }>,
  projectFiles: readonly ProjectFile[],
  claimedNames: ReadonlySet<string> = new Set(),
): Map<string, ProjectFile> {
  const matchesByTask = new Map<string, ProjectFile[]>();
  const claimCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const matches = mediaTaskFileCandidates(candidate.file, projectFiles, claimedNames);
    matchesByTask.set(candidate.taskId, matches);
    for (const match of matches) {
      claimCounts.set(match.name, (claimCounts.get(match.name) ?? 0) + 1);
    }
  }

  const resolved = new Map<string, ProjectFile>();
  for (const [taskId, matches] of matchesByTask) {
    const uncontested = matches.filter((match) => (claimCounts.get(match.name) ?? 0) === 1);
    const only = uncontested.length === 1 ? uncontested[0] : undefined;
    if (only) resolved.set(taskId, only);
  }
  return resolved;
}

function reconciledMediaTaskFile(
  taskFile: unknown,
  projectFile: ProjectFile,
): Record<string, unknown> {
  const original = taskFile && typeof taskFile === 'object'
    ? taskFile as Record<string, unknown>
    : {};
  return {
    ...original,
    name: projectFile.name,
    size: projectFile.size,
    mtime: projectFile.mtime,
    kind: projectFile.kind,
    mime: projectFile.mime,
  };
}

function mediaProviderId(model: string): string | undefined {
  return findMediaModel(model)?.provider;
}

export interface RegisterMediaRoutesDeps extends RouteDeps<'db' | 'design' | 'http' | 'paths' | 'ids' | 'auth' | 'media' | 'appConfig' | 'orbit' | 'nativeDialogs' | 'projectStore' | 'projectFiles' | 'conversations'> {}

export type LegacyMediaRouteGrantDecision =
  | { ok: true; grant: ToolTokenGrant | null }
  | {
      ok: false;
      code: string;
      details?: Record<string, unknown>;
      message: string;
      status: number;
    };

export function resolveLegacyMediaRouteGrant(input: {
  grant: ToolTokenGrant | null;
  projectId: string;
  requestProjectOverride: (projectId: string, tokenProjectId: string) => boolean;
  sandboxMode: boolean;
}): LegacyMediaRouteGrantDecision {
  if (
    input.sandboxMode &&
    input.grant &&
    input.requestProjectOverride(input.projectId, input.grant.projectId)
  ) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      details: { suppliedProjectId: input.projectId },
      message: 'projectId is derived from the tool token',
      status: 403,
    };
  }

  if (!input.grant && input.sandboxMode) {
    return {
      ok: false,
      code: 'TOOL_TOKEN_MISSING',
      message: 'tool token is required for media generation in sandbox mode',
      status: 401,
    };
  }

  return { ok: true, grant: input.grant };
}

export { mediaTaskErrorFromFailure };

export function registerMediaRoutes(app: Express, ctx: RegisterMediaRoutesDeps) {
  const { db, design } = ctx;
  const { sendApiError, requireLocalDaemonRequest, isLocalSameOrigin, resolvedPortRef } = ctx.http;
  const { PROJECT_ROOT, PROJECTS_DIR, RUNTIME_DATA_DIR } = ctx.paths;
  // Derived from the one resolved daemon data root; the store rejects anything
  // else, so there is no second data root to drift.
  const chatArtifactBlobs = createChatArtifactBlobStore({ dataDir: RUNTIME_DATA_DIR });
  const chatArtifactQuota = resolveChatArtifactQuota(process.env);
  const { authorizeToolRequest, optionalToolGrantFromRequest, requestProjectOverride } = ctx.auth;
  const { randomUUID } = ctx.ids;
  const { MEDIA_PROVIDERS, MEDIA_ASPECTS, VIDEO_LENGTHS_SEC, readMaskedConfig, writeConfig, generateMedia, createMediaTask, persistMediaTask, appendTaskProgress, notifyTaskWaiters, getLiveMediaTask, mediaTaskSnapshot, listMediaTasksByProject } = ctx.media;
  const { readAppConfig, writeAppConfig } = ctx.appConfig;
  const onAppConfigWritten =
    typeof ctx.appConfig.onAppConfigWritten === 'function'
      ? ctx.appConfig.onAppConfigWritten
      : null;
  const { orbitService } = ctx.orbit;
  const { openBrowser, openNativeFolderDialog } = ctx.nativeDialogs;
  const { getWorkspaceProjectByProjectId, getProject } = ctx.projectStore;
  const { listFiles, resolveProjectDir, resolveProjectFilePath } = ctx.projectFiles;
  const { insertConversation, upsertMessage } = ctx.conversations;
  const getResolvedPort = () => resolvedPortRef.current;

  const mediaPolicyForGrant = (grant: ToolTokenGrant | null):
    | { ok: true; policy: MediaExecutionPolicy }
    | { ok: false; code: string; message: string } => {
    if (!grant?.runId) return { ok: true, policy: defaultMediaExecutionPolicy() };
    const run = design.runs.get(grant.runId);
    if (!run) {
      return {
        ok: false,
        code: 'MEDIA_POLICY_UNAVAILABLE',
        message: 'media generation policy is unavailable for this run',
      };
    }
    return { ok: true, policy: run.mediaExecution ?? defaultMediaExecutionPolicy() };
  };

  const mediaAnalyticsContext = async (
    req: any,
    grant: ToolTokenGrant | null,
  ): Promise<AnalyticsContext | null> => resolveMediaAnalyticsContext({
    req,
    design,
    runId: grant?.runId,
    readAppConfig,
    runtimeDataDir: RUNTIME_DATA_DIR,
  });

  const handleGenerate = async (
    req: any,
    res: any,
    options: { projectId: string; grant: ToolTokenGrant | null },
  ) => {
    const projectId = options.projectId;
    const project = getProject(db, projectId);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const surface = req.body?.surface;
    if (surface !== 'image' && surface !== 'video') {
      return sendApiError(res, 400, 'BAD_REQUEST', 'surface must be image or video');
    }
    const model = typeof req.body?.model === 'string' ? req.body.model : '';
    if (!model) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'model is required');
    }
    // One image unless the caller asked for a batch. Clamped here, at the
    // request boundary, so every downstream path sees the same number.
    const requestedCount = clampMediaGenerateCount(req.body?.count);

    const policy = mediaPolicyForGrant(options.grant);
    if (!policy.ok) {
      return sendApiError(res, 403, policy.code, policy.message);
    }
    const denial = mediaPolicyDenial(policy.policy, { surface, model });
    if (denial) {
      return sendApiError(res, 403, denial.code, denial.message);
    }

    /**
     * The dual of `attachLateOutputToRunMessage` below: hand the FAILURE back to
     * the turn that asked for it.
     *
     * Every failure path here already knew which run this was — `runId` is right
     * there in `options.grant`, printed in the `[media]` diagnostic and shipped
     * to analytics — and none of them wrote it anywhere the run could see. So
     * the run's terminal verdict came from the agent's exit code alone: the
     * agent apologises in prose and exits 0, and the turn published
     * `status: "succeeded"`, `endedWithUnfinishedWork: false`, a green check and
     * an empty artifact rail while the daemon's own log said the only
     * deliverable had failed 55s earlier.
     *
     * Declared outside the try so BOTH failure paths reach it: the async
     * provider rejection AND the synchronous dispatch throw below, which marks
     * the same task failed and would otherwise stay silent for the same reason.
     *
     * Best-effort by construction: the task is already marked failed and its
     * waiters already told, so this must never turn a recorded failure into an
     * unhandled rejection.
     */
    const reportFailureToRun = (taskId: string, error: unknown): void => {
      const runId = options.grant?.runId;
      if (!runId || !taskId) return;
      try {
        design.runs.noteMediaTaskFailure(runId, {
          taskId,
          surface,
          model,
          failedAt: Date.now(),
          error,
        });
      } catch (err) {
        console.warn('[media] run failure association failed', err);
      }
    };

    let task: ReturnType<typeof createMediaTask> | null = null;
    try {
      const taskId = randomUUID();
      const analyticsContext = await mediaAnalyticsContext(req, options.grant);
      let providerRequestSummary:
        | (ImageGenerationRequestSummary & { providerId: string })
        | null = null;
      task = createMediaTask(taskId, projectId, {
        surface: req.body?.surface,
        model: req.body?.model,
        runId: options.grant?.runId,
      });
      const requestedProviderId = mediaProviderId(model);
      const diagnosticContext = {
        taskId,
        runId: options.grant?.runId,
        projectId,
        surface,
        model,
      };
      console.error(formatMediaTaskDiagnostic({
        ...diagnosticContext,
        event: 'queued',
        providerId: requestedProviderId,
        status: task.status,
        referenceImageCount: Array.isArray(req.body?.images)
          ? req.body.images.length
          : req.body?.image
            ? 1
            : 0,
        hasCompositionDir: Boolean(req.body?.compositionDir),
      }));

      /**
       * Hand this task's output back to the turn that asked for it.
       *
       * A media generation is a 202 dispatch: the file can land long after the
       * run went terminal, and the run-terminal produced-file floor works off a
       * filesystem diff frozen before these bytes existed (Plane OPEND-2608 /
       * OPEND-2609). `associateLateRunProducedFile` is additive and refuses to
       * act while the run is still live, so the terminal pass keeps ownership
       * of every file that DID land in time.
       *
       * Resolves the project directory exactly the way `generateMedia` does
       * (`ensureProject(projectsRoot, projectId)` — no metadata), so this points
       * at the bytes that were actually written.
       */
      const attachLateOutputToRunMessage = async (meta: unknown): Promise<void> => {
        const runId = options.grant?.runId;
        const name =
          meta && typeof meta === 'object' && typeof (meta as { name?: unknown }).name === 'string'
            ? (meta as { name: string }).name
            : '';
        if (!runId || !name) return;
        try {
          await associateLateRunProducedFile(db, {
            runId,
            projectRoot: resolveProjectDir(PROJECTS_DIR, projectId),
            projectRelativePath: name,
          });
        } catch (err) {
          console.warn('[media] late produced-file association failed', err);
        }
      };

      const proxyDispatcher = proxyDispatcherRequestInit(process.env, {
        headersTimeout: LONG_MEDIA_PROXY_TIMEOUT_MS,
        bodyTimeout: LONG_MEDIA_PROXY_TIMEOUT_MS,
      });
      task.status = 'running';
      persistMediaTask(task);
      // Media billing follows the project's Workspace binding, not its sharing
      // visibility. A private project inside a team Workspace must still spend
      // that Workspace's balance; `findTeamWorkspaceIdForProject` deliberately
      // answers the narrower collaboration question and excludes it.
      const workspaceId =
        getWorkspaceProjectByProjectId(db, projectId)?.workspaceId?.trim() || undefined;
      const baseArgs = {
        projectRoot: PROJECT_ROOT,
        projectsRoot: PROJECTS_DIR,
        projectId,
        surface: req.body?.surface,
        model: req.body?.model,
        prompt: req.body?.prompt,
        output: req.body?.output,
        aspect: req.body?.aspect,
        quality: typeof req.body?.quality === 'string' ? req.body.quality : undefined,
        resolution: typeof req.body?.resolution === 'string' ? req.body.resolution : undefined,
        // The direct-image workbench names the model its own endpoint serves.
        // Wins over the provider config and the catalog alias inside the
        // renderer; absent for every other caller.
        modelOverride: typeof req.body?.modelOverride === 'string'
          ? req.body.modelOverride
          : undefined,
        length:
          typeof req.body?.length === 'number' ? req.body.length : undefined,
        compositionDir: req.body?.compositionDir,
        image: req.body?.image,
        images: Array.isArray(req.body?.images) ? req.body.images : undefined,
        workspaceId,
        // Strong capture path (spec §5.1.1): freeze the provider's own bytes
        // the moment they land, so a later turn overwriting the same output
        // name can never rewrite this message's history. Bound to THIS run and
        // task, so the run-terminal pass can reuse it verbatim instead of
        // re-reading a file that may already have moved on.
        onBytesWritten: async (written: {
          bytes: Buffer;
          name: string;
          mime: string;
          kind: string;
          mtime: number;
        }) => {
          await captureChatArtifactSnapshotFromBytes(
            { db, blobs: chatArtifactBlobs, quota: chatArtifactQuota },
            {
              projectId,
              projectRelativePath: written.name,
              kind: written.kind,
              mime: written.mime,
              bytes: written.bytes,
              sourceMtime: written.mtime,
              ...(options.grant?.runId ? { runId: options.grant.runId } : {}),
              mediaTaskId: taskId,
            },
          );
        },
        onProgress: (line: any) => appendTaskProgress(task, line),
        requestInit: proxyDispatcher.requestInit,
        onProviderRequestSettled: (summary: ImageGenerationRequestSummary & { providerId: string }) => {
          providerRequestSummary = summary;
        },
      };

      // Multi-image request: N parallel single-image calls, answered once every
      // slot has settled. The caller asked for files, not for N tasks, so this
      // path reports per-file outcomes instead of a task to poll.
      if (requestedCount > 1) {
        const outputBase =
          typeof req.body?.output === 'string' && req.body.output.trim()
            ? req.body.output.trim()
            : autoOutputName(surface, model);
        const outputNames = Array.from(
          { length: requestedCount },
          (_, index) => deriveBatchOutputName(outputBase, index + 1),
        );
        const batch = await generateMediaBatch(baseArgs, outputNames, generateMedia);
        // `providerRequestSummary` is written from inside the provider callback
        // below, which control-flow analysis cannot follow to this point. The
        // assertion reads it at its declared type, exactly like the async
        // `.then` path does, instead of the `null` it was initialised with.
        const settledProvider = providerRequestSummary as
          | (ImageGenerationRequestSummary & { providerId: string })
          | null;
        task.status = batch.metas.length > 0 ? 'done' : 'failed';
        if (batch.metas.length > 0) task.file = batch.metas[0];
        else {
          task.error = mediaTaskErrorFromFailure(
            new Error(batch.files[0]?.error ?? 'image generation failed'),
            { model },
          );
        }
        task.endedAt = Date.now();
        persistMediaTask(task);
        if (analyticsContext && settledProvider && batch.metas.length > 0) {
          captureMediaGenerationResult(design, {
            analyticsContext,
            durationMs: task.endedAt - task.startedAt,
            meta: batch.metas[0],
            model,
            projectId,
            providerRequestSummary: settledProvider,
            ...(options.grant?.runId ? { runId: options.grant.runId } : {}),
            surface,
            taskId,
          });
        }
        notifyTaskWaiters(task);
        console.error(formatMediaTaskDiagnostic({
          ...diagnosticContext,
          event: task.status === 'done' ? 'done' : 'failed',
          providerId: batch.metas[0]?.providerId ?? settledProvider?.providerId ?? requestedProviderId,
          status: task.status,
          elapsedMs: task.endedAt - task.startedAt,
          fileSize: typeof batch.metas[0]?.size === 'number' ? batch.metas[0].size : undefined,
          mime: typeof batch.metas[0]?.mime === 'string' ? batch.metas[0].mime : undefined,
          error: task.error?.message,
        }));
        await proxyDispatcher.close();
        for (const meta of batch.metas) await attachLateOutputToRunMessage(meta);
        if (batch.metas.length === 0) {
          // Same invariant as the single-image failure path: a run that asked
          // for these images must not report itself complete without them.
          if (task.error) reportFailureToRun(taskId, task.error);
          return sendApiError(
            res,
            502,
            'MEDIA_GENERATION_FAILED',
            batch.files[0]?.error ?? 'image generation failed',
          );
        }
        return res.status(200).json({
          taskId,
          status: task.status,
          startedAt: task.startedAt,
          files: batch.files,
        });
      }

      generateMedia(baseArgs)
        .then(async (meta: any) => {
          task.status = 'done';
          task.file = meta;
          task.endedAt = Date.now();
          persistMediaTask(task);
          if (analyticsContext && providerRequestSummary) {
            captureMediaGenerationResult(design, {
              analyticsContext,
              durationMs: task.endedAt - task.startedAt,
              meta,
              model,
              projectId,
              providerRequestSummary,
              ...(options.grant?.runId ? { runId: options.grant.runId } : {}),
              surface,
              taskId,
            });
          }
          notifyTaskWaiters(task);
          console.error(formatMediaTaskDiagnostic({
            ...diagnosticContext,
            event: 'done',
            providerId: meta?.providerId ?? providerRequestSummary?.providerId ?? requestedProviderId,
            status: task.status,
            elapsedMs: task.endedAt - task.startedAt,
            fileSize: typeof meta?.size === 'number' ? meta.size : undefined,
            mime: typeof meta?.mime === 'string' ? meta.mime : undefined,
          }));
          // Last, and only after the waiters have been told: this generation
          // may have outlived the turn that asked for it, and the run-terminal
          // floor froze its file list before these bytes existed. Attach them
          // to that turn now, additively. A no-op whenever the run is still
          // live — the terminal pass covers that case on its own.
          await attachLateOutputToRunMessage(meta);
        })
        .catch((err: any) => {
          task.status = 'failed';
          task.error = mediaTaskErrorFromFailure(err, { model });
          task.endedAt = Date.now();
          persistMediaTask(task);
          if (analyticsContext && providerRequestSummary) {
            captureMediaGenerationResult(design, {
              analyticsContext,
              durationMs: task.endedAt - task.startedAt,
              model,
              projectId,
              providerRequestSummary,
              ...(options.grant?.runId ? { runId: options.grant.runId } : {}),
              surface,
              taskId,
            });
          }
          notifyTaskWaiters(task);
          console.error(formatMediaTaskDiagnostic({
            ...diagnosticContext,
            event: 'failed',
            providerId: providerRequestSummary?.providerId ?? requestedProviderId,
            status: task.error.status,
            code: task.error.code,
            elapsedMs: task.endedAt - task.startedAt,
            error: task.error.message,
          }));
          // Last, and only after the waiters have been told: the run that asked
          // for this generation must not be able to report itself complete when
          // the host just watched its deliverable fail.
          reportFailureToRun(taskId, task.error);
        })
        .finally(() => proxyDispatcher.close());

      return res.status(202).json({
        taskId,
        status: task.status,
        startedAt: task.startedAt,
      });
    } catch (err: any) {
      if (task) {
        task.status = 'failed';
        task.error = mediaTaskErrorFromFailure(err, { model });
        task.endedAt = Date.now();
        persistMediaTask(task);
        notifyTaskWaiters(task);
        console.error(formatMediaTaskDiagnostic({
          event: 'failed',
          taskId: task.id,
          runId: options.grant?.runId,
          projectId,
          surface,
          model,
          providerId: mediaProviderId(model),
          status: task.error.status,
          code: task.error.code,
          elapsedMs: task.endedAt - task.startedAt,
          error: task.error.message,
        }));
        // Same invariant as the async rejection above: a dispatch that threw
        // before the provider was ever reached is still a generation this run
        // asked for and did not get.
        reportFailureToRun(task.id, task.error);
      }
      throw err;
    }
  };

  const handleHyperFramesScaffold = async (
    req: any,
    res: any,
    projectId: string,
  ) => {
    const project = getProject(db, projectId);
    if (!project) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
    }
    const body = (req.body ?? {}) as Partial<HyperFramesScaffoldRequest>;
    if (typeof body.compositionDir !== 'string' || !body.compositionDir.trim()) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'compositionDir is required');
    }
    const projectDir = resolveProjectDir(PROJECTS_DIR, project.id, project.metadata);
    const result: HyperFramesScaffoldResponse = await scaffoldHyperFramesComposition({
      projectDir,
      compositionDir: body.compositionDir,
    });
    return res.status(201).json(result);
  };

  app.get('/api/media/models', (_req, res) => {
    // 阶段1：不再指向 vela 云的媒体模型/ provider 不进入目录，前端选择器
    // 与 CLI 帮助因此看不到它们（`offeredModelsForSurface` 是那条唯一规则）。
    res.json({
      providers: MEDIA_PROVIDERS.filter(isMediaProviderOffered),
      image: offeredModelsForSurface('image'),
      video: offeredModelsForSurface('video'),
      aspects: MEDIA_ASPECTS,
      videoLengthsSec: VIDEO_LENGTHS_SEC,
    });
  });

  app.get('/api/media/config', async (_req, res) => {
    try {
      const cfg = await readMaskedConfig(PROJECT_ROOT);
      res.json(cfg);
    } catch (err: any) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.put('/api/media/config', async (req, res) => {
    try {
      const cfg = await writeConfig(PROJECT_ROOT, req.body);
      res.json(cfg);
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      res
        .status(status)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  // Model catalogue for a provider the user configured, for the Settings →
  // Media "fetch models" button. The daemon makes the call instead of the
  // browser so the stored API key never leaves the daemon and the redirect /
  // timeout policy stays in one place; the upstream origin comes from the
  // saved config (or the registry default), never from the request, and only
  // providers flagged `supportsModelFetch` are served — either one of those
  // missing would make this an open proxy for any URL in the path.
  app.get('/api/media/providers/:id/model-options', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const proxyDispatcher = proxyDispatcherRequestInit(process.env);
    try {
      const models = await fetchProviderModelOptions(PROJECT_ROOT, req.params.id, {
        requestInit: proxyDispatcher.requestInit,
      });
      res.json({ ok: true, models });
    } catch (err: any) {
      // Every failure leaves through this one envelope shape; the status comes
      // off the error (400/404/502) and defaults to 502 for anything that is
      // not a recognized precondition — e.g. the upstream fetch itself
      // throwing (DNS, TLS, proxy, timeout).
      const status = typeof err?.status === 'number' ? err.status : 502;
      res
        .status(status)
        .json({ error: String(err && err.message ? err.message : err) });
    } finally {
      await proxyDispatcher.close();
    }
  });

  app.get('/api/app-config', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const config = await readAppConfig(RUNTIME_DATA_DIR);
      res.json({ config });
    } catch (err: any) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.put('/api/app-config', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const currentConfig = await readAppConfig(RUNTIME_DATA_DIR);
      if (
        req.body?.orbit
        && typeof req.body.orbit === 'object'
        && Object.hasOwn(req.body.orbit, 'workspaceScope')
        && JSON.stringify(req.body.orbit) !== JSON.stringify(currentConfig.orbit)
      ) {
        const scope = normalizePersistedAutomationWorkspaceScope(
          req.body.orbit.workspaceScope,
        );
        if (req.body.orbit.workspaceScope !== null && !scope) {
          return res.status(400).json({
            error: 'Orbit Workspace scope must contain workspaceId and workspaceMemberId',
            code: 'WORKSPACE_CONTEXT_INCOMPLETE',
          });
        }
        if (scope) {
          const claimedWorkspaceId = String(req.get('x-od-workspace-id') ?? '').trim();
          const claimedMemberId = String(req.get('x-od-workspace-member-id') ?? '').trim();
          if (
            claimedWorkspaceId !== scope.workspaceId
            || claimedMemberId !== scope.workspaceMemberId
          ) {
            return res.status(400).json({
              error: 'Orbit Workspace scope must match the explicit request identity',
              code: 'WORKSPACE_CONTEXT_INCOMPLETE',
            });
          }
        }
      }
      const config = await writeAppConfig(RUNTIME_DATA_DIR, req.body);
      // 全局代理设置：本轮写入触及 proxyPrefs 时同步本进程代理环境。
      if (Object.hasOwn(req.body ?? {}, 'proxyPrefs')) {
        applyProxyPrefsToProcess(config.proxyPrefs);
      }
      orbitService.configure(config.orbit);
      onAppConfigWritten?.(config);
      res.json({ config });
    } catch (err: any) {
      if (err?.code === 'INVALID_APP_CONFIG_VALUE') {
        // Nested envelope on purpose. `od`'s error reader only finds a code in
        // this shape; from a flat body it falls back to `daemon-not-running`
        // and exits 64, which tells a caller to go start a daemon that just
        // answered. Rejected input should read as a plain failure.
        return res.status(400).json({
          error: { code: err.code, message: String(err.message) },
        });
      }
      const status = err?.code === 'WORKSPACE_ACCESS_DENIED'
          ? 403
          : 500;
      res
        .status(status)
        .json({
          error: String(err && err.message ? err.message : err),
          ...(err?.code ? { code: err.code } : {}),
          ...(err?.retryable ? { retryable: true } : {}),
        });
    }
  });

  // Lightweight existence probe for a single directory, used by the composer
  // to flag a working directory in red the moment its folder is gone (the
  // composer re-checks on focus / picker-open, so deletions reflect live).
  app.post('/api/dir-exists', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const dir = typeof req.body?.path === 'string' ? req.body.path : '';
    let exists = false;
    if (dir) {
      try {
        exists = fs.statSync(dir).isDirectory();
      } catch {
        exists = false;
      }
    }
    res.json({ exists });
  });

  // Recent working directories, pruned to those that still exist on disk. A
  // folder the user deleted (or an external drive that's gone) drops out of
  // the list here and the pruned list is persisted back, so the picker's
  // "recent folders" never offers a path that no longer resolves.
  app.get('/api/recent-dirs', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const config = await readAppConfig(RUNTIME_DATA_DIR);
      const recents = Array.isArray(config.recentLinkedDirs)
        ? config.recentLinkedDirs
        : [];
      const existing = recents.filter((dir: string) => {
        try {
          return fs.statSync(dir).isDirectory();
        } catch {
          return false;
        }
      });
      if (existing.length !== recents.length) {
        await writeAppConfig(RUNTIME_DATA_DIR, { recentLinkedDirs: existing });
      }
      /** @type {import('@open-design/contracts').RecentLinkedDirsResponse} */
      const body = { dirs: existing };
      res.json(body);
    } catch (err: any) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.get('/api/orbit/status', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      res.json(await orbitService.status());
    } catch (err: any) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.post('/api/orbit/run', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const locale = typeof req.body?.locale === 'string' ? req.body.locale : null;
      res.json(await orbitService.start('manual', { locale }));
    } catch (err: any) {
      const status = err?.code === 'WORKSPACE_ACCESS_DENIED'
          ? 403
          : 500;
      res
        .status(status)
        .json({
          error: String(err && err.message ? err.message : err),
          ...(err?.code ? { code: err.code } : {}),
          ...(err?.retryable ? { retryable: true } : {}),
        });
    }
  });

  app.post('/api/system/open-external', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return res.status(400).json({ ok: false, error: 'url must be a valid URL' });
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return res.status(400).json({ ok: false, error: 'url must be http or https' });
      }
      const child = openBrowser(parsed.toString());
      res.json({ ok: Boolean(child) });
    } catch (err: any) {
      res
        .status(500)
        .json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  });

  // Native OS folder picker dialog. Returns { path: string | null }.
  app.post('/api/dialog/open-folder', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const selected = await openNativeFolderDialog();
      res.json({ path: selected });
    } catch (err: any) {
      res
        .status(500)
        .json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.post('/api/projects/:id/media/hyperframes/scaffold', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({
        error: 'cross-origin request rejected: HyperFrames scaffolding is restricted to the local UI / CLI',
      });
    }
    try {
      const project = getProject(db, req.params.id);
      if (!project) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      await handleHyperFramesScaffold(req, res, project.id);
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      const code = err?.code;
      const body: any = { error: String(err && err.message ? err.message : err) };
      if (code) body.code = code;
      res.status(status).json(body);
    }
  });

  app.post(HYPERFRAMES_SCAFFOLD_TOOL_ENDPOINT, async (req, res) => {
    const grant = authorizeToolRequest(req, res, 'media:scaffold', {
      endpoint: HYPERFRAMES_SCAFFOLD_TOOL_ENDPOINT,
    });
    if (!grant) return;
    try {
      await handleHyperFramesScaffold(req, res, grant.projectId);
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      const code = err?.code;
      const body: any = { error: String(err && err.message ? err.message : err) };
      if (code) body.code = code;
      res.status(status).json(body);
    }
  });

  app.post('/api/projects/:id/media/generate', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({
        error:
          'cross-origin request rejected: media generation is restricted to the local UI / CLI',
      });
    }

    try {
      const project = getProject(db, req.params.id);
      if (!project) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      const grant = optionalToolGrantFromRequest(req, { operation: 'media:generate' });
      const grantDecision = resolveLegacyMediaRouteGrant({
        grant,
        projectId: req.params.id,
        requestProjectOverride,
        sandboxMode: isSandboxModeEnabled(process.env),
      });
      if (!grantDecision.ok) {
        return sendApiError(
          res,
          grantDecision.status,
          grantDecision.code,
          grantDecision.message,
          grantDecision.details ? { details: grantDecision.details } : {},
        );
      }
      await handleGenerate(req, res, { projectId: req.params.id, grant: grantDecision.grant });
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      const code = err?.code;
      const body: any = { error: String(err && err.message ? err.message : err) };
      if (code) body.code = code;
      res.status(status).json(body);
    }
  });

  app.post('/api/tools/media/generate', async (req, res) => {
    const grant = authorizeToolRequest(req, res, 'media:generate');
    if (!grant) return;
    try {
      await handleGenerate(req, res, { projectId: grant.projectId, grant });
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      const code = err?.code;
      const body: any = { error: String(err && err.message ? err.message : err) };
      if (code) body.code = code;
      res.status(status).json(body);
    }
  });

  app.post('/api/media/tasks/:id/wait', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const authorizationHeader = req.get('authorization');
    // Only a Bearer credential chooses the tool-token lane: that is the sole
    // shape `bearerTokenFromRequest` parses. A reverse proxy that
    // authenticates browsers itself forwards its own `Authorization: Basic
    // ...`, which can never satisfy the lane, so claiming it here failed
    // every proxied wait with TOOL_TOKEN_MISSING. Once a Bearer caller does
    // choose the lane, invalid, expired, or under-scoped credentials must not
    // downgrade to project authorization.
    // Classify the scheme independently of whether a token follows it: a bare
    // `Bearer` (or `Bearer ` trimmed to it) is still a caller reaching for the
    // tool-token lane and must keep failing closed with TOOL_TOKEN_MISSING
    // rather than downgrading to browser project authority.
    const usesToolTokenLane = typeof authorizationHeader === 'string'
      && /^Bearer(?:\s|$)/i.test(authorizationHeader.trim());
    const toolGrant = usesToolTokenLane
      ? authorizeToolRequest(
          req,
          res,
          'media:generate',
          { endpoint: MEDIA_TASK_WAIT_TOOL_ENDPOINT },
        )
      : null;
    if (usesToolTokenLane && !toolGrant) return;

    // Token callers must prove their grant targets the persisted local project
    // before task lookup; cloud availability is irrelevant to this local wait.
    const taskId = req.params.id;
    const task = getLiveMediaTask(taskId);
    if (!task) return res.status(404).json({ error: 'task not found' });
    if (toolGrant) {
      if (requestProjectOverride(task.projectId, toolGrant.projectId)) {
        return sendApiError(
          res,
          403,
          'FORBIDDEN',
          'media task belongs to a different project',
        );
      }
    }

    const since = Number.isFinite(req.body?.since) ? Number(req.body.since) : 0;
    const requestedTimeout = Number.isFinite(req.body?.timeoutMs)
      ? Number(req.body.timeoutMs)
      : 25_000;
    const timeoutMs = Math.min(Math.max(requestedTimeout, 0), 25_000);

    const respond = () => {
      if (res.writableEnded) return;
      res.json(mediaTaskSnapshot(task, since));
    };

    if (
      task.status === 'done' ||
      task.status === 'failed' ||
      task.status === 'interrupted' ||
      task.progress.length > since
    ) {
      return respond();
    }

    let resolved = false;
    const wake = () => {
      if (resolved) return;
      resolved = true;
      task.waiters.delete(wake);
      clearTimeout(timer);
      respond();
    };
    task.waiters.add(wake);
    const timer = setTimeout(wake, timeoutMs);
    res.on('close', wake);
  });

  app.get('/api/projects/:id/media/tasks', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const projectId = req.params.id;
    const project = getProject(db, projectId);
    if (!project) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
    }
    const includeDone =
      req.query.includeDone === '1' || req.query.includeDone === 'true';
    const taskRows = listMediaTasksByProject(db, projectId, {
      includeTerminal: includeDone,
    });
    const confirmedFiles = new Map<string, ProjectFile>();
    const movedCandidates: typeof taskRows = [];
    if (includeDone && taskRows.some((task: any) => task.status === 'done')) {
      await Promise.all(taskRows.map(async (task: any) => {
        if (task.status !== 'done') return;
        const name = typeof task.file?.name === 'string' ? task.file.name.trim() : '';
        if (!name) return;
        try {
          confirmedFiles.set(
            task.id,
            await resolveProjectFilePath(PROJECTS_DIR, projectId, name, project.metadata),
          );
        } catch {
          if (finiteNumber(task.file?.size) !== null && finiteNumber(task.file?.mtime) !== null) {
            movedCandidates.push(task);
          }
        }
      }));
    }
    if (movedCandidates.length > 0) {
      try {
        const projectFiles = await listFiles(
          PROJECTS_DIR,
          projectId,
          { metadata: project.metadata },
        );
        // Files a task still resolves by its recorded path are already
        // spoken for; a moved task must not take one of them.
        const claimedNames = new Set(
          [...confirmedFiles.values()].map((file) => file.name),
        );
        const resolved = resolveMovedMediaTaskFiles(
          movedCandidates.map((task: any) => ({ taskId: task.id, file: task.file })),
          projectFiles,
          claimedNames,
        );
        for (const [taskId, file] of resolved) confirmedFiles.set(taskId, file);
      } catch {
        // Task status remains useful when an imported folder is temporarily
        // unavailable. Omit unconfirmed files and let the client's bounded
        // terminal poll reconcile them if the project root returns.
      }
    }
    const batches = assignMediaTaskBatches(taskRows.map((task: any) => ({
      id: task.id,
      runId: task.runId,
      surface: task.surface,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      sequence: task.sequence,
    })));
    const tasks = taskRows.map((t: any) => {
      const resolvedFile = confirmedFiles.get(t.id) ?? null;
      let confirmedFile: Record<string, unknown> | null = null;
      if (resolvedFile) {
        confirmedFile = reconciledMediaTaskFile(t.file, resolvedFile);
        if ((t.file as { name?: unknown } | null)?.name !== resolvedFile.name) {
          const liveTask = getLiveMediaTask(t.id);
          if (liveTask) {
            liveTask.file = confirmedFile;
            persistMediaTask(liveTask);
          }
        }
      }
      const batch = batches.get(t.id);
      return {
        taskId: t.id,
        sequence: t.sequence,
        ...(batch ?? {}),
        ...(t.runId ? { runId: t.runId } : {}),
        status: t.status,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        elapsed: Math.round(((t.endedAt ?? Date.now()) - t.startedAt) / 1000),
        surface: t.surface,
        model: t.model,
        progress: t.progress.slice(-3),
        progressCount: t.progress.length,
        ...(confirmedFile ? { file: confirmedFile } : {}),
        ...(t.status === 'failed' || t.status === 'interrupted' ? { error: t.error } : {}),
      };
    });
    // Newest first, with creation order breaking the ties a parallel fan-out
    // always produces.
    tasks.sort((a: any, b: any) => (b.startedAt - a.startedAt) || (b.sequence - a.sequence));
    res.json({ tasks });
  });

  // Multi-file upload that the chat composer uses for paste/drop/picker.
  // Files land flat in the project folder; the response carries the same
  // metadata as listFiles so the client can stage them as ChatAttachments
  // without a separate refetch.

}
