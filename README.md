# Engine

**"The AI visibility platform that fixes what it finds."**

Unified SEO + GEO + local visibility with an agentic **Fix Queue** that deploys, verifies, and rolls back fixes into the customer's own CMS/code/GBP. Measurement is the input; execution is the moat.

> Internal repository. Product strategy, specs, architecture, and design.

## Documentation

Everything lives in [`docs/`](docs/) — start at [`docs/README.md`](docs/README.md).

| Doc | What it is |
|---|---|
| [Master PRD](docs/00-Master-PRD.md) | Full feature catalogue, Pillars A–D + platform, granular → end-to-end |
| [Roadmap](docs/10-Roadmap.md) | Phased build (MVP / Depth / Platform), milestones, exit criteria |
| [Architecture](docs/20-Architecture.md) | Four-layer system + GitHub + Cloudflare Pages/Workers spine |
| [Design System](docs/30-Design-System.md) | Liquid-glass visual language, confidence-band signature, motion rules |
| [Feature specs](docs/feature-specs/) | Per-feature deep dives (A1–A6, B1–B5) |
| [Pulse mockup](docs/mockups/pulse.html) | Live interactive hero-screen design reference |

## Strategic spine

Measuring AI visibility is table stakes (Profound, Peec already do it). Engine's defensible wedge is the **Fix Queue** — deploy → verify → rollback into production surfaces, with audit logs. Pillars A (Visibility) & B (Diagnosis) are built as the necessary *input* to execution; every Pillar B finding maps to an executable action (the `Finding → Action` contract).

Two decisions that can't be retrofitted: the **entity-first data model** and the **`Finding → Action` contract**.
