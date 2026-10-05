/**
 * 内嵌生图 surface 的纯领域逻辑(无 JSX、无 DOM、无 fetch)。
 *
 * 分层判据见 `components/chat/AGENTS.md` §1 第三步:表单怎么变成请求体、一张
 * 结果卡从哪来、失败怎么读 —— 这些都能纯函数测,所以它们在这里,组件只负责画。
 *
 * 目标(reference / 产物落地)永远是**当前项目**:工作台的 scratch 档不在这一层
 * 出现,所以 `targetProjectId` 是入参而不是可选项。`surface` 恒为 `'image'`。
 */
import type {
  PlaygroundGenerateRequest,
  PlaygroundGeneration,
  PlaygroundGenerationFile,
} from '@open-design/contracts';

/** 比例档位。与工作台同一组取值(设计稿给的就是这五档)。 */
export const GENERATE_ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const;

/** 质量档位。`standard` 是默认档,`high` 只在用户显式挑时出现。 */
export const GENERATE_QUALITIES = ['standard', 'high'] as const;

/*
 * 两个默认档单独立成常量,不写 `GENERATE_ASPECTS[0]`:`noUncheckedIndexedAccess`
 * 会把下标读出来的类型补上 `undefined`,而 draft 上这两个字段是 `string`。
 */
export const GENERATE_DEFAULT_ASPECT = '1:1';
export const GENERATE_DEFAULT_QUALITY = 'standard';

/** 张数的上下限。与工作台一致 —— daemon 的 `clampMediaGenerateCount` 是同一档。 */
export const GENERATE_COUNT_MIN = 1;
export const GENERATE_COUNT_MAX = 10;

/**
 * v1 只认这一个目录 id(`PlaygroundGenerateRequest.model` 是**目录 id**,
 * 不是 wire 模型名)。真正的模型名走 `modelOverride`。
 */
export const GENERATE_MODEL_ID = 'custom-image';

/** 用户正在填的那份表单。 */
export interface GenerateDraft {
  prompt: string;
  /** wire 模型名;留空 = 用 daemon 侧配置的默认。 */
  modelOverride: string;
  aspect: string;
  quality: string;
  count: number;
  /** 目标基目录下的相对路径(项目内相对路径)。 */
  references: readonly string[];
}

/** 一张结果卡。`running` 是**乐观**卡:POST 还没回来时的占位。 */
export interface GenerateSessionCard {
  id: string;
  prompt: string;
  modelOverride: string | null;
  aspect: string;
  quality: string;
  count: number;
  status: 'running' | 'done' | 'failed';
  files: readonly PlaygroundGenerationFile[];
  /** 整批失败的原因;槽位级失败在 `files[].error` 上。 */
  error: string | null;
}

/** 每次打开 surface 都从这一份开始,不跨会话留残留。 */
export function createGenerateDraft(): GenerateDraft {
  return {
    prompt: '',
    modelOverride: '',
    aspect: GENERATE_DEFAULT_ASPECT,
    quality: GENERATE_DEFAULT_QUALITY,
    count: 1,
    references: [],
  };
}

/** 张数夹进 `[1, 10]`。非有限值(输入框被清空时算出来的 `NaN`)退回下限。 */
export function clampGenerateCount(value: number): number {
  if (!Number.isFinite(value)) return GENERATE_COUNT_MIN;
  return Math.min(GENERATE_COUNT_MAX, Math.max(GENERATE_COUNT_MIN, Math.trunc(value)));
}

/** 挂一张参考图。已经在列表里的不再重复挂(同一份文件传两次不该出两枚芯片)。 */
export function addReferenceName(references: readonly string[], name: string): string[] {
  if (!name || references.includes(name)) return [...references];
  return [...references, name];
}

/** 摘掉第 `index` 枚参考图。越界时原样返回。 */
export function removeReferenceAt(references: readonly string[], index: number): string[] {
  if (index < 0 || index >= references.length) return [...references];
  return references.filter((_, at) => at !== index);
}

/** 只有正文非空才发得出去(空白不算)。 */
export function canSubmitGenerate(draft: GenerateDraft): boolean {
  return draft.prompt.trim().length > 0;
}

/**
 * 表单 → 请求体。
 *
 * 三条「空就不发」的字段一起写在这里:`modelOverride` 留空等于不覆盖、参考图为空
 * 等于不带图、`targetProjectId` 恒为当前项目。散在组件里写就会三处各判一次,
 * 早晚分叉。
 */
export function buildGenerateRequest(
  projectId: string,
  draft: GenerateDraft,
): PlaygroundGenerateRequest {
  const modelOverride = draft.modelOverride.trim();
  const references = draft.references.filter((name) => name.trim().length > 0);
  return {
    targetProjectId: projectId,
    surface: 'image',
    model: GENERATE_MODEL_ID,
    ...(modelOverride ? { modelOverride } : {}),
    prompt: draft.prompt.trim(),
    aspect: draft.aspect,
    quality: draft.quality,
    count: clampGenerateCount(draft.count),
    ...(references.length > 0 ? { images: references } : {}),
  };
}

/** POST 还没回来的那张乐观卡:先按用户填的张数铺出等量的空格子。 */
export function runningCard(
  id: string,
  draft: GenerateDraft,
  prompt: string,
): GenerateSessionCard {
  const count = clampGenerateCount(draft.count);
  const modelOverride = draft.modelOverride.trim();
  return {
    id,
    prompt,
    modelOverride: modelOverride || null,
    aspect: draft.aspect,
    quality: draft.quality,
    count,
    status: 'running',
    files: Array.from({ length: count }, () => ({ name: '' })),
    error: null,
  };
}

/** 落定的那张卡。daemon 的响应**永远是完整一行**(全失败也 200),所以直接换掉乐观卡。 */
export function settledCard(generation: PlaygroundGeneration): GenerateSessionCard {
  return {
    id: generation.id,
    prompt: generation.prompt,
    modelOverride: generation.modelOverride ?? null,
    aspect: generation.params?.aspect ?? '',
    quality: generation.params?.quality ?? '',
    count: generation.params?.count ?? generation.files.length,
    status: generation.status,
    files: generation.files ?? [],
    error: generation.error ?? null,
  };
}

/**
 * 失败卡重试时,把卡上的参数原样搬回一份 draft(正文与参数都用**当时那一发**的,
 * 不是用户此刻在表单里改到一半的值)。参考图沿用调用方当前挂着的那一份。
 */
export function draftFromCard(
  card: GenerateSessionCard,
  references: readonly string[],
): GenerateDraft {
  return {
    prompt: card.prompt,
    modelOverride: card.modelOverride ?? '',
    aspect: card.aspect || GENERATE_DEFAULT_ASPECT,
    quality: card.quality || GENERATE_DEFAULT_QUALITY,
    count: clampGenerateCount(card.count),
    references: [...references],
  };
}

/** 请求本身失败(网络断、非 2xx)时,把乐观卡原地转成失败卡。 */
export function failedCard(card: GenerateSessionCard, message: string): GenerateSessionCard {
  return {
    ...card,
    status: 'failed',
    files: [{ name: '', error: message }],
    error: message,
  };
}

/**
 * 从错误响应里读人话。
 *
 * daemon 的错误信封是 `{ error: { message } }`,但断网 / 代理插进来时拿到的是
 * HTML 或空体 —— 那时候不能把 `undefined` 摆到界面上,退回调用方给的兜底句。
 */
export function generateErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === 'string' && error.trim()) return error;
    if (error && typeof error === 'object' && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) return message;
    }
  }
  return fallback;
}
