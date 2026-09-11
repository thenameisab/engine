# Driver — vendor probe

**Status:** measured. This is step 1 of the build sequence in
`docs/reviews/2026-09-10-driver-scoping.md` §7, the one that document calls "not optional".
**Owns three answers only:** whether parallel tool calls work, whether a worst-case turn fits
the Cloudflare Worker's limits, and what `reasoning_effort: high` costs in seconds. It designs
nothing and changes no source file.
**Run:** 2026-09-11 against the live Sarvam API, from `feat/driver-tool-calling` at `1af3f82`.
**Model:** `sarvam-105b` (128K context, 16,000-token output ceiling), the model
`createConversationalLlmConnector` already selects for Driver.
**Spend:** 23 API calls — 4 tool-calling tests, 15 timing runs, 1 call-ceiling test, 3 one-token
calls to measure the prompt-token split. All 23 returned 200.

---

## Method

Every measurement was taken through the code Driver will actually use: `SarvamConnector.converse`
and `SarvamConnector.streamConverse` in `packages/connectors/src/llmSarvam.ts`, driven from a
standalone script outside the repository tree. The connector's `fetchImpl` hook was used to
capture the exact outbound request body and to tee the raw SSE response, so the wire format
recorded below is the bytes that went over the network, not a reconstruction. No raw `fetch`
fallback was needed.

The **worst-case turn** is the one §4.1 describes, built once and reused for every timing run:

| Part | Measured prompt tokens |
|---|---|
| System prompt | **937** |
| Tool catalogue — 20 tools, the §4.2 names, with real JSON Schema `parameters` | **2,974** |
| 4 prior user turns and 4 assistant replies, plus 1 assistant message with 3 `tool_calls`, 3 `tool` results of ~1,900 bytes each, and the live question | **2,944** |
| **Total on the wire** | **6,866 tokens, 22,882 bytes** |

The split was measured by three differential calls (bare user message: 11 tokens; plus the system
prompt: 948; plus the catalogue: 3,922). **The system prompt came out at 937 tokens, not the ~1,500
the brief specified** — it is a real Driver system prompt written to the §4.5-§4.7 rules and it
landed shorter. A 1,500-token prompt would put the turn at ~7,430 tokens, 8% larger, which changes
no conclusion below. Said here rather than rounded away.

One figure worth carrying into §4.2's open question about whether a router should narrow the
catalogue: **the 20 tools are 2,974 tokens, 43% of the whole request** — three times the system
prompt and slightly more than the entire conversation history plus three tool results.

"Measured" below means a number this probe observed. "Inferred" means it comes from Cloudflare's
documentation or from arithmetic over a measured number, and is labelled as such at each use.

---

## 1. Parallel tool calls

### Answer: yes, confirmed, up to at least four in one turn.

**Measured.** With `tool_choice: 'auto'` and the 20-tool catalogue, a question that plainly needs
two independent lookups produced two `tool_calls` entries in a single assistant turn, both
non-streaming and streaming:

| Test | Calls returned | `finish_reason` | Wall clock |
|---|---|---|---|
| A. Non-streaming, two independent lookups | 2 — `top_queries`, `findings` | `tool_calls` | 3,810 ms |
| B. Streaming, same question | 2 — `top_queries`, `findings` | `tool_calls` | 4,611 ms |
| E. Non-streaming, four independent lookups | 4 — `top_queries`, `findings`, `integration_status`, `crawl_coverage` | `tool_calls` | 2,250 ms |

Three calls also appeared unprompted in one worst-case timing run (`p2-high-1`), so the behaviour
is not an artefact of the four-way question's phrasing. Arguments were well-formed JSON in every
call observed; none had to be repaired.

No ceiling was found. Four is the largest number asked for and the largest returned. **A ceiling
above four is not measured**, so the loop should cap calls per round itself rather than assume the
vendor caps them.

### `ToolCallAccumulator`'s `index` assumption: confirmed, and stronger than it needs to be.

**Measured** from the raw SSE capture of test B, 303 events:

- Every `tool_calls` fragment carried an integer `index`. Fragments for the first call carried
  `"index":0` (14 fragments), the second `"index":1` (11 fragments). The field was never absent.
- `id` arrived exactly once per call, on that call's first fragment.
- `name` arrived **whole in one fragment**, not split. `ToolCallAccumulator` concatenates it
  (`entry.name += delta.function.name`), which is harmless and remains the safe choice.
- `arguments` arrived in 13 and 10 fragments respectively, a few characters at a time, 38
  characters of JSON each.
- The two calls were **not interleaved**: all 14 fragments of index 0 arrived, then all 11 of
  index 1. The index sequence was `0×14, 1×11` with no alternation.

So the assumption in `packages/connectors/src/llmStream.ts`'s sibling file
`packages/connectors/src/llmTools.ts` — that `index` distinguishes fragments — is **confirmed as
present and correct**. What this run did *not* find is a case where keying on `index` was
*necessary*, because this vendor emits calls sequentially rather than interleaved. That is a
behaviour, not a contract: keeping the accumulator keyed costs nothing and survives a vendor that
starts interleaving. No change needed.

One frame ordering detail worth recording: the accumulator's `drain()` runs after the stream ends,
so `tool_call` chunks are emitted only at the end. `tool_call_start` fired at +4,057 ms and
+4,359 ms in test B against a 4,611 ms total, so the name is available to the UI roughly 250-550 ms
before the arguments complete. That is a real but small head start on this vendor.

### `tool_choice`: both forms behave as documented.

**Measured.**

- `tool_choice: 'required'` on a question needing no tool ("Say the word ok and nothing else")
  still produced one call — `ai_citations` — with `finish_reason: 'tool_calls'` and no text. The
  vendor forces a tool; which tool it picks when none is appropriate is arbitrary, so `'required'`
  is only safe when a tool genuinely is required.
- `tool_choice: {type:'function', function:{name:'top_queries'}}` against a findings question
  returned exactly one call to `top_queries` with `{}` as its arguments, ignoring the question.
  Forcing a named tool works, which confirms §2's claim that structured output is obtainable by
  forcing a tool whose `parameters` are the schema you want back.

### Bound this sets on the agent loop

- **Max calls per round: 4.** Measured to work; no higher number was tested and no vendor ceiling
  was found. Four independent reads is also as wide as any question in §4.2's catalogue plausibly
  needs. Enforce it in the loop — truncate the model's list and tell it so in the next `tool`
  message — rather than trusting the vendor.
- **Execute a round's calls concurrently, not serially.** The vendor returns them together and they
  are independent by construction (§4.2 tools are parameterised reads). Serialising them would
  multiply the round's wall clock by the number of calls for no benefit.
- **Do not build a single-call fallback path.** Parallel calls are confirmed, so the loop does not
  need the serial degradation §4.8 would otherwise have had to specify.

---

## 2. Does a worst-case turn fit the Worker's limits?

### Answer: not on the plan this account is on, if the loop streams. CPU is the binding limit, not subrequests.

### Which plan applies

**Measured from the repository**, not assumed. `apps/api/wrangler.toml` has no `[limits]` block, so
the plan's defaults apply. The plan is **Workers Free**, stated twice in the tree:

- `apps/api/working_log.md`: the user's decision, "**no Workers Paid upgrade**, the account stays on
  Free".
- `apps/api/src/email.ts`: Cloudflare Email Sending is closed to this deployment because outbound
  sending is "Not available" on Workers Free "and the account stays on Free".

The brief for this probe assumed the paid bound of 1,000 subrequests. Both halves of that need
correcting.

### The documented limits

**Inferred — from `https://developers.cloudflare.com/workers/platform/limits/`, last updated
2026-09-05.** These are documentation, not measurements.

| Limit | Workers Free | Workers Paid |
|---|---|---|
| CPU time per HTTP request | **10 ms** | 5 min (default 30 s, set via `limits.cpu_ms`) |
| Subrequests per invocation | **50** | 10,000 (default; raisable) |
| Simultaneous connections awaiting response headers | 6 | 6 |
| Wall-clock duration, HTTP-triggered | No limit while the client is connected | Same |
| `fetch()` subrequest timeout | None documented | None documented |

Three corrections to the assumptions in the brief: the paid CPU default is **30 seconds**, not
50 ms (Cloudflare raised it; 50 ms is the deprecated Bundled plan). The paid subrequest limit is
**10,000**, not 1,000. And wall clock is **not** limited for an HTTP-triggered Worker, so a
multi-second agent turn is not itself a problem — only the CPU inside it is.

### Measured CPU cost of one round

CPU excludes time awaiting the network, so the only CPU a Driver round spends is serialising the
request and parsing the response. Both were measured through the real code paths
(`toWireMessage`, `toWireTools`, `parseSseJson`, `ToolCallAccumulator`) over the payloads this
probe captured, on Node 22.22.3 on an Apple-silicon laptop.

| Operation | Size | CPU per round |
|---|---|---|
| Build the request body (round 1) | 22,882 bytes | **0.060 ms** |
| Build the request body (round 2, +1 tool result) | 25,030 bytes | **0.060 ms** |
| `JSON.parse` a non-streamed response, short turn | 3,247 bytes | **0.0056 ms** |
| `JSON.parse` a non-streamed response, long turn | 15,461 bytes | **0.0182 ms** |
| `parseSseJson` + accumulator, short streamed turn | 309,782 bytes, 779 events | **1.769 ms** |
| `parseSseJson` + accumulator, long streamed turn | 1,445,942 bytes, 3,651 events | **5.964 ms** |

**The finding is the 300-fold gap between the last two rows and the two above them.** The same
turn costs 0.018 ms of CPU to parse as one JSON body and 5.96 ms to parse as a stream. The cause
is the envelope: this vendor sends roughly one SSE frame per token, each ~400 bytes of JSON
wrapping a few characters of text, so a 3,649-token reply is 3,651 separate `JSON.parse` calls
over 1.4 MB instead of one over 15 KB. Reasoning tokens dominate that count — `sarvam-105b`
emitted 273 reasoning deltas against 2 content deltas in the streaming parallel-call test.

**Caveat, stated plainly:** this is a laptop, not workerd on Cloudflare's edge. Same V8 engine,
different machine. The numbers should be treated as the right order of magnitude, not as the
Worker's own figures. Nothing in this probe measured CPU on the edge, and the margin against the
10 ms free limit is too small for the difference between the two machines to be waved away.

### What fits

**Inferred by arithmetic over the measured figures above.**

On **Workers Free, 10 ms CPU**:

- Streaming: one short round costs ~1.8 ms and one long round ~6.0 ms. **A two-round streaming
  turn does not reliably fit, and a three-round one does not fit at all.** One long round alone
  consumes 60% of the budget.
- Non-streaming: one round costs ~0.08 ms all in. **A ten-round non-streaming turn spends under
  1 ms**, leaving the rest of the budget for tool execution, database row mapping and response
  assembly.

On **Workers Paid, 30 s CPU default**: both shapes fit with several orders of magnitude to spare.
CPU stops being a consideration entirely.

### Subrequests are not the binding constraint

**Inferred.** One model round is one `fetch`, so one subrequest. Tool queries go to Neon through
the `postgres` npm driver (`apps/api/src/db.ts`), which opens a TCP socket via `connect()` under
`nodejs_compat` — a **pooled** socket, so the count does not scale with the number of queries.
Whether a `connect()` socket counts against the subrequest limit at all is **not stated** in the
limits page and was not determined here; it does count against the 6-simultaneous-connection
limit, which matters only if more than six tool queries are issued concurrently and is why the
per-round cap of 4 is comfortable.

Worst case, counting every database query as a subrequest: 4 rounds × 4 calls = 16 tool queries,
plus 4 model rounds, plus the session's own auth and lookup calls — call it 25. Against 50 on
Free that has margin; against 10,000 on Paid it is irrelevant. **Subrequests do not bound the
loop on either plan.**

### Bound this sets on the agent loop

- **Max model rounds per turn: 4.** Not a CPU bound — it is a wall-clock and cost bound, see §3.
  CPU permits far more in the non-streaming shape.
- **The loop must not stream every round.** Measured: SSE parsing is the entire CPU cost of a
  Driver turn, and on Workers Free two streamed rounds exhaust the budget. The shape that fits is
  **non-streaming for the tool-calling rounds, streaming only for the final answer round** — the
  intermediate rounds produce no text a user sees, so streaming them buys nothing and costs
  1.8-6.0 ms each. That keeps the turn at one streamed round, ~1.8-6.0 ms, plus ~0.08 ms per tool
  round.
- **Even that is tight on Free.** One streamed final round at 6.0 ms measured on a laptop against
  a 10 ms edge budget is not a margin to build on. Two options, and this probe does not choose
  between them: move to Workers Paid, where the question disappears, or run the final round
  non-streamed and give up the thinking-phase display. The second is a product regression —
  `llmStream.ts` exists specifically because `sarvam-105b` shows nothing for the entire reasoning
  phase otherwise.
- **Wall clock is not limited by the platform**, so the turn budget in §3 is a product decision
  about what a person will wait for, not a platform constraint.
- **Token budget: 6,866 prompt tokens measured for the worst-case turn**, against `sarvam-105b`'s
  128,000-token window. That is 5.4% of the window. Even at 4 rounds each appending 4 tool results
  of 2KB (~500 tokens each), the turn ends near 6,866 + 8,000 = ~15,000 tokens, **12% of the
  window**. History trimming is not needed for v1. The 32K `sarvam-105b-conversations` model would
  sit at 21% on round one and 47% by round four, which is why §9a decision 5's context filter is
  the right call, but the 128K model has room the scoping document assumed it might not.

---

## 3. What `reasoning_effort: high` costs in seconds

### Answer: nothing measurable. The parameter does not predict latency; the number of completion tokens does, at ~185 tokens per second.

**Measured.** Fifteen runs of the identical worst-case turn — 5 per effort level, streamed, taken
sequentially.

| Effort | n | Time to first chunk (ms) | Time to first answer text (ms) | Time to complete (ms) | Completion tokens |
|---|---|---|---|---|---|
| `low` | 5 | median **386**, range 282-559 | median **2,154**, range 1,158-7,386 | median **2,232**, range 1,441-7,833 | median 349, range 182-1,455 |
| `medium` | 5 | median **245**, range 223-440 | median **7,055**, range 3,212-18,040 | median **7,891**, range 3,336-19,149 | median 1,494, range 572-3,649 |
| `high` | 5 | median **188**, range 176-291 | median **5,857**, range 859-10,664 | median **6,271**, range 1,187-12,095 | median 1,166, range 159-2,350 |

Prompt tokens were **6,866 in all fifteen runs**, so the input was genuinely identical and the
variance is entirely in the model's behaviour.

**The ordering is not monotonic.** `high` finished faster than `medium` at the median (6,271 ms
against 7,891 ms) and emitted fewer completion tokens (1,166 against 1,494). The ranges overlap
heavily: the fastest `high` run finished in 1,187 ms and the slowest in 12,095 ms — a 10× spread
within one level, wider than any gap between levels. **At n=5 per level, this probe cannot
distinguish `medium` from `high` on either latency or output length.**

What does explain the wall clock, completely:

```
Pearson r(completion_tokens, total_ms) = 0.9996  over n=15
throughput: median 185.1 tokens/sec, range 126.3 - 194.3
```

Every run, at every effort level, sat on the same line. Wall clock is `completion_tokens / 185`
plus about 250 ms of connection and prefill. The effort parameter influences how many tokens the
model chooses to emit — weakly and unpredictably at this sample size — and nothing else. This
matches the note already in `llmSarvam.ts`, which records an 8,000-token truncation on a `'low'`
run and concludes the parameter "does not bound it".

**Time to first chunk is fast and stable across all levels: median 282 ms over all 15 runs, range
176-559 ms.** That first chunk is always a reasoning delta. Time to the first *answer* token is
the wait that matters, and it is long — median 2.2 s at `low`, 5.9 s at `high`, up to 18 s in the
worst run measured — because the model spends the whole interval reasoning.

### Bound this sets on the agent loop

- **Do not expose `reasoning_effort` as a latency control, and do not set it to `low` expecting a
  faster turn.** Measured: it does not deliver one. Leave it at the vendor default (`medium`) and
  omit the parameter, which is what the connector already does when `reasoningEffort` is not
  passed.
- **Wall-clock budget per turn: 45 seconds**, with a partial answer on expiry as §4.1 requires.
  Derived from measurement: a round's median is 5.2 s and its observed worst case 19.1 s; four
  rounds at the median is 21 s and at the worst case would be 77 s. 45 s covers four median rounds
  with room for two slow ones, and is about as long as a person will watch a chat box. The budget
  must be enforced as a deadline across the whole turn, not per round, because the variance is
  per round.
- **Max model rounds per turn: 4**, from that budget divided by the 5.2 s median round. The loop
  should check remaining wall clock before starting a round rather than counting rounds alone —
  measured round times span 1.2 s to 19.1 s, so a round counter is a poor proxy for time spent.
- **Show the thinking phase from the first chunk.** Measured at 282 ms median, it is the only
  thing available to paint before a multi-second wait. This is why the streamed final round is
  worth the CPU it costs.
- **The 16,000-token output ceiling was never approached**: the largest completion measured was
  3,649 tokens. No truncation occurred in any of the 23 calls.

---

## 4. The confirmed wire format

Recorded so step 2 is written against bytes that were observed to work, not against
documentation. This is the request `SarvamConnector.post` built and the vendor accepted.

**Endpoint:** `POST https://api.sarvam.ai/v1/chat/completions`
**Headers:** `api-subscription-key: <key>`, `content-type: application/json`

**Request body** — exactly these six top-level keys, in this shape:

```json
{
  "model": "sarvam-105b",
  "messages": [ ... ],
  "max_tokens": 16000,
  "tools": [ { "type": "function", "function": { "name": "...", "description": "...", "parameters": { ... } } } ],
  "tool_choice": "auto",
  "reasoning_effort": "medium"
}
```

Accepted and confirmed working:

- `tools` — 20 entries, each `{type:'function', function:{name, description, parameters}}` with
  `parameters` a JSON Schema object using `type`, `properties`, `enum`, `minimum`, `maximum`,
  `required` and `additionalProperties: false`. All sent verbatim; the vendor validated nothing
  and the model respected the enums in every call observed.
- `tool_choice` — the string `"auto"`, the string `"required"`, and the object
  `{"type":"function","function":{"name":"top_queries"}}`. All three behaved as §2 documented.
- `reasoning_effort` — `"low"`, `"medium"`, `"high"` all accepted; none rejected.
- **A full four-role message list.** The worst-case request sent
  `['system','user','assistant','user','assistant','user','assistant','user','assistant','user','assistant','tool','tool','tool']`
  and was accepted. This is the first confirmation that the tool round-trip shape works on this
  vendor:
  - the assistant message carrying calls sent `"content": null` alongside `tool_calls`, and was
    accepted — `toWireMessage`'s choice to send `null` rather than `''` is safe;
  - each `tool` message sent `{role:'tool', tool_call_id, content}` with `content` a ~1,900-byte
    JSON string, and was accepted;
  - `tool_call_id` values were arbitrary strings this probe invented (`call_probe_0`), not ids the
    vendor had issued, and the request was still accepted. The vendor does not appear to validate
    them. The loop should still echo the real ids.
  - `stream: true` is added for the streaming call and omitted otherwise. `stream_options` was
    never sent, consistent with §2 listing it unsupported.

**Non-streaming response:**

```json
{ "id": "...", "choices": [ { "finish_reason": "tool_calls", "index": 0,
    "message": { "role": "assistant", "content": null, "reasoning_content": "...",
                 "refusal": null,
                 "tool_calls": [ { "id": "call_9bf872ffd21d46278c73d4f3", "type": "function",
                                   "function": { "name": "top_queries",
                                                 "arguments": "{\"period\": \"last_28_days\", \"limit\": 5}" } } ] } } ],
  "created": 1789110307, "model": "sarvam-105b", "object": "chat.completion",
  "usage": { "completion_tokens": 274, "prompt_tokens": 3958, "total_tokens": 4232,
             "completion_tokens_details": null, "prompt_tokens_details": null } }
```

`finish_reason` is `"tool_calls"` when the turn asked for tools. Call ids are 24 hex characters
prefixed `call_`. `arguments` is a JSON **string**, as `LlmToolCall` already assumes.

**Streamed response** — `text/event-stream`, `data:`-prefixed JSON, terminated by `data: [DONE]`.
Each frame:

```json
{ "id": "20260911_0aa59a6b-...", "choices": [ { "index": 0, "finish_reason": null, "logprobs": null,
    "matched_stop": null,
    "delta": { "role": null, "content": null, "reasoning_content": " asking",
               "function_call": null, "refusal": null, "tool_calls": null } } ],
  "created": 1789110307, "model": "sarvam-105b", "object": "chat.completion.chunk",
  "service_tier": null, "system_fingerprint": null, "usage": null }
```

Tool-call fragments replace `tool_calls: null` with:

```json
"tool_calls": [ { "index": 1, "id": null, "type": "function",
                  "function": { "name": null, "arguments": "0" } } ]
```

Three details step 2 should know:

1. **`usage` arrives in the stream** without `stream_options` being sent — in a dedicated
   penultimate frame with `"choices": []`, immediately before `[DONE]`. `streamConverse` currently
   discards it: `parseSseJson` yields the frame, and the `if (!choice) continue` guard skips it.
   Driver needs token counts for a budget, so that frame should be read rather than a separate
   non-streaming call being made for it.
2. **`finish_reason` arrives on its own frame** after the last content or tool fragment, with an
   otherwise empty delta. `streamConverse` already handles this.
3. **The frame count is the CPU cost.** One frame per token, ~400 bytes each. A 3,649-token reply
   is 1.4 MB of SSE. This is the whole of §2's finding.

---

## 5. What was not measured

Stated so nothing here is mistaken for a fact it is not.

- **CPU on Cloudflare's edge.** Every CPU figure is Node 22 on an Apple-silicon laptop. workerd
  runs the same V8 but on different hardware. The conclusion that streaming is ~300× the CPU of
  non-streaming is a ratio and survives the machine difference; the absolute 1.8-6.0 ms against a
  10 ms budget does not, and should be re-measured on a deployed Worker before the loop's shape is
  frozen. A `wrangler dev`-hosted measurement would be closer but still not the edge.
- **Whether a `connect()` TCP socket counts as a subrequest.** The limits page does not say. It
  does not change the conclusion, because even counting every query as a subrequest the worst case
  is ~25 against 50.
- **Any ceiling on parallel calls above four.** Four was asked for and four arrived. Five was not
  tried.
- **Whether calls ever interleave in the stream.** They did not in the one multi-call stream
  captured. One observation is not a contract.
- **Behaviour under vendor error or rate limit.** No call failed. All 23 returned 200, so the
  retry and degradation paths §4.8 describes are still unexercised.
- **`wiki_grounding`.** Not tested; out of scope for this probe.
- **Whether `reasoning_effort` affects answer quality.** Only latency and token counts were
  measured. No quality judgement was made and none should be read into the recommendation to leave
  it at default.

---

## 6. The loop's bounds, in one place

Every number below traces to a measurement above.

| Bound | Value | Source |
|---|---|---|
| Max model rounds per turn | 4 | §3, wall-clock budget ÷ median round |
| Max tool calls per round | 4 | §1, measured to work; no vendor ceiling found |
| Tool calls within a round | executed concurrently | §1, vendor returns them together |
| Wall-clock budget per turn | 45 s, enforced as a deadline across the turn | §3, median round 5.2 s, worst 19.1 s |
| Token budget | ~15,000 tokens at 4 rounds, against a 128,000 window | §2, 6,866 measured for round 1 |
| History trimming | not needed for v1 | §2, 12% of the window at worst |
| Streaming | final answer round only; tool rounds non-streamed | §2, 1.8-6.0 ms CPU per streamed round against 10 ms on Free |
| `reasoning_effort` | omit; take the vendor default | §3, no measurable latency effect |
| `max_tokens` | 16,000, unchanged | §3, largest completion measured 3,649 |
| Model | `sarvam-105b` | 128K window; the 32K model would reach 47% by round 4 |

**The one open question this probe raises rather than answers:** the account is on Workers Free,
and a streamed round costs 18-60% of that plan's entire 10 ms CPU budget on a laptop measurement.
Either the plan moves to Paid, or the final round is measured on a real Worker before Driver's
loop is committed to streaming at all. That decision belongs with step 3, not here.
