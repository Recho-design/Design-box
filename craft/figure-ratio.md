# Figure ratio craft rules

Image-area ratio benchmarks, cropping disciplines, and layout container contracts across commercial surfaces.
> Opt in via `od.craft.requires: [figure-ratio]`.

---

## What is figure ratio

The **figure ratio** (image-to-canvas ratio) is the percentage of the total layout occupied by imagery, photography, or illustrative focal blocks. It dictates the emotional temperature of a design: high ratios create visceral, immersive urgency; low ratios create intellectual, restrained luxury.

---

## Commercial intent & target ratio tiers

| Tier | Ratio range | Commercial posture | Typical surfaces | Core behavioral rule |
|---|---|---|---|---|
| **Low** | 10%–30% | Restrained, intellectual, luxury, architectural confidence. | Haute horlogerie, art monographs, executive essays, private equity. | Single focal subject surrounded by expansive negative space. The void is an active design element. Never add decorative clutter to "fill" space. |
| **Balanced** | 40%–60% | Pragmatic, objective, credible, informative. | SaaS landing pages, documentation hubs, corporate overviews, editorial magazines. | Strict 50/50 or 60/40 grid alignment. Image serves as direct explanatory proof, not merely decorative wallpaper. |
| **High** | 70%–90% | Visceral, energetic, commercial, emotionally driven. | Social campaign posters, e-commerce drops, lifestyle editorial, entertainment. | Photography fills the frame. Text must be overlaid on the image and protected with contrast scrims. |
| **Extreme (Bleed)** | 95%–100% | Cinematic, experiential, visceral immersion. | Film posters, festival key art, vinyl album covers, full-screen heroes. | Edge-to-edge full bleed. Minimalist typography (<5% area) pinned to the perimeter; image tells the entire story. |

---

## Subject scale vs container scale

Do not confuse the **image container size** with the **subject mass**:

- **Subject scale inside the container**: A full-bleed image container (100% ratio) with a tiny product sitting in the center (occupying only 15% of pixels) behaves perceptually as a **Low figure ratio**.
- **Cropping & close-ups**: A 50% split container featuring an extreme macro close-up of a human eye behaves perceptually as a **High figure ratio**.
- **Rule of thumb**: Measure the visual weight of the *active subject* plus its immediate bounding tone, not just the bounding box `<div>`.

---

## Measurable CSS implementation techniques

Translate target ratios into explicit CSS geometry instead of loose guesses.

### 1. Flex & Grid dimensional ratios
```css
/* Balanced 60/40 editorial split */
.editorial-grid {
  display: grid;
  grid-template-columns: 3fr 2fr; /* 60% image, 40% text */
  gap: var(--grid-gutter, 24px);
  align-items: center;
}

/* Low figure ratio luxury layout */
.luxury-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: calc(var(--container-padding) * 2);
}
.luxury-image-slot {
  width: 28%; /* Strictly capped figure ratio */
  max-width: 360px;
}
```

### 2. Strict aspect-ratio contracts
Never allow images to render at unpredictable aspect ratios that collapse layout bounds:
- **Vertical social cards**: `aspect-ratio: 3 / 4` or `4 / 5` (`1080×1440` or `1080×1350`).
- **Mobile story / poster**: `aspect-ratio: 9 / 16` (`1080×1920`).
- **Square posts & badges**: `aspect-ratio: 1 / 1`.
- **Widescreen editorial hero**: `aspect-ratio: 16 / 9` or `21 / 9`.

### 3. Object-fit and focal protection
```css
.card-media-hero {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center 30%; /* Protects faces/heads from top-edge clipping */
}
```

### 4. High-ratio legibility scrims
When figure ratio exceeds **70%**, text placed over photography must be shielded with an engineered gradient scrim. A flat 20% opacity wash looks cheap; use a multi-stop directional curve:
```css
.scrim-overlay {
  background: linear-gradient(
    to top,
    rgba(0, 0, 0, 0.85) 0%,
    rgba(0, 0, 0, 0.45) 45%,
    rgba(0, 0, 0, 0) 100%
  );
}
```

---

## Degradation modes & linting checks

| Failure mode | Symptom | Defensive remediation |
|---|---|---|
| **Stretched low-res** | 80%+ figure ratio populated by low-resolution blurry raster assets. | Drop figure ratio to <=30% with an enclosed card; emphasize typography instead. |
| **Stamp-sized luxury** | Intended low figure ratio, but image is shrunk to <8% area with cluttered copy. | Enlarge image to 18%–24% area; enforce clean negative space margin around it. |
| **Unshielded hero text** | High-ratio image with body copy or buttons sitting over high-frequency contrast noise. | Add an engineered gradient scrim or place text into a frosted token container (`backdrop-filter: blur(12px)`). |
| **Timid middle split** | Split layout sitting at 50/50 without establishing whether the image or copy leads. | Shift split decisively to 65/35 (`2fr 1fr`) or 35/65 (`1fr 2fr`). |
