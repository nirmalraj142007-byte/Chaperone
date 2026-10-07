# Rubric map

The track's stated goals, each mapped to the file, command or test that
supports it, with a status that says what is and is not there. A row marked
**Not delivered** is a gap, written down so a reviewer does not have to find it.
Nothing here is a score; the scoring is the judges'.

Status key: **Delivered** (the evidence runs and says what the row claims) ·
**Partial** (some of it exists; the missing part is named) · **Not delivered**.

---

## 1. An MCP integration on Streamable HTTP

| Claim | Status | Evidence |
|---|---|---|
| Chaperone is an MCP server on Streamable HTTP, spec revision `2025-11-25` | Delivered | `packages/gateway/src/session.ts` (one `StreamableHTTPServerTransport` per session), `packages/gateway/src/protocol.ts`; `@modelcontextprotocol/sdk` 1.30.0 |
| Session lifecycle is correct: id minted on `initialize`, missing id 400, unknown id 404, `DELETE` terminates | Delivered | `spec/conformance.spec.test.ts`; run with `pnpm spec` (27 named assertions) |
| An older protocol revision is refused, naming both versions | Delivered | the same suite |
| Transport hygiene: 406 without the required `Accept`, 403 on a disallowed `Origin`, bind to loopback by default | Delivered | `packages/gateway/src/security.ts`; conformance suite |
| Resumable SSE: every event durable before it is sent, `Last-Event-ID` replays | Delivered locally | `packages/gateway/src/event-store.ts`; `spec/resumption.test.ts` (ten kill-and-resume iterations, `place_order` invoked exactly once each time, counted by the upstream); `pnpm resume-demo` for one narrated run |
| The same suites pass against a deployed environment | **Not delivered** | `TARGET=https://<host>/mcp` is supported by `pnpm spec` and `pnpm test:resume`, but there is no deployed environment to point them at. `infra/` contains the advisory pipeline stack only; there is no ECS/ALB stack |
| Progress notifications, cancellation, `list_changed` | Delivered | conformance suite; `e2e/consent-flow.spec.ts` for `list_changed` |
| Honest friction with the SDK, recorded as it happened | Delivered | `friction-log.md`; `docs/PRODUCT-FEEDBACK.md`, section "MCP TypeScript SDK" |

## 2. Agent Skills

| Claim | Status | Evidence |
|---|---|---|
| The repo ships an Agent Skill | **Not delivered** | There is no `SKILL.md` and no skill packaging anywhere in the repository. The exact format the track means has also not been confirmed against the track page, so no format is assumed here |
| What exists in its place | Partial | The assistant-facing surface that a skill would describe does exist and is testable: the gateway's first-party tools `chaperone/pending_changes` and `chaperone/approve_change` (`packages/gateway/src/firstPartyTools.ts`), and the frozen refusal texts (`packages/policy/src/messages.ts`). A skill teaching an assistant to use them, and to call `approve_change` only on a resident's say-so, is unwritten |

## 3. A simulated Alexa+ experience

| Claim | Status | Evidence |
|---|---|---|
| A web page plays the household assistant, and says it is simulated | Delivered | `packages/assistant-sim` (`pnpm demo:assistant`, port 5174). The page is titled "Simulated Alexa+ experience" and states it is not made by or affiliated with Amazon. No Amazon or Alexa branding is used. Decision record: `docs/DECISIONS.md`, "The simulated Alexa+ experience is the primary demo surface" |
| The assistant has no model, and the page says so | Delivered | `packages/assistant-sim/src/rules.ts` is the whole assistant: fixed phrases mapped to tool calls. The banner reads "rule-based stand-in for the assistant's model — not part of Chaperone" |
| It is a real MCP host, with no shortcut around the gateway | Delivered | Official SDK client over Streamable HTTP (`packages/assistant-sim/src/gateway.ts`); `initialize`, `tools/list`, `tools/call`, `list_changed` |
| The consent card appears inside the conversation as an MCP App | Delivered | `@modelcontextprotocol/ext-apps` 1.7.5 `AppBridge`; sandboxed frame; `ui/initialize` handshake; text card as the floor. `e2e/assistant-sim.spec.ts` (four tests: approve, keep blocked, text floor, gateway unreachable) |
| The refusal is the gateway's frozen text, byte for byte | Delivered | `e2e/assistant-sim.spec.ts` compares the page's text to `REFUSAL_TOOL_CHANGED` |
| Speech | Partial | Spoken replies (`speechSynthesis`) behind a default-off toggle. No speech recognition, deliberately: browsers send that audio to a vendor's cloud, which would break "runs with the network off" |
| Two hand-written stand-ins in the demo | Disclosed | the advisory line on the card and the "12 January" approval history are fixtures, labelled on screen; `demo/OFFLINE.md` lists which is which |

## 4. Maintaining state across sessions

This is the core claim: an assistant re-reads a tool's instructions on every
connect and keeps nothing; Chaperone is the memory.

| Claim | Status | Evidence |
|---|---|---|
| What the household approved is kept: a content hash of each tool definition, written at approval | Delivered | `packages/ledger/src/repos/pin.ts`; hashing in `packages/policy/src/canonical.ts` |
| The comparison is a pure hash compare, with no model and no clock | Delivered | `packages/policy/src/allow.ts`; `packages/policy` is gated at 100% statements and branches |
| "No model in the policy" is enforced, not asserted | Delivered | `pnpm depcruise` rule `no-llm-in-policy` (`.dependency-cruiser.cjs`) fails the build when `packages/policy` imports a model client |
| A changed tool is withheld and held for review, and every other tool keeps working | Delivered | `packages/gateway/src/gate.ts`; denied tools are left out of `tools/list`; `e2e/consent-flow.spec.ts` |
| Storage failure never means allow | Delivered | `e2e/fails-closed.spec.ts`; `/healthz` 503 is never permissive |
| The household's history is an append-only, hash-chained ledger that can be verified | Delivered | `packages/ledger/src/repos/ledgerEvent.ts` (`appendEvent` only); `pnpm verify-ledger` / `pnpm demo:ledger` ("chain OK"); `pnpm test:tamper` |
| A refused change stays refused until a resident decides otherwise | Delivered | `spec/refusal-final.test.ts`; `docs/DECISIONS.md`, "A refused change is not re-asked" |
| The session itself survives a dropped connection | Delivered locally | the resumability rows in section 1 |

## 5. Evidence beyond the demo

| Claim | Status | Evidence |
|---|---|---|
| The interval between the two crawls is stated as a day count | Delivered | **35 days**, 2026-09-15 to 2026-10-20; `CRAWL_DATES.md`; `pnpm check-claims` fails on rounded-week language |
| The taxonomy and predictions were fixed before the first crawl | Delivered | `corpus/TAXONOMY.md`, `corpus/PREDICTIONS.md`, committed 2026-09-12 and not edited since; `docs/QA.md` question 1 |
| The drift rate | **Not measured yet** | {{PENDING: semantic-intent drift rate and its denominator — 2026-10-20}} |
| An unaided-model comparison, reported as a delta, never an absolute block rate | Delivered, one model | `gpt-oss-120b` on Groq, two-turn: followed in 52 of 90 attack runs (57.8%), refused 0, 0 of 30 benign controls refused. `docs/BASELINE2-RUBRIC.md` was committed before the run; `data/baseline2-raw.json` holds every response; `pnpm eval:baseline2` re-scores with no model call |
| The tautology is stated, not hidden | Delivered | README "What this does not prove"; the guard test in `packages/eval/test/guards.test.ts` fails if an absolute Chaperone block rate enters a report |
| An ecosystem finding independent of the product | Delivered | 139 of 291 attempted servers (47.8%) did not start from their own setup instructions; `data/boot-rate.json` |

## 6. Hackathon-adjacent deliverables

| Item | Status | Evidence |
|---|---|---|
| Friction log in the required six-field form | Delivered | `friction-log.md` |
| Product feedback for each tool used | Partial | `docs/PRODUCT-FEEDBACK.md`. The CDK deploy section and the Kiro section are open placeholders: nothing was deployed, and Kiro was not used |
| Public HTTPS deployment | **Not delivered** | no ECS/ALB stack in `infra/`; no deployed URL |
| Multi-service AWS pipeline | Partial | `infra/lib/advisory-pipeline-stack.ts` synthesises (`pnpm infra:synth`); it has never been deployed, so there is no execution-graph screenshot |
| Added latency against real DynamoDB | **Not measured yet** | {{PENDING: added p50/p95/p99 against DynamoDB on AWS — after the AWS deployment (Phase 18)}}. Against DynamoDB Local the 30 ms p95 budget fails (591.89 ms), and `pnpm bench` exits 1 on purpose |
