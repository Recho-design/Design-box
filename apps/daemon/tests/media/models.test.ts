import { describe, expect, it } from 'vitest';

import {
  IMAGE_MODELS,
  MEDIA_PROVIDERS,
  canonicalMediaModelId,
  findMediaModel,
  isMediaProviderOffered,
  offeredModelsForSurface,
} from '../../src/media/models.js';

describe('image model defaults', () => {
  it('defaults image generation to the OpenAI BYOK route', () => {
    expect(IMAGE_MODELS.filter((model) => model.default).map((model) => model.id)).toEqual([
      'gpt-image-2',
    ]);
    expect(MEDIA_PROVIDERS.some((provider) => provider.id === 'codex')).toBe(false);
    expect(IMAGE_MODELS.some((model) => model.provider === 'codex')).toBe(false);
  });

  it('keeps the managed Cloud route out of the model catalogue', () => {
    for (const surface of ['image', 'video'] as const) {
      expect(offeredModelsForSurface(surface).some((model) => model.provider === 'vela')).toBe(false);
    }
    expect(
      MEDIA_PROVIDERS.filter(isMediaProviderOffered).some((provider) => provider.id === 'vela'),
    ).toBe(false);
    // 视频默认值本来就落在非云侧（Volcengine Seedance），不因下架而落空。
    expect(offeredModelsForSurface('video').some((model) => model.default)).toBe(true);
  });

  it('migrates the removed Codex image model id off the Cloud route', () => {
    expect(canonicalMediaModelId('codex-gpt-image-2')).toBe('gpt-image-2');
    expect(findMediaModel('codex-gpt-image-2')?.provider).toBe('openai');
  });

  it('points the nano-banana shorthands at the local Google provider', () => {
    expect(canonicalMediaModelId('nano-banana')).toBe('gemini-3.1-flash-image-preview');
    expect(canonicalMediaModelId('nano-banana-2')).toBe('gemini-3.1-flash-image-preview');
    expect(findMediaModel('nano-banana-2')?.provider).toBe('nanobanana');
  });

  it('leaves the Cloud-only nano-banana-2-lite shorthand unusable', () => {
    // 该档只有 vela 云实现，没有本地等价物：撤销别名后它不再解析到任何模型，
    // 而不是兜底到别的 provider。
    expect(canonicalMediaModelId('nano-banana-2-lite')).toBe('nano-banana-2-lite');
    expect(findMediaModel('nano-banana-2-lite')).toBeNull();
  });

  it('preserves explicit OpenAI BYOK model selection', () => {
    expect(canonicalMediaModelId('gpt-image-2')).toBe('gpt-image-2');
    expect(findMediaModel('gpt-image-2')?.provider).toBe('openai');
  });
});
