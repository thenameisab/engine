# Engine — Design System & Motion Language

**Status:** v1.0 · Last updated 2026-07-14
**Companion to:** [Master PRD §7 K](00-Master-PRD.md) · [Architecture §1 L4](20-Architecture.md)
**Live reference:** [Pulse hero mockup](mockups/pulse.html) — the design as a working, interactive artifact.
**Sources:** Apple *Designing Fluid Interfaces* (apple-design), Emil Kowalski's design-engineering philosophy, iOS 26 Liquid Glass (translated to web).

> **The one-line design thesis:** *One number, then depth — rendered on honest glass.* Engine is an **instrument**, and its signature is **honesty**: every AI-influenced metric is shown as a **confidence range**, never a false-precise point. The single deliberate gradient on any screen is the confidence band. Everything else is quiet.

---

## 0. Why this matters (from the strategy)
The competitor teardown says measurement is table stakes; the moat is execution + trust. Design carries the *trust* half. Two incumbent UX failures we attack directly: **overwhelming dashboards** and **12-click navigation**. Our answer is progressive disclosure ("one number, then depth"), max-2-level IA, and confidence bands as a visible integrity signal. Beauty is leverage — "why can't all products look this good" is a growth strategy, not vanity.

---

## 1. Color

Neutrals are **cool, biased toward the azure accent** — chosen, not defaulted to grey. One accent. Semantic colors are separate from the accent and never used decoratively.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--accent` | `#2E6BF0` | `#4C86FF` | The single signal color. Solid — never a hero gradient. |
| `--good` | `#12A66A` | `#2FD79A` | Up / verified / positive delta |
| `--watch` | `#E0951F` | `#F0B450` | Watch / measuring |
| `--risk` | `#E0455E` | `#FF6B84` | Risk / negative delta |
| `--bg` / `--bg-2` | `#EAEEF6` / `#E1E7F2` | `#080B12` / `#0C1220` | Ground (cool, not grey) |
| `--text` / `--muted` / `--faint` | `#0E1526` / `#5A6478` / `#8A93A6` | `#EAEEF7` / `#9AA5BC` / `#626C82` | Type hierarchy |
| `--band` / `--band-edge` | `rgba(46,107,240,.16)` / `.42` | `rgba(76,134,255,.20)` / `.55` | **The confidence aura — the only signature gradient** |

**Rule:** the accent appears solid (marks, active nav, meters, endpoints). Gradients are reserved for (a) the confidence band and (b) the faint ambient wash behind glass. No purple→blue hero gradients, no acid-green pop, no decorative gradients on cards (deliberately avoiding the AI-default look).

**Both themes are first-class.** Palette lives as CSS custom properties; only tokens are redefined under `@media (prefers-color-scheme)` and `:root[data-theme]` (toggle wins over OS in both directions). Style components through tokens, never inside the media query.

---

## 2. Typography — the instrument voice

Engine is an instrument, so **every number and label is monospace** (`ui-mono`, tabular figures) — an instrument-panel readout. Prose and headings use the system UI face with Apple-grade optical craft.

| Role | Family | Treatment |
|---|---|---|
| Display / headings | `ui-sans-serif, system-ui` | weight 600–650, **tight negative tracking** (`-0.025em`), `text-wrap: balance` |
| Body | `ui-sans-serif, system-ui` | weight 400–500, leading ~1.5, ~65ch measure |
| **Data / metrics / labels** | `ui-monospace` | `font-variant-numeric: tabular-nums`; uppercase labels at `.09em` tracking |

Tracking is **size-specific** (tight on the 92px score, near-0 on body) — never one letter-spacing value everywhere. System font first: it already ships optical sizing and legibility tuning, and it keeps us honest with the apple-design lineage.

---

## 3. Material — Liquid Glass on the web

The iOS 26 Liquid Glass language, translated to the web via `backdrop-filter` (per apple-design §12). Glass is a **floating functional layer**, not decoration.

```css
.glass {
  background: var(--glass);                 /* light: .62 white · dark: .055 white */
  backdrop-filter: blur(22px) saturate(180%);
  border: 1px solid var(--hairline);
  border-top-color: var(--glass-edge);      /* bright top edge = light catching the material */
  box-shadow: var(--glass-shadow);          /* context-aware depth */
  border-radius: 22px;
}
```

**Rules carried from Liquid Glass + apple-design:**
- **Group glass, don't scatter it.** Related glass elements share a container (the web analog of `GlassEffectContainer`) — improves coherence and lets neighbors read as one material.
- **Never stack light glass on light glass** — legibility collapses. Chips inside a glass panel use a lighter fill, not another blur layer.
- **Bigger surface = thicker material** — stronger blur + deeper shadow than small chips.
- **Bright top edge** on every panel (light catching a real material).
- **Materialize, don't fade.** Glass enters by animating blur + scale + opacity together (§5), so it reads as a material arriving.
- **Dim to focus.** The ⌘K copilot pairs its glass with a dimming scrim and pushes the background back — a modal task. Parallel panels use translucency *without* a scrim.
- **Needs something to refract:** a faint ambient radial wash sits behind all glass so the blur has content to bend. Keep it subtle — never a loud gradient hero.
- **Ambient background must be re-checked for contrast** so vibrant text stays legible over it.

---

## 4. The confidence band — our visual signature

The honesty principle (PRD X1) made visible. Wherever an AI-influenced number appears, its **range** is shown:

- **On the hero score:** a horizontal band track (`68 ——●—— 76`) with the point marker glowing; the gradient fades at both ends to say "this is a range, not an edge."
- **On charts:** a translucent `--band` area is drawn *around* the trend line, not just the line. The line is the estimate; the band is the truth.
- **On chips:** AI Share of Model shows `44–52` with a `± range` tag; organic/local (measured, not sampled) show a single figure — the asymmetry itself teaches which numbers are sampled.

This is the one place we spend visual boldness. It is unique to Engine and structurally hard for false-precision competitors to copy without admitting their own uncertainty.

---

## 5. Motion language

Motion and visuals are designed together (apple-design §17); motion is never a layer added after. Governed by Emil's decision framework: **animate only with a purpose, keep UI motion <300ms, never animate keyboard-repeated actions.**

### Easing tokens
```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);   /* entrances, feedback — strong, punchy */
--ease-io:  cubic-bezier(0.77, 0, 0.175, 1);   /* on-screen movement / morphing */
```
Built-in CSS easings are too weak; use these. **Never `ease-in`** on UI (sluggish at the moment the user is watching).

### The rules we ship
| Interaction | Spec |
|---|---|
| Any pressable (button, chip, card, nav) | `:active { transform: scale(0.97) }`, ~120–160ms `ease-out` — instant "it heard me" feedback |
| Card / panel entrance | **Materialize**: `translateY(14px) + scale(.98) + blur(6px) → 0`, 600ms `ease-out`, **staggered 40–60ms** |
| Never from `scale(0)` | Entrances start at `scale(.95–.98)` + opacity — nothing appears from nothing |
| Hero score | Counts up 0→72 with an `ease-out` (cubic) curve, spring-like settle |
| ⌘K copilot | Materializes from `translateY(-8px) + scale(.965) + blur(8px)`, `transform-origin: top center`; scrim fades in; **Esc / click-out** closes |
| Fix Queue card hover | `translateY(-2px)` + shadow + brighter glass — telegraphs "grab me" |
| Live pulse dot | Expanding ring ping on the Fix Queue header — the one ambient loop, slow and quiet |
| Keyboard actions (⌘K toggle, nav) | **No open/close animation on repeat** — repeated actions must feel instant (Raycast principle) |

### Discipline
- **Only animate `transform` and `opacity`** (GPU; skips layout/paint). Meters/bands never animate `width` in hot paths.
- **CSS transitions over keyframes** for anything rapidly re-triggered (interruptible, retargetable).
- **Springs** reserved for gesture/drag and "alive" elements; bounce kept subtle (0.1–0.3) and only after momentum.
- Where we later add drag (Fix Queue reordering, sheets): 1:1 pointer tracking with capture, velocity handoff, momentum projection, rubber-banding at edges (apple-design §2–9).

---

## 6. Information architecture (max 2 levels)

Directly attacks the "12-click navigation" incumbent failure. Nav items are **named for their contents**, not vague umbrellas.

1. **Pulse** — the Unified Visibility Score, 30-day trend, top-3 wins, top-3 risks, Fix Queue count. Understood in 10 seconds.
2. **Visibility** — organic + AI + local under one shared filter bar (market / language / engine / device).
3. **Fix Queue** — the product's heart. Proposed → Approved → Deployed → Verified, each card showing predicted impact + effort.
4. **Content Studio** — briefs, drafting, extractability scoring, decay alerts.
5. **Reports & Copilot** — persistent ⌘K copilot on *every* screen, not buried in a tab.

**Role-adaptive views** (set at user level, switch instantly): Owner (plain-language, prioritized actions), Analyst (full tables, exports, query builder), Executive (trend + revenue attribution), Agency (multi-client grid + white-label toggle).

---

## 7. Performance & accessibility budget (non-negotiable)
- **FMP < 1.5s; every dashboard query < 500ms** (ClickHouse makes this real). Skeleton loading everywhere; offline-tolerant report viewing.
- `prefers-reduced-motion`: replace movement/blur entrances with short opacity fades; drop the score count-up (show final value); keep comprehension-aiding color/opacity.
- `prefers-reduced-transparency`: frostier/solid glass — raise background opacity, drop blur.
- `prefers-contrast: more`: near-solid panels with defined borders.
- Visible keyboard focus on every interactive element; `@media (hover: hover)` gates hover states so touch taps don't false-trigger them.
- Text on glass uses vibrancy discipline: higher contrast, slightly heavier weight, small tracking bump — never flat grey on a translucent surface.

---

## 8. Component inventory (v1)
Glass panel · glass chip / filter · nav item (rail) · floating topbar chrome · hero score + confidence band · trend chart with band · contribution cell (meter) · win/risk row (status dot + delta) · Fix Queue lane + card (kind / title / impact-effort pills) · ⌘K copilot (scrim + input + suggestions) · theme toggle · icon button.

Build stack (from blueprint): **React + TypeScript, Tailwind + custom token layer, Radix primitives, TanStack Query/Table, ECharts/visx for charts, Motion (Framer Motion) used sparingly.** The tokens and motion specs above map 1:1 onto that stack; the [Pulse mockup](mockups/pulse.html) is the reference implementation of the visual + motion language in plain HTML/CSS.

---

## 9. What we deliberately avoid
Generic AI-design tells: warm-cream + serif + terracotta, lone acid-green pop on near-black, purple→blue gradient hero, Inter/Space-Grotesk as the "safe" face, emoji as section markers, everything centered, `rounded-lg` on everything, decorative accent rails on cards. Engine's identity — mono instrument readouts, the confidence-band gradient as the *only* signature gradient, cool azure-biased neutrals, Liquid Glass depth — is chosen against those defaults.
