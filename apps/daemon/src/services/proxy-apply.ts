// 全局代理设置对 daemon 自身出站请求的应用。
//
// daemon 进程的出站（fetch/undici，NODE_USE_ENV_PROXY 语义）读取本进程的
// process.env。用户在设置里保存 proxyPrefs 后，PUT /api/app-config 会调用
// applyProxyPrefsToProcess 同步本进程环境；enabled=false / 整体无效则恢复到
// 启动时的快照。关闭时不能粗暴清空代理键——shell 或系统本就可能有代理，
// 所以恢复快照里原有的键与值，只删除快照里没有的键。

import type { ProxyPrefs } from '@open-design/contracts';

import { proxyEnvFromPrefs } from '../runtimes/env.js';

/** 规范代理环境变量的键（小写比较；大小写不敏感匹配）。 */
const PROXY_ENV_KEYS: readonly string[] = [
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'node_use_env_proxy',
];

/** 单个代理键的快照条目：保留原始键名（大小写）与原始值。 */
export interface ProxyEnvSnapshot {
  /** 小写规范键 → 原始键名 + 原始值。 */
  entries: Map<string, { key: string; value: string }>;
}

/** 启动时的继承代理环境快照；由 snapshotInheritedProxyEnv 填充。 */
let inheritedSnapshot: ProxyEnvSnapshot | null = null;

/**
 * 快照当前进程环境里的全部代理键（大小写不敏感），保留原始键名。
 * 应在 daemon 启动早期、任何写入前调用一次。
 */
export function snapshotInheritedProxyEnv(): ProxyEnvSnapshot {
  const entries = new Map<string, { key: string; value: string }>();
  for (const [key, value] of Object.entries(process.env)) {
    const lower = key.toLowerCase();
    if (!PROXY_ENV_KEYS.includes(lower)) continue;
    if (typeof value !== 'string') continue;
    entries.set(lower, { key, value });
  }
  inheritedSnapshot = { entries };
  return inheritedSnapshot;
}

/**
 * 按全局代理偏好写入本进程环境：enabled 时注入代理键；disabled / 无效时逐键
 * 恢复快照值（快照没有的键删除，不触碰其他环境变量）。省略 snapshot 时使用
 * 启动快照；启动快照不存在则现场补拍。
 */
export function applyProxyPrefsToProcess(prefs: ProxyPrefs | undefined): void {
  const snap = inheritedSnapshot ?? snapshotInheritedProxyEnv();
  applyProxyEnvKeys(process.env, proxyEnvFromPrefs(prefs), snap);
}

/**
 * 将期望的代理键应用到指定环境对象上。纯函数，供单测使用：
 * 每个规范键先删除所有大小写变体，再按 期望值 > 快照值 > 删除 的顺序落值。
 */
export function applyProxyEnvKeys(
  env: Record<string, string | undefined>,
  desired: Record<string, string>,
  snapshot: ProxyEnvSnapshot,
): void {
  for (const lower of PROXY_ENV_KEYS) {
    const canonical = lower.toUpperCase();
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === lower) delete env[key];
    }
    const desiredValue = desired[canonical];
    if (typeof desiredValue === 'string') {
      env[canonical] = desiredValue;
      continue;
    }
    const snapEntry = snapshot.entries.get(lower);
    if (snapEntry) env[snapEntry.key] = snapEntry.value;
  }
}
