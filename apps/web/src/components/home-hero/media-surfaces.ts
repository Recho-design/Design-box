import type { InputFieldSpec, ProjectKind } from '@open-design/contracts';
import type { ProjectMetadata, PromptTemplateSummary } from '../../types';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_MODELS,
  MEDIA_ASPECTS,
  type MediaModel,
  VIDEO_LENGTHS_SEC,
  VIDEO_MODELS,
} from '../../media/models';

/**
 * Media modes the Home composer can drive. The audio mode is gone with the
 * audio surface itself: `MEDIA_SURFACES` in the contract is image + video,
 * the audio model catalogue was removed from `src/media/models.ts`, and the
 * daemon has no audio dispatcher — so a voice / duration / audio-kind block
 * would have nothing to bind to.
 */
export type HomeComposerMediaSurface = 'image' | 'video' | 'hyperframes';

export interface HomeMediaComposerState {
  surface: HomeComposerMediaSurface;
  projectKind: ProjectKind;
  queryTemplate: string;
  fields: InputFieldSpec[];
  inputs: Record<string, unknown>;
  editableFieldNames: string[];
}

export const HOME_MEDIA_CHIP_IDS = ['image', 'video', 'hyperframes'] as const;
const NO_TEMPLATE_PLACEHOLDER = 'No template';
const MEDIA_RESOLUTIONS = ['2k', '4k'] as const;
const MEDIA_RESOLUTION_LABELS: Record<(typeof MEDIA_RESOLUTIONS)[number], string> = {
  '2k': '2K',
  '4k': '4K',
};
const DEFAULT_MEDIA_RESOLUTION = '2k';

export function homeMediaSurfaceForChipId(chipId: string): HomeComposerMediaSurface | null {
  if (chipId === 'image') return 'image';
  if (chipId === 'video') return 'video';
  if (chipId === 'hyperframes') return 'hyperframes';
  return null;
}

export function buildHomeMediaComposer(
  surface: HomeComposerMediaSurface,
  promptTemplates: PromptTemplateSummary[],
  seedInputs: Record<string, unknown> = {},
  options: {
    imageModels?: MediaModel[];
  } = {},
): HomeMediaComposerState {
  const imageModels = options.imageModels ?? IMAGE_MODELS;
  const inputs = normalizeHomeMediaInputs(
    surface,
    {
      ...defaultInputsForSurface(surface, promptTemplates),
      ...seedInputs,
    },
    promptTemplates,
    imageModels,
  );
  const fields = fieldsForSurface(surface, imageModels);
  const editableFieldNames = fields.map((field) => field.name);
  const queryTemplate = queryTemplateForSurface(surface);
  return {
    surface,
    projectKind: surface === 'hyperframes' ? 'video' : surface,
    queryTemplate,
    fields,
    inputs,
    editableFieldNames,
  };
}

export function normalizeHomeMediaInputs(
  surface: HomeComposerMediaSurface,
  raw: Record<string, unknown>,
  promptTemplates: PromptTemplateSummary[] = [],
  imageModels: MediaModel[] = IMAGE_MODELS,
): Record<string, unknown> {
  if (surface === 'image') {
    const ratio = validOption(stringValue(raw.ratio) || stringValue(raw.aspect), MEDIA_ASPECTS, '16:9');
    return {
      mediaKind: 'image',
      subject: stringValue(raw.subject) || 'a premium product concept',
      style: stringValue(raw.style) || 'premium product-studio, elegant composition, refined lighting, restrained color',
      aspect: ratio,
      template: validTemplateId(surface, stringValue(raw.template), promptTemplates),
      designSystem: stringValue(raw.designSystem) || 'the active project design system',
      model: validOption(stringValue(raw.model), imageModels.map((m) => m.id), DEFAULT_IMAGE_MODEL),
      ratio,
      resolution: validOption(stringValue(raw.resolution), MEDIA_RESOLUTIONS, DEFAULT_MEDIA_RESOLUTION),
    };
  }
  if (surface === 'video') {
    const ratio = validOption(stringValue(raw.ratio) || stringValue(raw.aspect), MEDIA_ASPECTS, '16:9');
    return {
      mediaKind: 'video',
      subject: stringValue(raw.subject) || 'a premium product launch moment',
      style: stringValue(raw.style) || 'cinematic product-studio, elegant motion, refined lighting, restrained pacing',
      aspect: ratio,
      template: validTemplateId(surface, stringValue(raw.template), promptTemplates),
      designSystem: stringValue(raw.designSystem) || 'the active project design system',
      model: validOption(
        stringValue(raw.model),
        VIDEO_MODELS.filter((m) => m.id !== 'hyperframes-html').map((m) => m.id),
        DEFAULT_VIDEO_MODEL === 'hyperframes-html'
          ? VIDEO_MODELS.find((m) => m.id !== 'hyperframes-html')?.id ?? DEFAULT_VIDEO_MODEL
          : DEFAULT_VIDEO_MODEL,
      ),
      ratio,
      duration: validNumber(raw.duration, VIDEO_LENGTHS_SEC, 5),
      resolution: validOption(stringValue(raw.resolution), MEDIA_RESOLUTIONS, DEFAULT_MEDIA_RESOLUTION),
    };
  }
  const ratio = validOption(stringValue(raw.ratio) || stringValue(raw.aspect), MEDIA_ASPECTS, '16:9');
  return {
    mediaKind: 'video',
    subject: stringValue(raw.subject) || 'a premium product motion concept',
    style: stringValue(raw.style) || 'premium kinetic typography, elegant transitions, restrained motion language',
    aspect: ratio,
    template: validTemplateId(surface, stringValue(raw.template), promptTemplates),
    model: 'hyperframes-html',
    ratio,
    duration: validNumber(raw.duration, VIDEO_LENGTHS_SEC, 10),
  };
}

export function metadataForHomeMediaComposer(
  surface: HomeComposerMediaSurface,
  inputs: Record<string, unknown>,
  promptTemplates: PromptTemplateSummary[],
): ProjectMetadata {
  const template = promptTemplates.find((item) => item.id === stringValue(inputs.template)) ?? null;
  const promptTemplate = template
    ? {
        id: template.id,
        surface: template.surface,
        title: template.title,
        prompt: template.summary,
        summary: template.summary,
        category: template.category,
        ...(template.tags ? { tags: template.tags } : {}),
        ...(template.model ? { model: template.model } : {}),
        ...(template.aspect ? { aspect: template.aspect } : {}),
        source: template.source,
      }
    : undefined;

  // Media surfaces no longer seed ratio / duration from the composer footer.
  // The prompt marks them as not provided, infers safe defaults, and asks only
  // when a choice materially changes the output. We seed `kind`, the selected
  // image route, (+ the hyperframes route discriminator) and any picked prompt
  // template, mirroring how prototype/deck defer their settings. Persisting the
  // image route keeps the run aligned with the model shown in the Home composer.
  if (surface === 'image') {
    const imageModel = stringValue(inputs.model);
    return {
      kind: 'image',
      ...(imageModel ? { imageModel } : {}),
      ...(promptTemplate ? { promptTemplate } : {}),
    };
  }
  return {
    kind: 'video',
    ...(surface === 'hyperframes'
      ? { intent: 'hyperframes' as const, videoModel: 'hyperframes-html' as const }
      : {}),
    ...(promptTemplate ? { promptTemplate } : {}),
  };
}

export function templatesForHomeMediaSurface(
  surface: HomeComposerMediaSurface,
  promptTemplates: PromptTemplateSummary[],
): PromptTemplateSummary[] {
  if (surface === 'image') {
    return promptTemplates.filter((template) => template.surface === 'image');
  }
  if (surface === 'video') {
    return promptTemplates.filter(
      (template) => template.surface === 'video' && !isHyperFramesTemplate(template),
    );
  }
  return promptTemplates.filter(
    (template) => template.surface === 'video' && isHyperFramesTemplate(template),
  );
}

function fieldsForSurface(
  surface: HomeComposerMediaSurface,
  imageModels: MediaModel[] = IMAGE_MODELS,
): InputFieldSpec[] {
  if (surface === 'image') {
    return [
      stringField('designSystem', 'Design system', 'Design system'),
      selectField('model', 'Model', imageModels.map((m) => m.id), modelLabels(imageModels)),
      selectField('ratio', 'Ratio', MEDIA_ASPECTS),
      selectField('resolution', 'Resolution', MEDIA_RESOLUTIONS, MEDIA_RESOLUTION_LABELS),
    ];
  }
  if (surface === 'video') {
    return [
      stringField('designSystem', 'Design system', 'Design system'),
      selectField('model', 'Model', VIDEO_MODELS.filter((m) => m.id !== 'hyperframes-html').map((m) => m.id), modelLabels(VIDEO_MODELS)),
      selectField('ratio', 'Ratio', MEDIA_ASPECTS),
      selectField('duration', 'Duration', VIDEO_LENGTHS_SEC.map(String), secondsLabels(VIDEO_LENGTHS_SEC)),
      selectField('resolution', 'Resolution', MEDIA_RESOLUTIONS, MEDIA_RESOLUTION_LABELS),
    ];
  }
  return [
    selectField('ratio', 'Ratio', MEDIA_ASPECTS),
    selectField('duration', 'Duration', VIDEO_LENGTHS_SEC.map(String), secondsLabels(VIDEO_LENGTHS_SEC)),
  ];
}

function queryTemplateForSurface(surface: HomeComposerMediaSurface): string {
  // No ratio / duration / model / resolution slots — those are asked for by
  // the agent during the run rather than baked into the prompt body.
  if (surface === 'image') {
    return 'Create a premium product-studio image using {{designSystem}}: elegant composition, refined lighting, restrained color, rich material detail, and commercial campaign-level polish.';
  }
  if (surface === 'video') {
    return 'Create a premium product-studio video using {{designSystem}}: cinematic product pacing, elegant motion, refined lighting, and a polished launch-film feel.';
  }
  return 'Create a premium product-studio HyperFrames video: refined kinetic typography, elegant transitions, restrained motion language, and studio-grade timing.';
}

function defaultInputsForSurface(
  surface: HomeComposerMediaSurface,
  promptTemplates: PromptTemplateSummary[],
): Record<string, unknown> {
  if (surface === 'image') {
    return {
      template: firstTemplateId(surface, promptTemplates),
      designSystem: 'the active project design system',
      model: DEFAULT_IMAGE_MODEL,
      ratio: '16:9',
      resolution: DEFAULT_MEDIA_RESOLUTION,
    };
  }
  if (surface === 'video') {
    return {
      template: firstTemplateId(surface, promptTemplates),
      designSystem: 'the active project design system',
      model: DEFAULT_VIDEO_MODEL === 'hyperframes-html'
        ? VIDEO_MODELS.find((m) => m.id !== 'hyperframes-html')?.id ?? DEFAULT_VIDEO_MODEL
        : DEFAULT_VIDEO_MODEL,
      ratio: '16:9',
      duration: 5,
      resolution: DEFAULT_MEDIA_RESOLUTION,
    };
  }
  return { template: firstTemplateId(surface, promptTemplates), model: 'hyperframes-html', ratio: '16:9', duration: 10 };
}

function stringField(name: string, label: string, placeholder?: string): InputFieldSpec {
  return {
    name,
    label,
    type: 'string',
    ...(placeholder ? { placeholder } : {}),
  };
}

function selectField(
  name: string,
  label: string,
  options: readonly string[],
  optionLabels: Record<string, string> = {},
  placeholder?: string,
): InputFieldSpec {
  return {
    name,
    label,
    type: 'select',
    options: [...options],
    ...(placeholder ? { placeholder } : {}),
    optionLabels,
  };
}

function firstTemplateId(
  surface: HomeComposerMediaSurface,
  promptTemplates: PromptTemplateSummary[],
): string {
  return templatesForHomeMediaSurface(surface, promptTemplates)[0]?.id ?? NO_TEMPLATE_PLACEHOLDER;
}

function validTemplateId(
  surface: HomeComposerMediaSurface,
  rawTemplate: string,
  promptTemplates: PromptTemplateSummary[],
): string {
  const templates = templatesForHomeMediaSurface(surface, promptTemplates);
  if (templates.some((template) => template.id === rawTemplate)) return rawTemplate;
  return templates[0]?.id ?? NO_TEMPLATE_PLACEHOLDER;
}

function isHyperFramesTemplate(template: PromptTemplateSummary): boolean {
  return template.model === 'hyperframes-html' || template.source.repo === 'heygen-com/hyperframes';
}

function modelLabels(models: Array<{ id: string; label: string }>): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const model of models) labels[model.id] = model.label;
  return labels;
}

function secondsLabels(seconds: readonly number[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const value of seconds) labels[String(value)] = `${value}s`;
  return labels;
}

function validOption<T extends string>(
  raw: string,
  options: readonly T[],
  fallback: T,
): T {
  return options.includes(raw as T) ? raw as T : fallback;
}

function validNumber(raw: unknown, options: readonly number[], fallback: number): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  return options.includes(value) ? value : fallback;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}
