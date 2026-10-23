import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
} from 'react';
import type {
  PlaygroundGeneration,
  PlaygroundGenerateRequest,
  PlaygroundGenerationFile,
  PlaygroundGenerationParams,
  PlaygroundUploadResponse,
  PlaygroundGenerationListResponse,
  PlaygroundTransferResponse,
  PlaygroundBatchDeleteRequest,
  PlaygroundBatchDeleteResponse,
} from '@open-design/contracts';
import {
  gptImageQualityFor,
  nanoBananaAspectRatioFor,
  nanoBananaImageSizeFor,
} from '@open-design/contracts';
import { Button } from '@open-design/components';
import type { MediaProviderCredentials, Project } from '../types';
import { useI18n } from '../i18n';
import { invalidateProjectFilesCache, projectFileUrl } from '../providers/registry';
import { isMediaProviderPickerReady } from '../media/provider-readiness';
import {
  IMAGE_MODELS,
  MEDIA_ASPECTS,
  MEDIA_PROVIDERS,
  findProvider,
  mediaModelProviderId,
} from '../media/models';
import type { MediaProviderId } from '../media/models';
import { CustomSelect } from './CustomSelect';
import type { CustomSelectItem } from './CustomSelect';
import { Icon } from './Icon';
import { GenerateToolbarParams } from './GenerateToolbarParams';
import { GenerateCard, type CardItem, type OptimisticCard } from './GenerateCard';
import { GenerateHistoryGrid } from './GenerateHistoryGrid';
import { GenerateHistoryList } from './GenerateHistoryList';
import {
  GENERATE_VIEW_STORAGE_KEY,
  getSelectableIds,
  isAllSelected,
  toggleSelectAll,
  toggleSelection,
  type GenerateViewMode,
} from './generate-history-selection';
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

/**
 * 提交侧的质量词汇收口（openai 源）。与 daemon 侧 `gptImageQualityFor` 是同一条
 * 规则的两侧实现（contracts 里那份的 doc 注释写明了为什么必须同步）。
 *
 * 工作台只发 `GPT_IMAGE_QUALITIES` 里的档位：`'auto'` 与缺省一律不发字段，让模型
 * 用自己的默认档；表外的值（旧存量卡上的 `'standard'` 是 dall-e 时代的词汇）同样
 * 按「用户没要求」处理 —— 原样转发上游只会回 400。
 *
 * 回填侧（`handleReuse`）刻意不做收口：卡片照原样显示当时那一发用了什么，收口只发生在
 * 真正发请求的这一处，于是「切模型后旧值残留」也一并被挡住。
 */
function submitQualityFor(catalogModel: string, quality: string): string | undefined {
  return gptImageQualityFor(catalogModel, quality);
}

/**
 * 非 openai / nanobanana 源（如 grok）的 aspect 收口：只发该源真正认得的 5 档。
 *
 * `'auto'` 是工作台的档位（「让模型自己决定」），grok 并没有这个概念，
 * 原样发过去就是一个上游 400。缺省时不发字段，由 daemon 落各自的默认比例。
 */
function submitAspectForNonOpenAI(aspect: string): string | undefined {
  return (MEDIA_ASPECTS as readonly string[]).includes(aspect) ? aspect : undefined;
}

/** 不同生图源的初始/重置比例：openai 与 nanobanana 默认为 'auto'，其余源为 '1:1'。 */
function defaultAspectForSource(source: MediaProviderId): string {
  return source === 'openai' || source === 'nanobanana' ? 'auto' : '1:1';
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
  // 后 userPickedSource 落地，不再被重置。
  const [userPickedSource, setUserPickedSource] = useState<MediaProviderId | null>(null);
  const [userPickedModel, setUserPickedModel] = useState<string | null>(null);

  const sourceOptions = useMemo(
    () =>
      IMAGE_SOURCE_PROVIDERS.map((p) => ({
        provider: p,
        // 已移除 custom-image 特判，完全基于 provider 准备度
        enabled: isMediaProviderPickerReady(p.id, mediaProviders),
      })),
    [mediaProviders],
  );
  const autoSourceId = useMemo(
    () =>
      sourceOptions.find((o) => o.enabled)?.provider.id
      ?? sourceOptions[0]?.provider.id
      ?? 'openai',
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
  // fetchedModelIds 命中即短路）。依赖 deps 短路 + cancelled 旗标。
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
        if (!cancelled) {
          setFetchingModelIds((prev) => ({ ...prev, [selectedSource]: false }));
        }
      });
    return () => { cancelled = true; };
  }, [selectedSource, sourceSupportsModelFetch, fetchedModelIds]);

  // 生图源变化时清空模型选择回默认档、并把参数复位到该源的默认档；复用参数恢复
  // （源+模型同批落位，`handleReuse` 自己把参数摆好）跳过一次。
  const skipModelResetRef = useRef(false);

  /**
   * 参数复位：只留下目标源真正消费的参数。
   *
   * 单独成函数是因为它有两个调用方：用户手动切源（`handleSourceChange`），以及
   * **源自己变了**——`mediaProviders` 从 undefined 变成已加载时 `autoSourceId` 会重算，
   * 那一刻没有任何点击发生。只在手动路径复位的话，后一条路径会把上一个源的档位
   * （例如 openai 的 `'auto'` 比例）原样带到新源上。
   */
  const resetParamsForSource = useCallback((source: MediaProviderId) => {
    setAspect(defaultAspectForSource(source));
    setResolution('auto');
    setQuality('auto');
    setModeration('auto');
    setTransparent(false);
  }, []);

  // 切换生图源时重置不适用参数
  const handleSourceChange = useCallback((newSource: MediaProviderId) => {
    setUserPickedSource(newSource);
    resetParamsForSource(newSource);
  }, [resetParamsForSource]);

  useEffect(() => {
    if (skipModelResetRef.current) {
      skipModelResetRef.current = false;
      return;
    }
    setUserPickedModel(null);
    resetParamsForSource(selectedSource);
  }, [selectedSource, resetParamsForSource]);

  const catalogModels = useMemo(
    () => IMAGE_MODELS.filter((m) => m.provider === selectedSource),
    [selectedSource],
  );
  const sourceDefaultModelId = useMemo(() => defaultCatalogModelId(selectedSource), [selectedSource]);
  const configuredSourceModel = mediaProviders?.[selectedSource]?.model?.trim();
  const sourceModelsLoading = fetchingModelIds[selectedSource] === true;

  const autoModelId = useMemo(() => {
    if (configuredSourceModel) return configuredSourceModel;
    const fetched = fetchedModelIds[selectedSource];
    if (fetched && fetched.length > 0) {
      return fetched.includes(sourceDefaultModelId) ? sourceDefaultModelId : fetched[0]!;
    }
    return sourceDefaultModelId;
  }, [configuredSourceModel, fetchedModelIds, selectedSource, sourceDefaultModelId]);

  const selectedModel = userPickedModel ?? autoModelId;

  /**
   * 模型下拉列表：
   * - 下拉展示具体模型（拉取模型非空优先，若拉取中/失败/不支持，回退到目录预置模型）；
   * - 若 provider 配置了自定义默认模型且不在基底中，单独置于首位去重展示；
   * - 目录命中时显示目录友好 label（如 nanobanana 显示 'nano-banana-2'），拉取真实 id 显示 id；
   * - 不再包含任何 value 为 '' 的伪条目（'' 语义消失）。
   */
  const modelItems: CustomSelectItem[] = useMemo(() => {
    const fetched = fetchedModelIds[selectedSource];
    const baseIds = fetched && fetched.length > 0
      ? fetched
      : catalogModels.map((m) => m.id);

    const ids = [...baseIds];
    if (configuredSourceModel && !ids.includes(configuredSourceModel)) {
      ids.unshift(configuredSourceModel);
    }

    const items: CustomSelectItem[] = ids.map((id) => {
      const hit = catalogModels.find((m) => m.id === id);
      return {
        value: id,
        label: hit ? hit.label : id,
      };
    });

    if (sourceModelsLoading) {
      items.push({ value: '__models-loading__', label: t('generate.modelsLoading'), disabled: true });
    }
    return items;
  }, [catalogModels, configuredSourceModel, fetchedModelIds, selectedSource, sourceModelsLoading, t]);

  /**
   * 提交语义（与 daemon 侧配套）：默认档 → 目录默认 id、无 override；所选名
   * 命中目录 → model = 目录 id；否则 model 兜底目录默认 id、override 带所选名。
   *
   * 算成 memo 而不是函数：`model`（目录 id）同时是工具栏的能力判据与尺寸预览的
   * 输入 —— 两边必须是同一个值，否则 UI 显示的档位和真正发出去的那一发会分叉。
   */
  const dispatch = useMemo(() => {
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
  // openai 与 nanobanana 默认 'auto'，其他源默认 '1:1'
  const [aspect, setAspect] = useState<string>(defaultAspectForSource(selectedSource));
  const [resolution, setResolution] = useState<string>('auto');
  const [quality, setQuality] = useState<string>('auto');
  const [moderation, setModeration] = useState<string>('auto');
  const [transparent, setTransparent] = useState<boolean>(false);
  const [count, setCount] = useState<number>(1);
  const [referenceChips, setReferenceChips] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);

  // View mode state with localStorage persistence
  const [viewMode, setViewMode] = useState<GenerateViewMode>(() => {
    if (typeof window === 'undefined') return 'stream';
    try {
      const stored = window.localStorage.getItem(GENERATE_VIEW_STORAGE_KEY);
      return stored === 'stream' || stored === 'grid' || stored === 'list' ? stored : 'stream';
    } catch {
      return 'stream';
    }
  });

  const handleSetViewMode = useCallback((mode: GenerateViewMode) => {
    setViewMode(mode);
    try {
      window.localStorage.setItem(GENERATE_VIEW_STORAGE_KEY, mode);
    } catch {
      // ignore storage quota error
    }
  }, []);

  // Selection & batch delete state
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);

  // Clear selection on target switch
  useEffect(() => {
    setSelected(new Set());
    setSelectMode(false);
  }, [selectedTarget]);

  // Lightbox preview state (gallery with multi-image page navigation)
  const [lightbox, setLightbox] = useState<{ images: string[]; currentIndex: number } | null>(null);

  const handlePreviewSingle = useCallback((url: string) => {
    setLightbox({ images: [url], currentIndex: 0 });
  }, []);

  const handlePreviewGallery = useCallback((images: string[], initialIndex = 0) => {
    if (!images || images.length === 0) return;
    const idx = Math.max(0, Math.min(initialIndex, images.length - 1));
    setLightbox({ images, currentIndex: idx });
  }, []);

  const handlePrevImage = useCallback(() => {
    setLightbox((cur) => {
      if (!cur || cur.images.length <= 1) return cur;
      const nextIdx = (cur.currentIndex - 1 + cur.images.length) % cur.images.length;
      return { ...cur, currentIndex: nextIdx };
    });
  }, []);

  const handleNextImage = useCallback(() => {
    setLightbox((cur) => {
      if (!cur || cur.images.length <= 1) return cur;
      const nextIdx = (cur.currentIndex + 1) % cur.images.length;
      return { ...cur, currentIndex: nextIdx };
    });
  }, []);

  // Keyboard navigation for lightbox
  useEffect(() => {
    if (!lightbox) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handlePrevImage();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleNextImage();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setLightbox(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [lightbox, handlePrevImage, handleNextImage]);

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

  /**
   * Paste / drop image support：整块工作台都是参考图投放区。
   *
   * 只在拿到图片时才 `preventDefault`，普通文本粘贴与文件拖放不受影响。
   */
  const handlePaste = (e: ReactClipboardEvent) => {
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

  const handleDrop = (e: ReactDragEvent) => {
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
    const { model: dispatchModel, modelOverride: dispatchOverride } = dispatch;

    let genParams: PlaygroundGenerationParams;
    let reqBody: PlaygroundGenerateRequest;

    if (selectedSource === 'openai') {
      // wire 语义：'auto' 与 false 不发字段；具体值正常提交。质量走
      // `submitQualityFor` 收口（旧卡的 'standard' 等表外词汇按"没要求"处理）。
      const finalAspect = aspect !== 'auto' ? aspect : undefined;
      // resolution 与 aspect 不同：**'auto' 也要发出去**。daemon 靠
      // `undefined`（旧路径：agent / CLI 根本没有档位概念，照旧算具体尺寸）与
      // 显式 `'auto'`（工作台选了自动档，size 字段完全不出现）区分两种语义，
      // 这里替它省掉字段等于把用户的「自动」降级成旧行为。
      const finalResolution = resolution;
      const finalQuality = submitQualityFor(dispatchModel, quality);
      const finalModeration = moderation !== 'auto' ? moderation : undefined;
      const finalTransparent = transparent ? true : undefined;

      genParams = {
        aspect: finalAspect,
        resolution: finalResolution,
        quality: finalQuality,
        moderation: finalModeration,
        transparent: finalTransparent,
        count,
      };

      reqBody = {
        targetProjectId,
        surface: 'image',
        model: dispatchModel,
        modelOverride: dispatchOverride ?? undefined,
        prompt: trimmedPrompt,
        ...(finalAspect ? { aspect: finalAspect } : {}),
        resolution: finalResolution,
        ...(finalQuality ? { quality: finalQuality } : {}),
        ...(finalModeration ? { moderation: finalModeration } : {}),
        ...(finalTransparent ? { transparent: finalTransparent } : {}),
        count,
        images: referenceChips.length > 0 ? referenceChips : undefined,
      };
    } else if (selectedSource === 'nanobanana') {
      const finalAspect = nanoBananaAspectRatioFor(aspect);   // auto/表外 → undefined（不发字段）
      const finalResolution = nanoBananaImageSizeFor(resolution);
      genParams = { aspect: finalAspect, resolution: finalResolution, count };
      reqBody = {
        targetProjectId,
        surface: 'image',
        model: dispatchModel,
        modelOverride: dispatchOverride ?? undefined,
        prompt: trimmedPrompt,
        ...(finalAspect ? { aspect: finalAspect } : {}),
        ...(finalResolution ? { resolution: finalResolution } : {}),
        count,
        images: referenceChips.length > 0 ? referenceChips : undefined,
      };
    } else {
      // 非 openai 源只发 aspect / count（不再发无效的 quality）；`'auto'` 不在该源的
      // 词表里，收口成不发字段，由 daemon 落各自的默认比例。
      const finalAspect = submitAspectForNonOpenAI(aspect);
      genParams = {
        aspect: finalAspect,
        count,
      };

      reqBody = {
        targetProjectId,
        surface: 'image',
        model: dispatchModel,
        modelOverride: dispatchOverride ?? undefined,
        prompt: trimmedPrompt,
        ...(finalAspect ? { aspect: finalAspect } : {}),
        count,
        images: referenceChips.length > 0 ? referenceChips : undefined,
      };
    }

    const optCard: OptimisticCard = {
      isOptimistic: true,
      id: optimisticId,
      targetProjectId: targetProjectId ?? null,
      surface: 'image',
      model: dispatchModel,
      modelOverride: dispatchOverride,
      prompt: trimmedPrompt,
      params: genParams,
      status: 'running',
      files: Array.from({ length: count }, () => ({ name: '' })),
      createdAt: Date.now(),
    };

    setOptimisticCards((prev) => [optCard, ...prev]);

    try {
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
  const handleReuse = useCallback((card: CardItem) => {
    setPrompt(card.prompt);
    // 从目录 id 反查 provider 恢复生图源；模型恢复为 override ?? 目录 id。
    const reuseSource = mediaModelProviderId(card.model);
    const targetSource = (reuseSource && reuseSource !== selectedSource) ? reuseSource : selectedSource;
    if (reuseSource && reuseSource !== selectedSource) {
      skipModelResetRef.current = true;
      setUserPickedSource(reuseSource);
    }
    setUserPickedModel(card.modelOverride || card.model);

    if (targetSource === 'openai') {
      setAspect(card.params?.aspect ?? 'auto');
      setResolution(card.params?.resolution ?? 'auto');
      setQuality(card.params?.quality ?? 'auto');
      setModeration(card.params?.moderation ?? 'auto');
      setTransparent(card.params?.transparent ?? false);
    } else {
      // openai 走上面的分支，这里 targetSource 必非 openai，defaultAspectForSource
      // 在此恰好给出「nano → auto、其余 → 1:1」的缺省档。
      setAspect(card.params?.aspect ?? defaultAspectForSource(targetSource));
      setResolution(card.params?.resolution ?? 'auto');
      setQuality('auto');
      setModeration('auto');
      setTransparent(false);
    }

    if (card.params?.count) setCount(card.params.count);
    promptTextareaRef.current?.focus();
  }, [selectedSource]);

  // Card action: Turn generated file into reference chip
  const handleAsReference = useCallback((card: CardItem, fileName: string) => {
    if (!fileName) return;
    if (card.targetProjectId !== (selectedTarget === 'scratch' ? null : selectedTarget)) {
      alert(t('generate.crossTargetRefNotice'));
    }
    setReferenceChips((prev) => (prev.includes(fileName) ? prev : [...prev, fileName]));
  }, [selectedTarget, t]);

  // Resolve media URL for a slot
  const getFileUrl = useCallback((card: CardItem, file: PlaygroundGenerationFile, slotIndex: number): string => {
    if (file.name && card.targetProjectId) {
      return projectFileUrl(card.targetProjectId, file.name, null);
    }
    return `/api/media/playground/files/${encodeURIComponent(card.id)}/${slotIndex}`;
  }, []);

  // Card action: Download image
  const handleDownload = useCallback((card: CardItem, file: PlaygroundGenerationFile, slotIndex: number) => {
    const url = getFileUrl(card, file, slotIndex);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name || `image-${card.id}-${slotIndex + 1}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [getFileUrl]);

  // Card action: Delete generation
  const handleDelete = useCallback(async (card: CardItem) => {
    if ('isOptimistic' in card) {
      setOptimisticCards((prev) => prev.filter((c) => c.id !== card.id));
      return;
    }
    if (!confirm(t('generate.deleteConfirm'))) return;

    try {
      const res = await fetch(`/api/media/playground/generations/${encodeURIComponent(card.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        if (res.status === 409) {
          alert(t('generate.deleteRunningError'));
          return;
        }
        throw new Error(apiErrorMessage(await res.json().catch(() => null), `HTTP ${res.status}`));
      }
      setGenerations((prev) => prev.filter((g) => g.id !== card.id));
    } catch (err: any) {
      alert(err.message || 'Delete failed');
    }
  }, [t]);

  // Scratch -> Project transfer
  const handleOpenTransfer = useCallback((gen: PlaygroundGeneration) => {
    setTransferTargetGenId(gen.id);
    const firstProject = eligibleProjects[0]?.id ?? '';
    setTransferDestinationPid(firstProject);
  }, [eligibleProjects]);

  const handleConfirmTransfer = async () => {
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
      setGenerations((prev) => prev.map((g) => (g.id === transferTargetGenId ? data.generation : g)));
      invalidateProjectFilesCache(transferDestinationPid);
      setTransferTargetGenId(null);
    } catch (err: any) {
      alert(err.message || t('generate.transferFailed'));
    } finally {
      setTransferring(false);
    }
  };

  // Combine optimistic cards and settled generations for rendering
  const allCards: CardItem[] = useMemo(
    () => [...optimisticCards, ...generations],
    [optimisticCards, generations],
  );

  const selectableIds = useMemo(() => getSelectableIds(allCards), [allCards]);
  const allSelected = useMemo(
    () => isAllSelected(selectableIds, selected),
    [selectableIds, selected],
  );

  const handleToggleSelect = useCallback((id: string) => {
    setSelected((prev) => toggleSelection(prev, id));
  }, []);

  const handleToggleSelectAll = useCallback(() => {
    setSelected((prev) => toggleSelectAll(selectableIds, prev));
  }, [selectableIds]);

  const handleExitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, []);

  const handleBatchDelete = useCallback(async () => {
    const ids = Array.from(selected);
    if (ids.length === 0 || isBatchDeleting) return;

    if (!confirm(t('generate.batchDeleteConfirm', { n: ids.length }))) return;

    setIsBatchDeleting(true);
    try {
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += 100) {
        chunks.push(ids.slice(i, i + 100));
      }

      const allDeleted: string[] = [];
      let totalSkipped = 0;

      for (const chunk of chunks) {
        const body: PlaygroundBatchDeleteRequest = { ids: chunk };
        const res = await fetch('/api/media/playground/generations/batch-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          throw new Error(apiErrorMessage(await res.json().catch(() => null), `HTTP ${res.status}`));
        }
        const data = (await res.json()) as PlaygroundBatchDeleteResponse;
        if (Array.isArray(data.deleted)) {
          allDeleted.push(...data.deleted);
        }
        const skipped = (data.skippedRunning?.length ?? 0) + (data.notFound?.length ?? 0);
        totalSkipped += skipped;
      }

      const deletedSet = new Set(allDeleted);
      setGenerations((prev) => prev.filter((g) => !deletedSet.has(g.id)));
      setSelected(new Set());

      if (totalSkipped > 0) {
        alert(t('generate.batchDeletePartial', { deleted: allDeleted.length, skipped: totalSkipped }));
      } else {
        alert(t('generate.batchDeleteSuccess', { deleted: allDeleted.length }));
      }
    } catch (err: any) {
      alert(err.message || t('generate.batchDeleteFailed'));
    } finally {
      setIsBatchDeleting(false);
    }
  }, [selected, isBatchDeleting, t]);

  const targetItems: CustomSelectItem[] = useMemo(() => {
    const items: CustomSelectItem[] = [
      { value: 'scratch', label: t('generate.targetScratch') },
    ];
    for (const p of eligibleProjects) {
      items.push({
        value: p.id,
        label: t('generate.targetProject', { name: p.name || p.id }),
      });
    }
    return items;
  }, [eligibleProjects, t]);

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
          {!selectMode && (
            <span className={styles.historyCount}>{t('generate.historyCount', { count: allCards.length })}</span>
          )}

          <div className={styles.viewToggle} role="group" aria-label={t('generate.viewMode')}>
            <button
              type="button"
              className={`${styles.viewToggleBtn} od-tooltip`}
              data-active={viewMode === 'stream' ? 'true' : 'false'}
              aria-pressed={viewMode === 'stream'}
              onClick={() => handleSetViewMode('stream')}
              data-tooltip={t('generate.viewStreamTooltip')}
              data-tooltip-placement="bottom"
            >
              {t('generate.viewStream')}
            </button>
            <button
              type="button"
              className={`${styles.viewToggleBtn} od-tooltip`}
              data-active={viewMode === 'grid' ? 'true' : 'false'}
              aria-pressed={viewMode === 'grid'}
              onClick={() => handleSetViewMode('grid')}
              data-tooltip={t('generate.viewGridTooltip')}
              data-tooltip-placement="bottom"
            >
              {t('generate.viewGrid')}
            </button>
            <button
              type="button"
              className={`${styles.viewToggleBtn} od-tooltip`}
              data-active={viewMode === 'list' ? 'true' : 'false'}
              aria-pressed={viewMode === 'list'}
              onClick={() => handleSetViewMode('list')}
              data-tooltip={t('generate.viewListTooltip')}
              data-tooltip-placement="bottom"
            >
              {t('generate.viewList')}
            </button>
          </div>

          {selectMode ? (
            <div className={styles.selectBar} role="group">
              <span className={styles.selectCount}>
                {t('generate.selectedCount', { n: selected.size })}
              </span>
              <button
                type="button"
                className={styles.selectActionBtn}
                onClick={handleToggleSelectAll}
              >
                {allSelected
                  ? t('generate.deselectAll')
                  : t('generate.selectAll', { m: selectableIds.length })}
              </button>
              <Button
                variant="secondary"
                size="sm"
                className={styles.btnDanger}
                disabled={selected.size === 0 || isBatchDeleting}
                onClick={() => void handleBatchDelete()}
              >
                <Icon name="trash" size={13} />
                <span>{isBatchDeleting ? t('common.loading') : t('generate.batchDelete')}</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleExitSelectMode}
              >
                {t('generate.cancelSelect')}
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className={styles.manageBtn}
              disabled={selectableIds.length === 0}
              onClick={() => setSelectMode(true)}
            >
              <Icon name="check" size={13} />
              <span>{t('generate.manage')}</span>
            </Button>
          )}
        </div>
      </header>

      {/* Main card list */}
      <main className={styles.cardStream}>
        {loadingHistory && allCards.length === 0 ? (
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
        ) : viewMode === 'grid' ? (
          <GenerateHistoryGrid
            cards={allCards}
            selectMode={selectMode}
            selected={selected}
            onToggleSelect={handleToggleSelect}
            onPreviewGallery={handlePreviewGallery}
            getFileUrl={getFileUrl}
          />
        ) : viewMode === 'list' ? (
          <GenerateHistoryList
            cards={allCards}
            selectMode={selectMode}
            selected={selected}
            onToggleSelect={handleToggleSelect}
            onPreviewGallery={handlePreviewGallery}
            onReuse={handleReuse}
            onDelete={handleDelete}
            getFileUrl={getFileUrl}
          />
        ) : (
          allCards.map((card) => (
            <GenerateCard
              key={card.id}
              card={card}
              onPreview={handlePreviewSingle}
              onReuse={handleReuse}
              onAsReference={handleAsReference}
              onDownload={handleDownload}
              onOpenTransfer={handleOpenTransfer}
              onDelete={handleDelete}
              getFileUrl={getFileUrl}
              selectMode={selectMode}
              isSelected={selected.has(card.id)}
              onToggleSelect={handleToggleSelect}
            />
          ))
        )}

        {nextBefore && (
          <Button variant="secondary" size="sm" className={styles.loadMore} onClick={handleLoadMore} disabled={loadingMore}>
            <Icon name="chevron-down" size={13} />
            <span>{loadingMore ? t('common.loading') : t('generate.loadMore')}</span>
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
                  <Icon name="image" size={12} />
                  <span className={styles.refChipName}>{chip}</span>
                  <button
                    type="button"
                    className={styles.refChipRemove}
                    onClick={() => setReferenceChips((prev) => prev.filter((_, i) => i !== idx))}
                    aria-label={t('generate.removeReference')}
                  >
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

            {/* 隐藏的文件输入 */}
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
            {/* 漂浮于输入框内的附件按钮 */}
            <button
              type="button"
              className={styles.promptAttachBtn}
              onClick={(e) => {
                e.stopPropagation();
                fileInputRef.current?.click();
              }}
              disabled={uploadingImage}
              title={t('generate.addReference')}
              aria-label={t('generate.addReference')}
            >
              <Icon name="attach" size={15} />
            </button>
          </div>

          <div className={styles.composerToolbar}>
            <GenerateToolbarParams
              selectedSource={selectedSource}
              sourceItems={sourceItems}
              onSourceChange={handleSourceChange}
              selectedModel={selectedModel}
              modelItems={modelItems}
              onModelChange={setUserPickedModel}
              catalogModel={dispatch.model}
              aspect={aspect}
              onAspectChange={setAspect}
              resolution={resolution}
              onResolutionChange={setResolution}
              quality={quality}
              onQualityChange={setQuality}
              moderation={moderation}
              onModerationChange={setModeration}
              transparent={transparent}
              onTransparentChange={setTransparent}
              count={count}
              onCountChange={setCount}
            />

            <div className={styles.submitGroup}>
              <span className={styles.shortcutKbd} title="Command / Ctrl + Enter">
                <kbd className={styles.kbdKey}>⌘</kbd>
                <kbd className={styles.kbdKey}>↵</kbd>
              </span>
              <Button
                variant="primary"
                size="sm"
                disabled={isSubmitting || !prompt.trim()}
                onClick={() => void handleGenerate()}
                data-testid="generate-submit-button"
              >
                <Icon name="sparkles" size={14} />
                <span>{isSubmitting ? t('generate.generating') : t('generate.generate')}</span>
              </Button>
            </div>
          </div>
        </div>
      </footer>

      {/* Lightbox Modal */}
      {lightbox && (
        <div className={styles.lightbox} role="dialog" aria-modal="true" onClick={() => setLightbox(null)}>
          <Button
            variant="subtle"
            size="icon"
            className={styles.lightboxClose}
            onClick={() => setLightbox(null)}
            aria-label={t('common.close')}
          >
            <Icon name="close" size={18} />
          </Button>

          {lightbox.images.length > 1 && (
            <>
              <button
                type="button"
                className={`${styles.lightboxNavBtn} ${styles.lightboxNavPrev}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handlePrevImage();
                }}
                aria-label={t('generate.prevImage')}
                title={t('generate.prevImage')}
              >
                <Icon name="chevron-left" size={20} />
              </button>

              <button
                type="button"
                className={`${styles.lightboxNavBtn} ${styles.lightboxNavNext}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleNextImage();
                }}
                aria-label={t('generate.nextImage')}
                title={t('generate.nextImage')}
              >
                <Icon name="chevron-right" size={20} />
              </button>

              <div className={styles.lightboxCounter} onClick={(e) => e.stopPropagation()}>
                {lightbox.currentIndex + 1} / {lightbox.images.length}
              </div>
            </>
          )}

          <div className={styles.lightboxStage} onClick={(e) => e.stopPropagation()}>
            <img
              src={lightbox.images[lightbox.currentIndex]}
              alt={`Preview ${lightbox.currentIndex + 1}`}
              className={styles.lightboxImg}
            />
          </div>
        </div>
      )}

      {/* Scratch -> Project Transfer Modal */}
      {transferTargetGenId && (
        <div
          className={styles.transferDialogBackdrop}
          onClick={() => { if (!transferring) setTransferTargetGenId(null); }}
        >
          <div className={styles.transferDialog} role="dialog" aria-modal="true">
            <div className={styles.transferTitle}>{t('generate.transfer')}</div>
            <div className={styles.transferField}>
              <span className={styles.transferLabel}>{t('generate.transferSelectProject')}</span>
              <CustomSelect
                value={transferDestinationPid}
                options={eligibleProjects.map((p) => ({ value: p.id, label: p.name || p.id }))}
                onChange={setTransferDestinationPid}
                disabled={transferring}
                ariaLabel={t('generate.transferSelectProject')}
              />
            </div>
            <div className={styles.transferActions}>
              <Button variant="secondary" size="sm" onClick={() => setTransferTargetGenId(null)} disabled={transferring}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" size="sm" onClick={() => void handleConfirmTransfer()} disabled={transferring || !transferDestinationPid}>
                {transferring ? t('common.loading') : t('generate.transfer')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
