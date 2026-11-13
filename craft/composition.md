# Composition craft rules

Structural layout armatures for posters, key visuals, marketing cards, and editorial surfaces.
> Opt in via `od.craft.requires: [composition]`.

---

## The core contract

Composition governs eye velocity, gaze direction, and visual weight distribution across the canvas.

1. **One dominant archetype.** Select exactly one primary composition archetype per canvas. Mixing armatures is permitted only when one is declared dominant (holding >=60% of the visual space) and the second is explicitly subordinate.
2. **Deterministic eye path.** Every composition must author a clear progression: Entry Point (where the eye lands first within 0.5s) -> Trajectory (guided secondary path) -> Anchor (resting zone or call-to-action).
3. **No accidental center.** If an element sits in the geometric center, it must be the deliberate hero. If it is offset, the offset must be pronounced (>=10% off-axis) so it reads as intentional asymmetry rather than an alignment error.
4. **Token integration.** Margin and padding must bind to OpenDesign layout tokens: safe canvas margins use `var(--container-padding, 32px)` or `calc(var(--spacing) * 4)`, while structural gutters use `var(--grid-gutter, 24px)`.

---

## The 11 composition archetypes

### 1. Centered symmetry (中心对称)
- **When to use**: High-end luxury branding, formal exhibition covers, ceremonial invitations, single-hero product showcases.
- **Core constraints**: Shared vertical central axis (`align-items: center; text-align: center;`); lateral balance across left and right flanks; place optical center at `top: 45%–48%`, slightly above mathematical center to avoid visual sagging.
- **Degenerate case**: Rigid, tombstone-like stiffness; elements feel pinned without room to breathe; secondary labels clutter the symmetry.

### 2. Asymmetric diagonal (非对称对角)
- **When to use**: Athletic sports campaigns, music festivals, kinetic product launches, high-energy disruptive marketing.
- **Core constraints**: Dominant diagonal axis (typically 30°–45° or corner-to-corner trajectory); place a heavy counterweight anchor in the opposing corner (e.g., top-left title countered by bottom-right CTA badge) to prevent tipping.
- **Degenerate case**: Canvas feels like it is sliding off-screen; unanchored rotation looks like an accidental CSS transform glitch; multi-line text rotated off-axis becomes unreadable.

### 3. Broken grid (网格破坏)
- **When to use**: Contemporary editorial, tech brand manifestos, avant-garde portfolios, experimental typography.
- **Core constraints**: An underlying 3-to-6 column CSS grid must be established first; exactly 1 or 2 hero elements deliberately overlap columns, breach track boundaries, or extend into margins (`margin-left: -2rem`).
- **Degenerate case**: Total structural disintegration resembling an unstyled HTML document with broken floats; viewer cannot infer the underlying grid order.

### 4. Scatter (散点式)
- **When to use**: Cultural festival line-ups, creative agency showcases, youth lifestyle collages, experimental art covers.
- **Core constraints**: Minimum 5–8 distributed micro-elements; canvas negative space must exceed 60%; elements must cluster along an invisible curved or diagonal vector with strict grouping proximity (`gap: 12px` inside clusters vs `48px+` between clusters).
- **Degenerate case**: Visual noise resembling randomly tossed debris or desktop clutter; eye wanders aimlessly with zero landing focus.

### 5. Triangle (三角形)
- **When to use**: Enduring institutional brands, tri-pillar feature announcements, classical balance, architectural stability.
- **Core constraints**: Form a pyramid (broad heavy base tapering to a single apex) or an inverted funnel; apex carries the primary title or central crest; base corners anchor supporting proof points; preserve equal bilateral negative space at shoulders.
- **Degenerate case**: Top-heavy inverted imbalance causing visual vertigo; forced geometric triangle shapes that awkwardly truncate text copy.

### 6. Nine-palace grid (九宫格)
- **When to use**: Curated artifact galleries, multi-attribute feature matrices, classical Eastern symmetry, structured editorial.
- **Core constraints**: 3×3 proportional grid derived from the Rule of Thirds (`grid-template: repeat(3, 1fr) / repeat(3, 1fr)`); primary focal points must anchor strictly at the 4 intersection nodes; at least 1–2 cells must remain entirely empty as negative space relief.
- **Degenerate case**: Rigid tic-tac-toe boxiness; uniform density across all 9 cells flattening all hierarchy and killing narrative progression.

### 7. Enveloping (包围式)
- **When to use**: Precious single-object hero cards, commemorative awards, framed manifestos, collector edition packaging.
- **Core constraints**: Outer boundary consists of framing typography, date stamps, or hairline decorative rules (`border: 1px solid var(--border)`); center hosts an isolated hero island; maintain a clear buffer moat of `>=32px` between frame and subject.
- **Degenerate case**: Claustrophobic crowding; peripheral borders constrict the hero element; outer text turns into a distracting prison wall.

### 8. Curve (曲线式)
- **When to use**: Organic wellness, beauty and cosmetics, flowing narratives, beverage packaging, musical events.
- **Core constraints**: A continuous S-curve or C-curve trajectory guides the gaze from corner to opposing corner; elements alternate in size along crests and troughs; text blocks remain horizontally oriented even if positioned along the curve.
- **Degenerate case**: Weak, meandering composition lacking punchy anchor points; feels mushy and ungrounded; wrapping sentences along severe curved paths ruins legibility.

### 9. Split / Segmentation (分割式)
- **When to use**: Editorial publications, dual-narrative product comparisons, before/after showcases, structured content cards.
- **Core constraints**: Explicit dividing boundary or gutter; ratio must be asymmetrical (Golden ratio `1:1.618`, `2:1`, or `3:1` via `grid-template-columns: 2fr 1fr`); avoid 50/50 splits unless authoring a strict, direct binary comparison.
- **Degenerate case**: Stiff split-screen with zero tension; equal 50/50 division splits attention into two competing micro-pages with no clear starting point.

### 10. Four-corner anchor (四角式)
- **When to use**: Fashion lookbooks, cinematic posters, high-production photography cards, streetwear graphics.
- **Core constraints**: The four outer corners host compact metadata, timestamps, or category badges (`position: absolute; top/bottom/left/right: var(--container-padding)`); canvas center is reserved for an expansive hero visual occupying `>=70%` of canvas area.
- **Degenerate case**: Missing visual center leaves a gaping hole; corner tags float too far inward looking misplaced; disjointed metadata feels like four disconnected apps.

### 11. Minimalist / Extreme void (极简式)
- **When to use**: Luxury apparel, architectural monographs, high-conviction brand manifestos, premium hardware.
- **Core constraints**: Extreme negative space (`>=75%–85%` pure background); hero subject occupies `<15%–20%` area; single crisp typography lockup with high typographic refinement; zero decorative lines or badge gimmicks.
- **Degenerate case**: Empty, abandoned canvas resembling an incomplete wireframe; typography lacks scale confidence and looks lost in the void.

---

## Composition selection & decision matrix

| Business context | Recommended archetype | Figure ratio target | Primary eye path |
|---|---|---|---|
| Luxury / High-end | Centered symmetry or Minimalist | 15%–30% | Center-downward or Golden anchor |
| Kinetic / Campaign | Asymmetric diagonal | 55%–75% | Diagonal slash (top-left -> bottom-right) |
| Editorial / Content | Split / Segmentation or Nine-palace | 40%–60% | Left-to-right columnar flow |
| Event / Cultural | Scatter or Broken grid | 30%–50% | Clustered constellation flow |
| Hero Visual / Fashion | Four-corner anchor or Enveloping | 70%–85% | Radial outward from center |

---

## Defensive layout rules

- **No dual-primary clash**: Never place two competing visual heroes of equal mass on opposite quadrants. One element must dominate.
- **Safe-margin guard**: Never position critical readable copy closer than `24px` (`var(--container-padding)`) to the canvas boundary.
- **Asymmetric conviction**: If an element is offset from the center axis, ensure an offset of at least `10%` of the viewport width. Offsets smaller than `5%` read as sloppy CSS misalignments.
- **Subordinate blending**: When combining two archetypes (e.g. Split layout with Centered symmetry inside the content column), the secondary archetype must stay strictly contained within its assigned module.
