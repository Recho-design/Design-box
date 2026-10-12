import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  PlaygroundGeneration,
  PlaygroundGenerationFile,
  PlaygroundGenerationParams,
} from '@open-design/contracts';
import { Button } from '@open-design/components';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import styles from './GenerateView.module.css';

export interface OptimisticCard {
  isOptimistic: true;
  id: string;
  targetProjectId: string | null;
  surface: 'image';
  model: string;
  modelOverride: string | null;
  prompt: string;
  params: PlaygroundGenerationParams;
  status: 'running' | 'failed';
  files: PlaygroundGenerationFile[];
  createdAt: number;
}

export type CardItem = PlaygroundGeneration | OptimisticCard;

export interface GenerateCardProps {
  card: CardItem;
  onPreview: (url: string) => void;
  onReuse: (card: CardItem) => void;
  onAsReference: (card: CardItem, fileName: string) => void;
  onDownload: (card: CardItem, file: PlaygroundGenerationFile, slotIndex: number) => void;
  onOpenTransfer: (card: PlaygroundGeneration) => void;
  onDelete: (card: CardItem) => void;
  getFileUrl: (card: CardItem, file: PlaygroundGenerationFile, slotIndex: number) => string;
}

/**
 * 生图工作台中的单张结果卡片。
 *
 * 渲染生图批次的提示词、状态徽标、图片槽位网格及卡片级操作按钮（复用/转存/设为参考/下载/删除）。
 */
export function GenerateCard({
  card,
  onPreview,
  onReuse,
  onAsReference,
  onDownload,
  onOpenTransfer,
  onDelete,
  getFileUrl,
}: GenerateCardProps) {
  const { t } = useI18n();

  const isOpt = 'isOptimistic' in card;
  const isRunning = card.status === 'running';
  const isFailed = card.status === 'failed';
  // 「能不能转存」是**这张卡自己的属性**：产物落在 scratch（`targetProjectId === null`）
  // 才需要搬进项目。顶栏当前选中的目标与之无关 —— 卡片流里可以同时躺着 scratch 卡和
  // 项目卡，按顶栏选择判断会让项目卡在切到 scratch 时冒出一个注定失败的转存按钮。
  const isScratch = card.targetProjectId === null;

  const files = card.files && card.files.length > 0 ? card.files : [{ name: '' }];
  const isSingle = files.length === 1;

  // 比例样式：若未指定或为 'auto'，则使用默认正方形，不强加 style
  const aspectStyle = useMemo(() => {
    if (!card.params?.aspect || card.params.aspect === 'auto') return undefined;
    return { aspectRatio: card.params.aspect.replace(':', ' / ') };
  }, [card.params?.aspect]);

  const modelBadge = card.modelOverride || card.model;

  const [isExpanded, setIsExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(() => {
    return (card.prompt?.length ?? 0) > 120 || (card.prompt?.includes('\n') ?? false);
  });
  const promptRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    setIsExpanded(false);
  }, [card.id, card.prompt]);

  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;

    const checkOverflow = () => {
      if (!el) return;
      if (!isExpanded) {
        setCanExpand(el.scrollHeight > el.clientHeight + 1);
      }
    };

    checkOverflow();

    const observer = new ResizeObserver(() => {
      checkOverflow();
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [card.prompt, isExpanded]);

  return (
    <article
      className={styles.card}
      data-testid={`generate-card-${card.id}`}
    >
      {/* 头部元信息 */}
      <div className={styles.cardHeader}>
        <div className={styles.cardMeta}>
          {modelBadge && (
            <span className={styles.badge} title={modelBadge}>
              {modelBadge}
            </span>
          )}

          {/* 比例徽标：非 auto 时展示 */}
          {card.params?.aspect && card.params.aspect !== 'auto' && (
            <span className={styles.badge}>
              <Icon name="crop" size={10} />
              <span>{card.params.aspect}</span>
            </span>
          )}

          {/* 分辨率徽标：非 auto 时展示 */}
          {card.params?.resolution && card.params.resolution !== 'auto' && (
            <span className={styles.badge}>
              <span>{card.params.resolution}</span>
            </span>
          )}

          {/* 质量徽标：非 auto 时展示 */}
          {card.params?.quality && card.params.quality !== 'auto' && (
            <span className={styles.badge}>
              <span>{card.params.quality}</span>
            </span>
          )}

          {/* 审核徽标：非 auto 时展示 */}
          {card.params?.moderation && card.params.moderation !== 'auto' && (
            <span className={styles.badge}>
              <span>
                {card.params.moderation === 'low'
                  ? t('generate.moderationLow')
                  : card.params.moderation}
              </span>
            </span>
          )}

          {/* 透明背景徽标 */}
          {card.params?.transparent && (
            <span className={styles.badge}>
              <span>{t('generate.transparentBadge')}</span>
            </span>
          )}

          {/* 运行中徽标 */}
          {isRunning && (
            <span className={`${styles.badge} ${styles.badgeRunning}`}>
              <span className={styles.pulseDot} />
              <span>{t('generate.generating')}</span>
            </span>
          )}

          {/* 失败徽标 */}
          {isFailed && (
            <span className={`${styles.badge} ${styles.badgeFailed}`}>
              <Icon name="alert-triangle" size={10} />
              <span>{t('generate.failedSlot')}</span>
            </span>
          )}
        </div>

        <div className={styles.cardPromptBox}>
          <p
            ref={promptRef}
            className={`${styles.cardPrompt} ${!isExpanded ? styles.cardPromptClamped : styles.cardPromptExpanded}`}
          >
            {card.prompt}
          </p>
          {canExpand && (
            <button
              type="button"
              className={styles.promptToggleBtn}
              onClick={() => setIsExpanded((prev) => !prev)}
              aria-expanded={isExpanded}
            >
              <span>{isExpanded ? t('generate.collapsePrompt') : t('generate.expandPrompt')}</span>
              <Icon name={isExpanded ? 'chevron-up' : 'chevron-down'} size={11} />
            </button>
          )}
        </div>
      </div>

      {/* 媒体槽位网格 */}
      <div className={isSingle ? `${styles.cardGrid} ${styles.cardGridSingle}` : styles.cardGrid}>
        {files.map((file, slotIdx) => {
          if (isRunning) {
            return (
              <div key={slotIdx} className={styles.slotWrapper} style={aspectStyle}>
                <div className={styles.slotRunning}>
                  <div className={styles.runningAperture}>
                    <div className={styles.runningRings} />
                    <Icon name="sparkles" size={20} className={styles.runningIcon} />
                  </div>
                  <div className={styles.runningMeta}>
                    <span className={styles.runningTitle}>{t('generate.generating')}</span>
                    <div className={styles.runningPulseBar} />
                  </div>
                </div>
              </div>
            );
          }

          if (file.error) {
            return (
              <div key={slotIdx} className={styles.slotWrapper} style={aspectStyle}>
                <div className={styles.slotFailed}>
                  <Icon name="alert-triangle" size={24} />
                  <span>{file.error}</span>
                </div>
              </div>
            );
          }

          const url = getFileUrl(card, file, slotIdx);
          return (
            <div key={slotIdx} className={styles.slotWrapper} style={aspectStyle}>
              <img
                src={url}
                alt={card.prompt}
                className={styles.slotImg}
                onClick={() => onPreview(url)}
                loading="lazy"
              />
              <button
                type="button"
                className={styles.slotPreviewBtn}
                onClick={() => onPreview(url)}
                aria-label={t('generate.preview')}
                title={t('generate.preview')}
              >
                <Icon name="eye" size={13} />
              </button>
            </div>
          );
        })}
      </div>

      {/* 卡片底部操作按钮 */}
      <div className={styles.cardActions}>
        <div className={styles.actionGroup}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onReuse(card)}
            title={t('generate.reuse')}
          >
            <Icon name="refresh" size={12} />
            <span>{t('generate.reuse')}</span>
          </Button>

          {files.map((file, slotIdx) => {
            if (!file.name || file.error) return null;
            return (
              <React.Fragment key={slotIdx}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onAsReference(card, file.name)}
                  title={t('generate.useAsReference')}
                >
                  <Icon name="image" size={12} />
                  <span>
                    {files.length > 1
                      ? `${t('generate.useAsReference')} #${slotIdx + 1}`
                      : t('generate.useAsReference')}
                  </span>
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onDownload(card, file, slotIdx)}
                  title={t('generate.download')}
                >
                  <Icon name="download" size={12} />
                  <span>
                    {files.length > 1
                      ? `${t('generate.download')} #${slotIdx + 1}`
                      : t('generate.download')}
                  </span>
                </Button>
              </React.Fragment>
            );
          })}

          {isScratch && !isOpt && !isRunning && !isFailed && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onOpenTransfer(card as PlaygroundGeneration)}
              title={t('generate.transfer')}
            >
              <Icon name="folder-transfer" size={12} />
              <span>{t('generate.transfer')}</span>
            </Button>
          )}
        </div>

        <div className={styles.actionGroup}>
          <Button
            variant="secondary"
            size="sm"
            className={styles.btnDanger}
            onClick={() => onDelete(card)}
            disabled={isRunning}
            title={t('generate.delete')}
          >
            <Icon name="close" size={12} />
            <span>{t('generate.delete')}</span>
          </Button>
        </div>
      </div>
    </article>
  );
}
