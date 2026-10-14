import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  OPEN_DESIGN_SIDECAR_CONTRACT,
  SIDECAR_DEFAULTS,
} from "@open-design/sidecar-proto";
import { resolveNamespace } from "@open-design/sidecar";
import { releaseChannelFromVersion, releaseNamespace } from "@open-design/release";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveToolPackRoot(startDir: string): string {
  let candidate = startDir;
  while (true) {
    const packageJsonPath = join(candidate, "package.json");
    if (existsSync(packageJsonPath)) {
      const require = createRequire(packageJsonPath);
      const packageJson = require(packageJsonPath) as { name?: string };
      if (packageJson.name === "@open-design/tools-pack") return candidate;
    }

    const parent = path.dirname(candidate);
    if (parent === candidate) {
      throw new Error(`could not locate @open-design/tools-pack package from ${startDir}`);
    }
    candidate = parent;
  }
}

export const WORKSPACE_ROOT = resolve(resolveToolPackRoot(__dirname), "../..");

export type ToolPackPlatform = "mac" | "win" | "linux";
export type ToolPackBuildOutput = "all" | "app" | "appimage" | "dir" | "dmg" | "nsis" | "zip";
export type ToolPackMacCompression = "store" | "normal" | "maximum";
export type ToolPackWebOutputMode = "server" | "standalone";
export type ToolPackAmrProfile = "prod" | "test" | "feature-test" | "local";
export type ToolPackVelaWebUrls = Partial<Record<ToolPackAmrProfile, string>>;

export type ToolPackCliOptions = {
  appVersion?: string;
  cacheDir?: string;
  containerized?: boolean;
  dir?: string;
  diagnoseAttempts?: string | number;
  expectedVersion?: string;
  expr?: string;
  headless?: boolean;
  json?: boolean;
  macCompression?: string;
  notarize?: boolean;
  namespace?: string;
  path?: string;
  payloadPath?: string;
  portable?: boolean;
  removeCache?: boolean;
  removeData?: boolean;
  removeLogs?: boolean;
  removeProductUserData?: boolean;
  removeSidecars?: boolean;
  requireVelaCli?: boolean;
  signed?: boolean;
  silent?: boolean;
  statusPollCount?: string | number;
  statusPollIntervalMs?: string | number;
  to?: string;
  updateAction?: string;
};

export type ToolPackRoots = {
  output: {
    appBuilderRoot: string;
    namespaceRoot: string;
    platformRoot: string;
    root: string;
  };
  runtime: {
    namespaceBaseRoot: string;
    namespaceRoot: string;
  };
  cacheRoot: string;
  toolPackRoot: string;
};

export type ToolPackConfig = {
  appVersion?: string;
  containerized: boolean;
  electronBuilderCliPath: string;
  electronDistPath: string;
  electronVersion: string;
  macCompression: ToolPackMacCompression;
  macNotarize?: boolean;
  namespace: string;
  platform: ToolPackPlatform;
  portable: boolean;
  removeCache?: boolean;
  removeData: boolean;
  removeLogs: boolean;
  removeProductUserData: boolean;
  removeSidecars: boolean;
  requireVelaCli: boolean;
  roots: ToolPackRoots;
  silent: boolean;
  signed: boolean;
  amrProfile?: ToolPackAmrProfile;
  /**
   * Origin of the vela web console this build's AMR backend serves, sourced
   * from `OD_VELA_WEB_URL` at packaging time. Baked into
   * open-design-config.json so the packaged runtime can forward it to the
   * daemon as `OD_VELA_WEB_URL`, which is what turns the workspace-team
   * transports on and what the workspace settings / members / dashboard
   * console links are derived from.
   *
   * Deliberately injected rather than checked in: the non-prod AMR
   * environments are internal deployments, and this repository is public.
   * Official builds get it from a per-profile CI secret; fork and local builds
   * simply omit it, which leaves workspace-team dormant.
   */
  velaWebUrl?: string;
  /**
   * Optional per-profile origins used by the runtime profile switcher. Read
   * from `OD_VELA_WEB_URL_PROD`, `_TEST`, `_FEATURE_TEST`, and `_LOCAL` so an
   * official or local build can enable cross-profile links without checking
   * deployment-specific hostnames into source.
   */
  velaWebUrls?: ToolPackVelaWebUrls;
  updateMetadataUrl?: string;
  to: ToolPackBuildOutput;
  webOutputMode: ToolPackWebOutputMode;
  workspaceRoot: string;
};

function resolveToolPackBuildOutput(platform: ToolPackPlatform, value: string | undefined): ToolPackBuildOutput {
  if (value == null || value.length === 0) return platform === "win" ? "nsis" : "all";
  if (platform === "mac" && (value === "all" || value === "app" || value === "dmg" || value === "zip")) return value;
  if (platform === "win" && (value === "all" || value === "dir" || value === "nsis" || value === "zip")) return value;
  if (platform === "linux" && (value === "all" || value === "appimage" || value === "dir")) return value;
  throw new Error(`unsupported ${platform} --to target: ${value}`);
}

function resolveToolPackMacCompression(value: string | undefined): ToolPackMacCompression {
  if (value == null || value.length === 0) return "normal";
  if (value === "store" || value === "normal" || value === "maximum") return value;
  throw new Error(`unsupported mac --mac-compression value: ${value}`);
}

function resolveToolPackAppVersion(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error("--app-version must not be empty");
  if (/\s/.test(normalized)) throw new Error(`--app-version must not contain whitespace: ${value}`);
  return normalized;
}

function defaultNamespaceForAppVersion(platform: ToolPackPlatform, appVersion: string | undefined): string {
  const channel = releaseChannelFromVersion(appVersion);
  if (channel == null) return SIDECAR_DEFAULTS.namespace;

  return releaseNamespace(channel, platform);
}

function resolveToolPackWebOutputMode(platform: ToolPackPlatform, value: string | undefined): ToolPackWebOutputMode {
  // Standalone web output is wired for desktop packaged platforms; Linux stays on
  // the existing server output until its AppImage resource path is optimized.
  if (platform === "linux") return "server";
  if (value == null || value.length === 0) return "standalone";
  if (value === "server" || value === "standalone") return value;
  throw new Error(`unsupported OD_WEB_OUTPUT_MODE value: ${value}`);
}

function resolveToolPackAmrProfile(value: string | undefined): ToolPackAmrProfile | undefined {
  if (value == null) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  if (normalized === "prod" || normalized === "test" || normalized === "feature-test" || normalized === "local") {
    return normalized;
  }
  throw new Error(`OPEN_DESIGN_AMR_PROFILE must be prod, test, feature-test, or local: ${value}`);
}

/**
 * The vela web console origin to bake into the bundle, or undefined when this
 * build was given none. Rejects anything that is not an absolute http(s) URL so
 * a misconfigured CI secret fails the build instead of shipping a bundle whose
 * console links are silently broken.
 */
function resolveToolPackVelaWebUrl(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`OD_VELA_WEB_URL must be an absolute URL: ${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`OD_VELA_WEB_URL must be http(s): ${value}`);
  }
  return normalized.replace(/\/+$/, "");
}

function resolveToolPackVelaWebUrls(env: NodeJS.ProcessEnv): ToolPackVelaWebUrls | undefined {
  const candidates: ReadonlyArray<[ToolPackAmrProfile, string | undefined]> = [
    ['prod', env.OD_VELA_WEB_URL_PROD],
    ['test', env.OD_VELA_WEB_URL_TEST],
    ['feature-test', env.OD_VELA_WEB_URL_FEATURE_TEST],
    ['local', env.OD_VELA_WEB_URL_LOCAL],
  ];
  const result: ToolPackVelaWebUrls = {};
  for (const [profile, value] of candidates) {
    const origin = resolveToolPackVelaWebUrl(value);
    if (origin) result[profile] = origin;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function resolveToolPackUpdateMetadataUrl(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`OD_UPDATE_METADATA_URL must be an absolute URL: ${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`OD_UPDATE_METADATA_URL must use http(s): ${value}`);
  }
  return normalized;
}

function resolveElectronVersion(workspaceRoot: string): string {
  const require = createRequire(join(workspaceRoot, "apps/desktop/package.json"));
  const desktopPackage = require(join(workspaceRoot, "apps/desktop/package.json")) as {
    devDependencies?: Record<string, string>;
  };
  const version = desktopPackage.devDependencies?.electron;
  if (version == null || version.length === 0) {
    throw new Error("apps/desktop/package.json must declare electron");
  }
  return version;
}

function resolveElectronDistPath(workspaceRoot: string): string {
  const require = createRequire(join(workspaceRoot, "apps/desktop/package.json"));
  const electronEntry = require.resolve("electron");
  return join(path.dirname(electronEntry), "dist");
}

function resolveElectronBuilderCliPath(): string {
  const require = createRequire(import.meta.url);
  return require.resolve("electron-builder/out/cli/cli.js");
}

export function resolveToolPackConfig(
  platform: ToolPackPlatform,
  options: ToolPackCliOptions = {},
): ToolPackConfig {
  const appVersion = resolveToolPackAppVersion(options.appVersion);
  const namespace = resolveNamespace({
    contract: OPEN_DESIGN_SIDECAR_CONTRACT,
    env: process.env,
    namespace: options.namespace ?? defaultNamespaceForAppVersion(platform, appVersion),
  });
  const defaultToolPackRoot = join(WORKSPACE_ROOT, ".tmp", "tools-pack");
  const toolPackRoot = resolve(options.dir ?? defaultToolPackRoot);
  const cacheRoot = resolve(options.cacheDir ?? join(defaultToolPackRoot, "cache"));
  const outputRoot = join(toolPackRoot, "out");
  const outputPlatformRoot = join(outputRoot, platform);
  const outputNamespaceRoot = join(outputPlatformRoot, "namespaces", namespace);
  const runtimeNamespaceBaseRoot = join(toolPackRoot, "runtime", platform, "namespaces");

  return {
    appVersion,
    containerized: options.containerized === true,
    electronBuilderCliPath: resolveElectronBuilderCliPath(),
    electronDistPath: resolveElectronDistPath(WORKSPACE_ROOT),
    electronVersion: resolveElectronVersion(WORKSPACE_ROOT),
    macCompression: resolveToolPackMacCompression(options.macCompression),
    macNotarize: options.notarize === true,
    namespace,
    platform,
    portable: options.portable === true,
    roots: {
      output: {
        appBuilderRoot: join(outputNamespaceRoot, "builder"),
        namespaceRoot: outputNamespaceRoot,
        platformRoot: outputPlatformRoot,
        root: outputRoot,
      },
      runtime: {
        namespaceBaseRoot: runtimeNamespaceBaseRoot,
        namespaceRoot: join(runtimeNamespaceBaseRoot, namespace),
      },
      cacheRoot,
      toolPackRoot,
    },
    removeCache: options.removeCache === true,
    removeData: options.removeData === true,
    removeLogs: options.removeLogs === true,
    removeProductUserData: options.removeProductUserData === true,
    removeSidecars: options.removeSidecars === true,
    requireVelaCli: options.requireVelaCli === true,
    silent: options.silent !== false,
    signed: options.signed === true,
    amrProfile: resolveToolPackAmrProfile(process.env.OPEN_DESIGN_AMR_PROFILE),
    updateMetadataUrl: resolveToolPackUpdateMetadataUrl(process.env.OD_UPDATE_METADATA_URL),
    velaWebUrl: resolveToolPackVelaWebUrl(process.env.OD_VELA_WEB_URL),
    velaWebUrls: resolveToolPackVelaWebUrls(process.env),
    to: resolveToolPackBuildOutput(platform, options.to),
    webOutputMode: resolveToolPackWebOutputMode(platform, process.env.OD_WEB_OUTPUT_MODE),
    workspaceRoot: WORKSPACE_ROOT,
  };
}
