/**
 * @fileoverview 本地与 BYOK 运行失败 UI 映射（无云端依赖）
 *
 * 替换原运行报错引导逻辑，保留运行失败提示、
 * 重连判定和错误文案映射。
 */

import type { Dict } from '../i18n/types';

export const RECONNECT_OWNED_FAILURE_CODE = 'DAEMON_STREAM_DISCONNECTED';
const RECONNECT_OWNED_FAILURE_MESSAGE = 'daemon stream disconnected before run completed';

export function isReconnectOwnedFailure(
  code: string | null | undefined,
  rawMessage?: string | null,
): boolean {
  if (code === RECONNECT_OWNED_FAILURE_CODE) return true;
  return typeof rawMessage === 'string' && rawMessage.trim() === RECONNECT_OWNED_FAILURE_MESSAGE;
}

export type RunFailurePrimaryAction =
  | 'retry'
  | 'authorize'
  | 'recharge'
  | 'upgrade'
  | 'switch-model'
  | 'open-settings'
  | 'launch-terminal-auth'
  | 'launch-terminal-switch-model'
  | 'switch-to-cloud'
  | 'contact-support';

export interface RunFailureUi {
  primaryAction: RunFailurePrimaryAction;
  titleKey: keyof Dict;
  messageKey: keyof Dict | null;
  messageVars?: Record<string, string>;
  messageCauseKey?: keyof Dict;
  secondaryRetry: boolean;
  cloudSwitchCta: boolean;
  suppressCard?: boolean;
}

export const RUN_FAILURE_FALLBACK_MESSAGE_KEY: keyof Dict = 'chat.runError.fallbackMessage';

export function resolveRunFailureUi(
  code: string | null | undefined,
  detail: string | null | undefined,
  agentId: string | null | undefined,
  rawMessage?: string | null,
  verdict?: any,
): RunFailureUi {
  if (code === 'AGENT_CLI_SESSION_REFUSED') {
    return {
      primaryAction: 'retry',
      titleKey: 'chat.runError.title.cliSessionRefused' as keyof Dict,
      messageKey: 'chat.runError.cliSessionRefusedMessage' as keyof Dict,
      secondaryRetry: false,
      cloudSwitchCta: false,
    };
  }
  return {
    primaryAction: 'retry',
    titleKey: 'chat.runError.title.fallback' as keyof Dict,
    messageKey: RUN_FAILURE_FALLBACK_MESSAGE_KEY,
    secondaryRetry: false,
    cloudSwitchCta: false,
  };
}

export type RunErrorCardDescription =
  | { render: 'none' }
  | { render: 'mapped'; messageKey: keyof Dict }
  | { render: 'app-text'; text: string }
  | { render: 'fallback' };

export function resolveRunErrorCardDescription(input: {
  handedToAnotherSurface: boolean;
  mappedMessageKey: keyof Dict | null;
  paneError: string | null;
  paneErrorCameFromARun: boolean;
  failedRunRawDetail: string | null;
  turnEndedInTerminalFailure: boolean;
}): RunErrorCardDescription {
  if (input.handedToAnotherSurface) return { render: 'none' };
  if (input.mappedMessageKey) {
    return { render: 'mapped', messageKey: input.mappedMessageKey };
  }
  if (input.paneError) {
    return input.paneErrorCameFromARun
      ? { render: 'fallback' }
      : { render: 'app-text', text: input.paneError };
  }
  if (input.failedRunRawDetail) {
    return { render: 'fallback' };
  }
  return input.turnEndedInTerminalFailure
    ? { render: 'fallback' }
    : { render: 'none' };
}

export function daemonFailureVerdictFrom(source: unknown): { retryable?: boolean; failureAction?: string } | undefined {
  const value = source as { retryable?: unknown; failureAction?: unknown } | null | undefined;
  if (!value || typeof value !== 'object') return undefined;
  return {
    retryable: typeof value.retryable === 'boolean' ? value.retryable : undefined,
    failureAction: typeof value.failureAction === 'string' ? (value.failureAction as string) : undefined,
  };
}

export function formatModelWindowRetryAt(
  isoDateStr: string | null | undefined,
  locale?: string,
): string {
  if (!isoDateStr) return '';
  try {
    const d = new Date(isoDateStr);
    return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return isoDateStr;
  }
}

