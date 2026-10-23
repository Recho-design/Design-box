import type { PlaygroundGenerationFile } from '@open-design/contracts';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { RemixIcon } from './RemixIcon';
import type { CardItem } from './GenerateCard';
import { getCardImageUrls } from './generate-history-selection';
import styles from './GenerateHistoryGrid.module.css';

export interface GenerateHistoryGridProps {
  cards: CardItem[];
  selectMode: boolean;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onPreviewGallery: (images: string[], initialIndex?: number) => void;
  getFileUrl: (card: CardItem, file: PlaygroundGenerationFile, slotIndex: number) => string;
}

export function GenerateHistoryGrid({
  cards,
  selectMode,
  selected,
  onToggleSelect,
  onPreviewGallery,
  getFileUrl,
}: GenerateHistoryGridProps) {
  const { t } = useI18n();

  return (
    <div className={styles.gridContainer} data-testid="generate-history-grid">
      {cards.map((card) => {
        const isOpt = 'isOptimistic' in card;
        const isRunning = card.status === 'running';
        const isFailed = card.status === 'failed';
        const isSelected = selected.has(card.id);

        const imageUrls = getCardImageUrls(card, getFileUrl);
        const coverUrl = imageUrls[0] ?? null;

        const extraCount = Math.max(0, imageUrls.length - 1);
        const modelBadge = card.modelOverride || card.model;

        const openPreview = () => {
          if (imageUrls.length > 0) onPreviewGallery(imageUrls, 0);
        };

        const handleCardClick = () => {
          if (selectMode) {
            if (!isOpt && !isRunning) onToggleSelect(card.id);
          } else {
            openPreview();
          }
        };

        return (
          <div
            key={card.id}
            className={styles.gridItem}
            data-testid={`grid-item-${card.id}`}
            data-selected={isSelected ? 'true' : 'false'}
            onClick={handleCardClick}
            title={card.prompt || modelBadge}
          >
            {/* Cover Image or Empty Placeholder */}
            {coverUrl ? (
              <img
                src={coverUrl}
                alt={card.prompt || 'Generated preview'}
                className={styles.imageCover}
                loading="lazy"
              />
            ) : (
              <div
                className={`${styles.emptyCoverPlaceholder} ${
                  isFailed
                    ? styles.placeholderFailed
                    : isRunning
                    ? styles.placeholderRunning
                    : ''
                }`}
              >
                <div className={styles.placeholderIcon}>
                  {isRunning ? (
                    <span className={styles.pulseDot} />
                  ) : isFailed ? (
                    <Icon name="alert-triangle" size={20} />
                  ) : (
                    <Icon name="image" size={20} />
                  )}
                </div>
                <div className={styles.placeholderText}>
                  {isRunning
                    ? t('generate.statusRunning')
                    : isFailed
                    ? t('generate.statusFailed')
                    : t('generate.noImages')}
                </div>
              </div>
            )}

            {/* Top Overlay: Checkbox (Select Mode) and Preview Icon Button */}
            <div className={styles.overlayTop}>
              {selectMode && !isOpt ? (
                <button
                  type="button"
                  className={`${styles.checkboxBtn} ${isSelected ? styles.checkboxChecked : ''}`}
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
                  />
                </button>
              ) : <span />}

              {/* In multi-select mode, provide explicit small preview entry icon */}
              {selectMode && imageUrls.length > 0 && (
                <div className={styles.topRightActions}>
                  <button
                    type="button"
                    className={styles.previewBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      openPreview();
                    }}
                    title={t('generate.preview')}
                    aria-label={t('generate.preview')}
                  >
                    <Icon name="zoom-in" size={13} />
                  </button>
                </div>
              )}
            </div>

            {/* Bottom Overlay: Model badge, Status badge, Extra count */}
            <div className={styles.overlayBottom}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 }}>
                {isRunning ? (
                  <span className={`${styles.badge} ${styles.badgeRunning}`}>
                    <span className={styles.pulseDot} />
                    <span>{t('generate.statusRunning')}</span>
                  </span>
                ) : isFailed ? (
                  <span className={`${styles.badge} ${styles.badgeFailed}`}>
                    <Icon name="alert-triangle" size={10} />
                    <span>{t('generate.statusFailed')}</span>
                  </span>
                ) : null}

                {modelBadge && (
                  <span className={styles.badge} title={modelBadge}>
                    {modelBadge}
                  </span>
                )}
              </div>

              {extraCount > 0 && (
                <span className={styles.extraCountBadge}>+{extraCount}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
