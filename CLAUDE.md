# Engine — Project Instructions

## Working log (always)
Maintain `working_log.md` in this project folder. Append a dated entry for every
meaningful action taken in a session — files created/edited, research done,
decisions made, deliverables produced. Keep entries concise (one line each under a
date heading). Update it as you work, not only when asked.

## Pending items (end of every build)
`docs/PENDING.md` is the single current answer to "what is left". **Every build ends by
rewriting it** — not appending — so it always matches the code.

At the end of a build, before reporting done:
1. Move what you finished out of **Open**, into the one-paragraph **Done** section.
2. Re-check the items you did *not* touch against the source rather than copying the old row
   forward. A row that was true last week may not be now, and a stale ledger is worse than none.
3. Add anything the build uncovered, with a size and where its detail lives.
4. Update the `Last updated` line with the date and the commit you audited against.
5. Say in the final message what is now next, and what changed in the ledger.

Two rules that keep it honest. **Verify, do not assume:** every state claim should come from a
command against the tree, and a count should be measured, not remembered. **Distinguish
deferred from pending:** a deferral belongs in the deferred table with the trigger that reopens
it, never in Open.

`working_log.md` is the history and is appended. `docs/PENDING.md` is the state and is
rewritten. If they disagree, the ledger is wrong.

## Location
Save all deliverables and work files inside this project folder (`/Users/adityagaur/Desktop/Engine`).
Never write loose files to the Desktop.
