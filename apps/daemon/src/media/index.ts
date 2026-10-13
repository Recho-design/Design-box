// Media-generation dispatcher. The unifying contract is:
//
//   skills + metadata + system-prompt
//        ↓ (the code agent decides what to make)
//   `od media generate --surface … --model … --output … --prompt …`
//        ↓ (this module routes to a provider)
//   bytes written to <projectsRoot>/<projectId>/<output>
//        ↓
//   FileViewer renders it.
//
// Every surface (image / video) flows through this single entrypoint.
// Providers live behind the `provider` field on each model entry in
// models.ts — when a real integration ships we route to it; otherwise we
// emit a deterministic, lightweight placeholder (labelled SVG-PNG, blank
// MP4) so the framework works without API keys.
//
// Today we ship real integrations for:
//   * provider 'openai'      → OpenAI Images API (gpt-image-* / dall-e-*),
//                              with auto-detection for Azure OpenAI
//                              deployments based on the configured base URL.
//                              The same slot also carries user-supplied
//                              OpenAI-compatible endpoints (custom base URL /
//                              model / key), including their /images/edits
//                              endpoint when reference images are attached —
//                              the former 'custom-image' provider is gone.
//   * provider 'grok'        → xAI Imagine API: synchronous
//                              /v1/images/generations for grok-imagine-image
//                              and async /v1/videos/generations + GET poll
//                              for grok-imagine-video (t2v + i2v)
//   * provider 'nanobanana'  → Google Generative Language generateContent
//                              (Nano Banana image models)
//   * provider 'hyperframes' → local HTML→MP4 renderer (no network)
//
// The fallback stub handlers are gated behind OD_MEDIA_ALLOW_STUBS=1; in
// release builds they throw StubProviderDisabledError (mapped to HTTP
// 503) instead of writing placeholder bytes that look like a successful
// generation. Real-provider failures still produce a stub byte payload
// when stubs are allowed, but they tag the response with providerError
// so the CLI can exit non-zero and the agent can't silently narrate the
// placeholder as the final result.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Agent as UndiciAgent } from 'undici';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { load as loadHtml } from 'cheerio';
import {
  SETTINGS_MEDIA_PROVIDERS_PATH,
  gptImageQualityFor,
  gptImageSizeFor,
  isGptImageModel,
  nanoBananaAspectRatioFor,
  nanoBananaImageSizeFor,
} from '@open-design/contracts';
import {
  findRealTagOffset,
  HTML_TAG_PATTERNS,
} from '@open-design/contracts/runtime/html-injection-points';
import type {
  DesktopRenderFramesInput,
  DesktopRenderFramesResult,
} from '@open-design/sidecar-proto';
import {
  type MediaModel,
  type MediaProvider,
  type MediaSurface,
  VIDEO_LENGTHS_SEC,
  findMediaModel,
  findProvider,
  modelsForSurface,
} from './models.js';
import {
  resolveModelAlias,
  resolveProviderConfig,
} from './config.js';
import {
  fetchImageGenerationWithResponseRetry,
  type ImageGenerationRequestSummary,
} from './image-generation-retry.js';
import {
  resolveHyperFramesBrowserRuntimePath,
  resolveHyperFramesCliPath,
  resolveHyperFramesNodeBin,
} from './hyperframes-runtime.js';
import {
  ensureProject,
  kindFor,
  mimeFor,
  sanitizeName,
} from '../projects.js';

type ProviderConfig = { apiKey?: string; baseUrl?: string; model?: string };
type ProgressFn = (message: string) => void;
type DesktopFrameRenderer = (
  input: DesktopRenderFramesInput,
) => Promise<DesktopRenderFramesResult>;
type ImageRef = { path: string; abs: string; mime: string; size: number; dataUrl: string };
type MediaRequestInit = Pick<RequestInit, 'dispatcher'>;
type MediaContext = {
  surface: MediaSurface;
  /**
   * Registered catalog id (e.g. `dall-e-3`, `grok-imagine-image`,
   * `gemini-3.1-flash-image-preview`). Every model-family branch in
   * the renderers below keys off this field so DALL·E sizing and
   * gpt-image quality continue to fire even when the user has aliased
   * the catalog id to a custom wire-name via issue #1277's alias
   * layer. lefarcen + codex P2 review on PR #1309 caught the
   * regression where a single `ctx.model` doubled for both purposes
   * and accidentally disabled the capability branches under aliasing.
   */
  model: string;
  /**
   * What the provider's request body should carry as `model` (or
   * what gets templated into the URL for Azure-style deployment
   * routing). Equal to `model` when no alias is configured; equal
   * to the user-supplied alias from `OD_MEDIA_MODEL_ALIASES` /
   * `media-config.json` otherwise. Renderers must use this field
   * for `body.model = ...` and for `providerNote` so users see
   * what was actually sent.
   */
  wireModel: string;
  /**
   * 调用方直接指定的模型名,优先级高于一切已配置项。
   *
   * 直接生图工作台(项目面板 → `/media/playground/generate`)用它把用户真正选的
   * wire 模型名带进来，而 openai provider 槽位本身就承载任意 OpenAI 兼容端点
   * (自定义 baseUrl / model / key)，所以模型名不能只存在 provider 配置里,而是
   * 随请求进来。渲染器发 `body.model` 时它排第一。
   */
  modelOverride: string | undefined;
  modelDef: MediaModel;
  provider: MediaProvider | null;
  prompt: string;
  aspect: string | undefined;
  /**
   * Published quality tier the caller asked for, passed through verbatim and
   * left undefined when they asked for nothing. Read by the OpenAI-compatible
   * renderers; the OpenAI branch forwards it as `body.quality` for the
   * gpt-image family and maps it to dall-e's own 'hd' / 'standard' vocabulary.
   */
  quality: string | undefined;
  /** Published output resolution the caller asked for. */
  resolution: string | undefined;
  /**
   * 内容审核档：只有 `'low'` 会让请求体出现 `moderation`,其余(含 `'auto'`、
   * 缺省)一律不发 —— 默认档由 provider 决定。
   */
  moderation: string | undefined;
  /** 透明背景：`true` 才发 `background: 'transparent'`,缺省不发。 */
  transparent: boolean | undefined;
  length: number | undefined;
  compositionDir: string | null;
  imageRef: ImageRef | null;
  requestInit: MediaRequestInit;
  /** Additional reference images for multi-image i2v / style reference flows. */
  imageRefs: ImageRef[];
  projectRoot: string;
  workspaceId: string | undefined;
  onProviderRequestSettled:
    | ((summary: ImageGenerationRequestSummary & { providerId: string }) => void)
    | undefined;
};
type RenderResult = { bytes: Buffer; providerNote: string; suggestedExt?: string };
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorStringProp(err: unknown, key: string): string {
  return isRecord(err) && typeof err[key] === 'string' ? err[key] : '';
}
const NANOBANANA_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
// Verify the current Nano Banana / Gemini image model name against:
// https://ai.google.dev/gemini-api/docs/models
const NANOBANANA_DEFAULT_MODEL = 'gemini-3.1-flash-image-preview';
const DEFAULT_OUTPUT_BY_SURFACE = {
  image: 'image.png',
  video: 'video.mp4',
};

const SURFACES = new Set(['image', 'video']);

// Stubs ship a 1×1 PNG / ~24-byte mp4 so the dispatch path is exercisable
// before real provider integrations land. On a release build that lands as
// "successful" but functionally empty bytes — confusing to users. We
// therefore gate the stub renderers behind OD_MEDIA_ALLOW_STUBS=1 and
// otherwise return a 503 (mapped from the StubProviderDisabledError thrown
// below) with a clear message.
class StubProviderDisabledError extends Error {
  code = 'STUB_PROVIDER_DISABLED';
  status = 503;
  constructor(model: string) {
    super(
      `provider not configured: ${model}. Add your API key in ${SETTINGS_MEDIA_PROVIDERS_PATH} to enable real generation.`,
    );
    this.name = 'StubProviderDisabledError';
  }
}

function stubsAllowed() {
  const v = process.env.OD_MEDIA_ALLOW_STUBS;
  return v === '1' || v === 'true';
}

/**
 * Resolve a project-relative `--image` path into a base64 data URL the
 * upstream model APIs (Grok i2v, OpenAI image-edit, etc.) accept
 * directly. Returns null when no path was supplied.
 *
 * Security: refuses anything that escapes the allowed directory.
 * Without this guard, an agent (or a hallucinated arg) could ask the
 * daemon to upload `/etc/passwd` to a paid model.
 *
 * 「allowed directory」而不是「project directory」：Playground 把 scratch 目录
 * 也交给这里，报错文案不该再说这是项目（O2）。
 */
async function resolveProjectImage(rel: unknown, projectDir: string): Promise<ImageRef | null> {
  if (typeof rel !== 'string' || !rel.trim()) return null;
  const projectRootResolved = path.resolve(projectDir);
  const abs = path.resolve(projectRootResolved, rel.trim());
  if (
    abs !== projectRootResolved &&
    !abs.startsWith(projectRootResolved + path.sep)
  ) {
    throw new Error(
      `--image path "${rel}" resolves outside the allowed directory.`,
    );
  }
  let info;
  try {
    info = await stat(abs);
  } catch {
    throw new Error(`--image not found: ${rel}`);
  }
  if (!info.isFile()) {
    throw new Error(`--image is not a regular file: ${rel}`);
  }
  // Cap at 16 MB. Beyond this, base64 inflation alone (≈4/3) starts
  // hitting body-size limits at the upstream APIs and our own express
  // 4mb body cap on inbound requests; bigger payloads should travel
  // via the dedicated upload endpoint, not the dispatcher.
  const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
  if (info.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `--image too large (${info.size} bytes; max ${MAX_IMAGE_BYTES}).`,
    );
  }
  const bytes = await readFile(abs);
  const ext = path.extname(abs).toLowerCase();
  // Tight allowlist: only what i2v / image-edit endpoints actually
  // consume. Avoids smuggling arbitrary content through as data URLs.
  const mime = ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  })[ext];
  if (!mime) {
    throw new Error(
      `--image has unsupported extension "${ext}". Use png, jpg, jpeg, webp, or gif.`,
    );
  }
  return {
    path: rel.trim(),
    abs,
    mime,
    size: bytes.length,
    dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
  };
}

function clampNumber(value: unknown, allowed: number[]): number | undefined {
  // Accept exact registry values; otherwise snap to the nearest allowed
  // bucket so a hallucinated `Number.MAX_SAFE_INTEGER` can't bill an
  // entire month of credits when real providers plug in.
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (allowed.length === 0) return undefined;
  if (allowed.includes(value)) return value;
  let best = allowed[0]!;
  let bestDiff = Math.abs(value - best);
  for (const a of allowed) {
    const d = Math.abs(value - a);
    if (d < bestDiff) {
      best = a;
      bestDiff = d;
    }
  }
  return best;
}

function clampWithWarning(value: unknown, allowed: number[], flagName: string): { value: number | undefined; warning: string | null } {
  const clamped = clampNumber(value, allowed);
  if (
    typeof value === 'number'
    && Number.isFinite(value)
    && typeof clamped === 'number'
    && clamped !== value
  ) {
    return {
      value: clamped,
      warning: `--${flagName} ${value} clamped to ${clamped} (allowed: ${allowed.join(', ')})`,
    };
  }
  return { value: clamped, warning: null };
}

/**
 * Generate a media artifact and write it into the project's files dir.
 *
 * @param {Object} args
 * @param {string} args.projectRoot   - Repo root (.od/ lives directly under).
 * @param {string} args.projectsRoot  - Absolute path to <repo>/.od/projects.
 * @param {string} args.projectId
 * @param {'image'|'video'} args.surface
 * @param {string} args.model
 * @param {string} [args.prompt]
 * @param {string} [args.output]
 * @param {string} [args.aspect]
 * @param {number} [args.length]
 * @param {string} [args.outputDir] - 显式输出目录：提供时目录完全由它决定。
 * @returns {Promise<{ name: string, size: number, mtime: number, kind: string, mime: string, model: string, surface: string, providerNote: string, providerId: string }>}
 */
export async function generateMedia(args: {
  projectRoot: string; projectsRoot: string; projectId: string; surface: MediaSurface; model: string;
  prompt?: string; output?: string; aspect?: string; quality?: string; resolution?: string;
  /**
   * 内容审核档（仅 gpt-image 族）：`'low'` 才发到上游，其余/缺省不发。
   * 可选且缺省 undefined —— 旧调用方（agent 的 `/api/media/generate`）完全
   * 不知道这个字段，行为不受影响。
   */
  moderation?: string;
  /** 透明背景（仅 gpt-image 族）：`true` 才发 `background: 'transparent'`。 */
  transparent?: boolean;
  /**
   * 显式输出目录：提供时【目录派生】以它为准——跳过 ensureProject，
   * projectsRoot 不再参与路径，projectId 退化为纯错误上下文（不参与路径，
   * 与其同传不构成冲突）。
   *
   * 互斥的是**目录选择行为**，不是参数本身：`outputDir` 存在 → 目录完全由它
   * 决定；未传时行为逐字节不变（agent / CLI / 既有调用方零影响）。它同时是
   * 产物落盘根与参考图解析根——`resolveProjectImage` 强制目标在该目录内，
   * 所以参考图引用是「该目录下的相对路径」。
   */
  outputDir?: string;
  /** Caller-supplied provider model name; wins over provider config + alias. */
  modelOverride?: string;
  length?: number;
  compositionDir?: string; image?: string; images?: string[]; onProgress?: ProgressFn; requestInit?: MediaRequestInit;
  desktopFrameRenderer?: DesktopFrameRenderer | null;
  workspaceId?: string;
  onProviderRequestSettled?: (summary: ImageGenerationRequestSummary & { providerId: string }) => void;
  /**
   * Called once with the EXACT provider bytes that were just written, while
   * they are still in memory.
   *
   * This is the strongest capture point in the daemon: the caller receives the
   * very buffer that produced the file, so an immutable snapshot never has to
   * re-read a path that the next turn may already have overwritten. The media
   * layer stays a pure dispatcher — it hands over bytes and a project-relative
   * name and knows nothing about snapshots, runs, or messages.
   *
   * Failures here must never fail the generation, so the caller's rejection is
   * swallowed by design.
   */
  onBytesWritten?: (written: {
    bytes: Buffer;
    name: string;
    mime: string;
    kind: string;
    mtime: number;
  }) => void | Promise<void>;
}) {
  const {
    projectRoot,
    projectsRoot,
    projectId,
    surface,
    model,
    prompt,
    output,
    aspect,
    quality,
    resolution,
    moderation,
    transparent,
    modelOverride,
    length,
    compositionDir,
    image,
    requestInit,
    workspaceId,
    onProviderRequestSettled,
    outputDir,
  } = args;

  if (!projectRoot) throw new Error('projectRoot required');
  if (!projectsRoot) throw new Error('projectsRoot required');
  if (typeof projectId !== 'string' || !projectId) {
    throw new Error('projectId required');
  }
  if (!SURFACES.has(surface)) {
    throw new Error(`unsupported surface: ${surface}`);
  }
  if (typeof model !== 'string' || !model) {
    throw new Error('model required');
  }
  const def = findMediaModel(model);
  if (!def) {
    throw new Error(
      `unknown model: ${model}. Pass --model from the registered list (see /api/media/models).`,
    );
  }
  // Reject cross-surface combinations for catalogued models.
  const allowed = modelsForSurface(surface);
  if (!allowed.some((m) => m.id === def.id)) {
    const ids = allowed.map((m) => m.id).join(', ');
    throw new Error(
      `model "${model}" is not registered for surface "${surface}". Allowed: ${ids}.`,
    );
  }

  // Clamp registry-bound numeric inputs to their allowed buckets so a
  // hallucinated --length 9999999 doesn't reach a real provider as-is
  // when stubs are swapped for paid integrations.
  const lengthClamp =
    surface === 'video'
      ? clampWithWarning(length, VIDEO_LENGTHS_SEC, 'length')
      : { value: undefined, warning: null };
  const clampedLength = lengthClamp.value;
  const warnings = [lengthClamp.warning].filter(Boolean);

  // 目录派生：显式 outputDir 优先（Playground 两种目标都走它），否则沿用
  // ensureProject 的既有行为。projectId 在显式目录下只剩错误上下文一个角色。
  const dir =
    typeof outputDir === 'string' && outputDir
      ? path.resolve(outputDir)
      : await ensureProject(projectsRoot, projectId);
  const safeOut = sanitizeName(output || autoOutputName(surface, model));
  const target = path.join(dir, safeOut);
  await mkdir(path.dirname(target), { recursive: true });

  // Reference image for image-to-video / image-edit flows. The agent
  // passes a project-relative path; we read it once here, validate it
  // stays inside the project, and turn it into a base64 data URL the
  // upstream APIs accept directly. Renderers consume `ctx.imageRef`
  // and decide how to splice the data URL into their request.
  const imageRef = await resolveProjectImage(image, dir);

  // Multi-image support: resolve additional images from the `images`
  // array param. The first resolved image (imageRef) is the primary
  // reference; additional images flow as style/content references.
  const extraImages = Array.isArray(args.images) ? args.images : [];
  const imageRefs: ImageRef[] = [];
  if (imageRef) imageRefs.push(imageRef);
  for (const imgPath of extraImages) {
    const ref = await resolveProjectImage(imgPath, dir);
    if (ref && !imageRefs.some((r) => r.abs === ref.abs)) {
      imageRefs.push(ref);
    }
  }

  // Resolve any user-configured model alias BEFORE we hand the id to a
  // dispatcher (issue #1277). Catalog lookup + surface validation above
  // resolved product shorthands to `def.id`, so use that canonical id here.
  // The alias only changes what the provider receives on the wire.
  // lefarcen + codex P2 on PR #1309: keep BOTH values on ctx so capability
  // branches (DALL·E sizing, gpt-image quality) continue to key off the
  // catalog id while the provider's request body carries the alias.
  const canonicalModel = def.id;
  const wireModel = await resolveModelAlias(projectRoot, canonicalModel);
  const ctx: MediaContext = {
    surface,
    model: canonicalModel,
    wireModel,
    // Trimmed, and an all-whitespace override collapses to "no override" so a
    // renderer can treat it as absent instead of sending an empty model name.
    modelOverride:
      typeof modelOverride === 'string' && modelOverride.trim()
        ? modelOverride.trim()
        : undefined,
    modelDef: def,
    provider: findProvider(def.provider),
    prompt: prompt || '',
    aspect: aspect || defaultAspectFor(surface),
    // No default tier or resolution here on purpose: unlike aspect, an absent
    // one is a meaningful request. Substituting a value would take the pricing
    // decision away from the provider's own default.
    quality: typeof quality === 'string' && quality.trim() ? quality.trim() : undefined,
    resolution: typeof resolution === 'string' && resolution.trim() ? resolution.trim() : undefined,
    moderation: typeof moderation === 'string' && moderation.trim() ? moderation.trim() : undefined,
    // `=== true` 而不是真值判断：请求体里 `transparent: false` 与缺省同义。
    transparent: transparent === true ? true : undefined,
    length: clampedLength,
    // Project-relative path to the directory the agent scaffolded with
    // hyperframes.json / meta.json / index.html. Only consumed by the
    // hyperframes renderer; null/empty for every other provider.
    compositionDir: typeof compositionDir === 'string' ? compositionDir : null,
    // Resolved reference image for i2v / image-edit flows. `null` when
    // the agent didn't pass --image. See resolveProjectImage below.
    imageRef,
    requestInit: requestInit || {},
    imageRefs,
    projectRoot,
    workspaceId,
    onProviderRequestSettled,
  };

  const credentials = await resolveProviderConfig(projectRoot, def.provider);

  let bytes: Buffer;
  let providerNote: string;
  let suggestedExt: string | undefined;
  let providerId = def.provider;
  // Tracks whether the bytes came from a real provider call or from the
  // stub fallback. Surfaces in the response so the CLI/agent can tell a
  // legitimate placeholder ("provider not integrated yet") apart from a
  // silent failure ("API call blew up, here's a 67-byte PNG"). Without
  // this flag the chat agent narrates the stub as if it's the expected
  // output, and the user sees a blank file.
  let providerError: string | null = null;
  let usedStubFallback = false;
  // True only when the dispatcher intentionally returned a stub because
  // no real renderer is wired up for this (provider, surface) pair.
  let intentionalStub = false;
  try {
    if (def.provider === 'openai' && surface === 'image') {
      const result = await renderOpenAIImage(ctx, credentials);
      bytes = result.bytes;
      providerNote = result.providerNote;
      suggestedExt = result.suggestedExt;
    } else if (def.provider === 'grok' && surface === 'image') {
      const result = await renderGrokImage(ctx, credentials);
      bytes = result.bytes;
      providerNote = result.providerNote;
      suggestedExt = result.suggestedExt;
    } else if (def.provider === 'grok' && surface === 'video') {
      const result = await renderGrokVideo(ctx, credentials, args.onProgress);
      bytes = result.bytes;
      providerNote = result.providerNote;
      suggestedExt = result.suggestedExt;
    } else if (def.provider === 'nanobanana' && surface === 'image') {
      const result = await renderNanoBananaImage(ctx, credentials);
      bytes = result.bytes;
      providerNote = result.providerNote;
      suggestedExt = result.suggestedExt;
    } else if (def.provider === 'hyperframes' && surface === 'video') {
      // HyperFrames is templated by the agent (it reads the vendored
      // skill at skills/hyperframes/SKILL.md and writes a composition
      // HTML based on the user's prompt). But the actual `npx
      // hyperframes render` step runs HERE in the daemon process, not
      // in the agent's shell. Reason: the agent's shell on macOS
      // (Claude Code in particular) is wrapped in `sandbox-exec`, and
      // puppeteer's Chrome subprocess hangs partway through frame
      // capture under that sandbox. The daemon process is unsandboxed,
      // so puppeteer behaves correctly. Agent-side npx is reserved for
      // the lighter HF subcommands (lint, transcribe, tts) that don't
      // need to spawn Chrome.
      const result = await renderHyperFrames(
        ctx,
        dir,
        args.desktopFrameRenderer ?? null,
        args.onProgress,
      );
      bytes = result.bytes;
      providerNote = result.providerNote;
      suggestedExt = result.suggestedExt;
    } else {
      // No real renderer wired up for this (provider, surface). Gate the
      // stub fallback behind OD_MEDIA_ALLOW_STUBS so release builds don't
      // silently write placeholder bytes to disk and confuse the user.
      if (!stubsAllowed()) {
        throw new StubProviderDisabledError(model);
      }
      const result = await renderStub(ctx, safeOut);
      bytes = result.bytes;
      providerNote = result.providerNote;
      intentionalStub = true;
    }
  } catch (err) {
    // Stub-disabled errors are intentional — propagate so the daemon
    // maps them to 503 and the CLI surfaces a clear "configure a real
    // provider" message rather than writing fake bytes.
    if (err instanceof StubProviderDisabledError) {
      throw err;
    }
    // HyperFrames is a local render, not a remote provider. Falling back
    // to a stub here hides actionable composition/preflight failures and
    // can make the agent retry or narrate a fake MP4 as success.
    if (def.provider === 'hyperframes') {
      throw err;
    }
    // A real provider failed (network blip, 4xx, missing key, …). We
    // still want to fall back to a stub so the agent's chat loop
    // doesn't dead-end — but only when stubs are allowed for this
    // build. Otherwise re-throw so the CLI exits non-zero with the
    // real upstream message.
    if (!stubsAllowed()) {
      throw err;
    }
    const stub = await renderStub(ctx, safeOut);
    bytes = stub.bytes;
    const msg = errorMessage(err);
    providerNote = `[${providerId} error → stub] ${msg}`;
    providerError = msg;
    usedStubFallback = true;
    // Also log to daemon stderr so the failure is visible in the daemon
    // terminal — easiest place for the developer/operator to spot it.
    try {
      console.error(
        `[media] ${providerId}/${surface}/${model} failed: ${msg}`,
      );
    } catch {
      // best-effort logging only
    }
  }
  // Tag the providerNote with `[stub]` only when the bytes actually came
  // from the stub renderer — either as the intentional fallback for an
  // unintegrated (provider, surface) pair, or because a real-provider
  // call failed and we wrote a placeholder. Real-provider successes keep
  // the renderer's own note (e.g. "openai/gpt-image-2 · 1:1 · 1.2 MB")
  // untouched so the FileViewer toolbar shows the truth.
  if (intentionalStub || usedStubFallback) {
    providerNote = `[stub] ${providerNote}`;
  }

  // If the real provider returned a different extension than the
  // requested filename, swap it. Saves the agent from having to guess
  // (.png vs .jpg vs .webp) before it knows what the model emits.
  let finalOut = safeOut;
  if (suggestedExt) {
    const dot = safeOut.lastIndexOf('.');
    const stem = dot > 0 ? safeOut.slice(0, dot) : safeOut;
    finalOut = `${stem}${suggestedExt}`;
  }
  const finalTarget = path.join(dir, finalOut);
  await writeFile(finalTarget, bytes);
  const st = await stat(finalTarget);
  if (args.onBytesWritten) {
    try {
      await args.onBytesWritten({
        bytes,
        name: finalOut,
        mime: mimeFor(finalOut),
        kind: kindFor(finalOut),
        mtime: st.mtimeMs,
      });
    } catch (err) {
      // A snapshot is evidence, not a precondition. Losing it degrades one
      // chat card; failing the generation here would lose the file itself.
      console.warn('[media] onBytesWritten hook failed', err);
    }
  }
  return {
    name: finalOut,
    size: st.size,
    mtime: st.mtimeMs,
    kind: kindFor(finalOut),
    mime: mimeFor(finalOut),
    model,
    surface,
    providerNote,
    providerId,
    providerError,
    usedStubFallback,
    intentionalStub,
    warnings,
  };
}

/**
 * 自动命名生成的产出文件。
 *
 * 之所以导出:路由层的多图批次在调用方没给 output 时,必须从同一个基准名派生
 * 出 N 个不同文件名——两次并行调用各自自动命名会盖到同一个名字上。
 */
export function autoOutputName(surface: MediaSurface, model: string): string {
  const base = DEFAULT_OUTPUT_BY_SURFACE[surface] || 'artifact.bin';
  const stamp = Date.now().toString(36);
  // Slug the model id so the filename stays short and shell-safe.
  const slug = String(model).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  return `${stem}-${slug}-${stamp}${ext}`;
}

function defaultAspectFor(surface: MediaSurface): string | undefined {
  if (surface === 'image') return '1:1';
  if (surface === 'video') return '16:9';
  return undefined;
}

// ---------------------------------------------------------------------------
// Provider: OpenAI Images API (gpt-image-2, gpt-image-1.5, dall-e-3 …)
//
// We support both the canonical OpenAI endpoint AND Azure-hosted
// OpenAI deployments behind the same provider slot — Azure is detected
// from the base URL (`*.azure.com` host or a `/deployments/<name>`
// segment in the path). For Azure we additionally:
//   * append `?api-version=…` (default 2024-02-01, unless the user has
//     already encoded one into the base URL),
//   * send the api-key header in addition to Authorization (Azure
//     accepts either; some setups only honor api-key),
//   * drop the `model` field from the body since the deployment in the
//     path already names the model.
// ---------------------------------------------------------------------------

const AZURE_DEFAULT_API_VERSION = '2024-02-01';
const OPENAI_IMAGE_HEADERS_TIMEOUT_MS = 10 * 60 * 1000;
const OPENAI_IMAGE_BODY_TIMEOUT_MS = 10 * 60 * 1000;
const openAIImageDispatcher = new UndiciAgent({
  headersTimeout: OPENAI_IMAGE_HEADERS_TIMEOUT_MS,
  bodyTimeout: OPENAI_IMAGE_BODY_TIMEOUT_MS,
});

function withMediaRequestInit(
  ctx: Pick<MediaContext, 'requestInit'>,
  init: RequestInit = {},
): RequestInit {
  return {
    ...ctx.requestInit,
    ...init,
  };
}

const OPENAI_IMAGE_NO_CREDENTIAL_MESSAGE =
  `no OpenAI credential — configure an API key in ${SETTINGS_MEDIA_PROVIDERS_PATH} or set OPENAI_API_KEY.`;

/**
 * openai / grok 生图的 wire 模型名（条件翻译，2026-10-13）：
 *  * 请求级 `modelOverride` 最优先（工作台源切换 / 显式 wire 名）；
 *  * 请求的目录 id 是该 provider 的**目录默认模型**（`modelDef.default`，openai
 *    = `gpt-image-2`、grok = `grok-imagine-image`）且 Settings → Media 里配了
 *    默认模型 → **配置的模型名**作 wire 名——自建网关/中转常常只服务用户配置的
 *    那一个模型名，而工作台源切换与外部代理只会传目录 id，不翻译就等于每次都用
 *    网关不认识的 id 去打上游；
 *  * 显式选到的**非**默认目录模型（dall-e-3 等）是明确选择，原样发送——id 与
 *    端点真实模型不符时由上游回 422，`mediaFailureNextStep` 归为 `switch-model`
 *    让代理换模型自愈，而不是让宿主静默改道；
 *  * provider 配置模型位次高于别名（`wireModel`），与 renderNanoBananaImage 的
 *    链一致（那里目录只有一张图，所以是无条件链 + 内置默认）。
 */
function effectiveImageWireModel(ctx: MediaContext, credentials: ProviderConfig): string {
  return ctx.modelOverride
    || (ctx.modelDef.default === true && credentials.model ? credentials.model : ctx.wireModel);
}

/**
 * OpenAI Images（gpt-image 族与 dall-e 族）渲染器。
 *
 * 两条分支在这里收口：
 *  * 有参考图 → `/images/edits`（body.images 是 image_url 条目）；否则
 *    `/images/generations`。gpt-image 族在 edits 上不接受 `response_format`
 *    （上游回 HTTP 400 Unknown parameter），dall-e 族照旧要 `b64_json`。
 *  * 能力分支看**目录 id**（用户把 `dall-e-3` 别名到自家代理部署、或在工作台
 *    里覆盖成别的 wire 名时，该拿到的仍是 dall-e 那套模板 —— PR #1309 的约定），
 *    而真正发出去的模型名是 modelOverride > （目录默认模型时的 provider 配置模型）>
 *    别名 > 目录 id，见下面 {@link renderOpenAIImage} 里的条件翻译。
 *
 * 不变量：调用方传的档位决定请求体里的 size / quality / moderation /
 * background。缺席就是缺席 —— 档位差价由用户承担，宿主替他选档等于替他做计费
 * 决定，所以新路径上没有任何"兜底默认值"。唯一的例外是**没有档位概念的旧路径**
 * （`ctx.resolution === undefined`），它按改动前的行为补齐 size 与 quality，见
 * {@link buildOpenAIImageBody}。
 */
async function renderOpenAIImage(ctx: MediaContext, credentials: ProviderConfig): Promise<RenderResult> {
  if (!credentials.apiKey) {
    throw new Error(OPENAI_IMAGE_NO_CREDENTIAL_MESSAGE);
  }
  const rawBase = credentials.baseUrl || 'https://api.openai.com/v1';
  const azure = detectAzureEndpoint(rawBase);
  const effectiveModel = effectiveImageWireModel(ctx, credentials);
  const body = buildOpenAIImageBody(ctx, effectiveModel, azure);
  const url = ctx.imageRefs.length > 0
    ? buildOpenAIImageEditUrl(rawBase, azure)
    : buildOpenAIImageUrl(rawBase, azure);

  const headers: Record<string, string> = {
    'authorization': `Bearer ${credentials.apiKey}`,
    'content-type': 'application/json',
  };
  if (azure) {
    // Azure's canonical auth header. Some deployments accept Bearer
    // (the curl example we tested against does) but api-key is what
    // their docs document, so send both. OpenAI ignores unknown
    // headers, so this is harmless on the standard endpoint too.
    headers['api-key'] = credentials.apiKey;
  }

  const tag = azure ? 'azure-openai' : 'openai';
  const resp = await fetch(url, withMediaRequestInit(ctx, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    dispatcher: ctx.requestInit.dispatcher
      ?? openAIImageDispatcher as unknown as NonNullable<RequestInit['dispatcher']>,
    signal: AbortSignal.timeout(Math.max(OPENAI_IMAGE_HEADERS_TIMEOUT_MS, OPENAI_IMAGE_BODY_TIMEOUT_MS)),
  }));
  const data = await parseOpenAICompatibleJson(resp, tag);
  const bytes = await bytesFromOpenAICompatibleData(data, tag, ctx.requestInit);

  return {
    bytes,
    providerNote: openAIImageProviderNote(tag, effectiveModel, ctx.aspect, body, bytes.length),
    suggestedExt: sniffImageExt(bytes),
  };
}

/**
 * 组装发往 Images API 的请求体。
 *
 * 两个调用方的 `resolution` 语义不同，这里必须分开对待：
 *
 *  * `ctx.resolution === undefined` —— **旧路径**：调用方根本没有「档位」这个概念
 *    （agent 的 `/api/media/generate`、`od media generate`、`od media playground
 *    generate` 不带 `--resolution`）。行为逐字节保持改动前的样子：gpt-image 族用
 *    {@link openaiSizeFor} 算出具体尺寸，质量缺省 `high`。
 *  * `ctx.resolution === 'auto'` —— **工作台新 UI**：用户显式选了「自动档」，要的是
 *    「让模型自己决定输出尺寸」。`size` 字段根本不出现，`quality` 也不替他补默认档
 *    （档位差价由用户承担，宿主替他选档等于替他做计费决定）。具体档位（1K/2K/4K）
 *    同样只在 aspect 也具体时才通过 `gptImageSizeFor` 算出 size。
 *
 * dall-e 族两条路都一样：它们的尺寸枚举只有三档、且都不接受 `'auto'`，所以永远给
 * 具体值，与 resolution 无关。
 */
function buildOpenAIImageBody(
  ctx: MediaContext,
  effectiveModel: string,
  azure: boolean,
): Record<string, unknown> {
  const gptImage = isGptImageModel(ctx.model);
  /** 调用方没提供档位概念（旧路径）——见上面的两个调用方说明。 */
  const legacySizing = ctx.resolution === undefined;
  const body: Record<string, unknown> = {
    prompt: ctx.prompt || 'A high-quality reference image.',
    n: 1,
  };
  // For non-Azure calls, include `model` in the body. Azure infers it
  // from the deployment in the path so omitting it keeps payloads
  // compatible across both flavors. The wire-name (post-alias, post-
  // override) goes on the body so the user's alias from issue #1277
  // reaches the API.
  if (!azure) body.model = effectiveModel;
  const size = gptImage && !legacySizing
    ? gptImageSizeFor(effectiveModel, ctx.aspect, ctx.resolution)
    : openaiSizeFor(ctx.model, ctx.aspect);
  if (size) body.size = size;

  if (ctx.model.startsWith('dall-e-')) {
    // dall-e 的尺寸/质量是另一套词汇：三档尺寸 + hd/standard,且它们不支持
    // `'auto'`,所以这里永远给具体值。
    body.response_format = 'b64_json';
    if (ctx.model === 'dall-e-3') {
      body.quality = ctx.quality === 'high' ? 'hd' : 'standard';
    }
  } else if (gptImage) {
    // 旧路径缺省 `high`（改动前这里恒发 `high`）；新路径缺省/`'auto'` 一律不发
    // quality：缺席表示「用模型自己的默认档」。两条路都过一遍词表收口。
    const requested = legacySizing
      ? (ctx.quality && ctx.quality !== 'auto' ? ctx.quality : 'high')
      : ctx.quality;
    const quality = gptImageQualityFor(ctx.model, requested);
    if (quality) body.quality = quality;
    if (ctx.moderation === 'low') body.moderation = 'low';
    if (ctx.transparent === true) body.background = 'transparent';
  }

  // 所有已解析的参考图都按 OpenAI 兼容的 image_url 条目发出去（工作台可带多张）；
  // 由调用方据此切到 /images/edits 端点。gpt-image 族在 edits 上不接受
  // response_format，所以上面那条 dall-e 分支之外不再补它。
  //
  // 这个请求体形态（`{ images: [{ image_url }] }` + `application/json`）**是官方
  // 支持的**，不是只在中转端点上成立的私有约定：`POST /v1/images/edits` 有两种
  // 合法请求格式 —— `multipart/form-data`（`image` 文件字段）与 `application/json`
  // （`EditImageBodyJsonParam`，用 `images` 数组引用图片，`image_url` 接受
  // 「fully qualified URL or base64-encoded data URL」，正是这里的 data URL）。
  // 依据：OpenAI 官方 OpenAPI 规格 openai/openai-openapi 的 `POST /images/edits`
  // 两种 media type，以及 developers.openai.com 的 Create image edit 参考页
  // （JSON body 参数表把 `images` 列为 `array of object {file_id, image_url}`）。
  // 所以这里不需要为了官方端点改走 multipart。
  if (ctx.imageRefs.length > 0) {
    body.images = ctx.imageRefs.map((ref) => ({ image_url: ref.dataUrl }));
  }
  return body;
}

/**
 * providerNote 里带上真正发出去的档位。
 *
 * 排查「工作台选的参数到底有没有传到上游」时，这是唯一不用抓包的证据：stub 与
 * 真实 provider 的失败都从这一行读原因。
 */
function openAIImageProviderNote(
  tag: string,
  model: string,
  aspect: string | undefined,
  body: Record<string, unknown>,
  byteLength: number,
): string {
  const parts: string[] = [
    aspect ?? 'aspect:auto',
    typeof body.size === 'string' ? body.size : 'size:auto',
  ];
  if (typeof body.quality === 'string') parts.push(`quality:${body.quality}`);
  if (body.moderation === 'low') parts.push('moderation:low');
  if (body.background === 'transparent') parts.push('background:transparent');
  return `${tag}/${model} · ${parts.join(' · ')} · ${byteLength} bytes`;
}


async function parseOpenAICompatibleJson(resp: Response, providerTag: string): Promise<any> {
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`${providerTag} ${resp.status}: ${truncate(text, 240)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${providerTag} non-JSON response: ${truncate(text, 200)}`);
  }
}

async function bytesFromOpenAICompatibleData(data: any, providerTag: string, requestInit: MediaRequestInit = {}): Promise<Buffer> {
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!entry) throw new Error(`${providerTag} response had no data[0]`);
  if (typeof entry.b64_json === 'string' && entry.b64_json) {
    const raw = entry.b64_json.includes(',')
      ? entry.b64_json.slice(entry.b64_json.indexOf(',') + 1)
      : entry.b64_json;
    return Buffer.from(raw, 'base64');
  }
  if (typeof entry.url === 'string' && entry.url) {
    const mediaResp = await fetch(entry.url, requestInit);
    if (!mediaResp.ok) {
      throw new Error(`${providerTag} media fetch ${mediaResp.status}`);
    }
    const arr = await mediaResp.arrayBuffer();
    return Buffer.from(arr);
  }
  throw new Error(`${providerTag} response had neither b64_json nor url`);
}

/**
 * Heuristic: do we think this base URL points at an Azure OpenAI
 * deployment rather than the public OpenAI API?
 *
 *   true examples
 *     https://x.cognitiveservices.azure.com/openai/deployments/gpt-image-2
 *     https://x.openai.azure.com/openai/deployments/foo
 *     /openai/deployments/foo?api-version=2024-02-01
 *   false examples
 *     https://api.openai.com/v1
 *     http://localhost:8080/v1
 */
function detectAzureEndpoint(baseUrl: string): boolean {
  if (typeof baseUrl !== 'string' || !baseUrl) return false;
  if (/\.azure\.com\b/i.test(baseUrl)) return true;
  if (/\/openai\/deployments\//i.test(baseUrl)) return true;
  return false;
}

/**
 * Build the full /images/generations URL, preserving any user-supplied
 * query string (e.g. an explicit `?api-version=2024-12-01`) and
 * appending the default api-version for Azure when the user didn't
 * specify one. Returns a string ready for `fetch`.
 */
function normalizeOpenAICompatiblePath(pathname: string, mode: 'generations' | 'edits'): string {
  const strippedPath = pathname.replace(/\/+$/, '');
  const generationsSuffix = '/images/generations';
  const editsSuffix = '/images/edits';
  if (strippedPath.endsWith(generationsSuffix)) {
    if (mode === 'generations') return strippedPath;
    return `${strippedPath.slice(0, -generationsSuffix.length)}${editsSuffix}`;
  }
  if (strippedPath.endsWith(editsSuffix)) {
    if (mode === 'edits') return strippedPath;
    return `${strippedPath.slice(0, -editsSuffix.length)}${generationsSuffix}`;
  }
  return mode === 'edits'
    ? `${strippedPath}${editsSuffix}`
    : `${strippedPath}${generationsSuffix}`;
}

function buildOpenAIImageGenerationUrl(baseUrl: string): string {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    const stripped = baseUrl.replace(/\/$/, '');
    return normalizeOpenAICompatiblePath(stripped, 'generations');
  }
  parsed.pathname = normalizeOpenAICompatiblePath(parsed.pathname, 'generations');
  return parsed.toString();
}

function buildOpenAIImageUrl(baseUrl: string, isAzure: boolean): string {
  let parsed;
  try {
    parsed = new URL(buildOpenAIImageGenerationUrl(baseUrl));
  } catch {
    // Bad URL — fall back to naive concat so the upstream error is
    // surfaced through the normal HTTP path rather than a parse crash.
    return buildOpenAIImageGenerationUrl(baseUrl);
  }
  if (isAzure && !parsed.searchParams.has('api-version')) {
    parsed.searchParams.set('api-version', AZURE_DEFAULT_API_VERSION);
  }
  return parsed.toString();
}

/**
 * 与 {@link buildOpenAIImageUrl} 同一件事，只是落在 `/images/edits` 上。
 *
 * Azure 的 edits 端点同样要求 `api-version`，所以带图的那一发必须走同一个
 * 补参逻辑：漏掉它就是一个必然 400。
 */
function buildOpenAIImageEditUrl(baseUrl: string, isAzure = false): string {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    const stripped = baseUrl.replace(/\/$/, '');
    return normalizeOpenAICompatiblePath(stripped, 'edits');
  }
  parsed.pathname = normalizeOpenAICompatiblePath(parsed.pathname, 'edits');
  if (isAzure && !parsed.searchParams.has('api-version')) {
    parsed.searchParams.set('api-version', AZURE_DEFAULT_API_VERSION);
  }
  return parsed.toString();
}

/**
 * 「没有档位概念」时的尺寸收口：dall-e 族，以及 gpt-image 族的旧路径。
 *
 * 新路径（工作台显式给了 resolution）已经改走 contracts 的 `gptImageSizeFor`
 * （比例 + 分辨率两档才能算出具体 size）；这里服务的是另外两类调用方：dall-e 的
 * 尺寸枚举只有三档、都不能让模型自己定，而旧路径（agent / CLI 不带 `--resolution`）
 * 必须逐字节保持改动前的行为。
 */
function openaiSizeFor(model: string, aspect?: string): string {
  // gpt-image-1.5 / gpt-image-2 accept arbitrary sizes up to 4096; we
  // pick concrete ones tuned to common aspects so the API never
  // negotiates them down silently.
  if (model.startsWith('gpt-image-')) {
    if (aspect === '16:9') return '1792x1024';
    if (aspect === '9:16') return '1024x1792';
    if (aspect === '4:3') return '1408x1056';
    if (aspect === '3:4') return '1056x1408';
    return '1024x1024';
  }
  if (model === 'dall-e-3') {
    if (aspect === '16:9') return '1792x1024';
    if (aspect === '9:16') return '1024x1792';
    return '1024x1024';
  }
  // dall-e-2 only supports 256/512/1024 squares.
  return '1024x1024';
}

// ---------------------------------------------------------------------------
// Provider: xAI Grok Imagine.
//
// Docs: https://docs.x.ai/developers/model-capabilities/{images,video}/generation
//   * Image: POST /v1/images/generations — synchronous, returns
//            {data:[{b64_json|url}]}; we ask for b64_json so the bytes
//            arrive in one round-trip.
//   * Video: POST /v1/videos/generations — may return the finished video
//            inline ({status:'done', video:{url}}) or an async stub
//            ({id, status:'pending'}); in the async case we poll
//            GET /v1/videos/{id} until status flips to done/failed.
//
// xAI's video model produces native audio (background music + SFX +
// ambient) synchronised with the visual; that's the headline
// differentiator vs Seedance and Sora and is why grok-imagine-video
// declares the `audio` capability.
// ---------------------------------------------------------------------------

async function renderGrokImage(ctx: MediaContext, credentials: ProviderConfig): Promise<RenderResult> {
  if (!credentials.apiKey) {
    throw new Error(
      `no xAI credentials — sign in with your SuperGrok subscription in OD, set XAI_API_KEY, or configure a key in ${SETTINGS_MEDIA_PROVIDERS_PATH}`,
    );
  }
  const baseUrl = (credentials.baseUrl || 'https://api.x.ai/v1').replace(/\/$/, '');

  const aspectRatio = grokAspectFor(ctx.aspect);
  const effectiveModel = effectiveImageWireModel(ctx, credentials);
  const body = {
    // Caller-supplied override (Playground source switch) wins over both the
    // provider config's model and the alias-resolved wire name; capability
    // branches are unaffected because the grok renderer has none.
    model: effectiveModel,
    prompt: ctx.prompt || 'A high-quality reference image.',
    n: 1,
    aspect_ratio: aspectRatio,
    response_format: 'b64_json',
  };
  const resp = await fetch(`${baseUrl}/images/generations`, withMediaRequestInit(ctx, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${credentials.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }));
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`grok image ${resp.status}: ${truncate(text, 240)}`);
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`grok image non-JSON: ${truncate(text, 200)}`);
  }
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!entry) throw new Error('grok image response had no data[0]');
  let bytes;
  if (entry.b64_json) {
    bytes = Buffer.from(entry.b64_json, 'base64');
  } else if (entry.url) {
    const imgResp = await fetch(entry.url, withMediaRequestInit(ctx));
    if (!imgResp.ok) throw new Error(`grok image fetch ${imgResp.status}`);
    bytes = Buffer.from(await imgResp.arrayBuffer());
  } else {
    throw new Error('grok image response missing b64_json/url');
  }
  // xAI's Imagine returns JPEG by default (no format option in the API
  // surface), but PNG/WebP are technically possible. Sniff the magic
  // bytes so the on-disk extension matches reality — saving JPEG bytes
  // as `.png` confuses Finder previews and any downstream consumer that
  // trusts the extension.
  return {
    bytes,
    providerNote: `grok/${effectiveModel} · ${aspectRatio} · ${bytes.length} bytes`,
    suggestedExt: sniffImageExt(bytes),
  };
}

/**
 * Nano Banana (Gemini image 模型族) 的生图渲染器。
 *
 * 比例与分辨率都经 contracts 的收口函数翻成上游 wire 值，**undefined 的语义是
 * "请求体里不要出现这个字段"**，不是"用某个默认档顶上"：
 *   * `aspectRatio` 缺席 → 模型自选画幅；
 *   * `imageSize` 缺席 → 用 Google 文档写明的默认 1K。
 * 这是刻意的：档位差价由用户承担，宿主不替他挑档。旧调用方（agent / CLI 生图
 * 没有 resolution 概念，比例也只发 5 档老词表）行为不变 —— 老词表的值都在新表
 * 内，收口原样通过；缺省的比例仍旧只是"不发 aspectRatio"，而不是被改写成 1:1。
 *
 * `imageConfig` 本身也要按需组装：两个值都缺席时整个字段不发，因为不支持该配置
 * 的模型（老 gemini 族、部分自建网关）收到一个空配置对象会直接报错。
 */
async function renderNanoBananaImage(ctx: MediaContext, credentials: ProviderConfig): Promise<RenderResult> {
  const apiKey = credentials.apiKey;
  if (!apiKey) {
    throw new Error(
      `no Nano Banana API key — configure it in ${SETTINGS_MEDIA_PROVIDERS_PATH} or set OD_NANOBANANA_API_KEY`,
    );
  }

  const baseUrl = (credentials.baseUrl || NANOBANANA_DEFAULT_BASE_URL).replace(/\/$/, '');
  // Caller-supplied override (Playground source switch) wins over the provider
  // config's model and the catalog wire name; capability branches (none here)
  // still key off the catalog id.
  const wireModel = (
    ctx.modelOverride
    || credentials.model
    || ctx.wireModel
    || NANOBANANA_DEFAULT_MODEL
  ).trim();
  const aspectRatio = nanoBananaAspectRatioFor(ctx.aspect);
  const imageSize = nanoBananaImageSizeFor(ctx.resolution);
  // 只有确实要发的键才出现：`{ aspectRatio: undefined }` 会被 JSON.stringify 丢掉，
  // 但显式组装能让"空 imageConfig 不发"这条规则一眼可读，也是上游报错的那条边界。
  const imageConfig: Record<string, string> = {};
  if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
  if (imageSize) imageConfig.imageSize = imageSize;
  const body = {
    contents: [{
      parts: [{
        text: ctx.prompt || 'A high-quality reference image.',
      }],
    }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      ...(Object.keys(imageConfig).length > 0 ? { imageConfig } : {}),
    },
  };

  const resp = await fetchImageGenerationWithResponseRetry(
    () => fetch(`${baseUrl}/v1beta/models/${encodeURIComponent(wireModel)}:generateContent`, withMediaRequestInit(ctx, {
      method: 'POST',
      headers: nanoBananaHeaders(baseUrl, apiKey),
      body: JSON.stringify(body),
    })),
    (summary) => ctx.onProviderRequestSettled?.({
      providerId: 'nanobanana',
      ...summary,
    }),
  );
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`nano-banana image ${resp.status}: ${truncate(text, 240)}`);
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`nano-banana image non-JSON: ${truncate(text, 200)}`);
  }
  const bytes = inlineImageBytesFromGenerateContent(data);
  return {
    bytes,
    providerNote: `nano-banana/${wireModel} · ${aspectRatio ?? 'aspect:auto'} · ${imageSize ?? 'size:auto'} · ${bytes.length} bytes`,
    suggestedExt: sniffImageExt(bytes),
  };
}

function nanoBananaHeaders(baseUrl: string, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (usesOfficialGoogleApiKeyHeader(baseUrl)) {
    headers['x-goog-api-key'] = apiKey;
    return headers;
  }
  headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function usesOfficialGoogleApiKeyHeader(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname === 'generativelanguage.googleapis.com';
  } catch {
    return false;
  }
}

function inlineImageBytesFromGenerateContent(data: any): Buffer {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      const inline = part?.inlineData;
      if (typeof inline?.data === 'string' && inline.data) {
        return Buffer.from(inline.data, 'base64');
      }
    }
  }
  throw new Error('nano-banana image response missing candidates[].content.parts[].inlineData.data');
}

function sniffImageExt(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return '.jpg';
  }
  if (
    bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return '.png';
  }
  if (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return '.webp';
  }
  return '.png';
}

async function renderGrokVideo(ctx: MediaContext, credentials: ProviderConfig, onProgress?: ProgressFn): Promise<RenderResult> {
  if (!credentials.apiKey) {
    throw new Error(
      `no xAI credentials — sign in with your SuperGrok subscription in OD, set XAI_API_KEY, or configure a key in ${SETTINGS_MEDIA_PROVIDERS_PATH}`,
    );
  }
  const baseUrl = (credentials.baseUrl || 'https://api.x.ai/v1').replace(/\/$/, '');

  // Grok caps duration at 15s. The dispatcher already clamps to
  // VIDEO_LENGTHS_SEC (which goes up to 30) — re-clamp here so a user
  // who picked 30 doesn't bounce off the upstream API with a 4xx.
  const requested = ctx.length || 5;
  const durationSec = Math.min(Math.max(requested, 1), 15);
  const aspectRatio = grokAspectFor(ctx.aspect);

  const body: Record<string, unknown> = {
    model: ctx.wireModel,
    prompt: ctx.prompt || 'A short cinematic clip.',
    duration: durationSec,
    aspect_ratio: aspectRatio,
    resolution: '720p',
  };
  if (ctx.imageRef && ctx.imageRef.dataUrl) {
    // grok-imagine-video accepts a base64 data URI in `image` for i2v.
    // Same surface as Seedance — the dispatcher already produced the
    // data URL via resolveProjectImage, so we just hand it through.
    body.image = ctx.imageRef.dataUrl;
  }

  const submitResp = await fetch(`${baseUrl}/videos/generations`, withMediaRequestInit(ctx, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${credentials.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }));
  const submitText = await submitResp.text();
  if (!submitResp.ok) {
    throw new Error(`grok video submit ${submitResp.status}: ${truncate(submitText, 240)}`);
  }
  let submitData: any;
  try {
    submitData = JSON.parse(submitText);
  } catch {
    throw new Error(`grok video non-JSON: ${truncate(submitText, 200)}`);
  }

  // Two paths: (a) the API returned the finished video synchronously
  // (cached/short jobs), in which case we skip polling; (b) we got an
  // {id, status:'pending'} stub and need to poll GET /videos/{id}
  // until status flips to done/failed/expired.
  let videoUrl = submitData?.video?.url || null;
  let lastStatus = submitData?.status || '';
  const requestId = submitData?.id || submitData?.request_id || null;

  if (!videoUrl && requestId) {
    const startedAt = Date.now();
    const configuredMaxMs = Number(process.env.OD_GROK_VIDEO_MAX_POLL_MS);
    const maxMs =
      Number.isFinite(configuredMaxMs) && configuredMaxMs >= 60_000
        ? configuredMaxMs
        : 8 * 60 * 1000;
    if (typeof onProgress === 'function') {
      const mode = ctx.imageRef ? 'i2v' : 't2v';
      onProgress(`grok ${mode} task ${requestId} accepted; polling status…`);
    }
    while (Date.now() - startedAt < maxMs) {
      await sleep(4000);
      const pollResp = await fetch(`${baseUrl}/videos/${encodeURIComponent(requestId)}`, withMediaRequestInit(ctx, {
        headers: { 'authorization': `Bearer ${credentials.apiKey}` },
      }));
      const pollText = await pollResp.text();
      if (!pollResp.ok) {
        throw new Error(`grok poll ${pollResp.status}: ${truncate(pollText, 240)}`);
      }
      let pollData: any;
      try {
        pollData = JSON.parse(pollText);
      } catch {
        throw new Error(`grok poll non-JSON: ${truncate(pollText, 200)}`);
      }
      lastStatus = pollData.status || '';
      if (typeof onProgress === 'function') {
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        onProgress(`grok task ${requestId} status=${lastStatus || 'pending'} (elapsed ${elapsedSec}s)`);
      }
      if (lastStatus === 'done' || lastStatus === 'succeeded') {
        videoUrl = pollData?.video?.url || null;
        break;
      }
      if (lastStatus === 'failed' || lastStatus === 'expired') {
        const reasonRaw = pollData?.error?.message || pollData?.error || lastStatus;
        const reason = typeof reasonRaw === 'string' ? reasonRaw : JSON.stringify(reasonRaw);
        throw new Error(`grok task ${lastStatus}: ${reason}`);
      }
    }
    // Loop exited without a videoUrl. Distinguish the two reachable
    // cases so operators know which lever to pull: bumping the poll
    // ceiling (timeout) vs filing a bug against the upstream contract
    // (status=done but no video.url).
    if (!videoUrl) {
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      const ceilingSec = Math.round(maxMs / 1000);
      throw new Error(
        `grok video timed out after ${elapsedSec}s waiting for status=done `
        + `(last status: ${lastStatus || 'pending'}, ceiling ${ceilingSec}s). `
        + `If your jobs legitimately need longer, raise OD_GROK_VIDEO_MAX_POLL_MS.`,
      );
    }
  }

  if (!videoUrl) {
    // Submit returned neither an inline video.url nor a request_id —
    // upstream broke its own contract. Surfacing the last status helps
    // pinpoint whether it was a transient API blip or a malformed
    // response we should add a parser branch for.
    throw new Error(
      `grok video submit returned no inline video and no request_id to poll `
      + `(status=${lastStatus || 'unknown'})`,
    );
  }

  const dlResp = await fetch(videoUrl, withMediaRequestInit(ctx));
  if (!dlResp.ok) throw new Error(`grok video fetch ${dlResp.status}`);
  const arr = await dlResp.arrayBuffer();
  const bytes = Buffer.from(arr);

  return {
    bytes,
    providerNote: `grok/${ctx.wireModel} · ${aspectRatio} · ${durationSec}s · ${bytes.length} bytes`,
    suggestedExt: '.mp4',
  };
}

function grokAspectFor(aspect?: string): string {
  // xAI accepts a wide list (1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1,
  // 1:2, 19.5:9, 9:19.5, 20:9, 9:20, auto). Our MEDIA_ASPECTS subset
  // is a strict subset — pass through known values, otherwise 16:9.
  if (
    aspect === '1:1'
    || aspect === '16:9'
    || aspect === '9:16'
    || aspect === '4:3'
    || aspect === '3:4'
  ) {
    return aspect;
  }
  return '16:9';
}

// ---------------------------------------------------------------------------
// Provider: HyperFrames — local HTML→MP4 renderer (heygen-com/hyperframes).
//
// The agent does the creative work: it reads skills/hyperframes/SKILL.md,
// writes a composition (`hyperframes.json` + `meta.json` + `index.html`,
// with a GSAP timeline) into a hidden cache dir under the project, then
// dispatches here with `--composition-dir <relative-path>`.
//
// Packaged rendering uses the Electron Chromium already shipped with Open
// Design. Desktop captures deterministic PNG frames through its hidden render
// window/CDP path; daemon encodes them to MP4 with the bundled FFmpeg binary.
// An explicitly configured HYPERFRAMES_BROWSER_PATH retains a headless escape
// hatch for daemon-only development, but packaged clients never download or
// require a second Chrome installation.
// ---------------------------------------------------------------------------

const HYPERFRAMES_RENDER_TIMEOUT_MS = 5 * 60 * 1000;

async function renderHyperFrames(
  ctx: MediaContext,
  projectDir: string,
  desktopFrameRenderer: DesktopFrameRenderer | null,
  onProgress?: ProgressFn,
): Promise<RenderResult> {
  const compRel = ctx.compositionDir;
  if (typeof compRel !== 'string' || !compRel.trim()) {
    throw new Error(
      'hyperframes-html requires --composition-dir <project-relative-path> ' +
        'pointing at the directory the agent scaffolded with hyperframes.json / ' +
        'meta.json / index.html. The agent should write the composition into ' +
        '$OD_PROJECT_DIR/.hyperframes-cache/<id>/ and pass that path here.',
    );
  }
  // Resolve compositionDir against projectDir and refuse anything that
  // escapes — the agent has free file access to the project but the
  // dispatcher must not let a bad relative path render an arbitrary
  // directory on the host.
  const projectRootResolved = path.resolve(projectDir);
  const compAbs = path.resolve(projectRootResolved, compRel);
  if (
    compAbs !== projectRootResolved &&
    !compAbs.startsWith(projectRootResolved + path.sep)
  ) {
    throw new Error(
      `compositionDir "${compRel}" resolves outside the project directory. ` +
        'Pass a path relative to the project (e.g. ".hyperframes-cache/abc").',
    );
  }
  // Existence check — render against a missing directory hangs HF for
  // a while before failing, so short-circuit with a clear error.
  let compStat;
  try {
    compStat = await stat(compAbs);
  } catch {
    throw new Error(
      `compositionDir not found: ${compRel} (resolved to ${compAbs})`,
    );
  }
  if (!compStat.isDirectory()) {
    throw new Error(`compositionDir is not a directory: ${compRel}`);
  }
  await assertHyperFramesCompositionFile(
    compAbs,
    compRel,
    'hyperframes.json',
    'Run `"$OD_NODE_BIN" "$OD_BIN" media scaffold --project "$OD_PROJECT_ID" --composition-dir "$COMP_REL"` before editing the composition.',
  );
  await assertHyperFramesCompositionFile(
    compAbs,
    compRel,
    'meta.json',
    'Run `"$OD_NODE_BIN" "$OD_BIN" media scaffold --composition-dir "$COMP_REL"` so the renderer has duration/scene metadata before dispatch.',
  );
  await assertHyperFramesCompositionFile(
    compAbs,
    compRel,
    'index.html',
    'The agent must write index.html (with window.__timelines registration) before dispatch.',
  );

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'open-design-hf-'));
  const tmpOutput = path.join(tmpRoot, 'render.mp4');
  const usesHeadlessOverride = Boolean(process.env.HYPERFRAMES_BROWSER_PATH?.trim());
  const usesDesktopRenderer = !usesHeadlessOverride && desktopFrameRenderer != null;
  try {
    if (usesHeadlessOverride) {
      // Explicit daemon-only override. Never auto-discover or auto-download a
      // browser here: the packaged product path is the bundled Electron engine.
      await runHyperFramesRender(compAbs, tmpOutput, onProgress);
    } else if (desktopFrameRenderer) {
      await renderHyperFramesWithDesktop(
        compAbs,
        tmpRoot,
        tmpOutput,
        desktopFrameRenderer,
        onProgress,
      );
    } else {
      throw new Error(
        'Open Design desktop frame renderer is unavailable. Open or upgrade the desktop client and try again.',
      );
    }
    const bytes = await readFile(tmpOutput);
    return {
      bytes,
      providerNote: `hyperframes/${usesDesktopRenderer ? 'electron-html' : 'local-html'} · ${ctx.aspect} · ${bytes.length} bytes`,
      suggestedExt: '.mp4',
    };
  } catch (err) {
    const stderr =
      errorStringProp(err, 'stderr').trim();
    const message = stderr || errorMessage(err);
    throw new Error(`hyperframes render failed: ${truncate(message, 480)}`);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

async function renderHyperFramesWithDesktop(
  compAbs: string,
  tmpRoot: string,
  tmpOutput: string,
  desktopFrameRenderer: DesktopFrameRenderer,
  onProgress?: ProgressFn,
): Promise<void> {
  const sourceHtml = await readFile(path.join(compAbs, 'index.html'), 'utf8');
  const { fps, height, width } = hyperFramesCompositionMetrics(sourceHtml);
  const browserRuntime = await readFile(resolveHyperFramesBrowserRuntimePath(), 'utf8');
  const html = injectHyperFramesFrameBridge(sourceHtml, browserRuntime);
  const framesDir = path.join(tmpRoot, 'frames');

  onProgress?.('Rendering HyperFrames with the bundled Electron Chromium…');
  const rendered = await desktopFrameRenderer({
    baseHref: pathToFileURL(`${compAbs}${path.sep}`).href,
    fps,
    height,
    html,
    outputDir: framesDir,
    width,
  });
  if (!rendered.ok || !rendered.framePattern || !rendered.frameCount || !rendered.fps) {
    throw new Error(rendered.error || 'desktop frame renderer returned no frames');
  }

  onProgress?.(`Encoding ${rendered.frameCount} frame(s) at ${rendered.fps} fps…`);
  await encodeHyperFramesMp4(rendered.framePattern, rendered.fps, tmpOutput);
}

export function hyperFramesCompositionMetrics(html: string): {
  fps: number;
  height: number;
  width: number;
} {
  const $ = loadHtml(html);
  const root = $('[data-composition-id]').first();
  if (root.length === 0) {
    throw new Error('HyperFrames index.html has no [data-composition-id] root');
  }
  const width = Number(root.attr('data-width'));
  const height = Number(root.attr('data-height'));
  const declaredFps = Number(root.attr('data-fps'));
  const fps = Number.isFinite(declaredFps) && declaredFps > 0 ? declaredFps : 30;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error(
      `HyperFrames composition has invalid dimensions: width=${String(root.attr('data-width'))}, height=${String(root.attr('data-height'))}`,
    );
  }
  if (width > 8192 || height > 8192 || fps > 240) {
    throw new Error(`HyperFrames composition exceeds renderer limits: ${width}x${height} at ${fps} fps`);
  }
  return { fps, height, width };
}

export function injectHyperFramesFrameBridge(sourceHtml: string, runtimeScript: string): string {
  const safeRuntime = runtimeScript.replace(/<\/script/gi, '<\\/script');
  const bridge = `<script>${safeRuntime}</script><script>
(() => {
  const nextPaint = () => new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    setTimeout(finish, 100);
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
  const waitForRuntime = async () => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const player = window.__player;
      const duration = Number(player && typeof player.getDuration === 'function' && player.getDuration());
      if (window.__renderReady === true && player && typeof player.renderSeek === 'function' && duration > 0) {
        return { duration, seek: (timeSeconds) => player.renderSeek(timeSeconds, { suppressEvents: true }) };
      }
      const legacy = window.__hf;
      if (legacy && typeof legacy.seek === 'function' && Number(legacy.duration) > 0) {
        return { duration: Number(legacy.duration), seek: (timeSeconds) => legacy.seek(timeSeconds) };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const player = window.__player;
    const duration = Number(player && typeof player.getDuration === 'function' && player.getDuration());
    throw new Error(
      'HyperFrames runtime was not ready after 45 seconds' +
      ' (bootstrapped=' + String(window.__hyperframeRuntimeBootstrapped === true) +
      ', playerReady=' + String(window.__playerReady === true) +
      ', renderReady=' + String(window.__renderReady === true) +
      ', duration=' + String(duration) + ')'
    );
  };
  window.__odFrameRenderer = {
    async ready() {
      const runtime = await waitForRuntime();
      const root = document.querySelector('[data-composition-id]');
      const declaredDuration = Number(root && root.getAttribute('data-duration'));
      const declaredFps = Number(root && root.getAttribute('data-fps'));
      return {
        duration: Number.isFinite(declaredDuration) && declaredDuration > 0
          ? declaredDuration
          : Number(runtime.duration),
        fps: declaredFps > 0 ? declaredFps : 30
      };
    },
    async seek(timeSeconds) {
      const runtime = await waitForRuntime();
      runtime.seek(timeSeconds);
      if (typeof window.__hfWaitForSeekCompletion === 'function') {
        await window.__hfWaitForSeekCompletion();
      }
      const colorGrading = window.__hf && window.__hf.colorGrading;
      if (colorGrading && typeof colorGrading.waitForActiveLuts === 'function') {
        await colorGrading.waitForActiveLuts();
      }
      if (window.__hf_page_composite_pending && typeof window.__hf_page_composite_prepare === 'function') {
        await window.__hf_page_composite_prepare();
        await nextPaint();
        if (typeof window.__hf_page_composite_resolve === 'function') {
          window.__hf_page_composite_resolve();
        }
      }
      await nextPaint();
    }
  };
})();
</script>`;
  const bodyClose = findRealTagOffset(sourceHtml, HTML_TAG_PATTERNS.bodyClose);
  if (bodyClose >= 0) {
    return sourceHtml.slice(0, bodyClose) + bridge + sourceHtml.slice(bodyClose);
  }
  return `${sourceHtml}${bridge}`;
}

function encodeHyperFramesMp4(
  framePattern: string,
  fps: number,
  outputPath: string,
): Promise<void> {
  const ffmpegPath = process.env.HYPERFRAMES_FFMPEG_PATH?.trim() || ffmpegInstaller.path;
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-framerate',
        String(fps),
        '-start_number',
        '0',
        '-i',
        framePattern,
        '-vf',
        'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        outputPath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('HyperFrames FFmpeg encoding timed out after 5 minutes'));
    }, HYPERFRAMES_RENDER_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(
        `FFmpeg encoding failed (${signal ? `signal ${signal}` : `exit ${String(code)}`}): ${stderr.trim()}`,
      ));
    });
  });
}

async function assertHyperFramesCompositionFile(
  compAbs: string,
  compRel: string,
  fileName: string,
  guidance: string,
): Promise<void> {
  const fileStat = await stat(path.join(compAbs, fileName)).catch(() => null);
  if (!fileStat || !fileStat.isFile()) {
    throw new Error(
      `compositionDir is missing ${fileName}: ${compRel}. ${guidance}`,
    );
  }
}

/**
 * Run the pinned HyperFrames CLI and stream every line of stdout/stderr
 * through `onProgress`. Resolves on a clean exit, rejects on non-zero
 * exit (with the stderr tail attached so the dispatcher can surface it).
 *
 * Streaming matters for UX: the render typically takes 60–120s and
 * HF prints "Capturing frame N/M" as it goes. Without piping these
 * lines back to the caller, the HTTP request looks hung and the
 * agent's chat tool shows a long quiet spinner — users can't tell
 * whether anything is happening.
 */
function runHyperFramesRender(compAbs: string, tmpOutput: string, onProgress?: ProgressFn): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const hyperFramesCli = resolveHyperFramesCliPath();
    const child = spawn(
      resolveHyperFramesNodeBin(),
      [
        hyperFramesCli,
        'render',
        compAbs,
        '--output',
        tmpOutput,
        '--workers',
        '1',
      ],
      {
        // Use the same Node-compatible runtime that owns the daemon and a
        // pinned HyperFrames CLI shipped with Open Design. Do not delegate
        // native dependency selection to a user-level npx cache.
        env: {
          ...process.env,
          OD_HYPERFRAMES_BIN: hyperFramesCli,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    // HF uses ANSI escape sequences (cursor moves, color codes, line
    // erases) for its pretty progress bar. Strip those before
    // forwarding so the agent's chat doesn't render a wall of `[2K`.
    // The regex covers CSI sequences (most of what HF emits).
    const stripAnsi = (s: string): string =>
      s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\[\?[0-9]+[hl]/g, '');

    const emit = (chunk: Buffer): void => {
      if (typeof onProgress !== 'function') return;
      const text = stripAnsi(chunk.toString('utf8'));
      // HF refreshes a single progress line many times per second; split
      // on \r and \n so each "Capturing frame X/Y" update reaches the
      // caller as its own line. Drop empty/duplicate lines so the
      // SSE stream stays compact.
      const lines = text.split(/[\r\n]+/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          onProgress(trimmed);
        } catch {
          // best-effort: never let an emitter throw kill the render
        }
      }
    };

    let stderrTail = '';
    child.stdout.on('data', emit);
    child.stderr.on('data', (chunk) => {
      stderrTail += chunk.toString('utf8');
      if (stderrTail.length > 8000) stderrTail = stderrTail.slice(-8000);
      emit(chunk);
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(
        new Error(
          `hyperframes render timed out after ${Math.round(HYPERFRAMES_RENDER_TIMEOUT_MS / 1000)}s`,
        ),
      );
    }, HYPERFRAMES_RENDER_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const reason = signal ? `signal ${signal}` : `exit ${code}`;
      const tail = stderrTail.trim().split('\n').slice(-12).join('\n');
      const err = new Error(
        `hyperframes render exited ${reason}` + (tail ? `\n${tail}` : ''),
      ) as Error & { stderr: string };
      err.stderr = tail;
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Stub renderer.
//
// Used when no real provider integration ships for (provider, surface)
// or when the real one fails. Produces small but valid bytes so the
// downstream FileViewer round-trip works while the backend matures.
// ---------------------------------------------------------------------------

async function renderStub(ctx: MediaContext, fileName: string): Promise<RenderResult> {
  const note = ctx.provider && !ctx.provider.integrated
    ? `stub-${ctx.surface} · provider '${ctx.provider.id}' integration pending`
    : `stub-${ctx.surface} · model=${ctx.model}`;
  if (ctx.surface === 'image') {
    const ext = path.extname(fileName).toLowerCase();
    if (ext === '.svg') {
      return { bytes: Buffer.from(svgPlaceholder(ctx), 'utf8'), providerNote: note };
    }
    const png = Buffer.from(
      [
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ],
    );
    return {
      bytes: png,
      providerNote: `${note} · aspect=${ctx.aspect} · prompt=${truncate(ctx.prompt, 60)}`,
    };
  }
  if (ctx.surface === 'video') {
    const ftyp = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
      0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
    ]);
    const mdat = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x6d, 0x64, 0x61, 0x74]);
    return {
      bytes: Buffer.concat([ftyp, mdat]),
      providerNote: `${note} · aspect=${ctx.aspect} · length=${ctx.length ?? '?'}s · prompt=${truncate(ctx.prompt, 60)}`,
    };
  }
  throw new Error(`stub renderer has no output for surface: ${ctx.surface}`);
}

function svgPlaceholder(ctx: MediaContext): string {
  const [w, h] = aspectToBox(ctx.aspect, 800);
  const safe = (s: unknown): string =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`,
    `<rect width="${w}" height="${h}" fill="#0f1424"/>`,
    `<text x="50%" y="50%" fill="#7da4ff" font-family="ui-sans-serif" font-size="20" text-anchor="middle">${safe(ctx.model)} — ${safe(ctx.prompt).slice(0, 60)}</text>`,
    '</svg>',
  ].join('');
}

function aspectToBox(aspect: string | undefined, base: number): [number, number] {
  const [a, b] = String(aspect || '1:1').split(':').map(Number);
  if (!a || !b) return [base, base];
  if (a >= b) return [base, Math.round((base * b) / a)];
  return [Math.round((base * a) / b), base];
}

function truncate(s: unknown, n: number): string {
  const v = String(s || '');
  if (v.length <= n) return v;
  return v.slice(0, n - 1) + '…';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
