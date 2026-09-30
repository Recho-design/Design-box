// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { forwardRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatPane } from '../../src/components/ChatPane';
import {
  trackRunRecoveryActionClick,
  trackRunRecoveryActionSurfaceView,
} from '../../src/analytics/events';
import type { AppConfig, ChatMessage } from '../../src/types';

// G16 removes Continue from error cards, even when the stored CLI session is
// resumable. Keep source identity, history, and recovery analytics assertions.

const translate = (key: string, vars?: Record<string, string | number>) => {
  if (vars && Object.keys(vars).length > 0) {
    return `${key} ${Object.values(vars).join(' ')}`;
  }
  return key;
};

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => undefined, t: translate }),
  useT: () => translate,
}));

vi.mock('../../src/components/AssistantMessage', () => ({
  AssistantMessage: ({ message }: { message: ChatMessage }) => (
    <div data-testid={`assistant-${message.id}`}>{message.content}</div>
  ),
}));

vi.mock('../../src/components/ChatComposer', () => ({
  ChatComposer: forwardRef((_props, _ref) => <div data-testid="composer" />),
}));

vi.mock('../../src/analytics/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/events')>();
  return {
    ...actual,
    trackChatPanelClick: vi.fn(),
    trackRunFailedToastSurfaceView: vi.fn(),
    trackRunRecoveryActionClick: vi.fn(),
    trackRunRecoveryActionSurfaceView: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function resumableFailedMessage(agentId = 'claude'): ChatMessage {
  return {
    id: 'msg-upstream',
    role: 'assistant',
    content: 'Partial work before the upstream dropped.',
    createdAt: 1,
    runId: 'run-upstream',
    runStatus: 'failed',
    resumable: true,
    agentId,
    events: [
      {
        kind: 'status',
        label: 'error',
        detail: 'Upstream request failed: stream disconnected before completion.',
        code: 'UPSTREAM_UNAVAILABLE',
      },
    ],
  };
}

function renderChat(opts: {
  onResumeRun?: (m: ChatMessage) => void;
  onRetry: (m: ChatMessage) => void;
  onSend?: (...args: unknown[]) => void;
  activeAgentId?: string;
  failedAgentId?: string;
}) {
  return render(
    <ChatPane
      messages={[resumableFailedMessage(opts.failedAgentId)]}
      streaming={false}
      error={null}
      projectId="project-1"
      projectFiles={[]}
      onEnsureProject={async () => 'project-1'}
      onSend={opts.onSend ?? vi.fn()}
      onStop={vi.fn()}
      onRetry={opts.onRetry}
      onResumeRun={opts.onResumeRun}
      conversations={[
        { projectId: 'project-1', id: 'conv-1', title: 'Current', createdAt: 1, updatedAt: 1 },
      ]}
      activeConversationId="conv-1"
      onSelectConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
      config={{ agentId: opts.activeAgentId ?? 'claude', agentCliEnv: {} } as unknown as AppConfig}
    />,
  );
}

describe('ChatPane resumable failures retain local retry', () => {
  it('重试保留原失败轮次、历史和恢复埋点', () => {
    const onResumeRun = vi.fn();
    const onRetry = vi.fn();
    const { container } = renderChat({ onResumeRun, onRetry, activeAgentId: 'claude' });
    const card = screen.getByTestId('chat-run-error-card');
    const retry = within(card).getByRole('button', { name: 'promptTemplates.retry' });
    expect(container.querySelector('[data-user-action-footer="true"]')?.contains(retry)).toBe(true);
    expect(screen.queryByRole('button', { name: 'chat.resumeRunCta' })).toBeNull();
    expect(trackRunRecoveryActionSurfaceView).toHaveBeenCalledTimes(1);
    expect(vi.mocked(trackRunRecoveryActionSurfaceView).mock.calls[0]![1]).toMatchObject({
      recovery_action_instance_id: 'recovery:msg-upstream:manual_retry',
      recovery_action_type: 'manual_retry', source_run_id: 'run-upstream',
      source_agent_provider_id: 'claude_code',
    });
    fireEvent.click(retry);
    expect(trackRunRecoveryActionClick).toHaveBeenCalledTimes(1);
    expect(vi.mocked(trackRunRecoveryActionClick).mock.calls[0]![1]).toMatchObject({
      recovery_action_instance_id: 'recovery:msg-upstream:manual_retry',
      recovery_action_type: 'manual_retry',
    });
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-upstream', resumable: true }), 'manual_retry');
    expect(onResumeRun).not.toHaveBeenCalled();
  });

  it('宿主没有续跑回调时也不另发继续提示词', () => {
    const onRetry = vi.fn();
    const onSend = vi.fn();
    renderChat({ onRetry, onSend, activeAgentId: 'claude' });
    fireEvent.click(screen.getByRole('button', { name: 'promptTemplates.retry' }));
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-upstream' }), 'manual_retry');
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each([['claude', 'opencode'], ['codex', 'claude']])(
    '切换到 %s 后仍将原 %s 失败消息交回宿主',
    (failedAgentId, activeAgentId) => {
      const onRetry = vi.fn();
      renderChat({ onRetry, activeAgentId, failedAgentId });
      fireEvent.click(screen.getByRole('button', { name: 'promptTemplates.retry' }));
      expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-upstream', agentId: failedAgentId }), 'manual_retry');
    },
  );
});
