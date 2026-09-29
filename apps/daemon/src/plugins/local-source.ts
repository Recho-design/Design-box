import type Database from 'better-sqlite3';
import type { InstalledPluginRecord } from '@open-design/contracts';
// [COLLEB REMOVED] team-resource-materialization
import { isSafePluginId } from './installer.js';
import {
  getInstalledPlugin,
  resolvePluginFolder,
  resolveWorkspaceTeamPluginWithBindingGate,
  workspaceTeamPluginBindingAllowsRead,
} from './registry.js';

const TEAM_PLUGIN_SOURCE_PREFIX = 'team:plugin:';

function workspaceIdFromTeamPluginSource(
  source: string,
  pluginId: string,
): string | null {
  const suffix = `:${pluginId}`;
  if (!source.startsWith(TEAM_PLUGIN_SOURCE_PREFIX) || !source.endsWith(suffix)) {
    return null;
  }
  const workspaceId = source.slice(
    TEAM_PLUGIN_SOURCE_PREFIX.length,
    -suffix.length,
  ).trim();
  return workspaceId || null;
}

/**
 * Select the local registry partition that belongs to an exact plugin source.
 *
 * PRODUCT INVARIANT: this is filesystem provenance, not membership authority.
 * It lets a locally materialized Team plugin resolve the locally materialized
 * Skill and Design System records stored in the same catalogue partition. Do
 * not compare this Workspace with a project, fetch identity, or block Send.
 */
export function localPluginRegistryScope(
  plugin: { id?: unknown; source?: unknown },
): { workspaceId: string; workspaceMemberId: null } | undefined {
  if (typeof plugin.id !== 'string' || typeof plugin.source !== 'string') {
    return undefined;
  }
  const workspaceId = workspaceIdFromTeamPluginSource(plugin.source, plugin.id);
  return workspaceId ? { workspaceId, workspaceMemberId: null } : undefined;
}

/**
 * Resolve the exact record already selected from a local catalogue.
 *
 * PRODUCT INVARIANT: this is local identity resolution, not authorization.
 * The catalogue's Workspace partition and its SSE/poll reconciliation own
 * availability. Do not add a network membership check, compare against a new
 * project's Workspace, or turn this helper into a Send preflight. Remote
 * install/share/sync/move operations enforce their own current authority.
 */
/**
 * 解析本地插件记录。
 * 纯本地环境下，团队物化逻辑已移除，直接从本地数据库读取已安装插件。
 */
export async function resolveLocalPluginBySource(input: {
  db: Database.Database;
  id: string;
  source: string;
  userPluginsRoot: string;
}): Promise<InstalledPluginRecord | null> {
  const { db, id, source } = input;
  const installed = getInstalledPlugin(db, id);
  if (installed?.source === source) {
    return installed;
  }
  return installed || null;
}
