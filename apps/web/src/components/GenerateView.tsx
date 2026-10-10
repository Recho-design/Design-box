import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type {
  PlaygroundGeneration,
  PlaygroundGenerateRequest,
  PlaygroundGenerationFile,
  PlaygroundUploadResponse,
  PlaygroundGenerationListResponse,
  PlaygroundTransferResponse,
} from '@open-design/contracts';
import { Button, Input, Select, Textarea } from '@open-design/components';
import type { MediaProviderCredentials, Project } from '../types';
import { useI18n } from '../i18n';
import { invalidateProjectFilesCache, projectFileUrl } from '../providers/registry';
import { isMediaModelPickerReady } from '../media/provider-readiness';
import { Icon } from './Icon';
import styles from './GenerateView.module.css';

interface Props {
  initialProjectId?: string;
  projects?: Project[];
  /**
   * Saved media-provider credentials. The model suggestions below are filtered
   * through `isMediaModelPickerReady`, so the dropdown only ever offers models
   * whose provider the user can actually dispatch to. Omitted (or undefined)
   * means "credentials not loaded yet" — the readiness helper treats that as
   * ready and the full catalogue stays visible.
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

  // Model suggestions from GET /api/media/models. The route publishes the
  // whole catalogue, so the list is filtered down to models whose provider the
  // user has configured before it reaches the dropdown — offering a model the
  // run cannot dispatch is how a user ends up with a failed generation and no
  // idea why.
  const [suggestedModels, setSuggestedModels] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/media/models')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const models: string[] = [];
        if (Array.isArray(data.image)) {
          for (const m of data.image) {
            if (typeof m?.id === 'string') models.push(m.id);
          }
        }
        setSuggestedModels(models);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const readySuggestedModels = useMemo(
    () => suggestedModels.filter((id) => isMediaModelPickerReady(id, mediaProviders)),
    [suggestedModels, mediaProviders],
  );

  // History state
  const [generations, setGenerations] = useState<PlaygroundGeneration[]>([]);
  const [optimisticCards, setOptimisticCards] = useState<OptimisticCard[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Input bar state
  const [prompt, setPrompt] = useState('');
  const [modelOverride, setModelOverride] = useState('');
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

    const optCard: OptimisticCard = {
      isOptimistic: true,
      id: optimisticId,
      targetProjectId: targetProjectId ?? null,
      surface: 'image',
      model: 'custom-image',
      modelOverride: modelOverride.trim() || null,
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
        model: 'custom-image',
        modelOverride: modelOverride.trim() || undefined,
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
    if (card.modelOverride) setModelOverride(card.modelOverride);
    if (card.params?.aspect) setAspect(card.params.aspect);
    if (card.params?.quality) setQuality(card.params.quality);
    if (card.params?.count) setCount(card.params.count);
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

  return (
    <div className={styles.generateView} data-testid="generate-view" onPaste={handlePaste} onDrop={handleDrop}>
      {/* Top Bar */}
      <header className={styles.topBar}>
        <div className={styles.targetSelector}>
          <div className={styles.targetIconBadge}><Icon name="folder" size={14} /></div>
          <span className={styles.targetLabel}>{t('generate.target')}</span>
          <Select
            className={styles.targetSelect}
            value={selectedTarget}
            onChange={(e) => setSelectedTarget(e.target.value)}
            data-testid="generate-target-select"
          >
            <option value="scratch">{t('generate.targetScratch')}</option>
            {eligibleProjects.map((p) => (
              <option key={p.id} value={p.id}>{t('generate.targetProject', { name: p.name || p.id })}</option>
            ))}
          </Select>
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

            return (
              <article key={card.id} className={styles.card} data-testid={`generate-card-${card.id}`}>
                {/* Header */}
                <div className={styles.cardHeader}>
                  <div className={styles.cardPromptBox}>
                    <p className={styles.cardPrompt}>{card.prompt}</p>
                  </div>
                  <div className={styles.cardMeta}>
                    {card.modelOverride && <span className={styles.badge} title={card.modelOverride}>{card.modelOverride}</span>}
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

          <div className={styles.promptRow}>
            <Textarea
              className={styles.promptTextarea}
              placeholder={t('generate.promptPlaceholder')}
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
              <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploadingImage} title={t('generate.addReference')}>
                <Icon name="attach" size={13} /><span>{uploadingImage ? t('common.loading') : t('generate.addReference')}</span>
              </Button>

              <span className={styles.toolbarDivider} />

              <div className={styles.paramItem}>
                <label htmlFor="gen-model-override" className={styles.paramLabel}>{t('generate.modelLabel')}</label>
                <Input
                  id="gen-model-override"
                  list="gen-model-suggestions"
                  className={styles.paramInput}
                  value={modelOverride}
                  onChange={(e) => setModelOverride(e.target.value)}
                  placeholder={t('generate.modelPlaceholder')}
                />
                <datalist id="gen-model-suggestions">
                  {readySuggestedModels.map((m) => (<option key={m} value={m} />))}
                </datalist>
              </div>

              <div className={styles.paramItem}>
                <label htmlFor="gen-aspect" className={styles.paramLabel}>{t('generate.aspect')}</label>
                <Select id="gen-aspect" className={styles.paramSelect} value={aspect} onChange={(e) => setAspect(e.target.value)}>
                  {MEDIA_ASPECTS.map((asp) => (<option key={asp} value={asp}>{asp}</option>))}
                </Select>
              </div>

              <div className={styles.paramItem}>
                <label htmlFor="gen-quality" className={styles.paramLabel}>{t('generate.quality')}</label>
                <Select id="gen-quality" className={styles.paramSelect} value={quality} onChange={(e) => setQuality(e.target.value)}>
                  <option value="standard">{t('generate.qualityDefault')}</option>
                  <option value="high">High</option>
                </Select>
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
              <label htmlFor="gen-transfer-project-select" className={styles.transferLabel}>{t('generate.transferSelectProject')}</label>
              <Select
                id="gen-transfer-project-select"
                className={styles.transferSelect}
                value={transferDestinationPid}
                onChange={(e) => setTransferDestinationPid(e.target.value)}
                disabled={transferring}
              >
                {eligibleProjects.map((p) => (<option key={p.id} value={p.id}>{p.name || p.id}</option>))}
              </Select>
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
