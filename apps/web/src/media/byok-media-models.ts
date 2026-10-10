// BYOK media-model option lists.
//
// These hooks used to live in `aihubmix-image-models.ts` next to a live
// AIHubMix catalogue fetch (`GET /api/media/providers/aihubmix/models`, cached
// per catalogue type). AIHubMix and SenseAudio were removed as providers in
// S5a — the daemon no longer serves that route and no longer holds credentials
// for either — so the only thing left to resolve is the static registry entry
// list for the selected BYOK provider.
//
// The speech hook is gone with the audio surface: `AUDIO_MODELS_BY_KIND` was
// removed from the registry and there is no `generate_speech` tool left to
// point a voice at.
//
// Each hook keeps the same signature and memoisation it had, so the call sites
// in `SettingsDialog` and `ProjectView` did not have to grow their own
// `useMemo` just to hold an array identity.

import { useMemo } from 'react';
import {
  IMAGE_MODELS,
  VIDEO_MODELS,
  type MediaModel,
} from './models';

export function useByokImageModelOptions(
  provider: string | undefined,
): MediaModel[] {
  return useMemo(
    () => IMAGE_MODELS.filter((model) => model.provider === provider),
    [provider],
  );
}

export function useByokVideoModelOptions(
  provider: string | undefined,
): MediaModel[] {
  return useMemo(
    () => VIDEO_MODELS.filter((model) => model.provider === provider),
    [provider],
  );
}
