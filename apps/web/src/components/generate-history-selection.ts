import type { CardItem } from './GenerateCard';
import type { PlaygroundGeneration, PlaygroundGenerationFile } from '@open-design/contracts';
import type { Dict } from '../i18n/types';

export type GenerateViewMode = 'stream' | 'grid' | 'list';

export const GENERATE_VIEW_STORAGE_KEY = 'open-design:generate-view-mode';

/**
 * 判断卡片是否支持被批量选择管理。
 * 乐观卡（未落库）与运行中的生成任务均不可选中。
 */
export function isCardSelectable(card: CardItem): card is PlaygroundGeneration {
  if ('isOptimistic' in card) return false;
  return card.status !== 'running';
}

/**
 * 提取当前已加载卡片中所有可选记录的 ID 列表。
 */
export function getSelectableIds(cards: CardItem[]): string[] {
  const ids: string[] = [];
  for (const card of cards) {
    if (isCardSelectable(card)) {
      ids.push(card.id);
    }
  }
  return ids;
}

/**
 * 判断当前是否已全选所有已加载的可选记录。
 */
export function isAllSelected(selectableIds: string[], selected: Set<string>): boolean {
  if (selectableIds.length === 0) return false;
  return selectableIds.every((id) => selected.has(id));
}

/**
 * 切换某条记录的选中状态。
 */
export function toggleSelection(selected: Set<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

/**
 * 全选 / 取消全选切换：
 * 若当前已全选，则取消全选（移除已加载的可选项）；否则全部选中已加载的可选项。
 */
export function toggleSelectAll(selectableIds: string[], selected: Set<string>): Set<string> {
  const next = new Set(selected);
  const allSelected = isAllSelected(selectableIds, selected);
  if (allSelected) {
    for (const id of selectableIds) {
      next.delete(id);
    }
  } else {
    for (const id of selectableIds) {
      next.add(id);
    }
  }
  return next;
}

/**
 * 记录的可预览图片 URL 列表（排除失败槽位与无名占位）。
 *
 * 网格/列表视图共用的封面推导。slot 必须用**原始 `card.files` 下标**（与卡片流
 * GenerateCard 的约定一致）：scratch URL 按槽位取字节，过滤后重排会让部分失败
 * 批次的 URL 指到错误的槽位上。失败槽位与无名文件在 daemon 侧必然 404，不进
 * URL 列表，由视图渲染占位态。
 */
export function getCardImageUrls(
  card: CardItem,
  getFileUrl: (card: CardItem, file: PlaygroundGenerationFile, slotIndex: number) => string,
): string[] {
  if (!card.files) return [];
  return card.files.flatMap((file, slot) =>
    file.error || !file.name ? [] : [getFileUrl(card, file, slot)],
  );
}

/**
 * 人性化相对时间格式化，复用 common 多语言键。
 */
export function formatRelativeTime(
  ts: number,
  t: (key: keyof Dict, vars?: Record<string, string | number>) => string,
): string {
  const diff = Date.now() - ts;
  const min = 60 * 1000;
  const hr = 60 * min;
  const day = 24 * hr;

  if (diff < min) return t('common.justNow');
  if (diff < hr) return t('common.minutesAgo', { n: Math.max(1, Math.floor(diff / min)) });
  if (diff < day) return t('common.hoursAgo', { n: Math.max(1, Math.floor(diff / hr)) });
  if (diff < 7 * day) return t('common.daysAgo', { n: Math.max(1, Math.floor(diff / day)) });
  return new Date(ts).toLocaleDateString();
}
