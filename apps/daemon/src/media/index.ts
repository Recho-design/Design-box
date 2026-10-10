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
//                              deployments based on the configured base URL
//   * provider 'grok'        → xAI Imagine API: synchronous
//                              /v1/images/generations for grok-imagine-image
//                              and async /v1/videos/generations + GET poll
//                              for grok-imagine-video (t2v + i2v)
//   * provider 'nanobanana'  → Google Generative Language generateContent
//                              (Nano Banana image models)
//   * provider 'custom-image'→ user-supplied OpenAI-compatible
//                              /v1/images/generations + /v1/images/edits
//                              endpoints
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
import { SETTINGS_MEDIA_PROVIDERS_PATH } from '@open-design/contracts';
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
   * 直接生图工作台(项目面板 → `/media/generate`)复用同一个 `custom-image`
   * provider 槽位指向用户配置的任意 OpenAI 兼容端点,所以模型名不能只存在
   * provider 配置里,而是随请求进来。渲染器发 `body.model` 时它排第一。
   */
  modelOverride: string | undefined;
  modelDef: MediaModel;
  provider: MediaProvider | null;
  prompt: string;
  aspect: string | undefined;
  /**
   * Published quality tier the caller asked for, passed through verbatim and
   * left undefined when they asked for nothing. Read by the OpenAI-compatible
   * renderers; the OpenAI branch keeps deriving its own `body.quality` from
   * the model id, which is a different vocabulary ('hd' / 'standard').
   */
  quality: string | undefined;
  /** Published output resolution the caller asked for. */
  resolution: string | undefined;
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
const NANOBANANA_DEFAULT_IMAGE_SIZE = '1K';
const CUSTOM_IMAGE_MODEL_ID = 'custom-image';
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
  const customImageCredentials =
    surface === 'image' && def.provider === 'openai'
      ? await resolveProviderConfig(projectRoot, 'custom-image')
      : null;

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
  const customImageOverride = customImageOverridesOpenAIModel(
    ctx,
    customImageCredentials,
  );
  try {
    if (
      def.provider === 'openai'
      && surface === 'image'
      && customImageOverride
    ) {
      providerId = 'custom-image';
      const result = await renderCustomOpenAIImage(ctx, customImageCredentials!);
      bytes = result.bytes;
      providerNote = result.providerNote;
      suggestedExt = result.suggestedExt;
    
    } else if (def.provider === 'openai' && surface === 'image') {
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
    } else if (def.provider === 'custom-image' && surface === 'image') {
      const result = await renderCustomOpenAIImage(ctx, credentials);
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

async function renderOpenAIImage(ctx: MediaContext, credentials: ProviderConfig): Promise<RenderResult> {
  if (!credentials.apiKey) {
    throw new Error(OPENAI_IMAGE_NO_CREDENTIAL_MESSAGE);
  }
  const rawBase = credentials.baseUrl || 'https://api.openai.com/v1';
  const azure = detectAzureEndpoint(rawBase);
  const url = buildOpenAIImageUrl(rawBase, azure);

  const body: Record<string, unknown> = {
    prompt: ctx.prompt || 'A high-quality reference image.',
    n: 1,
    size: openaiSizeFor(ctx.model, ctx.aspect),
  };
  // For non-Azure calls, include `model` in the body. Azure infers it
  // from the deployment in the path so omitting it keeps payloads
  // compatible across both flavors. The wire-name (post-alias) goes
  // on the body so the user's alias from issue #1277 reaches the API.
  if (!azure) {
    body.model = ctx.wireModel;
  }
  // Capability branches key off the CATALOG id (not the alias) so a
  // user who aliased `dall-e-3` to a custom Azure / proxy deployment
  // still gets the DALL-E-specific quality + response_format flags
  // (lefarcen + codex P2 on PR #1309).
  if (ctx.model.startsWith('dall-e-')) {
    body.response_format = 'b64_json';
    body.quality = ctx.model === 'dall-e-3' ? 'hd' : 'standard';
  } else {
    // gpt-image-* accepts quality 'high' | 'medium' | 'low'.
    body.quality = 'high';
  }

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

  const resp = await fetch(url, withMediaRequestInit(ctx, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    dispatcher: ctx.requestInit.dispatcher
      ?? openAIImageDispatcher as unknown as NonNullable<RequestInit['dispatcher']>,
    signal: AbortSignal.timeout(Math.max(OPENAI_IMAGE_HEADERS_TIMEOUT_MS, OPENAI_IMAGE_BODY_TIMEOUT_MS)),
  }));
  const text = await resp.text();
  if (!resp.ok) {
    const tag = azure ? 'azure-openai' : 'openai';
    throw new Error(`${tag} ${resp.status}: ${truncate(text, 240)}`);
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`openai non-JSON response: ${truncate(text, 200)}`);
  }
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!entry) throw new Error('openai response had no data[0]');
  let bytes;
  if (entry.b64_json) {
    bytes = Buffer.from(entry.b64_json, 'base64');
  } else if (entry.url) {
    const imgResp = await fetch(entry.url, withMediaRequestInit(ctx));
    if (!imgResp.ok) throw new Error(`openai image fetch ${imgResp.status}`);
    const arr = await imgResp.arrayBuffer();
    bytes = Buffer.from(arr);
  } else {
    throw new Error('openai response had neither b64_json nor url');
  }

  const tag = azure ? 'azure-openai' : 'openai';
  return {
    bytes,
    providerNote: `${tag}/${ctx.wireModel} · ${ctx.aspect} · ${bytes.length} bytes`,
    suggestedExt: '.png',
  };
}

async function renderCustomOpenAIImage(ctx: MediaContext, credentials: ProviderConfig): Promise<RenderResult> {
  const baseUrl = (credentials.baseUrl || '').trim();
  if (!baseUrl) {
    throw new Error(
      `Custom Image API base URL required — configure an OpenAI-compatible /v1/images/generations or /v1/images/edits endpoint in ${SETTINGS_MEDIA_PROVIDERS_PATH}`,
    );
  }
  // 模型取值优先级:请求里的 override(直接生图工作台用端点自己的模型名)>
  // provider 配置 > 目录别名。`custom-image` 只是目录占位 id,不是 wire 名,
  // 绝不能发给上游。
  const wireModel = (
    ctx.modelOverride
    || credentials.model
    || (ctx.wireModel !== CUSTOM_IMAGE_MODEL_ID ? ctx.wireModel : '')
  ).trim();
  if (!wireModel) {
    throw new Error(
      `Custom Image API model required — configure the provider model in ${SETTINGS_MEDIA_PROVIDERS_PATH}`,
    );
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (credentials.apiKey) {
    headers.authorization = `Bearer ${credentials.apiKey}`;
  }
  const body: Record<string, unknown> = {
    prompt: ctx.prompt || 'A high-quality reference image.',
    model: wireModel,
    n: 1,
    size: openaiSizeFor('gpt-image-1', ctx.aspect),
  };
  // 质量档位原样透传;调用方没要求就不发——档位价差由用户承担,默认档交给
  // provider 自己决定。
  if (ctx.quality) {
    body.quality = ctx.quality;
  }
  // 所有已解析的参考图都按 OpenAI 兼容的 image_url 条目发出去(工作台会带多张),
  // 同时决定走 /edits 端点。
  const referenceImages = ctx.imageRefs.map((ref) => ({ image_url: ref.dataUrl }));
  let url = buildOpenAIImageUrl(baseUrl, false);
  if (referenceImages.length > 0) {
    // gpt-image-* does NOT accept response_format on /v1/images/edits
    // (HTTP 400 "Unknown parameter: 'response_format'"). dall-e-2
    // accepts it; the base b64 path is what callers expect either way,
    // so we only set response_format for non-gpt-image models.
    if (!wireModel.startsWith('gpt-image-')) {
      body.response_format = 'b64_json';
    }
    body.images = referenceImages;
    url = buildOpenAIImageEditUrl(baseUrl);
  }

  const resp = await fetchImageGenerationWithResponseRetry(
    () => fetch(url, withMediaRequestInit(ctx, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })),
    (summary) => ctx.onProviderRequestSettled?.({
      providerId: 'custom-image',
      ...summary,
    }),
  );
  const data = await parseOpenAICompatibleJson(resp, 'custom image');
  const bytes = await bytesFromOpenAICompatibleData(data, 'custom image', ctx.requestInit);
  return {
    bytes,
    providerNote: `custom-image/${wireModel} · ${body.size} · ${bytes.length} bytes`,
    suggestedExt: sniffImageExt(bytes),
  };
}

function customImageOverridesOpenAIModel(
  ctx: MediaContext,
  credentials: ProviderConfig | null,
): credentials is ProviderConfig {
  const baseUrl = credentials?.baseUrl?.trim();
  const model = credentials?.model?.trim();
  if (!baseUrl || !model) return false;
  return model === ctx.model || model === ctx.wireModel;
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

function buildOpenAIImageEditUrl(baseUrl: string): string {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    const stripped = baseUrl.replace(/\/$/, '');
    return normalizeOpenAICompatiblePath(stripped, 'edits');
  }
  parsed.pathname = normalizeOpenAICompatiblePath(parsed.pathname, 'edits');
  return parsed.toString();
}

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
  const body = {
    model: ctx.wireModel,
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
    providerNote: `grok/${ctx.wireModel} · ${aspectRatio} · ${bytes.length} bytes`,
    suggestedExt: sniffImageExt(bytes),
  };
}

async function renderNanoBananaImage(ctx: MediaContext, credentials: ProviderConfig): Promise<RenderResult> {
  const apiKey = credentials.apiKey;
  if (!apiKey) {
    throw new Error(
      `no Nano Banana API key — configure it in ${SETTINGS_MEDIA_PROVIDERS_PATH} or set OD_NANOBANANA_API_KEY`,
    );
  }

  const baseUrl = (credentials.baseUrl || NANOBANANA_DEFAULT_BASE_URL).replace(/\/$/, '');
  const wireModel = (credentials.model || ctx.wireModel || NANOBANANA_DEFAULT_MODEL).trim();
  const body = {
    contents: [{
      parts: [{
        text: ctx.prompt || 'A high-quality reference image.',
      }],
    }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: {
        aspectRatio: nanoBananaAspectFor(ctx.aspect),
        imageSize: NANOBANANA_DEFAULT_IMAGE_SIZE,
      },
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
    providerNote: `nano-banana/${wireModel} · ${nanoBananaAspectFor(ctx.aspect)} · ${NANOBANANA_DEFAULT_IMAGE_SIZE} · ${bytes.length} bytes`,
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

function nanoBananaAspectFor(aspect?: string): string {
  if (
    aspect === '1:1'
    || aspect === '16:9'
    || aspect === '9:16'
    || aspect === '4:3'
    || aspect === '3:4'
  ) {
    return aspect;
  }
  return '1:1';
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
