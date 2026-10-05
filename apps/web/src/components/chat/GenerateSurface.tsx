/**
 * 内嵌生图 surface —— 项目聊天面板**内**的一块面板,不是工作台、不是弹窗。
 *
 * 由来:`DesignFilesPanel` 工具栏那颗「直接生图」原来把用户 `navigate` 到全局
 * `/generate` 工作台(`specs/current/chat-panel-next.md` 记的 D 系列决策之外,
 * 见 `.agents/tasks/process/2026-10-05-generate-ui-and-chat-entry/task.md`)。
 * 现在入口搬到 composer 侧,点开就在聊天面板里长出来 —— **不复用 `GenerateView`**,
 * 两者零 import、零 CSS 共享(那边的模块另一条工作线在改)。
 *
 * 与工作台的三点差异(刻意的,不是没做完):
 *   · 目标**恒为当前项目**,没有 scratch 档,也就没有「转存到项目」这一步;
 *   · 历史**只覆盖本次会话**——关掉面板就没了;全量历史仍在导航栏「生成」入口;
 *   · 结果四态(运行中 / 失败 / 部分失败 / 成图)都在这块面板里,不注入聊天消息管线
 *     (`specs/current/chat-panel-next.md` 对消息管线有严格规约,生图结果不是消息)。
 *
 * 分层与样式:`components/chat/AGENTS.md` §1 第四步(业务组件平铺在 `chat/` 下)、
 * §2(共置 Module,只消费 `--chat-*`)。纯逻辑在 `runtime/chat/generate-surface.ts`。
 */
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { Button } from '@open-design/components';
import type { PlaygroundGeneration } from '@open-design/contracts';
import { useT } from '../../i18n';
import { Icon } from '../Icon';
import { invalidateProjectFilesCache, projectFileUrl } from '../../providers/registry';
import {
  addReferenceName,
  buildGenerateRequest,
  canSubmitGenerate,
  clampGenerateCount,
  createGenerateDraft,
  draftFromCard,
  failedCard,
  generateErrorMessage,
  GENERATE_ASPECTS,
  GENERATE_QUALITIES,
  removeReferenceAt,
  runningCard,
  settledCard,
  type GenerateDraft,
  type GenerateSessionCard,
} from '../../runtime/chat/generate-surface';
import styles from './GenerateSurface.module.css';

export interface GenerateSurfaceProps {
  /** 当前项目 —— 参考图与产物都落在它下面,没有别的目标可选。 */
  projectId: string;
  /** 收起这块面板(输入框那一侧的状态归宿主)。 */
  onClose: () => void;
}

/** 一次生成请求。落定的一行直接换掉乐观卡;失败按**人话**抛出。 */
async function postGenerate(
  projectId: string,
  draft: GenerateDraft,
  fallbackMessage: string,
): Promise<GenerateSessionCard> {
  const res = await fetch('/api/media/playground/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildGenerateRequest(projectId, draft)),
  });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(generateErrorMessage(payload, fallbackMessage));
  return settledCard(payload as PlaygroundGeneration);
}

/** 参考图上传。带 `targetProjectId`,回来的 `name` 就是可以直接塞进 `images` 的路径。 */
async function uploadReference(
  projectId: string,
  file: File,
  fallbackMessage: string,
): Promise<string> {
  const body = new FormData();
  body.append('file', file);
  body.append('targetProjectId', projectId);
  const res = await fetch('/api/media/playground/uploads', { method: 'POST', body });
  const payload: unknown = await res.json().catch(() => null);
  const name = (payload as { name?: unknown } | null)?.name;
  if (!res.ok || typeof name !== 'string' || !name) {
    throw new Error(generateErrorMessage(payload, fallbackMessage));
  }
  return name;
}

function replaceCard(
  cards: readonly GenerateSessionCard[],
  id: string,
  next: GenerateSessionCard,
): GenerateSessionCard[] {
  return cards.map((card) => (card.id === id ? next : card));
}

/** 产物的可访问地址。目标恒为项目,所以走项目相对 URL(scratch 那一支用不上)。 */
function fileUrl(projectId: string, name: string): string {
  return projectFileUrl(projectId, name, null);
}

function downloadImage(url: string, name: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

/**
 * 本次会话的卡片与提交。
 *
 * 提交**永远是乐观的**:先把用户填的张数铺成一排空格子,POST 回来再原地换成
 * 落定的一行;请求自己失败(断网 / 非 2xx)才把那张乐观卡转成失败态。daemon 的
 * 响应是完整一行,所以「部分失败」不用另开分支 —— 它在 `files[].error` 上。
 */
function useGenerateStudio(projectId: string) {
  const t = useT();
  const [cards, setCards] = useState<GenerateSessionCard[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const seqRef = useRef(0);

  /**
   * 发一发。乐观卡先铺出来,POST 回来原地换掉落定卡,请求自己失败就转成失败态。
   *
   * `replaceId` 是**重试**用的替换目标:给了它就拿乐观卡就地顶掉那张失败卡
   * (卡已经不在了才退回前插),会话面板里因此不留失败残迹、也不堆新卡。
   */
  const submit = async (request: GenerateDraft, replaceId?: string) => {
    if (submitting || !canSubmitGenerate(request)) return;
    const prompt = request.prompt.trim();
    const pendingId = `pending-${seqRef.current++}`;
    const optimistic = runningCard(pendingId, request, prompt);
    setCards((prev) =>
      replaceId && prev.some((card) => card.id === replaceId)
        ? replaceCard(prev, replaceId, optimistic)
        : [optimistic, ...prev],
    );
    setFormError(null);
    setSubmitting(true);
    try {
      const settled = await postGenerate(projectId, request, t('generate.generateFailed'));
      setCards((prev) => replaceCard(prev, pendingId, settled));
      // 产物落在当前项目里 —— 不通知一下,Design Files 要等下次刷新才看得到。
      invalidateProjectFilesCache(projectId);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('generate.generateFailed');
      setCards((prev) => replaceCard(prev, pendingId, failedCard(optimistic, message)));
      setFormError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return { cards, submitting, formError, setFormError, submit };
}

/** `GET /api/media/models` 的图片模型建议。拿不到就不给建议,不编一个默认值出来。 */
function useSuggestedModels(): string[] {
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/media/models')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { image?: Array<{ id?: unknown }> } | null) => {
        if (cancelled || !data || !Array.isArray(data.image)) return;
        const ids = data.image
          .map((model) => model?.id)
          .filter((id): id is string => typeof id === 'string');
        setModels(ids);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return models;
}

export function GenerateSurface({ projectId, onClose }: GenerateSurfaceProps): ReactElement {
  const t = useT();
  const [draft, setDraft] = useState<GenerateDraft>(createGenerateDraft);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const { cards, submitting, formError, setFormError, submit } = useGenerateStudio(projectId);
  const patch = (next: Partial<GenerateDraft>) => setDraft((cur) => ({ ...cur, ...next }));
  const useAsReference = (name: string) =>
    patch({ references: addReferenceName(draft.references, name) });
  // 重试 = 就地替换那张失败卡,不是再追加一发。
  const retry = (card: GenerateSessionCard) =>
    void submit(draftFromCard(card, draft.references), card.id);

  return (
    <section
      className={styles.surface}
      role="region"
      aria-label={t('generate.surfaceTitle')}
      data-testid="chat-generate-surface"
    >
      <SurfaceHead onClose={onClose} />
      <SurfaceForm
        projectId={projectId}
        draft={draft}
        patch={patch}
        submitting={submitting}
        formError={formError}
        onError={setFormError}
        onSubmit={() => void submit(draft)}
      />
      <SurfaceResults
        cards={cards}
        projectId={projectId}
        onPreview={setPreviewUrl}
        onUseAsReference={useAsReference}
        onRetry={retry}
      />
      {previewUrl ? <PreviewStage url={previewUrl} onClose={() => setPreviewUrl(null)} /> : null}
    </section>
  );
}

function SurfaceHead({ onClose }: { onClose: () => void }): ReactElement {
  const t = useT();
  return (
    <header className={styles.head}>
      <span className={styles.headTitle}>
        <Icon name="sparkles" size={14} />
        <span className={styles.headTitleText}>{t('generate.surfaceTitle')}</span>
      </span>
      <Button
        variant="subtle"
        size="icon"
        aria-label={t('generate.surfaceClose')}
        data-testid="chat-generate-close"
        onClick={onClose}
      >
        <Icon name="close" size={14} />
      </Button>
    </header>
  );
}

interface FormProps {
  projectId: string;
  draft: GenerateDraft;
  patch: (next: Partial<GenerateDraft>) => void;
  submitting: boolean;
  formError: string | null;
  onError: (message: string | null) => void;
  onSubmit: () => void;
}

/** 一个参数格:标签 + 控件。四个参数共用同一副骨架。 */
function ParamField({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactElement;
}): ReactElement {
  return (
    <div className={styles.param}>
      <label className={styles.paramLabel} htmlFor={id}>
        {label}
      </label>
      {children}
    </div>
  );
}

/** 图片模型名。建议列表来自 `GET /api/media/models`,拉不到就是空的(不编默认值)。 */
function ModelField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
}): ReactElement {
  const t = useT();
  const models = useSuggestedModels();
  return (
    <ParamField id={id} label={t('generate.modelLabel')}>
      <>
        <input
          id={id}
          className={styles.input}
          data-testid="chat-generate-model"
          list={`${id}-suggestions`}
          value={value}
          placeholder={t('generate.modelDatalistHint')}
          onChange={(event) => onChange(event.target.value)}
        />
        <datalist id={`${id}-suggestions`}>
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      </>
    </ParamField>
  );
}

function AspectField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
}): ReactElement {
  const t = useT();
  return (
    <ParamField id={id} label={t('generate.aspect')}>
      <select
        id={id}
        className={styles.select}
        data-testid="chat-generate-aspect"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {GENERATE_ASPECTS.map((aspect) => (
          <option key={aspect} value={aspect}>
            {aspect}
          </option>
        ))}
      </select>
    </ParamField>
  );
}

function QualityField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
}): ReactElement {
  const t = useT();
  return (
    <ParamField id={id} label={t('generate.quality')}>
      <select
        id={id}
        className={styles.select}
        data-testid="chat-generate-quality"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {GENERATE_QUALITIES.map((quality) => (
          <option key={quality} value={quality}>
            {quality === 'standard' ? t('generate.qualityDefault') : quality}
          </option>
        ))}
      </select>
    </ParamField>
  );
}

/** 张数。输入框随时可能被清空,所以一律过 `clampGenerateCount`。 */
function CountField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: number;
  onChange: (next: number) => void;
}): ReactElement {
  const t = useT();
  return (
    <ParamField id={id} label={t('generate.count')}>
      <input
        id={id}
        className={styles.input}
        data-testid="chat-generate-count"
        type="number"
        min={1}
        max={10}
        value={value}
        onChange={(event) => onChange(clampGenerateCount(Number(event.target.value)))}
      />
    </ParamField>
  );
}

/** 一枚参考图芯片:「×」把它从这一发里摘掉,文件本身留在项目里。 */
function ReferenceChip({
  name,
  onRemove,
}: {
  name: string;
  onRemove: () => void;
}): ReactElement {
  const t = useT();
  return (
    <span className={styles.refChip} title={name}>
      <span className={styles.refName}>{name}</span>
      <Button variant="subtle" size="icon" aria-label={t('generate.removeReference')} onClick={onRemove}>
        <Icon name="close" size={12} />
      </Button>
    </span>
  );
}

function ReferenceRow({
  projectId,
  draft,
  patch,
  onError,
}: {
  projectId: string;
  draft: GenerateDraft;
  patch: (next: Partial<GenerateDraft>) => void;
  onError: (message: string | null) => void;
}): ReactElement {
  const t = useT();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  const pick = async (file: File) => {
    setUploading(true);
    onError(null);
    try {
      const name = await uploadReference(projectId, file, t('generate.uploadFailed'));
      patch({ references: addReferenceName(draft.references, name) });
    } catch (err) {
      onError(err instanceof Error ? err.message : t('generate.uploadFailed'));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className={styles.references}>
      <span className={styles.groupLabel}>{t('generate.references')}</span>
      {draft.references.map((name, index) => (
        <ReferenceChip
          key={`${name}-${index}`}
          name={name}
          onRemove={() => patch({ references: removeReferenceAt(draft.references, index) })}
        />
      ))}
      <input
        ref={fileRef}
        data-testid="chat-generate-reference-input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void pick(file);
          event.target.value = '';
        }}
      />
      <Button
        variant="secondary"
        size="sm"
        data-testid="chat-generate-add-reference"
        disabled={uploading}
        onClick={() => fileRef.current?.click()}
      >
        <Icon name="plus" size={12} />
        {uploading ? t('common.loading') : t('generate.addReference')}
      </Button>
    </div>
  );
}

function SurfaceForm(props: FormProps): ReactElement {
  const t = useT();
  const { projectId, draft, patch, submitting, formError, onError, onSubmit } = props;
  // `useId` 原文带冒号,`list` 的 idref 用它虽然合法,但读起来像选择器;抹掉更稳。
  const uid = `chat-generate-${useId().replace(/:/g, '')}`;

  return (
    <div className={styles.form}>
      <div className={styles.params}>
        <ModelField
          id={`${uid}-model`}
          value={draft.modelOverride}
          onChange={(modelOverride) => patch({ modelOverride })}
        />
        <AspectField
          id={`${uid}-aspect`}
          value={draft.aspect}
          onChange={(aspect) => patch({ aspect })}
        />
        <QualityField
          id={`${uid}-quality`}
          value={draft.quality}
          onChange={(quality) => patch({ quality })}
        />
        <CountField
          id={`${uid}-count`}
          value={draft.count}
          onChange={(count) => patch({ count })}
        />
      </div>

      <ReferenceRow projectId={projectId} draft={draft} patch={patch} onError={onError} />

      <div className={styles.promptRow}>
        <textarea
          className={styles.prompt}
          data-testid="chat-generate-prompt"
          aria-label={t('generate.promptPlaceholder')}
          placeholder={t('generate.promptPlaceholder')}
          value={draft.prompt}
          rows={2}
          onChange={(event) => patch({ prompt: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        <Button
          variant="primary"
          size="sm"
          data-testid="chat-generate-submit"
          disabled={submitting || !canSubmitGenerate(draft)}
          onClick={onSubmit}
        >
          {submitting ? t('generate.generating') : t('generate.generate')}
        </Button>
      </div>

      {formError ? (
        <p className={styles.formError} role="alert" data-testid="chat-generate-error">
          {formError}
        </p>
      ) : null}
    </div>
  );
}

interface ResultsProps {
  cards: readonly GenerateSessionCard[];
  projectId: string;
  onPreview: (url: string) => void;
  onUseAsReference: (name: string) => void;
  onRetry: (card: GenerateSessionCard) => void;
}

function SurfaceResults(props: ResultsProps): ReactElement {
  const t = useT();
  return (
    <div className={styles.results} data-testid="chat-generate-results">
      {props.cards.length === 0 ? (
        <p className={styles.empty} data-testid="chat-generate-empty">
          {t('generate.surfaceEmpty')}
        </p>
      ) : (
        props.cards.map((card) => (
          <ResultCard
            key={card.id}
            card={card}
            projectId={props.projectId}
            onPreview={props.onPreview}
            onUseAsReference={props.onUseAsReference}
            onRetry={props.onRetry}
          />
        ))
      )}
    </div>
  );
}

interface ResultCardProps {
  card: GenerateSessionCard;
  projectId: string;
  onPreview: (url: string) => void;
  onUseAsReference: (name: string) => void;
  onRetry: (card: GenerateSessionCard) => void;
}

function ResultCard(props: ResultCardProps): ReactElement {
  const t = useT();
  const { card } = props;
  const failed = card.status === 'failed';
  return (
    <article className={styles.card} data-testid={`chat-generate-card-${card.id}`}>
      <div className={styles.cardHead}>
        <span className={styles.cardPrompt}>{card.prompt}</span>
        <span className={styles.badges}>
          {card.modelOverride ? <span className={styles.badge}>{card.modelOverride}</span> : null}
          {card.aspect ? <span className={styles.badge}>{card.aspect}</span> : null}
          <span className={styles.badge}>{t('generate.countBadge', { count: card.count })}</span>
          {card.status === 'running' ? (
            <span className={`${styles.badge} ${styles.badgeRunning}`} data-testid="chat-generate-running">
              {t('generate.generating')}
            </span>
          ) : null}
          {failed ? (
            <span className={`${styles.badge} ${styles.badgeFailed}`} data-testid="chat-generate-failed">
              {t('generate.failedSlot')}
            </span>
          ) : null}
        </span>
      </div>
      <ul className={styles.grid}>
        {card.files.map((file, slot) => (
          <ResultSlot
            key={`${card.id}-${slot}`}
            card={card}
            projectId={props.projectId}
            name={file.name}
            error={file.error ?? null}
            slot={slot}
            onPreview={props.onPreview}
            onUseAsReference={props.onUseAsReference}
          />
        ))}
      </ul>
      {failed ? (
        <div className={styles.slotActions}>
          <Button
            variant="secondary"
            size="sm"
            data-testid={`chat-generate-retry-${card.id}`}
            onClick={() => props.onRetry(card)}
          >
            <Icon name="refresh" size={12} />
            {t('generate.retry')}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

interface SlotProps {
  card: GenerateSessionCard;
  projectId: string;
  name: string;
  error: string | null;
  slot: number;
  onPreview: (url: string) => void;
  onUseAsReference: (name: string) => void;
}

function ResultSlot(props: SlotProps): ReactElement {
  const t = useT();
  const { card, name, error } = props;
  if (card.status === 'running') {
    return (
      <li className={styles.slot}>
        <div className={styles.placeholder} data-testid="chat-generate-slot-running">
          <Icon name="sparkles" size={18} />
          <span>{t('generate.generating')}</span>
        </div>
      </li>
    );
  }
  if (error || !name) {
    return (
      <li className={styles.slot}>
        <div className={styles.slotFailed} data-testid="chat-generate-slot-failed">
          <Icon name="alert-triangle" size={18} />
          <span>{error ?? t('generate.failedSlot')}</span>
        </div>
      </li>
    );
  }
  const url = fileUrl(props.projectId, name);
  return (
    <li className={styles.slot}>
      <button
        type="button"
        className={styles.shot}
        aria-label={t('generate.preview')}
        data-testid={`chat-generate-shot-${card.id}-${props.slot}`}
        onClick={() => props.onPreview(url)}
      >
        <img className={styles.shotImg} src={url} alt={card.prompt} loading="lazy" />
      </button>
      <div className={styles.slotActions}>
        <Button
          variant="subtle"
          size="icon"
          aria-label={t('generate.download')}
          data-testid={`chat-generate-download-${card.id}-${props.slot}`}
          onClick={() => downloadImage(url, name)}
        >
          <Icon name="download" size={12} />
        </Button>
        <Button
          variant="subtle"
          size="icon"
          aria-label={t('generate.useAsReference')}
          data-testid={`chat-generate-reference-${card.id}-${props.slot}`}
          onClick={() => props.onUseAsReference(name)}
        >
          <Icon name="image" size={12} />
        </Button>
      </div>
    </li>
  );
}

function PreviewStage({ url, onClose }: { url: string; onClose: () => void }): ReactElement {
  const t = useT();
  return (
    <div className={styles.preview} role="dialog" aria-label={t('generate.preview')}>
      <div className={styles.previewHead}>
        <Button
          variant="subtle"
          size="icon"
          aria-label={t('generate.surfaceClose')}
          data-testid="chat-generate-preview-close"
          onClick={onClose}
        >
          <Icon name="close" size={14} />
        </Button>
      </div>
      <div className={styles.previewStage}>
        <img className={styles.previewImg} src={url} alt={t('generate.preview')} />
      </div>
    </div>
  );
}
