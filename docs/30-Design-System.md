# Engine — Design System & Motion Language

**Status:** v2.0 · Last updated 2026-07-14
**Companion to:** [Master PRD §7 K](00-Master-PRD.md) · [Architecture §1 L4](20-Architecture.md)
**Live reference:** [Pulse mockup](mockups/pulse.html) — the design as a working, interactive artifact.
**Lineage:** the flat, functional product-UI tradition — **Linear, Notion, GitHub, Stripe.** Design serves the task; the tool disappears into the work.

> **The one-line design thesis:** *One number, then depth — rendered plainly.* Engine is an **instrument**, and its signature is **honesty**: every AI-influenced metric is shown as a **confidence range**, never a false-precise point. The interface itself is quiet — flat surfaces, hairline borders, one restrained accent — so the data is the only thing that speaks.

> **v2.0 note:** this replaces the earlier Liquid-Glass language. We removed translucency, backdrop-blur, ambient color washes, and materialize/blur choreography in favor of a flat, dense, functional aesthetic. The rationale: Engine is a task surface people live in daily; earned familiarity and legibility beat spectacle. Beauty here is *restraint done precisely*, not material effects.

---

## 0. Why this matters (from the strategy)
The competitor teardown says measurement is table stakes; the moat is execution + trust. Design carries the *trust* half. Two incumbent UX failures we attack directly: **overwhelming dashboards** and **12-click navigation**. Our answer is progressive disclosure ("one number, then depth"), max-2-level IA, and confidence bands as a visible integrity signal. The bar (per the product register) is: would a user fluent in Linear / Notion / Stripe sit down and *trust* this interface immediately, or pause at every subtly-off component? We aim for instant trust.

---

## 1. Color

**True neutrals — not tinted toward the accent.** A clean gray ramp on a near-white canvas (light) or near-black canvas (dark), in the GitHub/Linear tradition. One accent, used only for primary actions, current selection, links, and focus — never decoration. Semantic colors are separate and used sparingly on data.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--accent` | `#2f6feb` | `#4d84ff` | The single interaction color (primary action, selection, link, focus). Solid — never a gradient. |
| `--accent-wash` | `#eef3fe` | `#16223c` | Low-emphasis accent fill: active nav, selected rows |
| `--good` | `#1a7f52` | `#3fb27f` | Up / verified / positive delta |
| `--watch` | `#9a6700` | `#d0a215` | Watch / measuring |
| `--risk` | `#cf3049` | `#f2607a` | Risk / negative delta |
| `--bg` | `#f7f8fa` | `#0d0f12` | App canvas |
| `--surface` / `--surface-2` | `#ffffff` / `#f1f2f4` | `#16181d` / `#1d2026` | Panels/cards · insets/hover fills |
| `--text` / `--muted` / `--faint` | `#1a1d21` / `#616a75` / `#8b95a1` | `#e7e9ec` / `#9aa2ad` / `#6b7480` | Type hierarchy |
| `--border` / `--border-strong` | `#e4e7eb` / `#d3d8de` | `#262a31` / `#333842` | Hairline structure · hover/emphasis edges |

**Rules:**
- **Structure comes from borders, not shadows.** Panels and cards are a solid `--surface` with a 1px `--border`. Elevation exists only where something genuinely floats (popover, modal, command bar) via one soft `--shadow-pop`.
- **Body text hits ≥4.5:1.** `--muted` is the floor for secondary text on `--surface`; never lighter for "elegance."
- **The accent is rationed.** Roughly ≤10% of any screen. Active nav uses `--accent-wash` + accent text, not a saturated fill.
- **Both themes are first-class.** Tokens redefine under `@media (prefers-color-scheme)` and `:root[data-theme]` (explicit toggle wins over OS in both directions). Components read tokens only — never hard-coded colors, never values inside the media query.

---

## 2. Typography — the instrument voice

One sans family (`system-ui` stack) carries headings, labels, buttons, and body. A **monospace** face (`ui-mono`, tabular figures) is reserved for what is literally data: metrics, deltas, counts, keyboard hints. That mono/sans split is the "instrument readout" signature — but labels are **sentence case**, not the uppercase-tracked eyebrows of v1.

| Role | Family | Treatment |
|---|---|---|
| Page heading (h1) | `system-ui` | 20px, weight 600, tracking −0.01em |
| Panel heading (h3) | `system-ui` | 13.5px, weight 600 |
| Body / labels | `system-ui` | 13–14px, weight 400–550, sentence case |
| **Data / metrics / hints** | `ui-monospace` | `font-variant-numeric: tabular-nums`; the hero score at 46px, cell values at 24px |

**Fixed rem scale, not fluid clamp** (product register: users view at consistent DPI; a shrinking sidebar heading looks worse). Tight ~1.15–1.2 ratio between steps — many type elements here, so exaggerated contrast just adds noise. Prose caps at 65–75ch; dense data can run tighter.

---

## 3. Surfaces — flat, bordered, dense

No glass, no blur, no translucency as decoration. Surfaces are opaque and defined by hairlines.

```css
.panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;           /* 6/8/10 scale — tight, not pill-round */
}
/* elevation only where something truly floats */
.copilot { box-shadow: var(--shadow-pop); border: 1px solid var(--border-strong); }
```

**Rules:**
- **One radius scale, small:** `--r-sm 6` · `--r 8` · `--r-lg 10`. Nothing pill-shaped except status counts and meters.
- **Dividers over gaps** for related groups: the Fix Queue lanes are separated by 1px borders, not floating cards with shadows.
- **Second neutral layer** (`--bg` inside a `--surface`) marks insets — contribution cells, Fix Queue cards — instead of another elevation tier.
- **The one permitted blur** is a 6px backdrop on the sticky topbar so scrolled content doesn't muddy it — a functional legibility aid, not a material.
- **No side-stripe accent borders, no gradient text, no glass cards, no ambient washes.** (See §9.)

---

## 4. The confidence band — our visual signature

The honesty principle (PRD X1) made visible, now rendered *flat*. Wherever an AI-influenced number appears, its **range** shows — but as plain, legible data viz, not a glowing gradient:

- **On the hero score:** a thin bordered range bar beside the number — a filled inner segment (`68 ▓ 76`) with a solid accent tick at the point estimate. No glow, no shadow.
- **On charts:** a quiet shaded area is drawn *around* the trend line (a low-opacity accent fill), so the band reads as "the truth is in here," the line as the estimate.
- **On cells:** AI Share of Model shows `44–52` with a neutral `± range` tag; organic/local (measured, not sampled) show a single figure — the asymmetry itself teaches which numbers are sampled.

This remains the one place we spend a little visual emphasis. It is structurally hard for false-precision competitors to copy without admitting their own uncertainty — and it now earns attention by being the *only* non-neutral data mark on the page, not by glowing.

---

## 5. Motion language

Product-register motion: **state, not decoration.** Users are in flow; the interface loads into a task rather than performing an entrance. 120–250ms, `transform`/`opacity` only.

### Easing token
```css
--ease: cubic-bezier(0.2, 0, 0, 1);   /* ease-out; quiet, quick settle */
```
No bounce, no elastic, no `ease-in` on UI.

### The rules we ship
| Interaction | Spec |
|---|---|
| Hover (nav, chip, card, row) | Background/border tint, ~120ms — cheap, immediate feedback |
| Focus | Visible accent ring on every interactive element |
| Hero score | Counts up 0→72 over ~650ms `ease-out` — the one bit of arrival, because a number ticking up *is* state |
| ⌘K copilot | Opens with a 6px rise + fade over ~140ms + a dim scrim; **Esc / click-out** closes |
| Meters / bands | Rendered at final state; never animate `width` in hot paths |

### Discipline
- **No orchestrated page-load sequence, no staggered materialize.** The v1 blur-in choreography is gone; content is present on first paint.
- **Reveal animations enhance an already-visible default** — never gate content visibility on a transition (it never fires in headless renderers / hidden tabs).
- **`prefers-reduced-motion`** drops the score count-up (show final value) and reduces transitions to instant. Required, not optional.

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
- **FMP < 1.5s; every dashboard query < 500ms** (ClickHouse makes this real). Skeleton loading (not center-spinners); offline-tolerant report viewing.
- Every interactive component ships the full state set: default, hover, focus, active, disabled, loading, error.
- Body text ≥4.5:1, large text ≥3:1, placeholders ≥4.5:1 — verified in both themes.
- `prefers-reduced-motion`: drop the score count-up and movement; keep comprehension-aiding color.
- `prefers-contrast: more`: lean on `--border-strong` for defined edges.
- Visible keyboard focus on every interactive element; `@media (hover: hover)` gates hover so touch taps don't false-trigger.
- Empty states teach the interface (not "nothing here"); consistent affordances screen-to-screen (same button, same form controls, same icon style).

---

## 8. Component inventory (v1)
Panel (surface + hairline) · chip / filter · nav item (rail) · sticky topbar · hero score + confidence range bar · trend chart with band · contribution cell (meter) · win/risk row (status dot + delta) · Fix Queue lane + card (kind / title / impact-effort pills) · ⌘K copilot (scrim + input + suggestions) · theme toggle · icon button.

Build stack (from blueprint): **React + TypeScript, Tailwind + custom token layer, Radix primitives, TanStack Query/Table, ECharts/visx for charts, Motion (Framer Motion) used sparingly.** The tokens and motion specs above map 1:1 onto that stack; the [Pulse mockup](mockups/pulse.html) is the reference implementation of the visual + motion language in plain HTML/CSS.

---

## 9. What we deliberately avoid
Generic AI-design tells: warm-cream + serif + terracotta, lone acid-green pop on near-black, purple→blue gradient hero, gradient text, glassmorphism-as-default, decorative side-stripe accent rails on cards, uppercase tracked eyebrows above every section, numbered `01/02/03` section markers, identical icon-card grids, everything centered, `rounded-lg` on everything. Engine's identity — a flat neutral canvas, mono readouts for data only, the confidence range as the one place emphasis is spent, and a single rationed accent — is chosen against those defaults. The tell to guard against here isn't flatness; it's **strangeness without purpose** (invented affordances, mismatched controls, gratuitous motion). Earned familiarity is the goal.
