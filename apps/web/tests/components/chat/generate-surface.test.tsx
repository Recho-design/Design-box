// @vitest-environment jsdom
/**
 * 内嵌生图 surface(聊天面板内)。
 *
 * 断言只碰**行为 / ARIA / `data-testid`**(规约 `components/chat/AGENTS.md` §5),
 * 一条 CSS 类名都不碰。三态(运行中 / 失败 / 成图)是这一族的主线,所以三态各自
 * 钉了一遍;参考图、预览、模型建议只钉「接得上」这一件事。
 */
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { I18nProvider } from '../../../src/i18n';
import { ChatRoot } from '../../../src/components/chat/ChatRoot';
import { GenerateSurface } from '../../../src/components/chat/GenerateSurface';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 夹具挂接缝:`--chat-*` 按 DOM 树继承,不挂的话样式全落空(见 ChatRoot 的注释)。 */
const render = (ui: ReactElement) =>
  rtlRender(<I18nProvider initial="zh-CN"><ChatRoot>{ui}</ChatRoot></I18nProvider>);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function generation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gen-1',
    targetProjectId: 'project-1',
    surface: 'image',
    model: 'custom-image',
    modelOverride: null,
    prompt: '一只猫',
    params: { aspect: '1:1', quality: 'standard', count: 1 },
    status: 'done',
    files: [{ name: 'gen-1-1.png' }],
    createdAt: 1,
    ...overrides,
  };
}

let generateCalls: Array<Record<string, unknown>>;
let uploadCalls: FormData[];
let generateResponder: () => Promise<Response>;

function stubFetch(): void {
  generateCalls = [];
  uploadCalls = [];
  generateResponder = async () => jsonResponse(generation());
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/media/models') {
      return jsonResponse({ image: [{ id: 'gpt-image-2' }, { id: 'seedream-4' }] });
    }
    if (url === '/api/media/playground/uploads') {
      uploadCalls.push(init?.body as FormData);
      return jsonResponse({ name: 'cat.png' });
    }
    if (url === '/api/media/playground/generate') {
      generateCalls.push(JSON.parse(String(init?.body ?? '{}')));
      return generateResponder();
    }
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
}

function typePrompt(text: string): void {
  fireEvent.change(screen.getByTestId('chat-generate-prompt'), { target: { value: text } });
}

beforeEach(() => {
  stubFetch();
});

const surface = () => screen.getByTestId('chat-generate-surface');
const submit = () => screen.getByTestId('chat-generate-submit');

describe('GenerateSurface · 空态', () => {
  it('opens with an empty session, a disabled submit and no history fetched', () => {
    render(<GenerateSurface projectId="project-1" onClose={vi.fn()} />);

    expect(surface().textContent).toContain('本会话还没有生成记录');
    expect(screen.getByTestId('chat-generate-submit')).toBeDisabled();
    // 「历史只覆盖本次会话」:打开时不该去拉全量记录(那是导航栏「生成」入口的活)。
    const urls = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls
      .map(([url]) => url);
    expect(urls.some((url) => url.includes('/generations'))).toBe(false);
  });

  it('suggests image models from /api/media/models in the datalist', async () => {
    render(<GenerateSurface projectId="project-1" onClose={vi.fn()} />);

    await waitFor(() => {
      const options = Array.from(document.querySelectorAll('datalist option'))
        .map((option) => option.getAttribute('value'));
      expect(options).toEqual(['gpt-image-2', 'seedream-4']);
    });
  });
});

describe('GenerateSurface · 运行中', () => {
  it('shows one placeholder per requested image until the batch comes back', async () => {
    let release: ((response: Response) => void) | null = null;
    generateResponder = () => new Promise<Response>((resolve) => { release = resolve; });

    render(<GenerateSurface projectId="project-1" onClose={vi.fn()} />);
    typePrompt('一只猫');
    fireEvent.change(screen.getByTestId('chat-generate-count'), { target: { value: '4' } });
    await act(async () => {
      fireEvent.click(submit());
    });

    expect(screen.getByTestId('chat-generate-running').textContent).toBe('生成中…');
    expect(screen.getAllByTestId('chat-generate-slot-running')).toHaveLength(4);
    expect(generateCalls[0]).toMatchObject({ prompt: '一只猫', count: 4, targetProjectId: 'project-1' });

    await act(async () => {
      release?.(jsonResponse(generation()));
    });
    expect(screen.queryByTestId('chat-generate-running')).toBeNull();
  });
});

describe('GenerateSurface · 成图', () => {
  it('renders the finished images with preview / download / use-as-reference actions', async () => {
    render(<GenerateSurface projectId="project-1" onClose={vi.fn()} />);
    typePrompt('一只猫');
    await act(async () => {
      fireEvent.click(submit());
    });

    const shot = screen.getByTestId('chat-generate-shot-gen-1-0');
    expect(shot.querySelector('img')?.getAttribute('src'))
      .toBe('/api/projects/project-1/raw/gen-1-1.png');
    expect(screen.getByTestId('chat-generate-download-gen-1-0')).toBeTruthy();
    expect(screen.getByTestId('chat-generate-reference-gen-1-0')).toBeTruthy();
    expect(screen.queryByTestId('chat-generate-failed')).toBeNull();
  });

  it('previews an image in a dialog that the close button dismisses', async () => {
    render(<GenerateSurface projectId="project-1" onClose={vi.fn()} />);
    typePrompt('一只猫');
    await act(async () => {
      fireEvent.click(submit());
    });

    fireEvent.click(screen.getByTestId('chat-generate-shot-gen-1-0'));
    expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src'))
      .toBe('/api/projects/project-1/raw/gen-1-1.png');

    fireEvent.click(screen.getByTestId('chat-generate-preview-close'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('feeds a generated image back in as a reference for the next batch', async () => {
    render(<GenerateSurface projectId="project-1" onClose={vi.fn()} />);
    typePrompt('一只猫');
    await act(async () => {
      fireEvent.click(submit());
    });

    fireEvent.click(screen.getByTestId('chat-generate-reference-gen-1-0'));
    expect(screen.getByText('gen-1-1.png')).toBeTruthy();

    await act(async () => {
      fireEvent.click(submit());
    });
    expect(generateCalls[1]?.images).toEqual(['gen-1-1.png']);
  });
});

describe('GenerateSurface · 失败', () => {
  it('marks the optimistic card failed, states the reason and offers a retry', async () => {
    generateResponder = async () =>
      jsonResponse({ error: { message: '上游超时' } }, 500);

    render(<GenerateSurface projectId="project-1" onClose={vi.fn()} />);
    typePrompt('一只猫');
    await act(async () => {
      fireEvent.click(submit());
    });

    expect(screen.getByTestId('chat-generate-failed').textContent).toBe('此图片生成失败');
    expect(screen.getByRole('alert').textContent).toBe('上游超时');
    expect(screen.getAllByTestId('chat-generate-slot-failed')[0]?.textContent).toContain('上游超时');
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('re-runs the failed batch with the parameters that batch asked for', async () => {
    generateResponder = async () => jsonResponse({ error: { message: '上游超时' } }, 500);

    render(<GenerateSurface projectId="project-1" onClose={vi.fn()} />);
    typePrompt('一只猫');
    await act(async () => {
      fireEvent.click(submit());
    });

    // 用户接着改表单 —— 重试发的仍是**那一发**的参数,不是改到一半的值。
    typePrompt('换成一只狗');
    generateResponder = async () => jsonResponse(generation());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }));
    });

    expect(generateCalls[1]?.prompt).toBe('一只猫');
    expect(screen.queryByTestId('chat-generate-failed')).toBeNull();
    // 重试是**就地替换**:面板里始终只有那一张卡,不追加、不留失败残迹。
    expect(screen.getAllByTestId(/^chat-generate-card-/)).toHaveLength(1);
  });

  it('falls back to the dictionary copy when the failure body is not an envelope', async () => {
    generateResponder = async () => new Response('<html>502</html>', { status: 502 });

    render(<GenerateSurface projectId="project-1" onClose={vi.fn()} />);
    typePrompt('一只猫');
    await act(async () => {
      fireEvent.click(submit());
    });

    expect(screen.getByRole('alert').textContent).toBe('生成失败，请重试');
  });
});

describe('GenerateSurface · 参考图', () => {
  it('uploads a picked file into the current project and shows it as a chip', async () => {
    render(<GenerateSurface projectId="project-1" onClose={vi.fn()} />);

    const input = screen.getByTestId('chat-generate-reference-input');
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] },
    });

    await waitFor(() => {
      expect(screen.getByText('cat.png')).toBeTruthy();
    });
    expect(uploadCalls[0]?.get('targetProjectId')).toBe('project-1');
  });

  it('takes the chip back off without touching the uploaded file', async () => {
    render(<GenerateSurface projectId="project-1" onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('chat-generate-reference-input'), {
      target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] },
    });
    await waitFor(() => {
      expect(screen.getByText('cat.png')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '移除参考图' }));
    expect(screen.queryByText('cat.png')).toBeNull();
    // 摘芯片只是「这一发不带它」,不该再发一次删除请求。
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .some(([url]) => String(url).includes('DELETE'))).toBe(false);
  });
});

describe('GenerateSurface · 收起', () => {
  it('hands the close action back to the host', () => {
    const onClose = vi.fn();
    render(<GenerateSurface projectId="project-1" onClose={onClose} />);

    fireEvent.click(screen.getByTestId('chat-generate-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
