import type { ProjectSyncState, WorkspaceCollabContext } from '@open-design/contracts';

/**
 * 资源归属主体。
 *
 * 原类型定义在已删除的 `collab/resource-principal.ts`：它把登录态里的
 * 工作区身份转成资源中心的 principal。云协作链路摘除后，本文件只剩
 * Vela 团队项目目录客户端的类型契约，因此在这里保留最小形状，避免
 * 交叉引用已删除的模块。
 */
export interface ResourceHubPrincipal {
  memberId: string;
  teamId: string;
  role: WorkspaceCollabContext['role'];
  lifecycleState: WorkspaceCollabContext['lifecycleState'];
  workspaceType?: WorkspaceCollabContext['workspaceType'];
}

export type VelaTeamProjectSyncState =
  | 'pending_upload'
  | 'syncing'
  | 'synced'
  | 'failed';

export interface VelaTeamProjectRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  resourceId: string;
  ownerMemberId: string;
  displayName: string | null;
  syncState: VelaTeamProjectSyncState;
  lastSyncedVersionId: string | null;
  /** Absent when talking to an older Vela API, null when no published ref
   * exists, otherwise the immutable version currently available to readers. */
  publishedVersionId?: string | null;
  createdAt: string;
  /** Owner-origin project timestamp from the catalog row's metadata. This is
   * distinct from `updatedAt`, which is the catalog row revision time and may
   * be restamped by a delayed retry. */
  originProjectUpdatedAt: number | null;
  updatedAt: string;
  access: {
    canView: boolean;
    canComment: boolean;
    canEdit: boolean;
    frozen: boolean;
  };
}

export interface UpsertVelaTeamProjectInput {
  projectId: string;
  resourceId: string;
  displayName?: string | null;
  syncState?: VelaTeamProjectSyncState;
  lastSyncedVersionId?: string | null;
}

export interface VelaTeamProjectCatalogClient {
  list(principal: ResourceHubPrincipal): Promise<VelaTeamProjectRecord[]>;
  upsert(
    input: UpsertVelaTeamProjectInput,
    principal: ResourceHubPrincipal,
  ): Promise<VelaTeamProjectRecord | null>;
}

export function projectResourceIdFor(
  projectId: string,
  principal?: ResourceHubPrincipal | null,
): string {
  if (!principal) return `project-${projectId}`;
  const scoped = Buffer.from(
    JSON.stringify([principal.teamId, principal.memberId, projectId]),
    'utf8',
  ).toString('base64url');
  return `project-${scoped}`;
}

export function projectSyncStateToVela(
  state: ProjectSyncState,
): VelaTeamProjectSyncState {
  if (state === 'synced') return 'synced';
  if (state === 'sync_failed') return 'failed';
  return 'pending_upload';
}

export function velaProjectSyncStateToProject(
  state: VelaTeamProjectSyncState,
): ProjectSyncState {
  if (state === 'synced') return 'synced';
  if (state === 'failed') return 'sync_failed';
  return 'pending_upload';
}
