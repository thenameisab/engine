import { el, clear } from '../dom.js';
import {
  fetchEntities,
  fetchCitationOpportunities,
  runOffsiteAudit,
  fetchEntityPrompts,
  saveEntityPrompts,
  fetchAiVisibility,
  fetchAiModels,
  streamAi,
  fetchShareOfVoice,
} from '../api.js';
import { modelPicker } from '../modelPicker.js';
import { readableError } from '../errors.js';
import { auditLastRunLine, screenName } from '../format.js';
import type { AppContext } from '../context.js';
import type {
  ApiEntity,
  CitationOpportunity,
  AiVisibility,
  EngineCitedShare,
  EntityPrompts,
  AiModels,
  ShareOfVoice,
  BrandShare,
} from '../types.js';

/**
 * AI answers — what AI engines say when someone asks about this brand.
 *
 * Four panels, in the order the data depends on itself:
 *
 *   1. **Cited share by engine**, from the samples the weekly poll stored.
 *   2. **Prompts** — the bank the poll asks. Empty until someone fills it,
 *      which is why panel 1 was empty for every customer before this screen:
 *      `entities.prompts` had no editor and no route ever wrote to it.
 *   3. **Try a prompt** — one streamed answer, right now, for the person who
 *      does not want to wait a week to see what the model says.
 *   4. **Citation opportunities**, mined by the off-site audit from the
 *      sources answers name.
 *
 * Panel 4 is the honest one. Sarvam does not browse, so its answers almost
 * never carry a source URL, and an opportunity list mined from those sources
 * stays empty for a reason that has nothing to do with the customer's site.
 * The panel says that in place of showing nothing — the screen reports the
 * limit of the engine rather than implying the brand has no gaps to close.
 *
 * The route id stays `offsite`: it is in `PROJECT_ROUTES` and in whatever
 * links people have kept, and renaming a screen is not a reason to break them.
 */

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function authorityClass(n: number): string {
  return n >= 0.66 ? 'good' : n >= 0.4 ? 'warn' : 'bad';
}

/** Engine ids are vendor strings; this screen is read by customers. */
const ENGINE_LABEL: Record<string, string> = {
  sarvam: 'Sarvam',
  openai: 'ChatGPT',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
  anthropic: 'Claude',
  'google-ai-overview': 'Google AI Overview',
};

function engineLabel(engine: string): string {
  return ENGINE_LABEL[engine] ?? engine;
}

/** A model's customer-facing name, falling back to its vendor id. */
function modelLabel(id: string, catalogue: AiModels): string {
  return catalogue.models.find((m) => m.id === id)?.label ?? id;
}

function opportunityRow(o: CitationOpportunity): HTMLElement {
  return el('div', { class: 'off-row' }, [
    el('span', { class: 'off-domain' }, [o.domain]),
    el('span', { class: 'off-meta num' }, [`cited ${o.citationCount}× · ${o.distinctEntities} peer${o.distinctEntities === 1 ? '' : 's'}`]),
    el('span', { class: `off-auth num ${authorityClass(o.authority)}`, title: 'Category authority' }, [pct(o.authority)]),
  ]);
}

/**
 * One engine's cited share, as a band rather than a point.
 *
 * The range is shown next to the figure because at three samples a single
 * cited answer is 33% with a 95% range from 6% to 79%. Printing 33% alone
 * would claim a precision three samples cannot support, which is the rule A2
 * sets for every AI citation rate in the product.
 */
/**
 * How a group of samples credited the brand.
 *
 * "Named" and "linked" are shown apart because they are different results:
 * an answer that says the brand's name is a mention, and one that carries a
 * URL on the brand's own domain sent a reader there. The engines polled here
 * do not browse, so the second is normally zero — and folding both into one
 * "cited" figure would read as links that never happened.
 */
function creditLine(e: EngineCitedShare): string {
  if (e.citedByName === null) {
    // Rows written before the split was recorded. Saying "0 linked" here
    // would invent a measurement that was never taken.
    return `${e.cited} of ${e.samples} answer${e.samples === 1 ? '' : 's'} credited the brand · how is not recorded`;
  }
  return `named in ${e.citedByName} of ${e.samples} · linked in ${e.citedByDomain ?? 0}`;
}

function engineRow(e: EngineCitedShare, models: AiModels | null): HTMLElement {
  return el('div', { class: 'ai-eng' }, [
    el('div', { class: 'ai-eng-main' }, [
      el('div', { class: 't' }, [
        engineLabel(e.engine),
        // The model is part of the measurement's identity, not a detail: two
        // models of one vendor disagree, so a band is only meaningful within
        // one of them.
        el('span', { class: 'ai-eng-model num' }, [
          e.model === null ? 'model not recorded' : models ? modelLabel(e.model, models) : e.model,
        ]),
      ]),
      el('div', { class: 'm num' }, [
        `${creditLine(e)} · ${e.prompts} prompt${e.prompts === 1 ? '' : 's'}`,
      ]),
    ]),
    el('div', { class: 'ai-eng-band' }, [
      el('div', { class: 'ai-eng-pt num' }, [pct(e.band.point)]),
      el('div', { class: 'ai-eng-rng num' }, [`${pct(e.band.low)}–${pct(e.band.high)} range`]),
    ]),
  ]);
}

export async function offsiteView(ctx: AppContext): Promise<HTMLElement> {
  let entities: ApiEntity[] = [];
  let loadError: string | null = null;
  try {
    entities = await fetchEntities();
  } catch (err) {
    loadError = readableError(err);
  }

  const root = el('div', {});
  // Appended to `head` further down, not here: the early returns below render
  // `head` on its own, and a "last checked" line above an error would be a
  // claim about data that failed to load.
  const lastRunLine = el('p', { class: 'lastrun' }, [auditLastRunLine(null)]);
  const head = el('div', { class: 'pagehead' }, [
    el('h1', {}, [screenName('ai-answers')]),
    el('p', {}, [
      'What AI engines say when someone asks about this brand: how often an answer names you, the prompts that get sampled every week, and a live check you can run now.',
    ]),
  ]);

  if (loadError) {
    root.append(head, el('section', { class: 'panel' }, [el('div', { class: 'errbox' }, [loadError])]));
    return root;
  }
  if (entities.length === 0) {
    root.append(head, el('section', { class: 'panel' }, [
      el('div', { class: 'notebox' }, ['Add your brand under Settings first — AI visibility is measured per brand.']),
    ]));
    return root;
  }

  const selfSelect = el('select', { class: 'ci-select' },
    entities.map((e) => el('option', { value: e.id }, [e.canonicalName]))) as HTMLSelectElement;
  const runBtn = el('button', { class: 'btn' }, ['Run off-site audit']);

  const sharePanel = el('section', { class: 'panel' });
  const voicePanel = el('section', { class: 'panel' });
  const promptPanel = el('section', { class: 'panel' });
  const tryPanel = el('section', { class: 'panel' });
  const leadWrap = el('section', { class: 'panel off-lead' });

  /** The last visibility read, so the opportunities panel can explain itself. */
  let visibility: AiVisibility | null = null;
  /** Which models this deployment can offer. Null when the read failed. */
  let models: AiModels | null = null;

  // ---------------------------------------------------------------- panel 1
  function renderShare(): void {
    if (!visibility) {
      sharePanel.replaceChildren(
        el('header', {}, [el('h3', {}, ['Cited share by engine'])]),
        el('div', { class: 'errbox' }, ['Could not load AI visibility for this brand.']),
      );
      return;
    }
    const v = visibility;
    sharePanel.replaceChildren(
      el('header', {}, [
        el('h3', {}, ['Cited share by engine']),
        el('span', { class: 'num muted' }, [`last ${v.lookbackDays} days`]),
      ]),
      v.engines.length === 0
        ? el('div', { class: 'emptybox' }, [
            v.promptsTracked === 0
              ? 'Nothing sampled yet. Add a prompt below and the weekly poll starts measuring — or try one now to see an answer immediately.'
              : `${v.promptsTracked} prompt${v.promptsTracked === 1 ? '' : 's'} tracked, nothing sampled yet. The poll runs overnight; a prompt is sampled once a week.`,
          ])
        : el('div', { class: 'ai-engs' }, v.engines.map((e) => engineRow(e, models))),
    );
  }

  // ---------------------------------------------------------------- panel 1b
  /**
   * Who gets named instead of you. The question the opportunity panel below
   * was always trying to answer, asked of the thing this engine does produce:
   * answers name companies, they do not cite sources. Every brand named across
   * the same samples, as a band, with the customer's own brand marked.
   */
  let voice: ShareOfVoice | null = null;

  function brandRow(b: BrandShare): HTMLElement {
    return el('div', { class: 'ai-eng' }, [
      el('div', { class: 'ai-eng-main' }, [
        el('div', { class: 't' }, [
          b.brand,
          b.isSelf
            ? el('span', { class: 'ai-eng-model num' }, ['you'])
            : b.matchedEntityId
              ? el('span', { class: 'ai-eng-model num' }, ['tracked competitor'])
              : el('span', { class: 'ai-eng-model num' }, ['not tracked']),
        ]),
        el('div', { class: 'm num' }, [`named in ${b.named} of ${b.samples} answer${b.samples === 1 ? '' : 's'}`]),
      ]),
      el('div', { class: 'ai-eng-band' }, [
        el('div', { class: 'ai-eng-pt num' }, [pct(b.band.point)]),
        el('div', { class: 'ai-eng-rng num' }, [`${pct(b.band.low)}–${pct(b.band.high)} range`]),
      ]),
    ]);
  }

  function renderVoice(): void {
    const header = el('header', {}, [
      el('h3', {}, ['Who gets named instead of you']),
      voice ? el('span', { class: 'num muted' }, [`last ${voice.lookbackDays} days`]) : null,
    ].filter(Boolean) as HTMLElement[]);
    if (!voice) {
      voicePanel.replaceChildren(header, el('div', { class: 'errbox' }, ['Could not load share of voice for this brand.']));
      return;
    }
    const v = voice;
    let body: HTMLElement;
    if (v.samples === 0) {
      body = el('div', { class: 'emptybox' }, ['Nothing sampled yet. Share of voice is counted over the same answers as the cited share above.']);
    } else if (v.minedSamples === 0) {
      body = el('div', { class: 'emptybox' }, [
        `${v.samples} answer${v.samples === 1 ? '' : 's'} stored, none with its text kept — answers sampled before 2026-09-10 were not stored, so there is nothing to mine. The next poll fills this in.`,
      ]);
    } else {
      body = el('div', {}, [
        el('div', { class: 'notebox' }, [
          `Over ${v.minedSamples} of ${v.samples} stored answers` +
            (v.minedSamples < v.samples ? ` (the rest were sampled before answers were kept)` : '') +
            '. A brand named once in three answers shows as 33% with a wide range, because that is all three samples can say.',
        ]),
        v.brands.length === 0
          ? el('div', { class: 'emptybox' }, ['No company was named in any mined answer.'])
          : el('div', { class: 'ai-engs' }, v.brands.slice(0, 12).map(brandRow)),
      ]);
    }
    voicePanel.replaceChildren(header, body);
  }

  async function loadVoice(): Promise<void> {
    try {
      voice = await fetchShareOfVoice(selfSelect.value);
    } catch {
      voice = null;
    }
    renderVoice();
  }

  // ---------------------------------------------------------------- panel 2
  /**
   * The prompt editor. Local state until Save, because the API takes the whole
   * list: sending each edit on its own would make a half-finished bank the one
   * the poll asks overnight.
   */
  let bank: EntityPrompts | null = null;
  let draft: string[] = [];
  let dirty = false;

  function renderPrompts(): void {
    if (!bank) {
      promptPanel.replaceChildren(
        el('header', {}, [el('h3', {}, ['Prompts'])]),
        el('div', { class: 'errbox' }, ['Could not load the prompt bank for this brand.']),
      );
      return;
    }

    const input = el('input', {
      class: 'field',
      type: 'text',
      placeholder: 'a question someone would ask, e.g. best payslip ocr for india',
    }) as HTMLInputElement;

    const addTyped = (): void => {
      const clean = input.value.trim();
      if (!clean) return;
      if (draft.some((p) => p.toLowerCase() === clean.toLowerCase())) {
        ctx.toast('That prompt is already in the bank.');
        return;
      }
      draft = [...draft, clean];
      dirty = true;
      renderPrompts();
    };
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        e.preventDefault();
        addTyped();
      }
    });

    const save = el('button', { class: 'btn primary' }, [dirty ? 'Save prompts' : 'Saved']);
    if (!dirty) save.setAttribute('disabled', 'true');
    save.addEventListener('click', async () => {
      save.setAttribute('disabled', 'true');
      save.textContent = 'Saving…';
      try {
        await saveEntityPrompts(selfSelect.value, draft);
        ctx.toast(
          draft.length === 0
            ? 'Prompt bank cleared — nothing will be sampled for this brand.'
            : `${draft.length} prompt${draft.length === 1 ? '' : 's'} saved. The next weekly poll samples ${draft.length === 1 ? 'it' : 'them'}.`,
        );
        await loadBank();
        // The prompt count in the band's empty state comes from this read.
        await fetchVisibility();
        renderShare();
      } catch (err) {
        ctx.toast(readableError(err));
        save.removeAttribute('disabled');
        save.textContent = 'Save prompts';
      }
    });

    // Seeds from the keywords this brand already tracks, minus anything in the
    // draft — the reason the editor is not an empty box.
    const suggestions = bank.suggestions.filter(
      (s) => !draft.some((p) => p.toLowerCase() === s.toLowerCase()),
    );

    // Built as a list and filtered, because `replaceChildren` takes nodes and
    // two of these sections are conditional.
    const parts: (HTMLElement | null)[] = [
      el('header', {}, [
        el('h3', {}, ['Prompts']),
        el('span', { class: 'num muted' }, [String(draft.length)]),
      ]),
      el('div', { class: 'notebox' }, [
        'These are the questions Engine asks each AI engine every week. Each one is sampled three times per engine, so the cited share above carries a real confidence range.',
      ]),
      draft.length === 0
        ? el('div', { class: 'emptybox' }, ['No prompts yet. Add one below, or take a suggestion.'])
        : el('div', { class: 'kw-list' }, draft.map((p) =>
            el('div', { class: 'kw-row kw-2' }, [
              el('div', { class: 'kw-main' }, [el('div', { class: 't' }, [p])]),
              el('button', {
                class: 'frow-act',
                title: `Remove “${p}”`,
                onclick: () => {
                  draft = draft.filter((x) => x !== p);
                  dirty = true;
                  renderPrompts();
                },
              }, ['Remove']),
            ]),
          )),
      el('div', { class: 'ai-add' }, [input, el('button', { class: 'btn', onclick: addTyped }, ['Add']), save]),
      suggestions.length === 0
        ? null
        : el('div', {}, [
            el('div', { class: 'label serp-sec' }, [
              bank.keywordsTracked > 0
                ? `From your ${bank.keywordsTracked} tracked keyword${bank.keywordsTracked === 1 ? '' : 's'}`
                : 'Suggestions',
            ]),
            el('div', { class: 'serp-features' }, suggestions.slice(0, 12).map((s) => {
              const chip = el('button', { class: 'chip-plain chip-add', title: `Add “${s}”` }, [`+ ${s}`]);
              chip.addEventListener('click', () => {
                draft = [...draft, s];
                dirty = true;
                renderPrompts();
              });
              return chip;
            })),
          ]),
      bank.keywordsTracked === 0
        ? el('div', { class: 'emptybox' }, ['Track a keyword under Rankings and Engine will suggest prompts from it.'])
        : null,
    ];
    promptPanel.replaceChildren(...parts.filter((n): n is HTMLElement => n !== null));
  }

  // ---------------------------------------------------------------- panel 3
  /**
   * One streamed answer.
   *
   * Streamed rather than awaited because this engine is a reasoning model:
   * measured against the live vendor, the first thinking token arrives at
   * ~0.9 s, the first answer token at ~3.2 s and the whole answer at ~7.5 s.
   * A request that waited for the answer would show nothing for three seconds
   * and a spinner for seven. Showing the thinking phase as its own state is
   * the reason to stream at all here.
   *
   * Nothing this panel does is stored: a single ad-hoc sample is not a
   * measurement, and letting these clicks land in the same table would move
   * the band above by hand.
   */
  function renderTry(): void {
    const input = el('input', {
      class: 'field',
      type: 'text',
      placeholder: 'ask an AI engine something, e.g. best income verification api',
    }) as HTMLInputElement;
    const out = el('div', { class: 'ai-try-out' });
    const go = el('button', { class: 'btn primary' }, ['Ask']);
    const picker = modelPicker(models);
    // The note under the picker depends on the pick, so the panel is rebuilt
    // on change. Cheap: nothing in it is in flight at that moment.
    picker.root.addEventListener('change', () => renderTry());
    let controller: AbortController | null = null;

    async function run(): Promise<void> {
      const prompt = input.value.trim();
      if (!prompt) { input.focus(); return; }
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;

      // A model that does not reason has no thinking phase, so it gets a
      // plain waiting line instead of one that claims the model is thinking.
      const reasons = picker.reasons();
      const think = el('div', { class: 'ai-think' }, [
        el('span', { class: 'ai-think-dot' }),
        el('span', { class: 'ai-think-l' }, [reasons ? 'thinking…' : 'asking…']),
      ]);
      const answer = el('div', { class: 'ai-answer' });
      const footer = el('div', { class: 'ai-verdict' });
      clear(out);
      out.append(think, answer, footer);
      go.setAttribute('disabled', 'true');
      go.textContent = 'Asking…';

      let thinkChars = 0;
      let text = '';
      try {
        await streamAi(
          { mode: 'prompt', entityId: selfSelect.value, prompt, ...(picker.current() ? { model: picker.current()! } : {}) },
          {
            onThinking: (delta) => {
              thinkChars += delta.length;
              think.querySelector('.ai-think-l')!.textContent = `thinking… ${thinkChars.toLocaleString()} characters`;
            },
            onText: (delta) => {
              // The first answer token ends the thinking phase.
              think.classList.add('done');
              think.querySelector('.ai-think-l')!.textContent =
                thinkChars > 0 ? `thought for ${thinkChars.toLocaleString()} characters` : 'answering';
              text += delta;
              answer.textContent = text;
            },
            onResult: (result) => {
              footer.replaceChildren(
                el('span', { class: `pill ${result.cited ? 'impact' : ''}` }, [
                  result.citedByDomain
                    ? 'Linked your site'
                    : result.citedByName
                    ? 'Named your brand'
                    : 'Did not name your brand',
                ]),
                el('span', { class: 'num muted' }, [
                  result.sourcesCited.length > 0
                    ? `${result.sourcesCited.length} source${result.sourcesCited.length === 1 ? '' : 's'} named`
                    : 'no sources named — this engine does not browse',
                ]),
                el('span', { class: 'num muted' }, [`${engineLabel(result.engine)} · not stored`]),
              );
            },
            onError: (message) => {
              footer.replaceChildren(el('div', { class: 'errbox' }, [message]));
            },
          },
          signal,
        );
      } catch (err) {
        if (!signal.aborted) {
          clear(out);
          out.append(el('div', { class: 'errbox' }, [readableError(err)]));
        }
      } finally {
        if (!signal.aborted) {
          go.removeAttribute('disabled');
          go.textContent = 'Ask';
        }
      }
    }

    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); void run(); }
    });
    go.addEventListener('click', () => void run());

    tryPanel.replaceChildren(...[
      el('header', {}, [el('h3', {}, ['Try a prompt now'])]),
      el('div', { class: 'notebox' }, [
        'A single live answer, shown as it is written. Useful for reading what an engine actually says; it is not stored, because one answer is not a measurement.',
      ]),
      el('div', { class: 'ai-try-row' }, [input, go]),
      picker.root,
      // A live answer from a model the weekly poll does not use is still worth
      // reading, but it is not the model the stored band came from — so the
      // screen says which one is measured rather than letting the two be
      // confused.
      models && picker.current() && picker.current() !== models.pollModel
        ? el('div', { class: 'notebox' }, [
            `The weekly measurement above uses ${modelLabel(models.pollModel, models)}, not this model.`,
          ])
        : null,
      out,
    ].filter((n): n is HTMLElement => n !== null));
  }

  // ---------------------------------------------------------------- panel 4
  function renderOpps(opps: CitationOpportunity[]): void {
    const coverage = visibility?.sourceCoverage;

    /**
     * Which empty state is the true one.
     *
     * This panel is mined from the source URLs AI answers name, and the engine
     * this deployment polls does not browse — so it names sources rarely, and
     * an empty list usually means "we cannot see this" rather than "you have
     * no gaps to close". Reporting the actual source coverage is the only way
     * a reader can tell those apart.
     */
    function emptyNote(): HTMLElement {
      if (!coverage) {
        return el('div', { class: 'emptybox' }, [
          'No analysis yet, or no gaps found. Run the off-site audit to mine the AI citation archive.',
        ]);
      }
      if (coverage.samples === 0) {
        return el('div', { class: 'emptybox' }, [
          'Nothing to mine yet — this panel is built from the sources AI answers name, so it needs sampled answers first.',
        ]);
      }
      if (coverage.withSources === 0) {
        return el('div', { class: 'notebox' }, [
          `None of the ${coverage.samples} stored answer${coverage.samples === 1 ? '' : 's'} named a source. ` +
            'The engine this deployment polls answers from what it already knows rather than by searching the web, so there are no cited domains to mine. ' +
            'This panel fills once a browsing engine is connected — it is a limit of the engine, not a sign that there is nothing to fix.',
        ]);
      }
      return el('div', { class: 'emptybox' }, [
        `Only ${coverage.withSources} of ${coverage.samples} stored answers named a source, because this engine does not browse — ` +
          'so there is little to mine yet. Run the off-site audit to mine what there is.',
      ]);
    }

    leadWrap.replaceChildren(
      el('header', {}, [
        el('h3', {}, ['Citation opportunities']),
        el('span', { class: 'num muted' }, [String(opps.length)]),
      ]),
      opps.length > 0 ? el('div', { class: 'off-rows' }, opps.slice(0, 20).map(opportunityRow)) : emptyNote(),
    );
  }

  // ---------------------------------------------------------------- loading
  /** Read the band without painting it — `loadAll` paints once the model
   * catalogue is in, so a group can be labelled with the name the picker
   * uses rather than the raw vendor id. */
  async function fetchVisibility(): Promise<void> {
    try {
      visibility = await fetchAiVisibility(selfSelect.value);
    } catch {
      visibility = null;
    }
  }

  async function loadBank(): Promise<void> {
    try {
      bank = await fetchEntityPrompts(selfSelect.value);
      draft = [...bank.prompts];
      dirty = false;
    } catch {
      bank = null;
    }
    renderPrompts();
  }

  async function loadOpps(): Promise<void> {
    try {
      const { opportunities, lastRun } = await fetchCitationOpportunities(selfSelect.value);
      renderOpps(opportunities);
      lastRunLine.textContent = auditLastRunLine(lastRun);
    } catch {
      renderOpps([]);
    }
  }

  async function loadAll(): Promise<void> {
    // The catalogue is fetched alongside visibility, not after it: the band
    // names the model each group was measured on, and that name comes from the
    // catalogue. Loading it later renders the raw vendor id where the picker
    // says "Considered", so the same model reads as two different things on
    // one screen. A failure leaves the picker out and the raw id in, which is
    // still true, just less friendly.
    const [, catalogue] = await Promise.all([
      fetchVisibility(),
      models === null ? fetchAiModels().catch(() => null) : Promise.resolve(models),
    ]);
    models = catalogue;
    renderShare();

    // Opportunities second: its empty state reads the source coverage that
    // visibility just supplied to decide which one is the true one.
    await Promise.all([loadBank(), loadOpps(), loadVoice()]);
    renderTry();
  }

  selfSelect.addEventListener('change', () => void loadAll());

  runBtn.addEventListener('click', async () => {
    runBtn.setAttribute('disabled', 'true');
    runBtn.textContent = 'Running…';
    try {
      const res = await runOffsiteAudit(selfSelect.value);
      renderOpps(res.opportunities);
      lastRunLine.textContent = auditLastRunLine({
        trigger: 'manual',
        findingsCount: res.findingsCount,
        ranAt: new Date().toISOString(),
      });
      ctx.toast(`Analyzed ${res.observationsAnalyzed} citation(s) across ${res.categorySize} entit${res.categorySize === 1 ? 'y' : 'ies'} · ${res.findingsCount} finding(s) → Audit`);
    } catch (err) {
      ctx.toast(`Off-site audit failed: ${readableError(err)}`);
    } finally {
      runBtn.removeAttribute('disabled');
      runBtn.textContent = 'Run off-site audit';
    }
  });

  head.append(
    lastRunLine,
    el('div', { class: 'ci-controls' }, [el('label', { class: 'ci-lbl' }, ['Brand', selfSelect]), runBtn]),
  );
  root.append(head, sharePanel, voicePanel, promptPanel, tryPanel, leadWrap);

  await loadAll();
  return root;
}
