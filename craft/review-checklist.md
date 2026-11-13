# Review checklist craft rules

Build-time defensive invariants and structural gate checks to eliminate defects before rendering.
> Opt in via `od.craft.requires: [review-checklist]`.

---

## Defensive charter

**Defect detector, not an aesthetics judge.** This file strictly halts structural defects, contrast failures, broken reading paths, and clutter regressions. It does not police artistic style, expressive flair, or subjective visual taste.

Because generative models author artifacts sequentially rather than in an interactive feedback loop, these rules are **generative build-time invariants** to bake directly into layout authoring, not post-hoc inspection chores.

> **Scope boundary**: This checklist strictly excludes physical viewing-distance tests (e.g. "simulate viewing from 3 meters away") and physical print-scale tests. All checks are screen-bounded and geometrically verifiable in code.

---

## The three structural invariants

Every authored visual surface must satisfy all three invariants before code emission.

### 1. Luminance contrast invariant (明度对比不变量)
Text legibility must never depend on hue divergence alone. The relative luminance differential between any text string and its immediate background container must guarantee clear hierarchy even if the surface is rendered in 100% monochrome grayscale.

- **Body copy ratio**: All body text (14px–18px) and interactive form inputs must maintain a minimum contrast ratio of **>= 4.5:1** against their background (WCAG AA standard).
- **Display & large headings**: Headings (>=24px regular or >=18.5px bold) must maintain a minimum contrast ratio of **>= 3:1**.
- **Dark / Light token pairing**:
  - Light mode: `color: var(--fg)` on `background-color: var(--bg)` or `var(--surface)`. Muted text `var(--muted)` must stay above `#71717a` (on white) to maintain `>= 4.5:1`.
  - Dark mode: `color: var(--fg)` on dark surfaces; muted text must stay above `#a1a1aa` (on `#09090b`) to avoid disappearing.
  - Accent text: `color: var(--accent)` must only be used on backgrounds where its calculated luminance delivers `>= 4.5:1`. If `--accent` is high-chroma yellow or light green, it cannot carry white text; if dark blue/purple, it cannot carry dark text.
- **Overlay protection**: Text superimposed on photography, illustration, or mesh gradients must be backed by an engineered contrast scrim (e.g. multi-stop black-to-transparent gradient) or token backdrop blur (`backdrop-filter: blur(12px)`). Never drop raw white text directly onto raw photography.
- *Relation to accessibility*: Layer directly on top of `accessibility-baseline.md`.

### 2. Requirement traceability invariant (需求回溯不变量)
Every visual composition must rigorously anchor the brief's functional essentials within protected bounds.

- **Single level-1 entry point**: Exactly **one** Level-1 Primary Element (the core value proposition or headline hero) must exist on the canvas. If two competing headlines are both styled at display scale, the layout fails.
- **Mandatory elements presence**: Required brief elements (e.g., brand logo mark, primary action button, scan target / QR code placeholder, legal disclaimer) must be explicitly rendered in the DOM with proper semantics.
- **Safe-zone boundary**: Mandatory elements must never bleed off-edge or hug the canvas perimeter. They must sit firmly inside the safe perimeter margin:
  - Mobile cards / Moments: `inset >= 24px` (`calc(var(--spacing) * 3)`).
  - Desktop web / Posters: `inset >= 48px` (`calc(var(--spacing) * 6)`).

### 3. Redundancy reduction invariant (冗余删减不变量)
Visual clutter is an engineering failure. Every non-text visual entity on screen must earn its right to exist.

- **Single visual anchor**: Exactly **one core visual anchor** (hero illustration, focal screenshot, or display headline lockup) may command top hierarchy. Secondary cards, widgets, and badges must be visually quieter.
- **The line deletion test**: Examine every divider rule (`<hr>`, `border-bottom`, `border-left`), card outline, and decorative container. If removing the physical border leaves the semantic grouping obvious through spatial proximity alone, **delete the border immediately**.
- **Whitespace over ink**: Prioritize modular whitespace (8px grid multiples: 16px, 24px, 32px, 48px) over physical container boxes, borders, and tinted chips. Group related items with `gap-2` (8px) and separate distinct groups with `gap-8` (32px) or `gap-12` (48px).

---

## Heuristic note: The squint / block-out test

> **Mental heuristic**: When planning code structure, abstract every line of copy into a solid gray rectangular bar and every image into a single tone block.
> - Does gaze naturally land on the Level-1 block within 0.5 seconds?
> - Is there an obvious, uninterrupted reading vector leading toward the primary call-to-action or terminal anchor?
> - If all text blocks look equally thick and gray, hierarchy has collapsed into noise. Increase scale and spacing contrast immediately.

---

## Build-time gate matrix

Run this parameter checklist during component assembly:

| Check category | Passing condition | Defect trigger (FAIL) |
|---|---|---|
| **Luminance contrast** | Text contrast ratio >= 4.5:1 (body) or >= 3:1 (headings) against exact background token. | Text relies on hue alone (e.g. red text on green button); white text directly over unshielded photo. |
| **Hierarchy singularity** | Exactly 1 dominant entry point; secondary headers scaled down by >= 1.5× ratio. | 2 or 3 competing headers all set at 32px+ or `font-bold` in the same fold. |
| **Essential traceability** | Logo, main heading, and primary CTA present and placed within safe margin (`>=24px`). | CTA pushed beyond visible canvas boundary; missing essential brand logo. |
| **Container redundancy** | Borderless groups separated cleanly by 8-point whitespace multiples (`gap-6`, `gap-8`). | Cards inside cards inside cards; dividers placed between every single list row. |
| **Token fidelity** | Colors and type scales bind to `var(--fg)`, `var(--bg)`, `var(--accent)`, `var(--font-display)`. | More than 3 raw hex values outside `:root`; hardcoded Tailwind default indigo accents. |
