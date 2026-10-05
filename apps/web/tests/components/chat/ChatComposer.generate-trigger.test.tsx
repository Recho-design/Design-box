// @vitest-environment jsdom
/**
 * 「直接生图」入口按钮 —— 附件行里那颗,点开在聊天面板内长出 `GenerateSurface`。
 *
 * 这里只钉**入口**这一层:
 *   · 准入 —— 什么时候这颗按钮存在(有项目 + 此刻可写),什么时候不存在;
 *   · 开合 —— 点开 / 再点收起 / surface 自己的关闭也回到输入框,以及准入被
 *     撤掉时那块面板跟着收走(留一块能提交的界面在只读项目里更糟)。
 * surface 内部的三态 / 参考图归 `chat/generate-surface.test.tsx`,不在这重复。
 *
 * 断言只碰行为 / ARIA / `data-testid`(规约 `components/chat/AGENTS.md` §5),
 * 一条 CSS 类名都不碰。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';

import { ChatComposer } from '../../../src/components/ChatComposer';
import { flushMounts } from '../../helpers/lexical-composer';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  // surface 一挂载就去拉图片模型建议;输入框自己还会懒加载插件 / MCP / 连接器。
  // 这些都不是本文件要钉的东西,统一给个空壳,别让它们变成噪声。
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/media/models') return jsonResponse({ image: [] });
    return jsonResponse([]);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

/** 最小可用的一组 prop(与 `ChatComposer.empty-send-guard.test.tsx` 同款)。 */
function composerElement(
  overrides: Partial<ComponentProps<typeof ChatComposer>> = {},
) {
  return (
    <ChatComposer
      projectId="project-1"
      projectFiles={[]}
      streaming={false}
      onEnsureProject={async () => 'project-1'}
      onSend={vi.fn()}
      onStop={vi.fn()}
      {...overrides}
    />
  );
}

const trigger = () => screen.queryByTestId('composer-generate-trigger');
const surface = () => screen.queryByTestId('chat-generate-surface');

/** 点开面板并让它挂载时的拉取落定(否则那些状态更新跑在 act 之外)。 */
async function openSurface(): Promise<void> {
  fireEvent.click(trigger()!);
  await flushMounts();
}

describe('ChatComposer · 直接生图入口', () => {
  it('offers the trigger for a writable project composer', async () => {
    render(composerElement());
    await flushMounts();

    // 不按 testid 也能找到它:可访问名就是那行 title(没挂 provider 时 i18n
    // 落到英文兜底)。
    expect(screen.getByRole('button', { name: 'Open Media Playground' })).toBe(trigger());
    expect(trigger()?.getAttribute('aria-expanded')).toBe('false');
    // 面板是点开之后才长的,挂载不该自带一块。
    expect(surface()).toBeNull();
  });

  it('hides the trigger without a project — the images would have nowhere to land', async () => {
    render(composerElement({ projectId: null }));
    await flushMounts();

    expect(trigger()).toBeNull();
  });

  it('hides the trigger while the composer is not writable', async () => {
    // 宿主已判定此刻不许写(共享只读 / 同步中)。
    const view = render(composerElement({ sendDisabled: true }));
    await flushMounts();
    expect(trigger()).toBeNull();

    // 只读 viewer:输入框整个不可编辑,生图更是一次写操作。
    view.rerender(composerElement({ inputDisabled: true }));
    await flushMounts();
    expect(trigger()).toBeNull();

    // 恢复可写之后按钮自己回来 —— 上面两次为 null 是准入判掉的,不是整个输入框
    // 没渲染出来(那会让前两条断言白过)。
    view.rerender(composerElement());
    await flushMounts();
    expect(trigger()).toBeTruthy();
  });

  it('toggles the surface from the trigger and reports the state on it', async () => {
    render(composerElement());
    await flushMounts();
    expect(surface()).toBeNull();

    await openSurface();
    expect(surface()).toBeTruthy();
    expect(trigger()?.getAttribute('aria-expanded')).toBe('true');

    await openSurface();
    expect(surface()).toBeNull();
    expect(trigger()?.getAttribute('aria-expanded')).toBe('false');
  });

  it("closes the surface from the surface's own close button", async () => {
    render(composerElement());
    await flushMounts();
    await openSurface();
    expect(surface()).toBeTruthy();

    fireEvent.click(screen.getByTestId('chat-generate-close'));

    expect(surface()).toBeNull();
    expect(trigger()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes an open surface when the composer loses write access', async () => {
    const view = render(composerElement());
    await flushMounts();
    await openSurface();
    expect(surface()).toBeTruthy();

    // 协作状态翻成只读:按钮和面板一起撤掉,不把可提交的界面留在只读项目里。
    view.rerender(composerElement({ sendDisabled: true }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(surface()).toBeNull();
    expect(trigger()).toBeNull();
  });
});
