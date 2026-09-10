/**
 * Who each AI answer named (issue 17, migration 0034).
 *
 * The off-site audit mined `sources_cited` for domains, and a non-browsing
 * engine names sources almost never — measured across three category prompts,
 * both Sarvam models named competitors reliably (2–4 per answer) and emitted a
 * usable URL almost never. Answers name companies; they do not cite sources.
 * So this mines the thing that is there.
 *
 * Two passes over one answer:
 *
 *  - **Known names**, matched deterministically: the customer's own brand and
 *    every competitor tracked in the project. Free, and needs no model.
 *  - **Names we do not know yet**, extracted by asking the model which
 *    companies the answer names. This is the value: a competitor nobody
 *    tracked is being recommended, and nothing deterministic can find it.
 *
 * Every mention is attached to the sample it came from, so share of voice is
 * a count over the same n samples the cited share is, and re-mining a sample
 * replaces its mentions rather than adding to them.
 */
import { wilsonInterval } from '@engine/scoring';
import type { ConfidenceBand } from '@engine/core';
import type { LlmCompleter } from '@engine/connectors';
import type { Db } from '../db.js';

export interface KnownBrand {
  entityId: string;
  name: string;
  isSelf: boolean;
}

export interface Mention {
  brand: string;
  isSelf: boolean;
  matchedEntityId: string | null;
  source: 'known' | 'extracted';
}

/** Lower-cased, whitespace-collapsed: what makes "Acme" and "ACME" one brand. */
export function brandKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The customer's own brands and their tracked competitors, for one project. */
export async function listKnownBrands(db: Db, projectId: string): Promise<KnownBrand[]> {
  const rows = await db<{ id: string; canonical_name: string; role: string }[]>`
    select id, canonical_name, role from entities where project_id = ${projectId}
  `;
  return rows
    .filter((r) => r.canonical_name.trim().length > 0)
    .map((r) => ({ entityId: r.id, name: r.canonical_name.trim(), isSelf: r.role === 'self' }));
}

/**
 * Which known brands an answer names. Word-bounded and case-insensitive, so
 * "Tartan" does not match "tartanhq" but "TartanHQ" matches "tartanhq". A
 * two-character name is not matched at all: "AI" or "HR" as a brand would
 * match every answer in the category.
 */
export function matchKnownBrands(answerText: string, brands: readonly KnownBrand[]): Mention[] {
  const text = answerText.toLowerCase();
  const out: Mention[] = [];
  for (const b of brands) {
    const key = brandKey(b.name);
    if (key.length < 3) continue;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text)) {
      out.push({ brand: b.name, isSelf: b.isSelf, matchedEntityId: b.entityId, source: 'known' });
    }
  }
  return out;
}

/** The instruction the extraction pass sends. Exported so a test can pin its shape. */
export function extractionPrompt(answerText: string): string {
  return (
    'Below is an answer an AI assistant gave to a question. List the names of the companies, products or brands it recommends or mentions as options. ' +
    'Reply with a JSON array of strings only, no prose, no explanation. Use each name once, as written in the answer. ' +
    'If it names none, reply with [].\n\n' +
    `ANSWER:\n${answerText.slice(0, 6000)}`
  );
}

/**
 * Parse the extraction reply. The model is asked for a JSON array and mostly
 * obeys; when it wraps the array in prose or a code fence, the first array in
 * the text is taken. Anything that is not a short list of strings is treated
 * as "named none" rather than as an error, because one malformed reply must
 * not fail the poll that produced the sample.
 */
export function parseExtractedNames(reply: string): string[] {
  const match = reply.match(/\[[\s\S]*?\]/);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const name = item.trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 80) continue;
    const key = brandKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names.slice(0, 20);
}

/**
 * Both passes over one answer. Known names first; extracted names that match
 * a known brand are folded into it, so a brand is never listed twice for one
 * sample under two spellings.
 */
export async function mineMentions(
  answerText: string,
  brands: readonly KnownBrand[],
  completer: LlmCompleter | null,
): Promise<Mention[]> {
  const mentions = matchKnownBrands(answerText, brands);
  const have = new Set(mentions.map((m) => brandKey(m.brand)));
  if (!completer || !answerText.trim()) return mentions;

  const reply = await completer.complete(extractionPrompt(answerText), { maxTokens: 400 });
  for (const name of parseExtractedNames(reply)) {
    const key = brandKey(name);
    if (have.has(key)) continue;
    // A name the extractor spells differently from the tracked one, e.g.
    // "Tartan HQ" for "TartanHQ": fold into the known brand it contains,
    // comparing with spaces removed so the spacing is not the difference.
    const squashed = key.replace(/\s+/g, '');
    const known = brands.find((b) => {
      const k = brandKey(b.name).replace(/\s+/g, '');
      return k.length >= 3 && (squashed.includes(k) || k.includes(squashed));
    });
    if (known && have.has(brandKey(known.name))) continue;
    have.add(key);
    mentions.push({
      brand: known ? known.name : name,
      isSelf: known?.isSelf ?? false,
      matchedEntityId: known?.entityId ?? null,
      source: 'extracted',
    });
  }
  return mentions;
}

/** Replace a sample's mentions with these. */
export async function recordMentions(db: Db, citationEventId: string, mentions: readonly Mention[]): Promise<void> {
  await db.begin(async (tx) => {
    await tx`delete from answer_mentions where citation_event_id = ${citationEventId}`;
    for (const m of mentions) {
      await tx`
        insert into answer_mentions (citation_event_id, brand, brand_key, is_self, matched_entity_id, source)
        values (${citationEventId}, ${m.brand}, ${brandKey(m.brand)}, ${m.isSelf}, ${m.matchedEntityId}, ${m.source})
        on conflict (citation_event_id, brand_key) do nothing
      `;
    }
  });
}

export interface BrandShare {
  brand: string;
  isSelf: boolean;
  matchedEntityId: string | null;
  /** Samples in which the brand was named. */
  named: number;
  /** Samples the share is over — the mined ones. */
  samples: number;
  /** Wilson 95% band over `named`/`samples`. */
  band: ConfidenceBand;
}

export interface PromptShareOfVoice {
  prompt: string;
  samples: number;
  brands: BrandShare[];
}

export interface ShareOfVoice {
  lookbackDays: number;
  /** Samples in the window with an answer stored — the ones that could be mined. */
  minedSamples: number;
  /** Every sample in the window, mined or not. */
  samples: number;
  prompts: PromptShareOfVoice[];
  /** Across all prompts. */
  brands: BrandShare[];
}

/**
 * Share of voice for one entity's prompts: how often each brand is named
 * across the same samples, as a band.
 *
 * Only samples with a stored answer count towards a share. A pre-0034 sample
 * has no text and so no mentions; counting it in the denominator would report
 * every brand as less named than it was, and counting it out silently would
 * hide that most of the window was never mined. So both numbers are returned.
 */
export async function shareOfVoice(db: Db, entityId: string, sinceDays: number): Promise<ShareOfVoice> {
  const rows = await db<{ id: string; prompt: string; mined: boolean }[]>`
    select id, prompt, answer_text is not null as mined
    from citation_events
    where entity_id = ${entityId} and sampled_at >= now() - (${sinceDays}::text || ' days')::interval
  `;
  const mined = rows.filter((r) => r.mined);
  const mentions = mined.length
    ? await db<{ citation_event_id: string; brand: string; brand_key: string; is_self: boolean; matched_entity_id: string | null }[]>`
        select citation_event_id, brand, brand_key, is_self, matched_entity_id
        from answer_mentions
        where citation_event_id = any(${mined.map((r) => r.id)}::uuid[])
      `
    : [];

  interface Acc {
    brand: string;
    isSelf: boolean;
    matchedEntityId: string | null;
    events: Set<string>;
  }
  const byPrompt = new Map<string, { samples: Set<string>; brands: Map<string, Acc> }>();
  const overall = new Map<string, Acc>();
  const promptOf = new Map(mined.map((r) => [r.id, r.prompt]));

  for (const r of mined) {
    let p = byPrompt.get(r.prompt);
    if (!p) byPrompt.set(r.prompt, (p = { samples: new Set(), brands: new Map() }));
    p.samples.add(r.id);
  }
  const bump = (map: Map<string, Acc>, m: (typeof mentions)[number]) => {
    let a = map.get(m.brand_key);
    if (!a) map.set(m.brand_key, (a = { brand: m.brand, isSelf: m.is_self, matchedEntityId: m.matched_entity_id, events: new Set() }));
    a.events.add(m.citation_event_id);
    if (m.is_self) a.isSelf = true;
    if (m.matched_entity_id && !a.matchedEntityId) a.matchedEntityId = m.matched_entity_id;
  };
  for (const m of mentions) {
    const prompt = promptOf.get(m.citation_event_id);
    if (prompt === undefined) continue;
    bump(byPrompt.get(prompt)!.brands, m);
    bump(overall, m);
  }

  const toShares = (map: Map<string, Acc>, samples: number): BrandShare[] =>
    [...map.values()]
      .map((a) => ({
        brand: a.brand,
        isSelf: a.isSelf,
        matchedEntityId: a.matchedEntityId,
        named: a.events.size,
        samples,
        band: wilsonInterval(a.events.size, samples),
      }))
      .sort((x, y) => y.named - x.named || x.brand.localeCompare(y.brand));

  return {
    lookbackDays: sinceDays,
    minedSamples: mined.length,
    samples: rows.length,
    prompts: [...byPrompt.entries()]
      .map(([prompt, p]) => ({ prompt, samples: p.samples.size, brands: toShares(p.brands, p.samples.size) }))
      .sort((a, b) => a.prompt.localeCompare(b.prompt)),
    brands: toShares(overall, mined.length),
  };
}
