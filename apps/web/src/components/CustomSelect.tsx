import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

export interface CustomSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface CustomSelectGroup {
  label: string;
  options: CustomSelectOption[];
}

export type CustomSelectItem = CustomSelectOption | CustomSelectGroup;

interface Props {
  value: string;
  options: CustomSelectItem[];
  onChange: (value: string) => void;
  ariaLabel: string;
  labelledBy?: string;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  disabled?: boolean;
  placeholder?: string;
  portal?: boolean;
  title?: string;
  onFocus?: () => void;
}

interface FlatOption extends CustomSelectOption {
  group?: string;
}

interface MenuPosition {
  /** 向下展开：菜单上缘 = 触发器下缘 + gap。 */
  top?: number;
  /** 向上展开：菜单下缘 = 触发器上缘 - gap（bottom 锚定，菜单自然贴住触发器，
   * 不再按 maxHeight 预留高度悬空）。 */
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
}
/**
 * 量 menu 自身需占的最小宽度：在 body 挂一个不可见的测量副本，逐个读
 * option 行的自然宽（行 padding + check 列 + gap，与 `.od-select-menu` /
 * `.od-select-option` 的现行值对齐），取 max。动态内容（provider 拉回的
 * 模型 id、项目名）量出来才是准的 —— 与主界面 type-pill 行的探针量宽
 * 同一思路：量自然宽度，而不是把 menu 钉死在触发器宽度上。
 */
function measureMenuNaturalWidth(options: CustomSelectItem[]): number {
  const menu = document.createElement('div');
  menu.className = 'od-select-menu portal';
  menu.style.position = 'fixed';
  menu.style.visibility = 'hidden';
  menu.style.width = 'auto';
  menu.style.left = '-9999px';
  menu.style.top = '0';
  // 入场动画起始帧是 scale(0.93)，不关掉会把量出的宽度打 93 折。
  menu.style.animation = 'none';
  // 测量行：按钮外壳用 flex 造不出 grid 列（check 图标列 16px + gap 8px），
  // 直接补进增量里更稳 —— 见函数尾。
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'od-select-option';
  button.style.display = 'flex';
  button.style.width = 'auto';
  button.style.whiteSpace = 'nowrap';
  document.body.appendChild(menu);
  let max = 0;
  try {
    for (const item of options) {
      const entries = isGroup(item) ? item.options : [item];
      for (const option of entries) {
        button.textContent = option.label;
        menu.appendChild(button);
        max = Math.max(max, button.getBoundingClientRect().width);
      }
    }
  } finally {
    document.body.removeChild(menu);
  }
  // 量的按钮自带行 padding×2（16），再补：check 列 16 + grid gap 8 + menu
  // padding×2 (8) + 边框 2 + 滚动条余量 16（overflow-y:auto，Windows 经典
  // 滚动条出现时不把最宽项挤截断）。
  return Math.ceil(max) + 16 + 8 + 8 + 2 + 16;
}

function isGroup(item: CustomSelectItem): item is CustomSelectGroup {
  return 'options' in item;
}

function flattenOptions(items: CustomSelectItem[]): FlatOption[] {
  return items.flatMap((item) =>
    isGroup(item)
      ? item.options.map((option) => ({ ...option, group: item.label }))
      : [item],
  );
}

export function CustomSelect({
  value,
  options,
  onChange,
  ariaLabel,
  labelledBy,
  className,
  triggerClassName,
  menuClassName,
  disabled = false,
  placeholder,
  portal = true,
  title,
  onFocus,
}: Props) {
  const reactId = useId();
  const idBase = reactId.replace(/:/g, '');
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(false);
  const activeSourceValueRef = useRef(value);
  const [open, setOpen] = useState(false);
  const [activeValue, setActiveValue] = useState(value);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const flatOptions = useMemo(() => flattenOptions(options), [options]);
  const selected = flatOptions.find((option) => option.value === value);
  const selectedLabel = selected?.label ?? placeholder ?? value;
  const enabledOptions = useMemo(
    () => flatOptions.filter((option) => !option.disabled),
    [flatOptions],
  );
  const flatOptionsRef = useRef(flatOptions);
  flatOptionsRef.current = flatOptions;
  const optionIdByValue = useMemo(
    () => new Map(flatOptions.map((option, index) => [option.value, `${idBase}-option-${index}`])),
    [flatOptions, idBase],
  );
  const activeOptionId = open && activeValue ? optionIdByValue.get(activeValue) : undefined;

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const gap = 4;
    const viewportPad = 12;
    // 菜单最窄与触发器同宽（选中框与选项视觉对齐）；选项文字更长时按自然
    // 内容宽度撑开，不再把文字截在触发器宽度里。主界面 type-pill 行的
    // popover 同款思路：`width: max-content` 量宽，而非钉死在触发器上。
    const naturalWidth = measureMenuNaturalWidth(flatOptionsRef.current);
    const width = Math.max(rect.width, naturalWidth);
    const left = Math.min(
      Math.max(viewportPad, rect.left),
      Math.max(viewportPad, window.innerWidth - width - viewportPad),
    );
    const below = window.innerHeight - rect.bottom - viewportPad;
    const above = rect.top - viewportPad;
    const maxHeight = Math.max(160, Math.min(300, Math.max(below, above) - gap));
    const openAbove = below < 180 && above > below;
    // 向上展开用 `bottom` 锚定：菜单高度是内容高（≤ maxHeight），bottom 定
    // 位让它贴住触发器；top + maxHeight 会按最大高度预留，短菜单就悬空了。
    setPosition(
      openAbove
        ? { bottom: window.innerHeight - rect.top + gap, left, width, maxHeight }
        : { top: rect.bottom + gap, left, width, maxHeight },
    );
  }, []);

  useEffect(() => {
    if (!portal) return;
    if (!open) {
      setPosition(null);
      return;
    }
    updatePosition();
  }, [open, portal, updatePosition]);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      activeSourceValueRef.current = value;
      return;
    }
    if (wasOpenRef.current && activeSourceValueRef.current === value) return;
    const selectedOption = flatOptionsRef.current.find((option) => option.value === value && !option.disabled);
    setActiveValue(selectedOption?.value ?? enabledOptions[0]?.value ?? '');
    wasOpenRef.current = true;
    activeSourceValueRef.current = value;
  }, [open, value, enabledOptions]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onScrollOrResize = () => {
      if (portal) updatePosition();
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open, portal]);

  const choose = (nextValue: string) => {
    const next = flatOptions.find((option) => option.value === nextValue);
    if (!next || next.disabled) return;
    onChange(next.value);
    setOpen(false);
    buttonRef.current?.focus();
  };

  const moveActive = (direction: 1 | -1) => {
    if (!enabledOptions.length) return;
    const currentIndex = enabledOptions.findIndex((option) => option.value === activeValue);
    const nextIndex =
      currentIndex < 0
        ? 0
        : (currentIndex + direction + enabledOptions.length) % enabledOptions.length;
    setActiveValue(enabledOptions[nextIndex]!.value);
  };

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) {
        choose(activeValue || value);
      } else {
        setOpen(true);
      }
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  const menu = (
    <div
      ref={menuRef}
      id={`${idBase}-menu`}
      className={[
        'od-select-menu',
        portal ? 'portal' : 'inline',
        menuClassName,
      ].filter(Boolean).join(' ')}
      role="listbox"
      aria-label={ariaLabel}
      style={
        portal && position
          ? ({
              top: position.top,
              bottom: position.bottom,
              left: position.left,
              width: position.width,
              maxHeight: position.maxHeight,
            } as CSSProperties)
          : undefined
      }
    >
      {options.map((item) => {
        if (isGroup(item)) {
          return (
            <div className="od-select-group" key={`group:${item.label}`}>
              <div className="od-select-group-label">{item.label}</div>
              {item.options.map((option) => (
                <SelectOptionButton
                  key={option.value}
                  option={option}
                  selected={option.value === value}
                  active={option.value === activeValue}
                  id={optionIdByValue.get(option.value)}
                  onChoose={choose}
                  onActive={setActiveValue}
                />
              ))}
            </div>
          );
        }
        return (
          <SelectOptionButton
            key={item.value}
            option={item}
            selected={item.value === value}
            active={item.value === activeValue}
            id={optionIdByValue.get(item.value)}
            onChoose={choose}
            onActive={setActiveValue}
          />
        );
      })}
    </div>
  );

  return (
    <div className={['od-select', className].filter(Boolean).join(' ')}>
      <button
        ref={buttonRef}
        type="button"
        className={['od-select-trigger', triggerClassName].filter(Boolean).join(' ')}
        role="combobox"
        value={value}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${idBase}-menu`}
        aria-activedescendant={activeOptionId}
        aria-describedby={labelledBy}
        aria-label={`${ariaLabel}: ${selectedLabel}`}
        disabled={disabled}
        title={title}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onButtonKeyDown}
        onFocus={onFocus}
      >
        <span id={`${idBase}-value`} className="od-select-value">
          {selectedLabel}
        </span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open ? (portal ? (position ? createPortal(menu, document.body) : null) : menu) : null}
    </div>
  );
}

function SelectOptionButton({
  option,
  selected,
  active,
  id,
  onChoose,
  onActive,
}: {
  option: CustomSelectOption;
  selected: boolean;
  active: boolean;
  id?: string;
  onChoose: (value: string) => void;
  onActive: (value: string) => void;
}) {
  return (
    <button
      id={id}
      type="button"
      className={[
        'od-select-option',
        selected ? 'selected' : '',
        active ? 'active' : '',
      ].filter(Boolean).join(' ')}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      disabled={option.disabled}
      onMouseEnter={() => onActive(option.value)}
      onClick={() => onChoose(option.value)}
    >
      <span className="od-select-option-label">{option.label}</span>
      <span className="od-select-option-check" aria-hidden>
        <Icon name="check" size={14} />
      </span>
    </button>
  );
}
