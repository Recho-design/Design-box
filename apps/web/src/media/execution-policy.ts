import type { MediaExecutionPolicy } from '@open-design/contracts';
import type { ProjectMetadata } from '../types';

function cleanModel(model: unknown): string {
  return typeof model === 'string' ? model.trim() : '';
}

export function mediaExecutionPolicyForProjectMetadata(
  metadata: ProjectMetadata | null | undefined,
): MediaExecutionPolicy | undefined {
  if (!metadata) return undefined;
  if (metadata.kind === 'image') {
    const model = cleanModel(metadata.imageModel);
    return model
      ? { mode: 'enabled', allowedSurfaces: ['image'], allowedModels: [model] }
      : { mode: 'enabled', allowedSurfaces: ['image'] };
  }
  if (metadata.kind === 'video') {
    const model = cleanModel(metadata.videoModel);
    return model
      ? { mode: 'enabled', allowedSurfaces: ['video'], allowedModels: [model] }
      : { mode: 'enabled', allowedSurfaces: ['video'] };
  }
  // `kind: 'audio'` deliberately falls through: the audio surface is gone from
  // the contract (`MEDIA_SURFACES` is image + video) and `ProjectMetadata` no
  // longer carries `audioModel`, so there is nothing left to constrain. The
  // daemon applies `DEFAULT_MEDIA_EXECUTION_POLICY` when no policy is sent.
  return undefined;
}
