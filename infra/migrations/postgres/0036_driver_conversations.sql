-- 0036: Driver remembers a conversation, and who may read it.
--
-- Driver step 4 of the build sequence in docs/reviews/2026-09-10-driver-scoping.md
-- §7, implementing §4.4 as amended by §9a decision 4.
--
-- Two things land here, and the second is the reason the first is not simply
-- three tables. Until now `POST /projects/:id/driver/ask` took a `history`
-- array from the request body and passed it into the transcript unread. That
-- is a trust boundary: a browser could send an assistant turn it invented and
-- the model would treat it as something it had itself said, which is a way to
-- rewrite the conversation's premises without the system prompt ever changing.
-- History now comes from these tables and from nowhere else.
--
-- The second is sharing. §9 offered "private to the author" or "visible to the
-- account"; §9a decision 4 took neither, and asked for the model Claude uses
-- for artifacts — private by default, shared with named people, or shared with
-- the whole organisation. That cannot be expressed as a boolean, so it is a
-- three-value state plus a share table, and every route that reads a thread
-- checks it.

-- One conversation. Scoped to a project, owned by a person.
--
-- `visibility` is a check constraint rather than an enum type, following 0035:
-- the same closed set is declared in TypeScript, and a check is alterable in
-- one statement where an enum needs a type migration.
--
-- `created_by` cascades. A private thread is the author's own working notes and
-- has no meaning without them; this is unlike `invitations.invited_by`, which
-- is nullable because an invitation is the account's fact rather than the
-- inviter's. A thread shared with the organisation still goes, which is the
-- deliberate cost of that choice — the alternative is orphaned threads whose
-- author cannot be asked what they meant.
--
-- `title` is nullable but written on the first turn from the question itself,
-- truncated. A thread list of "Untitled" rows is not a thread list, and a model
-- call to name a conversation is a cost with no payer.
create table driver_threads (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  created_by text not null references users(id) on delete cascade,
  title text,
  visibility text not null default 'private'
    check (visibility in ('private', 'named', 'organisation')),
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

-- The thread list: this project's threads, most recently active first.
create index driver_threads_project_idx on driver_threads (project_id, last_message_at desc);
-- The read check's first branch, and "my threads" on any screen.
create index driver_threads_created_by_idx on driver_threads (created_by);

-- Who a `named` thread has been shared with.
--
-- Only meaningful when `visibility = 'named'`, and deliberately not deleted
-- when visibility changes: a thread made organisation-wide and then made named
-- again should return to the same people, not to nobody. The read check reads
-- this table only on the `named` branch, so rows left behind on a private
-- thread grant nothing.
--
-- The API refuses to share with someone who is not a member of the project's
-- account. That is enforced at the route rather than by a constraint, because
-- the account is two joins away and a membership that lapses later should
-- revoke the read, not fail a write on an unrelated table.
create table driver_thread_shares (
  thread_id uuid not null references driver_threads(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  -- Who shared it. Kept as a null when they leave: the share is still real.
  shared_by text references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (thread_id, user_id)
);

-- "Which threads have been shared with me", which the thread list needs.
create index driver_thread_shares_user_idx on driver_thread_shares (user_id);

-- One message in a thread, in the loop's own vocabulary.
--
-- `role` is the three roles a stored message can have. The system message is
-- absent on purpose: it is rebuilt every turn from `buildSystemPrompt` and it
-- carries today's date and the screen the question came from, so a stored copy
-- would be a stale duplicate of a thing that is cheap to regenerate.
--
-- `seq` orders the thread. `created_at` cannot: a round's tool results are
-- written together inside one transaction and share a timestamp, and their
-- order is what makes the transcript replayable.
--
-- `tool_call_id` is the vendor's id, set on `tool` rows and matching the
-- `driver_tool_calls` row that requested it. It is the vendor's string rather
-- than our uuid because it is what has to go back on the wire.
create table driver_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references driver_threads(id) on delete cascade,
  seq integer not null,
  role text not null check (role in ('user', 'assistant', 'tool')),
  -- Null on an assistant turn that only called tools and said nothing.
  content text,
  tool_call_id text,
  -- Assistant turns only: which model, and what the turn cost.
  model_id text,
  prompt_tokens integer,
  completion_tokens integer,
  created_at timestamptz not null default now(),
  unique (thread_id, seq)
);

create index driver_messages_thread_idx on driver_messages (thread_id, seq);

-- Every tool call the model made, with its arguments and what it cost.
--
-- §4.4's reason for a separate table, quoted because it is the whole point: a
-- customer who asks "where did that number come from" three days later needs
-- the call and its result, not the prose. The result itself is the `content` of
-- the `tool` message with the matching `tool_call_id`, so nothing is stored
-- twice.
--
-- `skipped` records a call the loop answered without running — today only
-- `per-round-cap` and `deadline`. An audit that shows four calls when the model
-- asked for six is an audit that hides the bound that shaped the answer.
create table driver_tool_calls (
  id uuid primary key default gen_random_uuid(),
  -- The assistant message that asked for this call.
  message_id uuid not null references driver_messages(id) on delete cascade,
  tool_call_id text not null,
  name text not null,
  -- The model's raw JSON string, exactly as sent. Stored unparsed because what
  -- an audit needs to show is what the model actually said, including when it
  -- was malformed and the validator rejected it.
  arguments text not null,
  duration_ms integer,
  skipped text,
  error text,
  created_at timestamptz not null default now()
);

create index driver_tool_calls_message_idx on driver_tool_calls (message_id);
