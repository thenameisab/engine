/**
 * The entity-first data model (Architecture §1, Layer 3).
 * All analytics join through `entityId`. A URL, a keyword, and an AI
 * citation are all facets of an Entity, not standalone records.
 * This is the join key the rest of the system is built around and is
 * explicitly called out as something that cannot be retrofitted later.
 */
export interface Entity {
  id: string;
  canonicalName: string;
  wikidataId: string | null;
  urls: string[];
  keywords: string[];
  prompts: string[];
  citations: string[];
  mentions: string[];
  schema: object[];
  createdAt: string;
  updatedAt: string;
}
