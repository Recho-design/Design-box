import { useEffect, useRef, useState } from 'react';
import {
  INSPIRE_IDEA_GROUPS,
  type InspireTranslateRequest,
  type InspireTranslateResponse,
} from '@open-design/contracts';
import { AlertCircle, Check, Lightbulb, Loader2, Sparkles, X } from 'lucide-react';
import styles from './GenerateInspirePopover.module.css';

export interface GenerateInspirePopoverProps {
  isOpen: boolean;
  onClose: () => void;
  currentPrompt: string;
  hasImage: boolean;
  selectedIdeaIds: Set<string>;
  onToggleIdea: (id: string) => void;
  onClearIdeas: () => void;
  onApplyPrompt: (newPrompt: string) => void;
  triggerRef?: React.RefObject<HTMLElement | null>;
}

export function GenerateInspirePopover({
  isOpen,
  onClose,
  currentPrompt,
  hasImage,
  selectedIdeaIds,
  onToggleIdea,
  onClearIdeas,
  onApplyPrompt,
  triggerRef,
}: GenerateInspirePopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [shouldRender, setShouldRender] = useState(isOpen);
  const [isExiting, setIsExiting] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // 协调 200ms 入场 / 140ms 退场动效周期
  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      setIsExiting(false);
    } else if (shouldRender) {
      setIsExiting(true);
      const timer = setTimeout(() => {
        setShouldRender(false);
        setIsExiting(false);
      }, 140);
      return () => clearTimeout(timer);
    }
  }, [isOpen, shouldRender]);

  // Click outside & Escape 键关闭处理
  useEffect(() => {
    if (!shouldRender || isExiting) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;

      if (popoverRef.current && popoverRef.current.contains(target)) {
        return;
      }
      if (triggerRef?.current && triggerRef.current.contains(target)) {
        return;
      }
      onClose();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [shouldRender, isExiting, onClose, triggerRef]);

  // 融合生成提示词
  const handleFusionSubmit = async () => {
    if (selectedIdeaIds.size === 0 || isLoading) return;

    setIsLoading(true);
    setErrorMessage(null);

    const reqBody: InspireTranslateRequest = {
      prompt: currentPrompt.trim() || undefined,
      ideaIds: Array.from(selectedIdeaIds),
      hasImage,
    };

    try {
      const res = await fetch('/api/media/inspire', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(reqBody),
      });

      if (res.status === 409) {
        throw new Error('未配置可用的文本模型，请先在设置中配置');
      }

      if (!res.ok) {
        const errorJson = await res.json().catch(() => null);
        const detailMsg =
          errorJson?.error?.message ||
          errorJson?.message ||
          errorJson?.error ||
          (typeof errorJson === 'string' ? errorJson : `请求失败 (${res.status})`);
        throw new Error(detailMsg);
      }

      const data: InspireTranslateResponse = await res.json();
      if (!data.prompt || !data.prompt.trim()) {
        throw new Error('服务返回的提示词为空，请重试');
      }

      onApplyPrompt(data.prompt);
      onClose();
    } catch (err: any) {
      setErrorMessage(err.message || '融合生成提示词失败');
    } finally {
      setIsLoading(false);
    }
  };

  if (!shouldRender) {
    return null;
  }

  const selectedCount = selectedIdeaIds.size;

  return (
    <div
      ref={popoverRef}
      className={`${styles.popoverContainer} ${isExiting ? styles.exiting : ''}`}
      role="dialog"
      aria-modal="false"
      aria-label="灵感思路拓展"
      onClick={(e) => e.stopPropagation()}
    >
      {/* 顶部标题与快捷操作 */}
      <div className={styles.popoverHeader}>
        <div className={styles.headerLeft}>
          <div className={styles.headerIcon}>
            <Lightbulb size={14} />
          </div>
          <span className={styles.headerTitle}>灵感拓展</span>
          {selectedCount > 0 && (
            <span className={styles.selectedBadge}>已选 {selectedCount}</span>
          )}
        </div>

        <div className={styles.headerRight}>
          {selectedCount > 0 && (
            <button
              type="button"
              className={styles.clearBtn}
              onClick={() => {
                onClearIdeas();
                setErrorMessage(null);
              }}
              disabled={isLoading}
            >
              清空
            </button>
          )}
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="关闭灵感面板"
            disabled={isLoading}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* 6 组创意维度 Chips 列表 */}
      <div className={styles.popoverBody}>
        {INSPIRE_IDEA_GROUPS.map((groupItem) => {
          const groupSelectedCount = groupItem.ideas.filter((idea) =>
            selectedIdeaIds.has(idea.id),
          ).length;

          return (
            <section key={groupItem.group} className={styles.groupBlock}>
              <div className={styles.groupHeader}>
                <span
                  className={`${styles.groupIndicator} ${
                    groupSelectedCount > 0 ? styles.groupIndicatorActive : ''
                  }`}
                />
                <span>{groupItem.group}</span>
                {groupSelectedCount > 0 && (
                  <span className={styles.groupCount}>({groupSelectedCount})</span>
                )}
              </div>

              <div className={styles.chipGrid}>
                {groupItem.ideas.map((idea) => {
                  const isSelected = selectedIdeaIds.has(idea.id);
                  return (
                    <button
                      key={idea.id}
                      type="button"
                      role="checkbox"
                      aria-checked={isSelected}
                      className={`${styles.ideaChip} ${
                        isSelected ? styles.ideaChipSelected : ''
                      }`}
                      title={idea.hint}
                      onClick={() => onToggleIdea(idea.id)}
                    >
                      {isSelected && <Check size={12} className={styles.chipCheckIcon} />}
                      <span>{idea.label}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      {/* 底部融合操作栏 */}
      <div className={styles.popoverFooter}>
        {errorMessage && (
          <div className={styles.errorBar} role="alert">
            <AlertCircle size={14} className={styles.errorIcon} />
            <span className={styles.errorText}>{errorMessage}</span>
          </div>
        )}

        <div className={styles.footerActions}>
          <div className={styles.footerHint}>
            {hasImage ? (
              <span>已关联参考图（侧重风格与氛围融合）</span>
            ) : (
              <span>点击思路卡片多选组合</span>
            )}
          </div>

          <button
            type="button"
            className={styles.submitBtn}
            disabled={selectedCount === 0 || isLoading}
            onClick={handleFusionSubmit}
          >
            {isLoading ? (
              <>
                <Loader2 size={13} className={styles.spinner} />
                <span>融合生成中...</span>
              </>
            ) : (
              <>
                <Sparkles size={13} />
                <span>融合生成提示词</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
