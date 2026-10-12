import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type {
  PlaygroundGeneration,
  PlaygroundGenerateRequest,
  PlaygroundGenerationFile,
  PlaygroundUploadResponse,
  PlaygroundGenerationListResponse,
  PlaygroundTransferResponse,
} from '@open-design/contracts';
import { Button, Input } from '@open-design/components';
import type { MediaProviderCredentials, Project } from '../types';
import { useI18n } from '../i18n';
import { invalidateProjectFilesCache, projectFileUrl } from '../providers/registry';
import { isMediaProviderPickerReady } from '../media/provider-readiness';
import {
  IMAGE_MODELS,
  MEDIA_PROVIDERS,
  findProvider,
  mediaModelProviderId,
} from '../media/models';
import type { MediaProviderId } from '../media/models';
import { CustomSelect } from './CustomSelect';
import type { CustomSelectItem } from './CustomSelect';
import { Icon } from './Icon';
import styles from './GenerateView.module.css';

interface Props {
  initialProjectId?: string;
  projects?: Project[];
  /**
   * Saved media-provider credentials. The image-source dropdown filters
   * entries through `isMediaProviderPickerReady`, so an unconfigured
   * provider shows up disabled instead of dispatchable-and-doomed.
   * Omitted (or undefined) means "credentials not loaded yet" — the
   * readiness helper treats that as ready and every source stays enabled.
   */
  mediaProviders?: Record<string, MediaProviderCredentials>;
}

interface OptimisticCard {
  isOptimistic: true;
  id: string;
  targetProjectId: string | null;
  surface: 'image';
  model: string;
  modelOverride: string | null;
  prompt: string;
  params: { aspect?: string; quality?: string; count?: number };
  status: 'running' | 'failed';
  files: PlaygroundGenerationFile[];
  createdAt: number;
}

type CardItem = PlaygroundGeneration | OptimisticCard;

const MEDIA_ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const;

/** 生图源候选：integrated 且目录里注册过 image 模型的 provider（目录顺序）。 */
const IMAGE_SOURCE_PROVIDERS = MEDIA_PROVIDERS.filter(
  (p) => p.integrated && IMAGE_MODELS.some((m) => m.provider === p.id),
);

/** provider 的默认目录模型 id：default 标记优先，否则目录第一个。 */
function defaultCatalogModelId(providerId: MediaProviderId): string {
  const models = IMAGE_MODELS.filter((m) => m.provider === providerId);
  return models.find((m) => m.default)?.id ?? models[0]?.id ?? '';
}

/**
 * 拉取 provider 的可用模型列表。契约 `200 { ok: true, models: [{ id }] }`；
 * 非 200 / 形状不对按失败处理（与 SettingsDialog 的同名逻辑一致）。
 */
async function fetchProviderModelOptions(providerId: MediaProviderId): Promise<string[]> {
  const res = await fetch(`/api/media/providers/${providerId}/model-options`);
  const payload = (await res.json().catch(() => null)) as
    | { ok?: boolean; models?: Array<{ id?: string }>; error?: string }
    | null;
  if (!res.ok || !payload || payload.ok !== true || !Array.isArray(payload.models)) {
    throw new Error(payload?.error ?? `HTTP ${res.status}`);
  }
  return payload.models
    .filter((m): m is { id: string } => typeof m?.id === 'string' && m.id.length > 0)
    .map((m) => m.id);
}

/**
 * 从错误响应体里读人话。daemon 的信封是 `{ error: { message } }`，但路由 catch
 * 分支会发 `{ error: string }`，断网/代理插入时拿到的是空体或 HTML —— 两种形状
 * 都认，读不出来退回 fallback（与 chat 侧 generate-surface 的同名逻辑一致）。
 */
function apiErrorMessage(payload: unknown, fallback: string): string {
  const error = (payload as { error?: unknown } | null)?.error;
  if (typeof error === 'string' && error.trim()) return error;
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' && message.trim() ? message : fallback;
}

export function GenerateView({ initialProjectId, projects = [], mediaProviders }: Props) {
  const { t } = useI18n();

  // D7: Only list personal/local projects, exclude team workspace projects
  const eligibleProjects = useMemo(
    () => projects.filter((p) => !p.workspaceVisibility || p.workspaceVisibility === 'personal'),
    [projects],
  );

  // Selected target: 'scratch' or a project id
  const [selectedTarget, setSelectedTarget] = useState<string>(() => {
    if (initialProjectId && eligibleProjects.some((p) => p.id === initialProjectId)) {
      return initialProjectId;
    }
    return 'scratch';
  });

  // Controlled sync from route -> selectedTarget (spec C1: single direction, never reverse)
  useEffect(() => {
    if (initialProjectId && eligibleProjects.some((p) => p.id === initialProjectId)) {
      setSelectedTarget(initialProjectId);
    } else if (!initialProjectId) {
      setSelectedTarget('scratch');
    }
  }, [initialProjectId, eligibleProjects]);

  // ── 生图源 / 模型 ──
  // null = 用户尚未手动选择，跟随自动默认（第一个 enabled 的 provider）。
  // mediaProviders 从 undefined 变为已加载时自动默认可重算一次；用户手动切换
  // 后 userPickedSource 落定，不再被重置。
  const [userPickedSource, setUserPickedSource] = useState<MediaProviderId | null>(null);
  const [selectedModel, setSelectedModel] = useState('');

  const sourceOptions = useMemo(
    () =>
      IMAGE_SOURCE_PROVIDERS.map((p) => ({
        provider: p,
        // custom-image 镜像 daemon renderer 的 keyless 语义：永远可选。
        enabled: isMediaProviderPickerReady(p.id, mediaProviders) || p.id === 'custom-image',
      })),
    [mediaProviders],
  );
  const autoSourceId = useMemo(
    () =>
      sourceOptions.find((o) => o.enabled)?.provider.id
      ?? sourceOptions[0]?.provider.id
      ?? 'custom-image',
    [sourceOptions],
  );
  const selectedSource: MediaProviderId = userPickedSource ?? autoSourceId;

  const sourceItems: CustomSelectItem[] = useMemo(
    () =>
      sourceOptions.map(({ provider, enabled }) => ({
        value: provider.id,
        label: enabled ? provider.label : `${provider.label} ${t('generate.sourceUnconfigured')}`,
        disabled: !enabled,
      })),
    [sourceOptions, t],
  );

  const sourceSupportsModelFetch = findProvider(selectedSource)?.supportsModelFetch === true;

  // 按 provider 缓存拉取结果；切换回已拉取的源不重复请求（deps 里的
  // fetchedModelIds 命中即短路）。不做 in-flight ref 拦截：dev 下 StrictMode
  // 双调用 effect，第 1 次的闭包被 cleanup 标记 cancelled 后，ref 拦截会挡住
  // 第 2 次重新发起，200 的响应就此被丢弃且不再有下次——依赖 deps 短路 +
  // cancelled 旗标足够，双请求只在 dev 挂载瞬间发生一次。
  const [fetchedModelIds, setFetchedModelIds] = useState<Partial<Record<MediaProviderId, string[]>>>({});
  const [fetchingModelIds, setFetchingModelIds] = useState<Partial<Record<MediaProviderId, boolean>>>({});

  useEffect(() => {
    if (!sourceSupportsModelFetch) return;
    if (fetchedModelIds[selectedSource]) return;
    let cancelled = false;
    setFetchingModelIds((prev) => ({ ...prev, [selectedSource]: true }));
    fetchProviderModelOptions(selectedSource)
      .then((ids) => {
        if (cancelled) return;
        setFetchedModelIds((prev) => ({ ...prev, [selectedSource]: ids }));
      })
      .catch(() => {
        // 静默回退：失败不缓存、不提示，下拉只保留目录模型；下次切回再试。
      })
      .finally(() => {
        // cancelled 时不抹 loading：本次 fetch 已作废，抹掉会闪掉正在进行的
        // 下一发（StrictMode 第 2 次 / 切源后的重发）的加载态。被作废源的
        // loading 残留为 true 无害——该源的下一次拉取落定时自愈。
        if (!cancelled) {
          setFetchingModelIds((prev) => ({ ...prev, [selectedSource]: false }));
        }
      });
    return () => { cancelled = true; };
  }, [selectedSource, sourceSupportsModelFetch, fetchedModelIds]);

  // 生图源变化时清空模型选择回默认档；复用参数恢复（源+模型同批落位）跳过一次。
  const skipModelResetRef = useRef(false);
  useEffect(() => {
    if (skipModelResetRef.current) {
      skipModelResetRef.current = false;
      return;
    }
    setSelectedModel('');
  }, [selectedSource]);

  const catalogModels = useMemo(
    () => IMAGE_MODELS.filter((m) => m.provider === selectedSource),
    [selectedSource],
  );
  const sourceDefaultModelId = useMemo(() => defaultCatalogModelId(selectedSource), [selectedSource]);
  const configuredSourceModel = mediaProviders?.[selectedSource]?.model?.trim();
  const sourceModelsLoading = fetchingModelIds[selectedSource] === true;

  const modelItems: CustomSelectItem[] = useMemo(() => {
    // 只显示用户配置源实际可拉到的模型（§2026-10-12 修订后续：目录内置
    // id 一律不列——它们只是 daemon 目录的常量，不代表该源真的可调度）。
    // 默认档 = provider 配置里存的模型名；无配置且未拉取到任何模型时，
    // 默认档就是唯一选项（显示当前 provider 配置为空的事实）。
    const items: CustomSelectItem[] = [
      {
        value: '',
        label: configuredSourceModel
          ? `${t('generate.modelDefault')} · ${configuredSourceModel}`
          : t('generate.modelDefaultUnset'),
      },
    ];
    for (const id of fetchedModelIds[selectedSource] ?? []) {
      items.push({ value: id, label: id });
    }
    if (sourceModelsLoading) {
      items.push({ value: '__models-loading__', label: t('generate.modelsLoading'), disabled: true });
    }
    return items;
  }, [configuredSourceModel, fetchedModelIds, selectedSource, sourceModelsLoading, t]);

  /**
   * 提交语义（与 daemon 侧配套）：默认档 → 目录默认 id、无 override；所选名
   * 命中目录 → model = 目录 id；否则 model 兜底目录默认 id、override 带所选名。
   */
  const resolveDispatchModel = useCallback(() => {
    const chosen = selectedModel.trim();
    if (!chosen) return { model: sourceDefaultModelId, modelOverride: null as string | null };
    const catalogHit = catalogModels.some((m) => m.id === chosen) ? chosen : null;
    return { model: catalogHit ?? sourceDefaultModelId, modelOverride: chosen };
  }, [selectedModel, catalogModels, sourceDefaultModelId]);

  // History state
  const [generations, setGenerations] = useState<PlaygroundGeneration[]>([]);
  const [optimisticCards, setOptimisticCards] = useState<OptimisticCard[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Input bar state
  const [prompt, setPrompt] = useState('');
  const [aspect, setAspect] = useState<string>('1:1');
  const [quality, setQuality] = useState<string>('standard');
  const [count, setCount] = useState<number>(1);
  const [referenceChips, setReferenceChips] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);

  // Lightbox preview state
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  // Transfer modal state
  const [transferTargetGenId, setTransferTargetGenId] = useState<string | null>(null);
  const [transferDestinationPid, setTransferDestinationPid] = useState<string>('');
  const [transferring, setTransferring] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Fetch initial history when selectedTarget changes
  useEffect(() => {
    let cancelled = false;
    setLoadingHistory(true);
    fetch(`/api/media/playground/generations?target=${encodeURIComponent(selectedTarget)}&limit=50`)
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((data: PlaygroundGenerationListResponse) => {
        if (cancelled) return;
        setGenerations(data.generations ?? []);
        setNextBefore(data.nextBefore ?? null);
      })
      .catch((err) => console.error('Failed to load generations:', err))
      .finally(() => { if (!cancelled) setLoadingHistory(false); });
    return () => { cancelled = true; };
  }, [selectedTarget]);

  // Load more pages
  const handleLoadMore = useCallback(() => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    fetch(`/api/media/playground/generations?target=${encodeURIComponent(selectedTarget)}&limit=50&before=${encodeURIComponent(nextBefore)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((data: PlaygroundGenerationListResponse) => {
        setGenerations((prev) => [...prev, ...(data.generations ?? [])]);
        setNextBefore(data.nextBefore ?? null);
      })
      .catch((err) => console.error('Failed to load more generations:', err))
      .finally(() => setLoadingMore(false));
  }, [selectedTarget, nextBefore, loadingMore]);

  // File upload to POST /api/media/playground/uploads
  const handleUploadFile = async (file: File) => {
    if (uploadingImage) return;
    setUploadingImage(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (selectedTarget !== 'scratch') formData.append('targetProjectId', selectedTarget);
      const res = await fetch('/api/media/playground/uploads', { method: 'POST', body: formData });
      if (!res.ok) {
        const errorJson = await res.json().catch(() => null);
        throw new Error(apiErrorMessage(errorJson, t('generate.uploadFailed')));
      }
      const data: PlaygroundUploadResponse = await res.json();
      if (data?.name) setReferenceChips((prev) => [...prev, data.name]);
    } catch (err: any) {
      alert(err.message || t('generate.uploadFailed'));
    } finally {
      setUploadingImage(false);
    }
  };

  // Paste / Drop image support
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item && item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (blob) {
          e.preventDefault();
          void handleUploadFile(blob);
          return;
        }
      }
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file && file.type.startsWith('image/')) {
          void handleUploadFile(file);
          return;
        }
      }
    }
  };

  // Generate submit
  const handleGenerate = async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || isSubmitting) return;

    setIsSubmitting(true);
    const targetProjectId = selectedTarget === 'scratch' ? undefined : selectedTarget;
    const optimisticId = `opt-${Date.now()}`;
    const { model: dispatchModel, modelOverride: dispatchOverride } = resolveDispatchModel();

    const optCard: OptimisticCard = {
      isOptimistic: true,
      id: optimisticId,
      targetProjectId: targetProjectId ?? null,
      surface: 'image',
      model: dispatchModel,
      modelOverride: dispatchOverride,
      prompt: trimmedPrompt,
      params: { aspect, quality, count },
      status: 'running',
      files: Array.from({ length: count }, () => ({ name: '' })),
      createdAt: Date.now(),
    };

    setOptimisticCards((prev) => [optCard, ...prev]);

    try {
      const reqBody: PlaygroundGenerateRequest = {
        targetProjectId,
        surface: 'image',
        model: dispatchModel,
        modelOverride: dispatchOverride ?? undefined,
        prompt: trimmedPrompt,
        aspect,
        quality,
        count,
        images: referenceChips.length > 0 ? referenceChips : undefined,
      };

      const res = await fetch('/api/media/playground/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => null);
        throw new Error(apiErrorMessage(errJson, 'Generation failed'));
      }

      const settled: PlaygroundGeneration = await res.json();
      setOptimisticCards((prev) => prev.filter((c) => c.id !== optimisticId));
      setGenerations((prev) => [settled, ...prev]);

      if (settled.targetProjectId) {
        invalidateProjectFilesCache(settled.targetProjectId);
      }
    } catch (err: any) {
      console.error('Generate error:', err);
      setOptimisticCards((prev) =>
        prev.map((c) =>
          c.id === optimisticId
            ? { ...c, status: 'failed', files: [{ name: '', error: err.message || 'Generation failed' }] }
            : c,
        ),
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  // Card action: Reuse prompt & parameters
  const handleReuse = (card: CardItem) => {
    setPrompt(card.prompt);
    // 从目录 id 反查 provider 恢复生图源；模型恢复为 override ?? 目录 id。
    const reuseSource = mediaModelProviderId(card.model);
    if (reuseSource && reuseSource !== selectedSource) {
      skipModelResetRef.current = true;
      setUserPickedSource(reuseSource);
    }
    setSelectedModel(card.modelOverride || card.model);
    if (card.params?.aspect) setAspect(card.params.aspect);
    if (card.params?.quality) setQuality(card.params.quality);
    if (card.params?.count) setCount(card.params.count);
    promptTextareaRef.current?.focus();
  };

  // Card action: Turn generated file into reference chip
  const handleAsReference = (card: CardItem, fileName: string) => {
    if (!fileName) return;
    if (card.targetProjectId !== (selectedTarget === 'scratch' ? null : selectedTarget)) {
      alert(t('generate.crossTargetRefNotice'));
    }
    setReferenceChips((prev) => (prev.includes(fileName) ? prev : [...prev, fileName]));
  };

  // Resolve media URL for a slot
  const getFileUrl = (card: CardItem, file: PlaygroundGenerationFile, slotIndex: number): string => {
    if (card.targetProjectId === null) {
      return `/api/media/playground/files/${encodeURIComponent(card.id)}/${slotIndex}`;
    }
    return projectFileUrl(card.targetProjectId, file.name, null);
  };

  // Card action: Download image
  const handleDownload = (card: CardItem, file: PlaygroundGenerationFile, slotIndex: number) => {
    const url = getFileUrl(card, file, slotIndex);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name || `image-${card.id}-${slotIndex + 1}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // Card action: Delete generation
  const handleDelete = async (card: CardItem) => {
    if ('isOptimistic' in card) {
      setOptimisticCards((prev) => prev.filter((c) => c.id !== card.id));
      return;
    }
    if (!confirm(t('generate.deleteConfirm'))) return;

    try {
      const res = await fetch(`/api/media/playground/generations/${encodeURIComponent(card.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const errJson = await res.json().catch(() => null);
        if (res.status === 409) {
          alert(t('generate.deleteRunningError'));
          return;
        }
        throw new Error(apiErrorMessage(errJson, 'Delete failed'));
      }
      setGenerations((prev) => prev.filter((g) => g.id !== card.id));
    } catch (err: any) {
      alert(err.message || 'Delete failed');
    }
  };

  // Card action: Open transfer modal
  const handleOpenTransfer = (card: PlaygroundGeneration) => {
    setTransferTargetGenId(card.id);
    if (eligibleProjects.length > 0 && eligibleProjects[0]) {
      setTransferDestinationPid(eligibleProjects[0].id);
    }
  };

  // Execute transfer scratch -> project
  const handleExecuteTransfer = async () => {
    if (!transferTargetGenId || !transferDestinationPid || transferring) return;
    setTransferring(true);
    try {
      const res = await fetch(`/api/media/playground/generations/${encodeURIComponent(transferTargetGenId)}/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: transferDestinationPid }),
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => null);
        throw new Error(apiErrorMessage(errJson, t('generate.transferFailed')));
      }
      const data: PlaygroundTransferResponse = await res.json();
      invalidateProjectFilesCache(transferDestinationPid);

      setGenerations((prev) =>
        prev.map((g) => {
          if (g.id !== transferTargetGenId) return g;
          const currentTransfers = g.params?.transfers ?? [];
          const exists = currentTransfers.some((tr) => tr.projectId === transferDestinationPid);
          const nextTransfers = exists
            ? currentTransfers
            : [...currentTransfers, { projectId: transferDestinationPid, files: data.transferredFiles }];
          return { ...g, params: { ...g.params, transfers: nextTransfers } };
        }),
      );
      setTransferTargetGenId(null);
    } catch (err: any) {
      alert(err.message || t('generate.transferFailed'));
    } finally {
      setTransferring(false);
    }
  };

  // Combine optimistic cards and server generations
  const allCards: CardItem[] = [...optimisticCards, ...generations];

  // Top-bar target dropdown options
  const targetItems: CustomSelectItem[] = useMemo(
    () => [
      { value: 'scratch', label: t('generate.targetScratch') },
      ...eligibleProjects.map((p) => ({
        value: p.id,
        label: t('generate.targetProject', { name: p.name || p.id }),
      })),
    ],
    [eligibleProjects, t],
  );

  return (
    <div className={styles.generateView} data-testid="generate-view" onPaste={handlePaste} onDrop={handleDrop}>
      {/* Top Bar */}
      <header className={styles.topBar}>
        <div className={styles.targetSelector}>
          <div className={styles.targetIconBadge}><Icon name="folder" size={14} /></div>
          <span className={styles.targetLabel}>{t('generate.target')}</span>
          <CustomSelect
            className={styles.targetSelect}
            value={selectedTarget}
            options={targetItems}
            onChange={setSelectedTarget}
            ariaLabel={t('generate.target')}
          />
        </div>

        <div className={styles.topBarMeta}>
          <span className={styles.historyCount}>{t('generate.historyCount', { count: allCards.length })}</span>
        </div>
      </header>

      {/* Card Stream */}
      <main className={styles.cardStream}>
        {loadingHistory ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyIconBadge}><Icon name="sparkles" size={24} /></div>
            <div className={styles.emptyDesc}>{t('common.loading')}</div>
          </div>
        ) : allCards.length === 0 ? (
          <div className={styles.emptyState} data-testid="generate-empty-state">
            <div className={styles.emptyFrame}>
              <div className={styles.emptyIconBadge}><Icon name="sparkles" size={28} /></div>
              <div className={styles.emptyTitle}>{t('generate.emptyTitle')}</div>
              <div className={styles.emptyDesc}>{t('generate.emptyDesc')}</div>
            </div>
          </div>
        ) : (
          allCards.map((card) => {
            const isOpt = 'isOptimistic' in card;
            const isRunning = card.status === 'running';
            const isFailed = card.status === 'failed';
            const files = card.files || [];
            const isScratch = card.targetProjectId === null;
            const isSingle = files.length === 1;
            const aspectStyle = card.params?.aspect ? { aspectRatio: card.params.aspect.replace(':', ' / ') } : undefined;
            // 徽标优先显示实际模型名（override），否则目录 id。
            const modelBadge = card.modelOverride || card.model;

            return (
              <article key={card.id} className={styles.card} data-testid={`generate-card-${card.id}`}>
                {/* Header */}
                <div className={styles.cardHeader}>
                  <div className={styles.cardPromptBox}>
                    <p className={styles.cardPrompt}>{card.prompt}</p>
                  </div>
                  <div className={styles.cardMeta}>
                    {modelBadge && <span className={styles.badge} title={modelBadge}>{modelBadge}</span>}
                    {card.params?.aspect && <span className={styles.badge}><Icon name="crop" size={10} /><span>{card.params.aspect}</span></span>}
                    {card.params?.quality && <span className={styles.badge}><span>{card.params.quality}</span></span>}
                    {isRunning && <span className={`${styles.badge} ${styles.badgeRunning}`}><span className={styles.pulseDot} /><span>{t('generate.generating')}</span></span>}
                    {isFailed && <span className={`${styles.badge} ${styles.badgeFailed}`}><Icon name="alert-triangle" size={10} /><span>{t('generate.failedSlot')}</span></span>}
                  </div>
                </div>

                {/* Media gallery grid */}
                <div className={isSingle ? `${styles.cardGrid} ${styles.cardGridSingle}` : styles.cardGrid}>
                  {files.map((file, slotIdx) => {
                    if (isRunning) {
                      return (
                        <div key={slotIdx} className={styles.slotWrapper} style={aspectStyle}>
                          <div className={styles.slotRunning}>
                            <div className={styles.runningAperture}><div className={styles.runningRings} /><Icon name="sparkles" size={20} className={styles.runningIcon} /></div>
                            <div className={styles.runningMeta}><span className={styles.runningTitle}>{t('generate.generating')}</span><div className={styles.runningPulseBar} /></div>
                          </div>
                        </div>
                      );
                    }

                    if (file.error) {
                      return (
                        <div key={slotIdx} className={styles.slotWrapper} style={aspectStyle}>
                          <div className={styles.slotFailed}><Icon name="alert-triangle" size={24} /><span>{file.error}</span></div>
                        </div>
                      );
                    }

                    const url = getFileUrl(card, file, slotIdx);
                    return (
                      <div key={slotIdx} className={styles.slotWrapper} style={aspectStyle}>
                        <img src={url} alt={card.prompt} className={styles.slotImg} onClick={() => setPreviewSrc(url)} loading="lazy" />
                        <button type="button" className={styles.slotPreviewBtn} onClick={() => setPreviewSrc(url)} aria-label={t('generate.preview')} title={t('generate.preview')}>
                          <Icon name="eye" size={13} />
                        </button>
                      </div>
                    );
                  })}
                </div>

                {/* Card actions */}
                <div className={styles.cardActions}>
                  <div className={styles.actionGroup}>
                    <Button variant="secondary" size="sm" onClick={() => handleReuse(card)} title={t('generate.reuse')}>
                      <Icon name="refresh" size={12} /><span>{t('generate.reuse')}</span>
                    </Button>

                    {files.map((file, slotIdx) => {
                      if (!file.name || file.error) return null;
                      return (
                        <React.Fragment key={slotIdx}>
                          <Button variant="secondary" size="sm" onClick={() => handleAsReference(card, file.name)} title={t('generate.useAsReference')}>
                            <Icon name="image" size={12} />
                            <span>{files.length > 1 ? `${t('generate.useAsReference')} #${slotIdx + 1}` : t('generate.useAsReference')}</span>
                          </Button>
                          <Button variant="secondary" size="sm" onClick={() => handleDownload(card, file, slotIdx)} title={t('generate.download')}>
                            <Icon name="download" size={12} />
                            <span>{files.length > 1 ? `${t('generate.download')} #${slotIdx + 1}` : t('generate.download')}</span>
                          </Button>
                        </React.Fragment>
                      );
                    })}

                    {isScratch && !isOpt && !isRunning && !isFailed && (
                      <Button variant="secondary" size="sm" onClick={() => handleOpenTransfer(card as PlaygroundGeneration)} title={t('generate.transfer')}>
                        <Icon name="folder-transfer" size={12} /><span>{t('generate.transfer')}</span>
                      </Button>
                    )}
                  </div>

                  <div className={styles.actionGroup}>
                    <Button variant="secondary" size="sm" className={styles.btnDanger} onClick={() => handleDelete(card)} disabled={isRunning} title={t('generate.delete')}>
                      <Icon name="close" size={12} /><span>{t('generate.delete')}</span>
                    </Button>
                  </div>
                </div>
              </article>
            );
          })
        )}

        {nextBefore && (
          <Button variant="secondary" size="sm" className={styles.loadMore} onClick={handleLoadMore} disabled={loadingMore}>
            <Icon name="chevron-down" size={13} /><span>{loadingMore ? t('common.loading') : t('generate.loadMore')}</span>
          </Button>
        )}
      </main>

      {/* Bottom studio console input */}
      <footer className={styles.inputBar}>
        <div className={styles.composerConsole}>
          {referenceChips.length > 0 && (
            <div className={styles.referenceChips}>
              {referenceChips.map((chip, idx) => (
                <div key={idx} className={styles.refChip} title={chip}>
                  <Icon name="image" size={12} /><span className={styles.refChipName}>{chip}</span>
                  <button type="button" className={styles.refChipRemove} onClick={() => setReferenceChips((prev) => prev.filter((_, i) => i !== idx))} aria-label={t('generate.removeReference')}>
                    <Icon name="close" size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div
            className={styles.promptRow}
            onClick={() => promptTextareaRef.current?.focus()}
          >
            <textarea
              ref={promptTextareaRef}
              className={styles.promptTextarea}
              placeholder={t('generate.promptPlaceholder')}
              aria-label={t('generate.promptPlaceholder')}
              data-testid="generate-prompt-input"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={2}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void handleGenerate();
                }
              }}
            />
          </div>

          <div className={styles.composerToolbar}>
            <div className={styles.paramGroup}>
              <input
                type="file"
                ref={fileInputRef}
                className={styles.fileInputHidden}
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleUploadFile(file);
                  e.target.value = '';
                }}
              />
              <Button
                variant="secondary"
                size="sm"
                className={styles.attachBtn}
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingImage}
                title={t('generate.addReference')}
                aria-label={t('generate.addReference')}
              >
                <Icon name="attach" size={13} />
              </Button>

              <span className={styles.toolbarDivider} />

              <div className={styles.paramItem}>
                <span className={styles.paramLabel}>{t('generate.sourceLabel')}</span>
                <CustomSelect
                  className={styles.sourceSelect}
                  value={selectedSource}
                  options={sourceItems}
                  onChange={(v) => setUserPickedSource(v as MediaProviderId)}
                  ariaLabel={t('generate.sourceLabel')}
                />
              </div>

              <div className={`${styles.paramItem} ${styles.paramItemModel}`}>
                <span className={styles.paramLabel}>{t('generate.modelLabel')}</span>
                <CustomSelect
                  value={selectedModel}
                  options={modelItems}
                  onChange={setSelectedModel}
                  ariaLabel={t('generate.modelLabel')}
                />
              </div>

              <div className={styles.paramItem}>
                <span className={styles.paramLabel}>{t('generate.aspect')}</span>
                <CustomSelect
                  className={styles.aspectSelect}
                  value={aspect}
                  options={MEDIA_ASPECTS.map((asp) => ({ value: asp, label: asp }))}
                  onChange={setAspect}
                  ariaLabel={t('generate.aspect')}
                />
              </div>

              <div className={styles.paramItem}>
                <span className={styles.paramLabel}>{t('generate.quality')}</span>
                <CustomSelect
                  className={styles.qualitySelect}
                  value={quality}
                  options={[
                    { value: 'standard', label: t('generate.qualityDefault') },
                    { value: 'high', label: 'High' },
                  ]}
                  onChange={setQuality}
                  ariaLabel={t('generate.quality')}
                />
              </div>

              <div className={styles.paramItem}>
                <label htmlFor="gen-count" className={styles.paramLabel}>{t('generate.count')}</label>
                <Input
                  id="gen-count"
                  type="number"
                  min={1}
                  max={10}
                  className={`${styles.paramInput} ${styles.paramInputCount}`}
                  value={count}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val)) setCount(Math.max(1, Math.min(10, val)));
                  }}
                />
              </div>
            </div>

            <div className={styles.submitGroup}>
              <span className={styles.shortcutKbd} title="Command / Ctrl + Enter">
                <kbd className={styles.kbdKey}>⌘</kbd><kbd className={styles.kbdKey}>↵</kbd>
              </span>
              <Button
                variant="primary"
                size="sm"
                disabled={isSubmitting || !prompt.trim()}
                onClick={() => void handleGenerate()}
                data-testid="generate-submit-button"
              >
                <Icon name="sparkles" size={14} /><span>{isSubmitting ? t('generate.generating') : t('generate.generate')}</span>
              </Button>
            </div>
          </div>
        </div>
      </footer>

      {/* Lightbox Modal */}
      {previewSrc && (
        <div className={styles.lightbox} role="dialog" aria-modal="true" onClick={() => setPreviewSrc(null)}>
          <Button
            variant="subtle"
            size="icon"
            className={styles.lightboxClose}
            onClick={() => setPreviewSrc(null)}
            aria-label={t('common.close')}
          >
            <Icon name="close" size={20} />
          </Button>
          <div className={styles.lightboxStage} onClick={(e) => e.stopPropagation()}>
            <img src={previewSrc} alt="Preview" className={styles.lightboxImg} />
          </div>
        </div>
      )}

      {/* Transfer Scratch -> Project Modal */}
      {transferTargetGenId && (
        <div className={styles.transferDialogBackdrop} onClick={() => !transferring && setTransferTargetGenId(null)}>
          <div className={styles.transferDialog} onClick={(e) => e.stopPropagation()}>
            <div className={styles.transferTitle}>{t('generate.transfer')}</div>
            <div className={styles.transferField}>
              <span className={styles.transferLabel}>{t('generate.transferSelectProject')}</span>
              <CustomSelect
                value={transferDestinationPid}
                options={eligibleProjects.map((p) => ({ value: p.id, label: p.name || p.id }))}
                onChange={setTransferDestinationPid}
                ariaLabel={t('generate.transferSelectProject')}
                disabled={transferring}
              />
            </div>
            <div className={styles.transferActions}>
              <Button variant="secondary" size="sm" onClick={() => setTransferTargetGenId(null)} disabled={transferring}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleExecuteTransfer()}
                disabled={transferring || !transferDestinationPid}
              >
                {transferring ? t('common.loading') : t('generate.transfer')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
