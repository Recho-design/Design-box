# Typographic treatments craft rules

Specialized display techniques and expressive typographic manipulations for posters, hero banners, and editorial focal points.
> Opt in via `od.craft.requires: [typographic-treatments]`.

---

## Brake valve contract — limits on expressive typography

Expressive typographic treatments are high-potency design tools. They are the exception, never the default.

1. **The 1–2 ceiling.** An artifact may employ at most **1 or 2 decorative treatments** across the entire visible surface. Using 3 or more treatments in a single view produces cacophony, destroying hierarchy and professional polish.
2. **Default to unadorned hierarchy.** Unless the brief explicitly demands expressive display design (such as a campaign poster, album cover, or brand hero), the default layout must remain clean, disciplined type hierarchy as specified in `typography.md` and `typography-hierarchy.md`.
3. **Division of labor with `anti-ai-slop`:**
   - **`typographic-treatments.md`** governs *how to execute* an expressive treatment correctly with mathematical precision, numerical thresholds, and optical harmony once chosen.
   - **`anti-ai-slop.md`** governs *prohibition and restraint*, preventing AI cliches, unmotivated decorations, illegible overlays, and decorative clutter. If a treatment does not serve content structure, `anti-ai-slop` demands its deletion.

---

## CJK and Latin dual-typographic rules

Treatments must respect the anatomical divergence between Latin and CJK scripts. Never apply Latin rules directly to Hanzi:

| Dimension | Latin rules | CJK (Chinese / Japanese / Korean) rules |
|---|---|---|
| **Tracking (letter-spacing)** | ALL CAPS requires `0.06em` to `0.1em`. Display text uses negative tracking (`-0.01em` to `-0.03em`). | Tracking must remain `0` on headlines (glyphs already fill square em-boxes). Never use negative tracking on CJK. Captions may use `0.01em` to `0.02em`. |
| **Leading (line-height)** | Display headlines can go tight to `1.0`–`1.2` due to ascender/descender buffers. | Multi-line headlines require `1.3`–`1.4` minimum to prevent severe glyph collision. Body text requires `1.6`–`1.8`. |
| **Emphasis mechanism** | Italicization, small caps, or all-caps tracking. | Italic and all-caps do not exist. Use weight steps (e.g. 400 vs 700/800), point-size jumps, or color value contrast. |
| **Punctuation & borders** | Proportional punctuation; kerning pairs adjust automatically. | Full-width punctuation; avoid placing punctuation at line starts (kinsoku shori / line-break discipline). |

---

## The 8 high-frequency treatments

### 1. Bilingual layering (`bilingual-layering`)
- **What it does**: Pairs primary and secondary language lockups (e.g. Chinese headline + English secondary title) into an integrated dual-core unit rather than a machine-translated afterthought.
- **When to use**: International brand campaigns, cultural exhibitions, bilingual magazine covers, global product hero headers.
- **Hard constraints**:
  - Primary language holds **60%–70%** visual weight; secondary holds **30%–40%** (scale ratio between `2.5:1` and `4:1`).
  - Colors must bifurcate: primary uses high-contrast text color (`var(--fg)`); secondary uses muted opacity (`color: var(--muted)` or `opacity: 0.5–0.7`).
  - Each language block must form an independent bounding group; gap between groups must be strictly smaller than the outer margin.

### 2. Front-back stacking (`front-back-stacking`)
- **What it does**: Positions massive low-contrast background lettering behind sharp foreground copy to generate spatial depth and texture.
- **When to use**: Editorial covers, music festival key art, streetwear lookbooks, athletic branding.
- **Hard constraints**:
  - Scale disparity: background display lettering must be **3× to 8×** the font size of the foreground text.
  - Opacity ceiling: background text opacity must sit strictly between `0.15` and `0.35` (`opacity: 0.25`). Anything above `0.4` obliterates foreground contrast.
  - Stroke clearance: foreground copy must anchor in the open negative space of the background glyphs, never intersecting heavy stroke crossings. Background text must maintain semantic relevance (not random gibberish).

### 3. Color block backing (`color-block-backing`)
- **What it does**: Backs key words, price anchors, or kicker labels with solid or semi-transparent rectangular or pill containers to guarantee contrast and draw immediate focus.
- **When to use**: Text placed over busy photography, promotional hero tags, event dates, high-priority status badges.
- **Hard constraints**:
  - Symmetrical padding: inline padding must be `8px–16px`, block padding `4px–8px` (`padding: 0.25em 0.6em;`).
  - Contrast threshold: text against the color block must strictly achieve `>= 4.5:1` luminance contrast ratio (e.g. `#ffffff` text on `var(--accent)`).
  - Surface cap: maximum **1 or 2 backed elements** per screen. All blocks on a surface must share the same `border-radius` token (e.g. `var(--radius-sm)` or `9999px` pill).

### 4. Baseline shift (`baseline-shift`)
- **What it does**: Shifts the alignment baseline between adjacent words, numbers, or units within a single headline to create micro-rhythm without altering narrative order.
- **When to use**: Large numerical statistics with currency or unit symbols (e.g. `$99/mo`, `10x`), editorial chapter headings, bilingual brand marks.
- **Hard constraints**:
  - Shift threshold: the baseline vertical offset must be `>= 0.3×` the height of the smaller glyph. Shifting by less than `0.2×` looks like an accidental alignment bug.
  - Max baseline sets: strictly limit to **2 baseline levels** in one lockup (e.g., primary base + superscript unit). Never use 3 or more competing baselines.
  - Horizontal proximity: horizontal gap between shifted elements must be `<= 0.3ch` to keep the typographic unit grouped.

### 5. Whitespace framing (`whitespace-framing`)
- **What it does**: Encloses a disciplined, tight typographic lockup within an expansive ocean of clean negative space, projecting calm authority and luxury.
- **When to use**: High-end luxury brands, architectural monograph covers, executive manifestos, minimalist landing heroes.
- **Hard constraints**:
  - Negative space ratio: the typography block must occupy **<= 30%** of the canvas area, leaving **>= 70%** as completely unoccupied negative space.
  - Placement: anchor the text block at the upper third or optical center (`top: 38%–45%`). Never place it dead center or jammed against an edge.
  - Zero filler: strictly 0 decorative floaters, floating icons, or background pattern meshes inside the negative space field.

### 6. Vertical-horizontal mix (`vertical-horizontal-mix`)
- **What it does**: Crosses a vertical typographic column with a horizontal reading line at 90 degrees, creating architectural stability and dynamic reading flow.
- **When to use**: Eastern cultural posters, tea and craftsmanship branding, contemporary architecture programs, artistic editorial.
- **Hard constraints**:
  - Character limit: vertical text runs must be limited to **2–6 characters** (CJK) or short stacked acronyms in Latin (`writing-mode: vertical-rl`). Never set continuous English prose vertically.
  - Orthogonal anchor: the vertical column and horizontal line must intersect or align along an explicit grid axis; clear gap between axes must be `<= 50%` of character width.
  - Hierarchy dominance: declare one axis dominant (e.g. vertical main title at 64px vs horizontal subtitle at 16px). Never make both axes equal in scale.

### 7. Typeface contrast (`typeface-contrast`)
- **What it does**: Mixes two visually polarized typefaces within a single title lockup (e.g., expressive serif + neutral grotesque, or brush script + mono).
- **When to use**: Dual-personality branding, cultural fusion events, thought-leadership editorial headers.
- **Hard constraints**:
  - Font limit: exactly **2 typefaces** allowed per artifact. Never use 3 distinct families.
  - Dominance ratio: the visual area ratio must follow **70% primary / 30% secondary** (`7:3`). Never split the title 50/50 between two typefaces.
  - Shared anchor: both typefaces must share either identical font weight (e.g. both Bold) or identical optical cap-height/baseline to prevent visual jitter.

### 8. Small-text supplement (`small-text-supplement`)
- **What it does**: Pairs an oversized display headline with dense, finely calibrated micro-metadata (coordinates, catalog numbers, dates, editorial tags) to establish high textural contrast.
- **When to use**: Technical product launches, Swiss-style posters, high-fashion campaign cards, exhibition catalogs.
- **Hard constraints**:
  - Size floor: font size must sit in the **11px–13px** bracket (using `var(--font-mono)` or `var(--font-sans)`). Never go below `10px` on screen.
  - Letter-spacing: small Latin text requires positive tracking of `0.02em` to `0.05em` (`tracking-wider`).
  - Line limit: small-text annotation blocks must not exceed **3 lines**. They must sit within `1.5×` line height distance from the headline they annotate.

---

## Decision checklist

Before finalizing an expressive typographic treatment, verify:
- [ ] Are there **<= 2** decorative treatments active across this entire screen?
- [ ] If using Latin uppercase, is `letter-spacing >= 0.06em` applied?
- [ ] If using CJK headlines, is line-height `>= 1.3` and tracking set to `0`?
- [ ] Does every text element achieve `>= 4.5:1` contrast against its backing surface?
- [ ] Would removing the treatment leave the information hierarchy intact? If not, fix the underlying hierarchy first.
