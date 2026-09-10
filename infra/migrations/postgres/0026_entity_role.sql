-- Say whether an entity is the customer's own, or a competitor of theirs.
--
-- The competitor screen has always needed two entities in a project, and
-- nothing in the product has ever created the second one: the only way to add
-- a competitor was to pick another *tracked entity*, and every entity a
-- customer has is their own brand. So the screen has been unreachable since
-- it shipped, and `competitor_sets` is empty in production.
--
-- Adding competitors as plain entity rows would fix that and break something
-- worse. `assembleSurfaceScores` walks every entity in a project and sums
-- their rank positions and citations into the customer's own visibility
-- score, so a competitor row would quietly fold a rival's performance into
-- the customer's number. The entity audit would emit findings telling the
-- customer to fix a competitor's schema. Every brand picker in the product
-- would offer competitors as if they were the customer's own.
--
-- The column is deliberately not called `kind`: `@engine/core` already uses
-- "kind" for the schema.org type of an entity (ENTITY_KINDS, EntityKind,
-- entities.schema_type), and two meanings of one word in one table is how a
-- future reader picks the wrong one.
alter table entities
  add column role text not null default 'self'
  check (role in ('self', 'competitor'));

-- Every existing row is the customer's own brand; the default is already
-- right for all of them, and no backfill is needed.

-- The readers that must exclude competitors filter by project and role.
create index entities_project_role_idx on entities (project_id, role);
