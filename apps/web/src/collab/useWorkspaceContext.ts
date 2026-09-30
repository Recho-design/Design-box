import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  TeamProject,
  WorkspaceBillingResponse,
  WorkspaceBillingRuntimeState,
  WorkspaceBillingSnapshot,
  WorkspaceBillingSummary,
  WorkspaceCollabContext,
  WorkspaceContextResponse,
  WorkspaceDirectoryItem,
  WorkspaceDirectoryResponse,
  WorkspaceInvalidationSsePayload,
} from '@open-design/contracts';
import {
  advanceWorkspaceAccountGeneration,
  beginWorkspaceScopedRead,
  currentWorkspaceAccountGeneration,
  resetWorkspaceAccountGeneration,
  workspaceIdentityCacheKey,
  type WorkspaceResourceReadIdentity,
} from './workspace-identity';

export {
  advanceWorkspaceAccountGeneration,
  beginWorkspaceScopedRead,
  currentWorkspaceAccountGeneration,
  resetWorkspaceAccountGeneration,
  workspaceIdentityCacheKey,
  type WorkspaceResourceReadIdentity,
};

export type {
  WorkspaceCollabContext,
  WorkspaceBillingSummary,
  WorkspaceBillingResponse,
  WorkspaceDirectoryItem,
  WorkspaceDirectoryResponse,
};

export interface WorkspaceContextState {
  context: WorkspaceCollabContext | null;
  loading: boolean;
  identityChangePending?: boolean;
  accountGeneration?: number;
  resourceReadIdentity?: WorkspaceResourceReadIdentity | null;
  directory?: WorkspaceDirectoryResponse | null;
  failure?: 'unsupported' | 'unavailable' | 'reauth-required';
}

export const OFFLINE_WORKSPACE_STATE: WorkspaceContextState = {
  context: null,
  loading: false,
  accountGeneration: 0,
};

export function useWorkspaceContext(): WorkspaceContextState {
  return OFFLINE_WORKSPACE_STATE;
}

export function currentWorkspaceContextRequestToken(): string {
  return 'offline-token';
}

/**
 * 从资源读取身份中提取工作空间上下文，兼容直接传入的上下文。
 */
export function workspaceResourceReadContext(
  state: WorkspaceContextState | WorkspaceCollabContext | null | undefined,
): WorkspaceCollabContext | null {
  if (!state) return null;
  if ('context' in state) {
    if (state.resourceReadIdentity !== undefined) {
      return state.resourceReadIdentity?.context ?? null;
    }
    return state.context;
  }
  return state;
}

export function workspaceProjectHeaders(
  context: WorkspaceCollabContext | null | undefined,
): Record<string, string> {
  if (!context?.workspaceId || !context?.workspaceMemberId) return {};
  return {
    'x-od-workspace-id': context.workspaceId,
    'x-od-workspace-member-id': context.workspaceMemberId,
  };
}

export async function readWorkspaceDirectoryForCurrentGeneration(): Promise<null> {
  return null;
}

export function workspaceContextFromDirectoryItem(): null {
  return null;
}

/**
 * 解析已绑定项目的实际工作空间上下文（单机模式下返回 null）。
 */
export async function resolveBoundProjectWorkspaceContext(
  _projectId?: string | null,
  _options?: any,
): Promise<WorkspaceCollabContext | null> {
  return null;
}

export interface CurrentWorkspaceContextReadWitness {
  state: WorkspaceContextState;
  context: WorkspaceCollabContext | null;
  isStillCurrent: () => boolean;
}

export function workspaceContextReadWitnessFromState(
  state: WorkspaceContextState,
): CurrentWorkspaceContextReadWitness {
  return {
    state,
    context: state.context,
    isStillCurrent: () => true,
  };
}

export async function resolveCurrentWorkspaceContextReadWitness(): Promise<CurrentWorkspaceContextReadWitness> {
  return {
    state: OFFLINE_WORKSPACE_STATE,
    context: null,
    isStillCurrent: () => true,
  };
}

export function resetWorkspaceContextCache(_scope?: unknown): void {
  // 单机离线模式无缓存需要重置
}

export function lastResolvedWorkspaceContext(): WorkspaceCollabContext | null {
  return null;
}

export function resetTeamProjectsCache(_scope?: unknown): void {
  // 单机离线模式无缓存需要重置
}

export function lastResolvedTeamProjects(_scope?: unknown): any[] {
  return [];
}

export const WORKSPACE_CONTEXT_REFRESH_EVENT = 'od:workspace-context-refresh';

export function workspaceContextRefreshHasVerifiedSelection(_scope?: unknown): boolean {
  return true;
}

export function notifyWorkspaceContextRefresh(_scope?: unknown): void {
  // 单机模式无需向网络刷新
}

export function resetWorkspaceBillingCache(_scope?: unknown): void {
  // 单机模式无计费缓存
}

export function shouldRefreshWorkspaceBilling(_scope?: unknown): boolean {
  return false;
}

export interface WorkspaceBillingScopeInput {
  context?: WorkspaceCollabContext | null;
  refresh?: boolean;
}

export function useWorkspaceBillingResponse(
  ..._args: any[]
): any {
  return { summary: null, workspaceBalance: null };
}

export function workspaceBillingSummaryForContext(
  ..._args: any[]
): WorkspaceBillingSummary | null {
  return null;
}

export function useWorkspaceBilling(_scope?: unknown): WorkspaceBillingSummary | null {
  return null;
}

export function workspaceBillingBalanceUsd(..._args: any[]): string | null {
  return null;
}

export function workspaceBillingSnapshotForContext(_scope?: unknown): null {
  return null;
}

export const WORKSPACE_BILLING_REFRESH_EVENT = 'od:workspace-billing-refresh';

export function notifyWorkspaceBillingRefresh(_scope?: unknown): void {
  // 单机模式无计费刷新
}

export interface TeamProjectsState {
  projects: any[];
  loading: boolean;
  refresh: () => void;
}

const OFFLINE_TEAM_PROJECTS: TeamProjectsState = {
  projects: [],
  loading: false,
  refresh: () => {},
};

export const TEAM_PROJECTS_CHANGED_EVENT = 'od:team-projects-changed';

export function notifyTeamProjectsChanged(_scope?: unknown): void {
  // 单机模式无团队项目变动
}

/**
 * 获取团队共享项目列表（单机模式恒返回空列表）。
 */
export function useTeamProjects(_scope?: unknown): TeamProjectsState {
  return OFFLINE_TEAM_PROJECTS;
}

export function __setWorkspaceContextRetryBackoffForTests(_backoff?: any): void {}

export function useWorkspacePlanNotice(_workspaceContext?: WorkspaceCollabContext | null): string | null {
  return null;
}
