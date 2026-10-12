import { useMemo, type RefObject } from 'react';
import { Button, Input } from '@open-design/components';
import {
  GPT_IMAGE_ASPECTS,
  GPT_IMAGE_RESOLUTIONS,
  GPT_IMAGE_QUALITIES,
  isGptImageModel,
  gptImageSupportsTiers,
  gptImageSupportsXhighMax,
  gptImageSizeFor,
} from '@open-design/contracts';
import { useI18n } from '../i18n';
import { MEDIA_ASPECTS } from '../media/models';
import type { MediaProviderId } from '../media/models';
import { CustomSelect } from './CustomSelect';
import type { CustomSelectItem } from './CustomSelect';
import { Icon } from './Icon';
import styles from './GenerateView.module.css';

export interface GenerateToolbarParamsProps {
  fileInputRef: RefObject<HTMLInputElement>;
  uploadingImage: boolean;
  onFileSelect: (file: File) => void;

  selectedSource: MediaProviderId;
  sourceItems: CustomSelectItem[];
  onSourceChange: (source: MediaProviderId) => void;

  selectedModel: string;
  modelItems: CustomSelectItem[];
  onModelChange: (model: string) => void;

  /**
   * 本发会发给 daemon 的**目录 id**（`PlaygroundGenerateRequest.model`），不是 wire
   * 模型名。它决定能力分档与尺寸预览，所以必须与 `handleGenerate` 组装请求体时用的
   * 是同一个值 —— 见 daemon 侧 `buildOpenAIImageBody` 的同一条约定（PR #1309）。
   */
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
 * 负责分流不同生图源与模型的能力分档：
 * - OpenAI + GPT-Image 系列：显示比例（8档+自动）、分辨率（自动/1K/2K/4K）及尺寸预览、质量（自动/low..max）、审核（自动/低）、透明背景开关、数量
 * - OpenAI + DALL-E 系列：维持比例（5档）+ 数量
 * - 非 OpenAI 源（xAI / Nano Banana 等）：维持比例（5档）+ 数量，隐藏质量下拉（让 UI 诚实，daemon 本就不消费）
 *
 * **能力判据一律看目录 id，不看 wire 名。**用户把 openai 槽位指向自家兼容端点、
 * 或在工作台里手填一个别名（`my-image-model`）时，wire 名与目录 id 无关，而 daemon
 * 的能力分支（PR #1309）与质量词表都按目录 id 走 —— 用 wire 名判断会让全部新参数
 * 在界面上消失，而 daemon 照样把它们发出去。
 *
 * 根据规约，条件显示的控件全部保持 DOM 挂载并切换样式类，避免 DOM 重建引起抖动。
 */
export function GenerateToolbarParams({
  fileInputRef,
  uploadingImage,
  onFileSelect,
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

  // 比例选项：GPT 模型支持 8 档 + 自动，其余源维持通用 5 档
  const aspectOptions: CustomSelectItem[] = useMemo(() => {
    if (isGpt) {
      return [
        { value: 'auto', label: t('generate.aspectAuto') },
        ...GPT_IMAGE_ASPECTS.map((asp) => ({ value: asp, label: asp })),
      ];
    }
    return MEDIA_ASPECTS.map((asp) => ({ value: asp, label: asp }));
  }, [isGpt, t]);

  // 分辨率选项：gpt-image-1/mini 仅支持 auto/1K，其他 gpt-image 系列支持 2K/4K
  const resolutionOptions: CustomSelectItem[] = useMemo(() => {
    const supportsTiers = gptImageSupportsTiers(catalogModel);
    const resolutions = supportsTiers ? GPT_IMAGE_RESOLUTIONS : (['auto', '1K'] as const);
    return resolutions.map((res) => ({
      value: res,
      label: res === 'auto' ? t('generate.resolutionAuto') : res,
    }));
  }, [catalogModel, t]);

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
      {/* 隐藏的文件输入框，通过左侧按钮触发 */}
      <input
        type="file"
        ref={fileInputRef}
        className={styles.fileInputHidden}
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFileSelect(file);
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

      {/* 分辨率选择（仅 GPT-Image，带尺寸预览，保持挂载切 class） */}
      <div className={`${styles.paramItem} ${isGpt ? '' : styles.paramHidden}`.trim()}>
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

      {/* 透明背景开关（仅 GPT-Image，保持挂载切 class） */}
      <div className={`${styles.paramItem} ${isGpt ? '' : styles.paramHidden}`.trim()}>
        <Button
          type="button"
          variant={transparent ? 'primary' : 'secondary'}
          size="sm"
          className={styles.transparentToggle}
          onClick={() => onTransparentChange(!transparent)}
          aria-pressed={transparent}
        >
          {t('generate.transparent')}
        </Button>
      </div>

      {/* 生成张数输入 */}
      <div className={styles.paramItem}>
        <label htmlFor="gen-count" className={styles.paramLabel}>
          {t('generate.count')}
        </label>
        <Input
          id="gen-count"
          type="number"
          min={1}
          max={10}
          className={`${styles.paramInput} ${styles.paramInputCount}`}
          value={count}
          onChange={(e) => {
            const val = parseInt(e.target.value, 10);
            if (!isNaN(val)) onCountChange(Math.max(1, Math.min(10, val)));
          }}
        />
      </div>
    </div>
  );
}
