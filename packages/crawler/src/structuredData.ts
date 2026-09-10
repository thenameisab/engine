/**
 * JSON-LD extraction + validation for B1.4. Pure over raw `<script
 * type="application/ld+json">` text content — the crawler (crawlPage.ts) pulls
 * the raw strings out of the rendered DOM; this module parses and validates
 * them into `StructuredDataBlock`s.
 */
import type { StructuredDataBlock } from '@engine/diagnosis';

/** Required properties for the schema.org types this MVP validates (B1.4 + feeds C2). */
const REQUIRED_PROPS: Record<string, string[]> = {
  Organization: ['name', 'url'],
  LocalBusiness: ['name', 'address'],
  Product: ['name'],
  Article: ['headline'],
  NewsArticle: ['headline'],
  BlogPosting: ['headline'],
  WebSite: ['name', 'url'],
  FAQPage: ['mainEntity'],
  BreadcrumbList: ['itemListElement'],
  Person: ['name'],
};

interface JsonLdNode {
  '@context'?: unknown;
  '@type'?: unknown;
  [key: string]: unknown;
}

function validateNode(node: JsonLdNode): StructuredDataBlock {
  const errors: string[] = [];
  const type = typeof node['@type'] === 'string' ? node['@type'] : undefined;

  if (!node['@context']) errors.push('missing @context');
  if (!type) errors.push('missing @type');

  const required = type ? REQUIRED_PROPS[type] : undefined;
  if (required) {
    for (const prop of required) {
      if (node[prop] === undefined || node[prop] === null || node[prop] === '') {
        errors.push(`missing required property '${prop}'`);
      }
    }
  }

  return { type: type ?? 'Unknown', valid: errors.length === 0, errors };
}

/** Flatten `@graph` containers and top-level arrays into individual nodes. */
function flattenNodes(parsed: unknown): JsonLdNode[] {
  if (Array.isArray(parsed)) return parsed.flatMap(flattenNodes);
  if (parsed && typeof parsed === 'object') {
    const node = parsed as JsonLdNode;
    if (Array.isArray(node['@graph'])) {
      // @context is declared once on the container and inherited by @graph
      // members, so propagate it down before flattening (else every member
      // spuriously fails validation for "missing @context").
      return node['@graph'].flatMap((child: JsonLdNode) =>
        flattenNodes(node['@context'] && !child['@context'] ? { ...child, '@context': node['@context'] } : child),
      );
    }
    return [node];
  }
  return [];
}

/**
 * The JSON-LD nodes a page actually declares, parsed and flattened.
 *
 * `extractStructuredData` reduces each node to a verdict — its type, and
 * whether it validated — which answers B1.4 and throws the content away. The
 * B3 entity audit needs the content: whether a block *names this entity*, and
 * which profiles its `sameAs` lists, are questions a verdict cannot answer.
 *
 * A block that will not parse is skipped rather than reported here; it is
 * already a B1.4 finding, and there is nothing to read.
 */
export function parseJsonLdNodes(scriptContents: string[]): object[] {
  const nodes: object[] = [];
  for (const raw of scriptContents) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    nodes.push(...flattenNodes(parsed));
  }
  return nodes;
}

/**
 * Parse+validate every JSON-LD `<script>` block found on a page. A block that
 * fails to parse as JSON is reported as one invalid `Unknown` block rather
 * than dropped, since malformed JSON-LD is itself a B1.4 finding.
 */
export function extractStructuredData(scriptContents: string[]): StructuredDataBlock[] {
  const blocks: StructuredDataBlock[] = [];
  for (const raw of scriptContents) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      blocks.push({ type: 'Unknown', valid: false, errors: ['invalid JSON'] });
      continue;
    }
    for (const node of flattenNodes(parsed)) {
      blocks.push(validateNode(node));
    }
  }
  return blocks;
}
