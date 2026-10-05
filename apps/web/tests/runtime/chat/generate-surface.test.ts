/**
 * 内嵌生图 surface 的纯领域逻辑。
 *
 * 这一层不启 jsdom(规约 `components/chat/AGENTS.md` §5:`runtime/chat/*` 必须有
 * 不启 DOM 的单元测试)。它管的是「表单怎么变成请求体、一张卡从哪来、失败怎么读」,
 * 组件那一侧的渲染断言在 `tests/components/chat/generate-surface.test.tsx`。
 */
import { describe, expect, it } from 'vitest';
import type { PlaygroundGeneration } from '@open-design/contracts';
import {
  addReferenceName,
  buildGenerateRequest,
  canSubmitGenerate,
  clampGenerateCount,
  createGenerateDraft,
  draftFromCard,
  failedCard,
  generateErrorMessage,
  removeReferenceAt,
  runningCard,
  settledCard,
  type GenerateDraft,
} from '../../../src/runtime/chat/generate-surface';

function draftWith(patch: Partial<GenerateDraft>): GenerateDraft {
  return { ...createGenerateDraft(), ...patch };
}

describe('createGenerateDraft', () => {
  it('starts from the two default档 and one image, with nothing attached', () => {
    expect(createGenerateDraft()).toEqual({
      prompt: '',
      modelOverride: '',
      aspect: '1:1',
      quality: 'standard',
      count: 1,
      references: [],
    });
  });

  it('hands out a fresh array each time — a shared one would leak across openings', () => {
    const first = createGenerateDraft();
    const second = createGenerateDraft();
    expect(first.references).not.toBe(second.references);
    expect(second.references).toEqual([]);
  });
});

describe('clampGenerateCount', () => {
  it('clamps into 1..10', () => {
    expect(clampGenerateCount(0)).toBe(1);
    expect(clampGenerateCount(-4)).toBe(1);
    expect(clampGenerateCount(99)).toBe(10);
    expect(clampGenerateCount(4)).toBe(4);
  });

  it('treats a cleared number input as the floor, not as zero images', () => {
    // `Number('')` 是 0,而输入框被清空时读到的就是它 —— 不夹的话界面上会出现「0 张」。
    expect(clampGenerateCount(Number(''))).toBe(1);
    expect(clampGenerateCount(Number.NaN)).toBe(1);
  });
});

describe('reference chips', () => {
  it('does not stack the same file twice', () => {
    const once = addReferenceName(['uploads/a.png'], 'uploads/a.png');
    expect(once).toEqual(['uploads/a.png']);
    expect(once).not.toBe(undefined);
  });

  it('removes by position and ignores an out-of-range index', () => {
    expect(removeReferenceAt(['a.png', 'b.png'], 0)).toEqual(['b.png']);
    expect(removeReferenceAt(['a.png'], 3)).toEqual(['a.png']);
    expect(removeReferenceAt(['a.png'], -1)).toEqual(['a.png']);
  });
});

describe('buildGenerateRequest', () => {
  it('always targets the current project on the image surface', () => {
    const request = buildGenerateRequest('project-1', draftWith({ prompt: '  一只猫  ' }));
    expect(request).toEqual({
      targetProjectId: 'project-1',
      surface: 'image',
      model: 'custom-image',
      prompt: '一只猫',
      aspect: '1:1',
      quality: 'standard',
      count: 1,
    });
  });

  it('only sends modelOverride / images when the user actually set them', () => {
    // 空串进 wire 会被 daemon 当成「指定了一个空模型名」,不是「没指定」。
    const request = buildGenerateRequest('project-1', draftWith({ prompt: 'p' }));
    expect('modelOverride' in request).toBe(false);
    expect('images' in request).toBe(false);
  });

  it('carries the model override, the parameters and the reference images', () => {
    const request = buildGenerateRequest(
      'project-1',
      draftWith({
        prompt: 'p',
        modelOverride: ' gpt-image-2 ',
        aspect: '16:9',
        quality: 'high',
        count: 42,
        references: ['uploads/a.png', '  '],
      }),
    );
    expect(request.modelOverride).toBe('gpt-image-2');
    expect(request.aspect).toBe('16:9');
    expect(request.quality).toBe('high');
    expect(request.count).toBe(10);
    // 空白项不是一张参考图 —— 发过去 daemon 会拿它去拼路径。
    expect(request.images).toEqual(['uploads/a.png']);
  });
});

describe('canSubmitGenerate', () => {
  it('requires real text, not just whitespace', () => {
    expect(canSubmitGenerate(draftWith({ prompt: '' }))).toBe(false);
    expect(canSubmitGenerate(draftWith({ prompt: '   \n ' }))).toBe(false);
    expect(canSubmitGenerate(draftWith({ prompt: '一张海报' }))).toBe(true);
  });
});

describe('session cards', () => {
  it('lays out one empty slot per requested image while the batch is in flight', () => {
    const card = runningCard('pending-0', draftWith({ prompt: '一只猫', count: 3 }), '一只猫');
    expect(card.status).toBe('running');
    expect(card.files).toHaveLength(3);
    expect(card.error).toBeNull();
    expect(card.count).toBe(3);
  });

  it('replaces the optimistic card with the settled row the daemon returned', () => {
    const generation: PlaygroundGeneration = {
      id: 'gen-1',
      targetProjectId: 'project-1',
      surface: 'image',
      model: 'custom-image',
      modelOverride: 'gpt-image-2',
      prompt: '一只猫',
      params: { aspect: '1:1', quality: 'high', count: 2 },
      status: 'done',
      files: [{ name: 'gen-1-1.png' }, { name: 'gen-1-2.png' }],
      createdAt: 1,
    };
    expect(settledCard(generation)).toEqual({
      id: 'gen-1',
      prompt: '一只猫',
      modelOverride: 'gpt-image-2',
      aspect: '1:1',
      quality: 'high',
      count: 2,
      status: 'done',
      files: [{ name: 'gen-1-1.png' }, { name: 'gen-1-2.png' }],
      error: null,
    });
  });

  it('keeps a per-slot failure on the slot instead of failing the whole batch', () => {
    const generation: PlaygroundGeneration = {
      id: 'gen-2',
      targetProjectId: 'project-1',
      surface: 'image',
      model: 'custom-image',
      modelOverride: null,
      prompt: 'p',
      params: { count: 2 },
      status: 'done',
      files: [{ name: 'gen-2-1.png' }, { name: '', error: 'provider 超时' }],
      createdAt: 1,
    };
    const card = settledCard(generation);
    expect(card.status).toBe('done');
    expect(card.files[1]?.error).toBe('provider 超时');
  });

  it('turns the optimistic card into a failed one in place', () => {
    const running = runningCard('pending-0', draftWith({ prompt: 'p', count: 2 }), 'p');
    const failed = failedCard(running, '生成失败，请重试');
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('生成失败，请重试');
    expect(failed.prompt).toBe('p');
    expect(failed.files).toEqual([{ name: '', error: '生成失败，请重试' }]);
  });
});

describe('draftFromCard', () => {
  it('rebuilds the retry request from what that batch actually asked for', () => {
    const card = settledCard({
      id: 'gen-3',
      targetProjectId: 'project-1',
      surface: 'image',
      model: 'custom-image',
      modelOverride: 'gpt-image-2',
      prompt: '一只猫',
      params: { aspect: '9:16', quality: 'high', count: 2 },
      status: 'failed',
      files: [],
      createdAt: 1,
    });
    expect(draftFromCard(card, ['uploads/a.png'])).toEqual({
      prompt: '一只猫',
      modelOverride: 'gpt-image-2',
      aspect: '9:16',
      quality: 'high',
      count: 2,
      references: ['uploads/a.png'],
    });
  });

  it('falls back to the default档 when the row never carried parameters', () => {
    const card = { ...runningCard('pending-1', draftWith({ prompt: 'p' }), 'p'), aspect: '', quality: '' };
    const draft = draftFromCard(card, []);
    expect(draft.aspect).toBe('1:1');
    expect(draft.quality).toBe('standard');
    expect(draft.modelOverride).toBe('');
  });
});

describe('generateErrorMessage', () => {
  it('reads the daemon error envelope', () => {
    expect(generateErrorMessage({ error: { message: '上游超时' } }, '兜底')).toBe('上游超时');
    expect(generateErrorMessage({ error: '拒绝' }, '兜底')).toBe('拒绝');
  });

  it('falls back when the body is HTML / empty / not an envelope', () => {
    // 断网或代理插进来时 `res.json()` 拿到的是 null 或一段 HTML。
    expect(generateErrorMessage(null, '兜底')).toBe('兜底');
    expect(generateErrorMessage('<html>', '兜底')).toBe('兜底');
    expect(generateErrorMessage({ error: { message: '  ' } }, '兜底')).toBe('兜底');
  });
});
