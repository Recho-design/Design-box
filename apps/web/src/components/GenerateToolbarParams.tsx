import { useMemo } from 'react';
import {
  GPT_IMAGE_ASPECTS,
  GPT_IMAGE_RESOLUTIONS,
  GPT_IMAGE_QUALITIES,
  isGptImageModel,
  gptImageSupportsTiers,
  gptImageSupportsXhighMax,
  gptImageSizeFor,
  NANO_BANANA_ASPECTS,
  NANO_BANANA_RESOLUTIONS,
} from '@open-design/contracts';
import { useI18n } from '../i18n';
import { MEDIA_ASPECTS } from '../media/models';
import type { MediaProviderId } from '../media/models';
import { CustomSelect } from './CustomSelect';
import type { CustomSelectItem } from './CustomSelect';
import styles from './GenerateView.module.css';

export interface GenerateToolbarParamsProps {
  selectedSource: MediaProviderId;
  sourceItems: CustomSelectItem[];
  onSourceChange: (source: MediaProviderId) => void;

  selectedModel: string;
  modelItems: CustomSelectItem[];
  onModelChange: (model: string) => void;

  catalogModel: string;

  aspect: string;
  onAspectChange: (aspect: string) => void;

  resolution: string;
  onResolutionChange: (resolution: string) => void;

  quality: string;
  onQualityChange: (quality: string) => void;

  moderation: string;
  onModerationChange: (moderation: string) => void;

  transparent: boolean;
  onTransparentChange: (transparent: boolean) => void;

  count: number;
  onCountChange: (count: number) => void;
}

/**
 * 生图工作台底部控制台工具栏参数区。
 *
 * 负责分流不同生图源与模型的能力分档，并组织为三个清晰逻辑分组：
 * 1. 模型与源：生图源 + 模型
 * 2. 画面规格：比例 + 分辨率（带尺寸预览） + 质量 + 审核
 * 3. 输出选项：透明背景 + 张数
 *
 * 能力分档：
 * - OpenAI (GPT-Image): 比例 8 档+auto、分辨率分档支持 1K/2K/4K、质量、审核、透明背景、尺寸预览
 * - Nano Banana: 比例 10 档+auto、分辨率 auto/1K/2K/4K、无质量/审核/透明
 * - 其他源 (Grok 等): 比例 5 档、无分辨率/质量/审核/透明
 *
 * 根据规约，条件显示的控件全部保持 DOM 挂载并切换样式类，避免 DOM 重建引起抖动。
 */
export function GenerateToolbarParams({
  selectedSource,
  sourceItems,
  onSourceChange,
  selectedModel,
  modelItems,
  onModelChange,
  catalogModel,
  aspect,
  onAspectChange,
  resolution,
  onResolutionChange,
  quality,
  onQualityChange,
  moderation,
  onModerationChange,
  transparent,
  onTransparentChange,
  count,
  onCountChange,
}: GenerateToolbarParamsProps) {
  const { t } = useI18n();

  // 判定当前是否属于 GPT-image 系列模型（目录 id）
  const isGpt = selectedSource === 'openai' && isGptImageModel(catalogModel);
  const isNano = selectedSource === 'nanobanana';

  // 比例选项：GPT 模型支持 8 档 + 自动，Nano Banana 支持 10 档 + 自动，其余源维持通用 5 档
  const aspectOptions: CustomSelectItem[] = useMemo(() => {
    if (isGpt) {
      return [
        { value: 'auto', label: t('generate.aspectAuto') },
        ...GPT_IMAGE_ASPECTS.map((asp) => ({ value: asp, label: asp })),
      ];
    }
    if (isNano) {
      return [
        { value: 'auto', label: t('generate.aspectAuto') },
        ...NANO_BANANA_ASPECTS.map((asp) => ({ value: asp, label: asp })),
      ];
    }
    return MEDIA_ASPECTS.map((asp) => ({ value: asp, label: asp }));
  }, [isGpt, isNano, t]);

  // 分辨率选项：Nano Banana 支持 auto/1K/2K/4K；gpt-image-1/mini 仅支持 auto/1K，其他 gpt-image 系列支持 2K/4K
  const resolutionOptions: CustomSelectItem[] = useMemo(() => {
    if (isNano) {
      return NANO_BANANA_RESOLUTIONS.map((res) => ({
        value: res,
        label: res === 'auto' ? t('generate.resolutionAuto') : res,
      }));
    }
    const supportsTiers = gptImageSupportsTiers(catalogModel);
    const resolutions = supportsTiers ? GPT_IMAGE_RESOLUTIONS : (['auto', '1K'] as const);
    return resolutions.map((res) => ({
      value: res,
      label: res === 'auto' ? t('generate.resolutionAuto') : res,
    }));
  }, [catalogModel, isNano, t]);

  // 计算具体尺寸预览（两档都为具体值时通过 gptImageSizeFor 计算）
  const calculatedSize = useMemo(() => {
    if (!isGpt || aspect === 'auto' || resolution === 'auto') return undefined;
    return gptImageSizeFor(catalogModel, aspect, resolution);
  }, [isGpt, catalogModel, aspect, resolution]);

  // 质量选项：gpt-image-2 系才有 xhigh/max，旧版无；其余源不展示质量
  const qualityOptions: CustomSelectItem[] = useMemo(() => {
    const supportsXhighMax = gptImageSupportsXhighMax(catalogModel);
    const qualities = supportsXhighMax
      ? GPT_IMAGE_QUALITIES
      : (['auto', 'low', 'medium', 'high'] as const);
    return qualities.map((q) => ({
      value: q,
      label: q === 'auto' ? t('generate.qualityAuto') : q,
    }));
  }, [catalogModel, t]);

  // 审核选项（自动/低）
  const moderationOptions: CustomSelectItem[] = useMemo(
    () => [
      { value: 'auto', label: t('generate.moderationAuto') },
      { value: 'low', label: t('generate.moderationLow') },
    ],
    [t],
  );

  return (
    <div className={styles.paramGroup}>
      {/* 分组 1：模型与生成源 */}
      <div className={styles.paramSection}>
        {/* 生图源选择 */}
        <div className={styles.paramItem}>
          <span className={styles.paramLabel}>{t('generate.sourceLabel')}</span>
          <CustomSelect
            className={styles.sourceSelect}
            value={selectedSource}
            options={sourceItems}
            onChange={(v) => onSourceChange(v as MediaProviderId)}
            ariaLabel={t('generate.sourceLabel')}
          />
        </div>

        {/* 模型选择 */}
        <div className={`${styles.paramItem} ${styles.paramItemModel}`}>
          <span className={styles.paramLabel}>{t('generate.modelLabel')}</span>
          <CustomSelect
            value={selectedModel}
            options={modelItems}
            onChange={onModelChange}
            ariaLabel={t('generate.modelLabel')}
          />
        </div>
      </div>

      <span className={styles.toolbarDivider} />

      {/* 分组 2：画面规格参数 */}
      <div className={styles.paramSection}>
        {/* 比例选择（GPT 8档+自动，其他源 5档） */}
        <div className={styles.paramItem}>
          <span className={styles.paramLabel}>{t('generate.aspect')}</span>
          <CustomSelect
            className={styles.aspectSelect}
            value={aspect}
            options={aspectOptions}
            onChange={onAspectChange}
            ariaLabel={t('generate.aspect')}
          />
        </div>

        {/* 分辨率选择（GPT-Image 与 Nano Banana，带尺寸预览，保持挂载切 class） */}
        <div className={`${styles.paramItem} ${isGpt || isNano ? '' : styles.paramHidden}`.trim()}>
          <span className={styles.paramLabel}>{t('generate.resolution')}</span>
          <CustomSelect
            className={styles.resolutionSelect}
            value={resolution}
            options={resolutionOptions}
            onChange={onResolutionChange}
            ariaLabel={t('generate.resolution')}
          />
          {calculatedSize && (
            <span
              className={styles.sizePreviewBadge}
              title={t('generate.sizePreview', { size: calculatedSize })}
            >
              {t('generate.sizePreview', { size: calculatedSize })}
            </span>
          )}
        </div>

        {/* 质量选择（仅 GPT-Image 显示，dall-e 与非 openai 隐藏，保持挂载切 class） */}
        <div className={`${styles.paramItem} ${isGpt ? '' : styles.paramHidden}`.trim()}>
          <span className={styles.paramLabel}>{t('generate.quality')}</span>
          <CustomSelect
            className={styles.qualitySelect}
            value={quality}
            options={qualityOptions}
            onChange={onQualityChange}
            ariaLabel={t('generate.quality')}
          />
        </div>

        {/* 审核选择（仅 GPT-Image，保持挂载切 class） */}
        <div className={`${styles.paramItem} ${isGpt ? '' : styles.paramHidden}`.trim()}>
          <span className={styles.paramLabel}>{t('generate.moderation')}</span>
          <CustomSelect
            className={styles.moderationSelect}
            value={moderation}
            options={moderationOptions}
            onChange={onModerationChange}
            ariaLabel={t('generate.moderation')}
          />
        </div>
      </div>

      <span className={styles.toolbarDivider} />

      {/* 分组 3：输出选项（透明背景开关、生成张数） */}
      <div className={styles.paramSection}>
        {/* 透明背景开关（仅 GPT-Image，保持挂载切 class） */}
        <div className={`${styles.paramItem} ${isGpt ? '' : styles.paramHidden}`.trim()}>
          <button
            type="button"
            className={`${styles.transparentToggle} ${transparent ? styles.transparentToggleActive : ''}`}
            onClick={() => onTransparentChange(!transparent)}
            aria-pressed={transparent}
            title={t('generate.transparent')}
          >
            <span className={styles.transparentDot} />
            <span>{t('generate.transparent')}</span>
          </button>
        </div>

        {/* 生成张数输入 */}
        <div className={styles.paramItem}>
          <label htmlFor="gen-count" className={styles.paramLabel}>
            {t('generate.count')}
          </label>
          <input
            id="gen-count"
            type="number"
            min={1}
            max={10}
            className={styles.paramInputCount}
            value={count}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val)) onCountChange(Math.max(1, Math.min(10, val)));
            }}
          />
        </div>
      </div>
    </div>
  );
}
