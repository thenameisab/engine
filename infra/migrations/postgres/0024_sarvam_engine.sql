-- 0024: allow 'sarvam' as a citation engine.
--
-- `citation_events.engine` was fixed at the five engines named in A2's spec
-- (migration 0005). This deployment polls Sarvam, so every insert from the
-- Sarvam connector would be rejected by the check constraint rather than by
-- anything a reader would recognise as a configuration problem.
--
-- The constraint is kept rather than dropped: an engine name is written by the
-- connector layer, and a typo there should fail loudly instead of creating a
-- sixth engine nobody meant.
alter table citation_events drop constraint citation_events_engine_check;

alter table citation_events add constraint citation_events_engine_check
  check (engine in ('openai', 'gemini', 'sarvam', 'perplexity', 'anthropic', 'google-ai-overview'));
