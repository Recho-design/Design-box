import React from 'react';
import type { PlaygroundGenerationFile } from '@open-design/contracts';
import { Button } from '@open-design/components';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { RemixIcon } from './RemixIcon';
import type { CardItem } from './GenerateCard';
import {
  formatRelativeTime,
  getCardImageUrls,
} from './generate-history-selection';
import styles from './GenerateHistoryList.module.css';

export interface GenerateHistoryListProps {
  cards: CardItem[];
  selectMode: boolean;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onPreviewGallery: (images: string[], initialIndex?: number) => void;
  onReuse: (card: CardItem) => void;
  onDelete: (card: CardItem) => void;
  getFileUrl: (card: CardItem, file: PlaygroundGenerationFile, slotIndex: number) => string;
}

export function GenerateHistoryList({
  cards,
  selectMode,
  selected,
  onToggleSelect,
  onPreviewGallery,
  onReuse,
  onDelete,
  getFileUrl,
}: GenerateHistoryListProps) {
  const { t } = useI18n();

  return (
    <div className={styles.listContainer} data-testid="generate-history-list">
      {cards.map((card) => {
        const isOpt = 'isOptimistic' in card;
        const isRunning = card.status === 'running';
        const isFailed = card.status === 'failed';
        const isSelected = selected.has(card.id);

        const imageUrls = getCardImageUrls(card, getFileUrl);
        const thumbUrl = imageUrls[0] ?? null;

        const extraCount = Math.max(0, imageUrls.length - 1);
        const modelBadge = card.modelOverride || card.model;

        const handleRowClick = () => {
          if (selectMode && !isOpt && !isRunning) {
            onToggleSelect(card.id);
          }
        };

        const handleThumbClick = (e: React.MouseEvent) => {
          e.stopPropagation();
          if (imageUrls.length > 0) {
            onPreviewGallery(imageUrls, 0);
          }
        };

        return (
          <div
            key={card.id}
            className={styles.listItem}
            data-testid={`list-item-${card.id}`}
            data-selected={isSelected ? 'true' : 'false'}
            data-clickable={selectMode && !isOpt && !isRunning ? 'true' : 'false'}
            onClick={handleRowClick}
          >
            {/* Section 1: Checkbox & Thumbnail */}
            <div className={styles.sectionThumb}>
              {selectMode && !isOpt && (
                <button
                  type="button"
                  className={styles.checkboxBtn}
                  disabled={isRunning}
                  title={isRunning ? t('generate.runningCannotDelete') : undefined}
                  aria-label={isSelected ? t('generate.deselectRecord') : t('generate.selectRecord')}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isRunning) onToggleSelect(card.id);
                  }}
                >
                  <RemixIcon
                    name={isSelected ? 'checkbox-line' : 'checkbox-blank-line'}
                    size={16}
                    className={isSelected ? styles.checkboxChecked : undefined}
                  />
                </button>
              )}

              <div
                className={styles.thumbBox}
                onClick={handleThumbClick}
                title={imageUrls.length > 0 ? t('generate.preview') : undefined}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (imageUrls.length > 0) onPreviewGallery(imageUrls, 0);
                  }
                }}
              >
                {thumbUrl ? (
                  <img
                    src={thumbUrl}
                    alt={card.prompt || 'Thumbnail'}
                    className={styles.thumbImg}
                    loading="lazy"
                  />
                ) : (
                  <div
                    className={`${styles.thumbPlaceholder} ${
                      isFailed ? styles.thumbFailed : ''
                    }`}
                  >
                    {isRunning ? (
                      <span className={styles.pulseDot} />
                    ) : isFailed ? (
                      <Icon name="alert-triangle" size={16} />
                    ) : (
                      <Icon name="image" size={16} />
                    )}
                  </div>
                )}
                {extraCount > 0 && (
                  <span className={styles.thumbBadgeExtra}>+{extraCount}</span>
                )}
              </div>
            </div>

            {/* Section 2: Prompt (single-line clamped) & Status */}
            <div className={styles.sectionPrompt}>
              <p
                className={`${styles.promptText} ${!card.prompt ? styles.promptMuted : ''}`}
                title={card.prompt}
              >
                {card.prompt || t('generate.noPrompt')}
              </p>
              <div className={styles.statusRow}>
                {isRunning ? (
                  <span className={`${styles.statusBadge} ${styles.statusRunning}`}>
                    <span className={styles.pulseDot} />
                    <span>{t('generate.statusRunning')}</span>
                  </span>
                ) : isFailed ? (
                  <span className={`${styles.statusBadge} ${styles.statusFailed}`}>
                    <Icon name="alert-triangle" size={10} />
                    <span>{t('generate.statusFailed')}</span>
                  </span>
                ) : (
                  <span className={styles.statusBadge}>
                    <span>{t('generate.statusDone')}</span>
                  </span>
                )}
              </div>
            </div>

            {/* Section 3: Badges (Model, Aspect, Quality) */}
            <div className={styles.sectionBadges}>
              {modelBadge && (
                <span className={`${styles.badge} ${styles.modelBadge}`} title={modelBadge}>
                  {modelBadge}
                </span>
              )}
              {card.params?.aspect && card.params.aspect !== 'auto' && (
                <span className={styles.badge}>
                  <Icon name="crop" size={10} />
                  <span>{card.params.aspect}</span>
                </span>
              )}
              {card.params?.quality && card.params.quality !== 'auto' && (
                <span className={styles.badge}>
                  <span>{card.params.quality}</span>
                </span>
              )}
              {card.params?.resolution && card.params.resolution !== 'auto' && (
                <span className={styles.badge}>
                  <span>{card.params.resolution}</span>
                </span>
              )}
            </div>

            {/* Section 4: Time & Actions */}
            <div className={styles.sectionActions}>
              <span className={styles.timeText} title={new Date(card.createdAt).toLocaleString()}>
                {formatRelativeTime(card.createdAt, t)}
              </span>

              <div className={styles.actionButtons}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onReuse(card);
                  }}
                  title={t('generate.reuse')}
                >
                  <Icon name="reload" size={12} />
                  <span>{t('generate.reuse')}</span>
                </Button>

                {!isOpt && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={styles.btnDanger}
                    disabled={isRunning}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(card);
                    }}
                    title={isRunning ? t('generate.runningCannotDelete') : t('generate.delete')}
                  >
                    <Icon name="trash" size={12} />
                    <span>{t('generate.delete')}</span>
                  </Button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
