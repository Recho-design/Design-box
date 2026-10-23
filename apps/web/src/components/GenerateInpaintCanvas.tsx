import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { Button } from '@open-design/components';
import {
  Paintbrush,
  Undo2,
  RotateCcw,
  X,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import styles from './GenerateInpaintCanvas.module.css';

/** 笔迹数据结构：原图像素坐标 x1, y1, x2, y2... 与原图像素笔刷直径 */
export interface InpaintStroke {
  points: number[];
  size: number;
}

export interface GenerateInpaintCanvasProps {
  /** 原图访问 URL */
  imageUrl: string;
  /** 原图的参考提示词（可选） */
  originalPrompt?: string;
  /** 提交中加载状态 */
  isSubmitting?: boolean;
  /** 关闭弹窗回调 */
  onClose: () => void;
  /** 提交重绘：传入生成的 mask File 和重绘指令 */
  onSubmit: (maskFile: File, prompt: string) => Promise<void> | void;
}

export interface GenerateInpaintCanvasHandle {
  /** 导出 1:1 黑底白迹的 mask PNG 文件，无笔迹时返回 null */
  exportMaskFile: () => Promise<File | null>;
  /** 逐笔撤销 */
  undo: () => void;
  /** 清空画布 */
  clear: () => void;
  /** 当前是否有涂抹笔迹 */
  hasStrokes: () => boolean;
}

/** 绘制单条笔迹（带安全索引检查） */
function renderStrokeToContext(
  ctx: CanvasRenderingContext2D,
  stroke: InpaintStroke,
) {
  const pts = stroke.points;
  if (pts.length < 2) return;
  const p0 = pts[0];
  const p1 = pts[1];
  if (p0 === undefined || p1 === undefined) return;

  ctx.lineWidth = stroke.size;
  if (pts.length === 2) {
    ctx.beginPath();
    ctx.arc(p0, p1, stroke.size / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  // 起点圆帽
  ctx.beginPath();
  ctx.arc(p0, p1, stroke.size / 2, 0, Math.PI * 2);
  ctx.fill();

  // 连线
  ctx.beginPath();
  ctx.moveTo(p0, p1);
  for (let i = 2; i < pts.length; i += 2) {
    const px = pts[i];
    const py = pts[i + 1];
    if (px !== undefined && py !== undefined) {
      ctx.lineTo(px, py);
    }
  }
  ctx.stroke();

  // 终点圆帽
  const lastX = pts[pts.length - 2];
  const lastY = pts[pts.length - 1];
  if (lastX !== undefined && lastY !== undefined) {
    ctx.beginPath();
    ctx.arc(lastX, lastY, stroke.size / 2, 0, Math.PI * 2);
    ctx.fill();
  }
}
const BRUSH_SIZE_PRESETS = [
  { size: 12, label: '细', dotSize: 4 },
  { size: 22, label: '标准', dotSize: 7 },
  { size: 36, label: '中等', dotSize: 11 },
  { size: 54, label: '较粗', dotSize: 15 },
  { size: 78, label: '特粗', dotSize: 19 },
];

/** 计算 contain-fit 缩放比例与居中偏移 */
function getContainFitMetrics(
  containerWidth: number,
  containerHeight: number,
  naturalWidth: number,
  naturalHeight: number,
) {
  if (!containerWidth || !containerHeight || !naturalWidth || !naturalHeight) {
    return null;
  }
  const scale = Math.min(
    containerWidth / naturalWidth,
    containerHeight / naturalHeight,
  );
  const displayWidth = naturalWidth * scale;
  const displayHeight = naturalHeight * scale;
  const offsetX = (containerWidth - displayWidth) / 2;
  const offsetY = (containerHeight - displayHeight) / 2;
  return { scale, displayWidth, displayHeight, offsetX, offsetY };
}

export const GenerateInpaintCanvas = forwardRef<
  GenerateInpaintCanvasHandle,
  GenerateInpaintCanvasProps
>(function GenerateInpaintCanvas(
  { imageUrl, originalPrompt, isSubmitting = false, onClose, onSubmit },
  ref,
) {
  // 原图加载状态
  const [imageElement, setImageElement] = useState<HTMLImageElement | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  // 笔迹与画笔状态
  const [strokes, setStrokes] = useState<InpaintStroke[]>([]);
  const [brushIndex, setBrushIndex] = useState<number>(1); // 默认标准 22px
  const [prompt, setPrompt] = useState<string>('');
  const [formError, setFormError] = useState<string | null>(null);

  // 画布容器与指针状态
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stageSize, setStageSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const [isPointerInside, setIsPointerInside] = useState<boolean>(false);

  // 绘制中的当前单笔（用 ref 保证指针拖拽 60fps+ 不卡顿）
  const currentStrokeRef = useRef<InpaintStroke | null>(null);

  // 1. 加载原图（处理跨域及异常重试）
  useEffect(() => {
    let cancelled = false;
    setImageLoaded(false);
    setImageError(null);

    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      if (cancelled) return;
      setImageElement(img);
      setImageLoaded(true);
    };

    img.onerror = () => {
      if (cancelled) return;
      // 若 anonymous 失败，尝试免跨域声明重试
      const fallback = new Image();
      fallback.onload = () => {
        if (cancelled) return;
        setImageElement(fallback);
        setImageLoaded(true);
      };
      fallback.onerror = () => {
        if (cancelled) return;
        setImageError('加载原图失败，请检查网络或图片资源');
      };
      fallback.src = imageUrl;
    };

    img.src = imageUrl;

    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  // 2. 监听画布容器尺寸
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const updateSize = () => {
      const rect = stage.getBoundingClientRect();
      setStageSize({
        width: Math.floor(rect.width),
        height: Math.floor(rect.height),
      });
    };

    updateSize();

    const observer = new ResizeObserver(() => {
      updateSize();
    });
    observer.observe(stage);

    return () => observer.disconnect();
  }, []);

  // 3. 屏幕画布重绘函数
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imageElement;
    if (!canvas || !img || !img.naturalWidth || !img.naturalHeight) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cw = stageSize.width;
    const ch = stageSize.height;
    if (cw <= 0 || ch <= 0) return;

    const metrics = getContainFitMetrics(cw, ch, img.naturalWidth, img.naturalHeight);
    if (!metrics) return;
    const { scale, displayWidth, displayHeight, offsetX, offsetY } = metrics;

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

    // 同步高分屏物理像素尺寸
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      canvas.style.width = `${cw}px`;
      canvas.style.height = `${ch}px`;
    }

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    // 绘制底图
    ctx.drawImage(img, offsetX, offsetY, displayWidth, displayHeight);

    // 叠加半透明高亮笔迹
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    ctx.strokeStyle = 'rgba(243, 255, 71, 0.55)';
    ctx.fillStyle = 'rgba(243, 255, 71, 0.55)';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const strokesToRender = currentStrokeRef.current
      ? [...strokes, currentStrokeRef.current]
      : strokes;

    for (const stroke of strokesToRender) {
      renderStrokeToContext(ctx, stroke);
    }

    ctx.restore();
  }, [stageSize, imageElement, strokes]);

  useEffect(() => {
    redrawCanvas();
  }, [redrawCanvas]);

  // 4. 指针事件：支持鼠标与触摸绘制
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !imageElement) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    const metrics = getContainFitMetrics(
      stageSize.width,
      stageSize.height,
      imageElement.naturalWidth,
      imageElement.naturalHeight,
    );
    if (!metrics) return;
    const { scale, displayWidth, displayHeight, offsetX, offsetY } = metrics;

    // 仅当点击在图片有效范围内或紧邻边缘时开始绘制
    if (
      clientX < offsetX - 8 ||
      clientX > offsetX + displayWidth + 8 ||
      clientY < offsetY - 8 ||
      clientY > offsetY + displayHeight + 8
    ) {
      return;
    }

    canvas.setPointerCapture(e.pointerId);

    const origX = Math.max(0, Math.min(imageElement.naturalWidth, (clientX - offsetX) / scale));
    const origY = Math.max(0, Math.min(imageElement.naturalHeight, (clientY - offsetY) / scale));

    const displayBrushSize = BRUSH_SIZE_PRESETS[brushIndex]?.size ?? 22;
    const sizeInOrigImg = displayBrushSize / scale;

    currentStrokeRef.current = {
      points: [origX, origY],
      size: sizeInOrigImg,
    };

    setFormError(null);
    redrawCanvas();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    setCursorPos({ x: clientX, y: clientY });

    // 只更新光标预览时不需要换算坐标；正在绘制才做 contain-fit 反算。
    if (!currentStrokeRef.current || !imageElement) return;

    const metrics = getContainFitMetrics(
      stageSize.width,
      stageSize.height,
      imageElement.naturalWidth,
      imageElement.naturalHeight,
    );
    if (!metrics) return;
    const { scale, offsetX, offsetY } = metrics;

    const origX = Math.max(0, Math.min(imageElement.naturalWidth, (clientX - offsetX) / scale));
    const origY = Math.max(0, Math.min(imageElement.naturalHeight, (clientY - offsetY) / scale));

    const pts = currentStrokeRef.current.points;
    const lastX = pts[pts.length - 2];
    const lastY = pts[pts.length - 1];
    if (lastX === undefined || lastY === undefined) return;

    // 避免过密无意义点
    const distSq = (origX - lastX) ** 2 + (origY - lastY) ** 2;
    if (distSq >= 2) {
      pts.push(origX, origY);
      redrawCanvas();
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!currentStrokeRef.current) return;
    const stroke = currentStrokeRef.current;
    currentStrokeRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}

    if (stroke.points.length >= 2) {
      setStrokes((prev) => [...prev, stroke]);
    }
  };

  // 5. 导出 1:1 黑底白迹 Mask 文件
  const exportMaskFile = useCallback(async (): Promise<File | null> => {
    if (strokes.length === 0 || !imageElement) {
      return null;
    }
    const nw = imageElement.naturalWidth;
    const nh = imageElement.naturalHeight;
    if (!nw || !nh) return null;

    const offscreen = document.createElement('canvas');
    offscreen.width = nw;
    offscreen.height = nh;
    const oCtx = offscreen.getContext('2d');
    if (!oCtx) return null;

    // ① 纯黑底色 (#000000)
    oCtx.fillStyle = '#000000';
    oCtx.fillRect(0, 0, nw, nh);

    // ② 纯白笔迹 (#ffffff)
    oCtx.strokeStyle = '#ffffff';
    oCtx.fillStyle = '#ffffff';
    oCtx.lineCap = 'round';
    oCtx.lineJoin = 'round';

    for (const stroke of strokes) {
      renderStrokeToContext(oCtx, stroke);
    }

    return new Promise<File | null>((resolve) => {
      offscreen.toBlob((blob) => {
        if (!blob) {
          resolve(null);
          return;
        }
        const file = new File([blob], 'mask.png', { type: 'image/png' });
        resolve(file);
      }, 'image/png');
    });
  }, [strokes, imageElement]);

  const handleUndo = useCallback(() => {
    setStrokes((prev) => prev.slice(0, -1));
  }, []);

  const handleClear = useCallback(() => {
    setStrokes([]);
  }, []);

  // 暴露组件 handle
  useImperativeHandle(
    ref,
    () => ({
      exportMaskFile,
      undo: handleUndo,
      clear: handleClear,
      hasStrokes: () => strokes.length > 0,
    }),
    [exportMaskFile, handleUndo, handleClear, strokes.length],
  );

  // 6. 提交触发
  const handleStartInpaint = async () => {
    if (isSubmitting) return;

    if (strokes.length === 0) {
      setFormError('请先在画面上涂抹需要重绘的区域');
      return;
    }

    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setFormError('请输入重绘指令，描述你希望修改或生成的内容');
      return;
    }

    setFormError(null);
    const maskFile = await exportMaskFile();
    if (!maskFile) {
      setFormError('生成蒙版失败，请重试');
      return;
    }

    await onSubmit(maskFile, trimmedPrompt);
  };

  // 快捷键支持：Esc 关闭、Ctrl+Z 撤销、Ctrl+Enter 提交
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!isSubmitting) onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        handleUndo();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void handleStartInpaint();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isSubmitting, onClose, handleUndo, handleStartInpaint]);

  const currentBrushSize = BRUSH_SIZE_PRESETS[brushIndex]?.size ?? 22;

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      onClick={() => {
        if (!isSubmitting) onClose();
      }}
    >
      <div
        className={styles.dialog}
        onClick={(e) => e.stopPropagation()}
        data-testid="inpaint-modal-dialog"
      >
        {/* 左侧：画笔 Canvas 区域 */}
        <div className={styles.canvasColumn}>
          <div
            ref={stageRef}
            className={styles.canvasStage}
            onPointerEnter={() => setIsPointerInside(true)}
            onPointerLeave={() => {
              setIsPointerInside(false);
              setCursorPos(null);
            }}
          >
            {!imageLoaded && !imageError && (
              <div className={styles.loadingOverlay}>
                <Loader2 size={24} className="animate-spin" />
                <span>正在载入图片...</span>
              </div>
            )}

            {imageError && (
              <div className={styles.errorOverlay}>
                <AlertCircle size={28} />
                <span>{imageError}</span>
              </div>
            )}

            <canvas
              ref={canvasRef}
              className={styles.canvasElement}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            />

            {/* 鼠标画笔环形光标预览 */}
            {isPointerInside && cursorPos && (
              <div
                className={styles.brushCursorRing}
                style={{
                  left: `${cursorPos.x}px`,
                  top: `${cursorPos.y}px`,
                  width: `${currentBrushSize}px`,
                  height: `${currentBrushSize}px`,
                }}
              />
            )}

            {/* 底部状态胶囊 */}
            <div className={styles.canvasStatusBar}>
              <span className={styles.statusDot} />
              <span>
                {strokes.length > 0
                  ? `已绘制 ${strokes.length} 处涂抹`
                  : '在画面上按住拖拽以涂抹重绘区域'}
              </span>
            </div>
          </div>
        </div>

        {/* 右侧：画笔工具 + 指令输入 + 提交按钮 */}
        <aside className={styles.sidebarColumn}>
          <div className={styles.header}>
            <div className={styles.headerMeta}>
              <h2 className={styles.title}>局部重绘</h2>
              <p className={styles.subtitle}>
                用黄色高亮画笔涂抹原图中需要重新生成的区域，并输入重绘指令。
              </p>
            </div>
            <button
              type="button"
              className={styles.closeBtn}
              onClick={onClose}
              disabled={isSubmitting}
              aria-label="关闭"
              title="关闭 (Esc)"
            >
              <X size={15} />
            </button>
          </div>

          {/* 画笔粗细调节 */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionLabel}>画笔粗细</span>
              <span className={styles.sectionHint}>
                {BRUSH_SIZE_PRESETS[brushIndex]?.label} ({currentBrushSize}px)
              </span>
            </div>
            <div className={styles.brushSizeGrid}>
              {BRUSH_SIZE_PRESETS.map((preset, idx) => {
                const isActive = idx === brushIndex;
                return (
                  <button
                    key={preset.size}
                    type="button"
                    className={styles.brushSizeBtn}
                    data-active={isActive ? 'true' : 'false'}
                    onClick={() => setBrushIndex(idx)}
                    title={`${preset.label} (${preset.size}px)`}
                  >
                    <div className={styles.brushDotWrapper}>
                      <span
                        className={styles.brushDot}
                        style={{
                          width: `${preset.dotSize}px`,
                          height: `${preset.dotSize}px`,
                        }}
                      />
                    </div>
                    <span className={styles.brushSizeLabel}>{preset.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 画笔快捷操作 */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionLabel}>画笔操作</span>
            </div>
            <div className={styles.brushActionsRow}>
              <button
                type="button"
                className={styles.toolBtn}
                onClick={handleUndo}
                disabled={strokes.length === 0 || isSubmitting}
                title="撤销上一笔 (Cmd/Ctrl + Z)"
              >
                <Undo2 size={13} />
                <span>撤销</span>
              </button>
              <button
                type="button"
                className={styles.toolBtn}
                onClick={handleClear}
                disabled={strokes.length === 0 || isSubmitting}
                title="清空所有涂抹"
              >
                <RotateCcw size={13} />
                <span>清空</span>
              </button>
            </div>
          </div>

          {/* 指令输入 */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionLabel}>重绘指令</span>
            </div>
            <div className={styles.promptBox}>
              <textarea
                className={styles.promptTextarea}
                placeholder="例如：将涂抹区域修改为一朵绽放的红色山茶花，光影与周边自然融合..."
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.target.value);
                  if (formError) setFormError(null);
                }}
                disabled={isSubmitting}
                rows={4}
              />
              <div className={styles.promptFootnote}>
                <span>按 Cmd / Ctrl + Enter 快捷提交</span>
                {originalPrompt && (
                  <span title={originalPrompt} style={{ cursor: 'help' }}>
                    参考原提示词 ⓘ
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* 校验错误提示 */}
          {formError && (
            <div className={styles.errorBanner} role="alert">
              <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{formError}</span>
            </div>
          )}

          {/* 底部按钮 */}
          <div className={styles.footer}>
            <Button
              variant="secondary"
              size="sm"
              onClick={onClose}
              disabled={isSubmitting}
            >
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleStartInpaint()}
              disabled={isSubmitting || strokes.length === 0 || !prompt.trim()}
              data-testid="inpaint-submit-button"
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  <span>正在提交...</span>
                </>
              ) : (
                <>
                  <Paintbrush size={13} />
                  <span>开始局部重绘</span>
                </>
              )}
            </Button>
          </div>
        </aside>
      </div>
    </div>
  );
});
