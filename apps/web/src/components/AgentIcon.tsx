import type { CSSProperties } from 'react';

interface Props {
  id: string;
  size?: number;
  className?: string;
}

// Agents that ship a bundled brand asset under `apps/web/public/agent-icons/`.
// SVG is preferred (resolution-independent, single file ≤ a few KB); PNG is
// the fallback for vendors that don't publish an SVG mark anywhere. New brand:
// drop the optimised file in that folder and add the id here.
//
// Only ids the daemon can still report are listed. The eighteen CLIs retired
// in S5a are gone, and an id nothing can spawn must not keep an entry alive:
// a historical message that still carries one renders the letter pill below,
// which is the honest answer (same rule as `utils/agentLabels.ts`).
// `qoder` stays because it is still a handoff *editor* id, not a CLI.
const ICON_EXT: Record<string, 'svg' | 'png'> = {
  claude: 'svg',
  codex: 'svg',
  opencode: 'svg',
  deepseek: 'svg',
  'grok-build': 'svg',
  antigravity: 'svg',
  qoder: 'svg',
};

// Runtime variants that share the same vendor mark. Keep one bundled asset
// instead of duplicating identical SVG files under transport-specific ids.
const ICON_ASSET_ID: Record<string, string> = {
  'deepseek-harness': 'deepseek',
};

// SVG marks that are single-color silhouettes (no baked brand colors).
// Rendered as a CSS-masked `<span>` so `background-color: currentColor`
// can paint them in whatever text color the surrounding theme resolves
// to — light text under dark theme, dark text under light theme. The
// SVG file itself uses an explicit dark fill (`#1c1b1a`, baked) instead
// of `currentColor`, so if anything outside this component ever loads
// the asset through `<img>` it still renders as a legible dark mark
// rather than collapsing to the SVG document's default black-on-…-black.
const MONO_ICONS = new Set([
  'opencode',
  'grok-build',
]);

export function AgentIcon({ id, size = 36, className }: Props) {
  const cls = 'agent-icon' + (className ? ' ' + className : '');
  const assetId = ICON_ASSET_ID[id] ?? id;
  const ext = ICON_EXT[assetId];
  if (ext) {
    if (ext === 'svg' && MONO_ICONS.has(assetId)) {
      const src = `/agent-icons/${assetId}.svg`;
      const style: CSSProperties = {
        width: size,
        height: size,
        WebkitMaskImage: `url("${src}")`,
        maskImage: `url("${src}")`,
      };
      return (
        <span
          className={cls + ' agent-icon-mono'}
          style={style}
          aria-hidden="true"
        />
      );
    }
    return (
      <img
        src={`/agent-icons/${assetId}.${ext}`}
        alt=""
        width={size}
        height={size}
        className={cls}
        aria-hidden="true"
        draggable={false}
      />
    );
  }
  // Fallback for brands we don't ship artwork for. A neutral rounded
  // square with the initial letter — reads as "no official mark yet"
  // without inventing brand artwork we can't license.
  const initial = (id.match(/[a-z]/i)?.[0] ?? '?').toUpperCase();
  return (
    <span
      className={cls + ' agent-icon-fallback'}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        lineHeight: 1,
      }}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}
