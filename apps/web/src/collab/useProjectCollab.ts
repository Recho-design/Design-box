/**
 * @file useProjectCollab.ts
 * 降级后的项目协作钩子。
 * 本仓库已彻底移除官方云端协作（Presence/Heartbeat/Sync），所有项目均作为单机/本地项目运行，拥有完全写入权限。
 */

import type {
  CollabMemberRole,
  CollabPresenceMember,
  ProjectContentTransferState,
  ProjectVisibility,
  WorkspaceCollabContext,
} from '@open-design/contracts';

/** 本地会话创建的项目 ID 缓存 */
const projectScopesCreatedByViewerThisSession = new Set<string>();

/**
 * 标记项目在本会话中由当前用户创建。
 */
export function markProjectCreatedByViewer(
  projectId: string,
  _workspaceContext?: WorkspaceCollabContext | null,
): void {
  projectScopesCreatedByViewerThisSession.add(projectId);
}

/** 测试辅助：清空缓存 */
export function resetProjectsCreatedByViewerCache(): void {
  projectScopesCreatedByViewerThisSession.clear();
}

export interface UseProjectCollabOptions {
  workspaceContext?: WorkspaceCollabContext | null;
  workspaceContextLoading?: boolean;
  initialMaterializationPending?: boolean;
  projectVisibility?: ProjectVisibility | null;
  fetch?: typeof fetch;
  baseUrl?: string;
  heartbeatMs?: number;
  statusPollMs?: number;
  presenceFilePath?: string | null;
}

export function useWorkspaceContext(
  _options: UseProjectCollabOptions = {},
): WorkspaceCollabContext | null {
  return null;
}

export interface ProjectCollab {
  enabled: boolean;
  member: CollabPresenceMember | null;
  present: CollabPresenceMember[];
  publishedVersion: number | null;
  syncState: string | null;
  viewerOnly: boolean;
  writerAuthority: 'allowed' | 'denied' | 'pending';
  isOwner: boolean;
  isEffectiveOwner: boolean;
  isSharedNonOwner: boolean;
  ownerDisplayName: string | null;
  ownerRole: CollabMemberRole | null;
  downloadPending: boolean;
  materializationPending?: boolean;
  reportChange: () => void;
  requestPublish: () => void;
  refreshPresence: () => void;
  checkStatusNow: () => void;
  applyContentTransferState?: (state: ProjectContentTransferState) => void;
}

/**
 * 判断项目是否被 Daemon 确认为个人项目。
 */
export function projectIsDaemonConfirmedPersonal(
  visibility: ProjectVisibility | null | undefined,
): boolean {
  return visibility === 'personal' || !visibility;
}

/**
 * 解析项目写入权限（单机模式下始终允许）。
 */
export function resolveProjectWriterAuthority(_options: {
  workspaceReadOnly?: boolean;
  workspaceContextReadOnly?: boolean;
  lostAccessAfterUnshare?: boolean;
  shared?: boolean;
  isOwner?: boolean;
  knownOwnedByViewer?: boolean;
  createdByViewerThisSession?: boolean;
  daemonConfirmedPersonal?: boolean;
  materializationPending?: boolean;
  syncState?: ProjectCollab['syncState'];
}): ProjectCollab['writerAuthority'] {
  return 'allowed';
}

const DEFAULT_PROJECT_COLLAB: ProjectCollab = {
  enabled: false,
  member: null,
  present: [],
  publishedVersion: null,
  syncState: null,
  viewerOnly: false,
  writerAuthority: 'allowed',
  isOwner: true,
  isEffectiveOwner: true,
  isSharedNonOwner: false,
  ownerDisplayName: null,
  ownerRole: null,
  downloadPending: false,
  materializationPending: false,
  reportChange: () => {},
  requestPublish: () => {},
  refreshPresence: () => {},
  checkStatusNow: () => {},
};

/**
 * 项目协作与状态管理 Hook（降级单机版）。
 * 不再发起云端心跳或状态轮询，始终返回具备完整编辑权限的本地项目状态。
 */
export function useProjectCollab(
  _projectId: string | null | undefined,
  _options?: UseProjectCollabOptions,
): ProjectCollab {
  return DEFAULT_PROJECT_COLLAB;
}
