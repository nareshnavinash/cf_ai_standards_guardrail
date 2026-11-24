# Standards Guardrail — Design

Date: 2026-11-24 · Deadline: ship today (2026-11-24)

## Intent and why

Cloudflare's fast-track assignment for the **Engineering Manager, Developer Productivity** role asks for an
AI-powered app on Cloudflare with: an LLM, workflow/coordination, chat or voice input, and memory/state.
The prompt history must be submitted too.

That team's second focus area is *"turning engineering standards into automated guardrails, paved paths,
and feedback engineers can act on, instead of checklists and manual review."* So the submission is a
small working version of exactly that: an agent that reviews a GitHub pull request against a written
standards catalog, explains each violation, suggests a fix, and remembers approved exceptions per repo.

It is meant to show: a prototype agent built fast ("ship a rough version this week"), judgment about
where an LLM is and isn't the right tool, evals, and clear writing about the why.

## Goals

- A reviewer can try it in **under a minute with no setup**: open a URL, click a sample PR or paste any
  public GitHub PR link, see findings, chat about them, add an exception, re-run and see it applied.
- All four required components are real, each doing a job the product needs:
  - **LLM:** Llama 3.3 70B on Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) judges the rules
    that need judgment, and answers chat questions.
  - **Coordination:** a Cloudflare **Workflow** runs each review as durable, retried steps.
  - **Input:** a chat panel in the web UI (served as Worker static assets).
  - **Memory:** a **Durable Object per repo** (SQLite) stores exceptions, past reviews, and chat history.
- An **eval set** with a precision/recall score per rule, committed with its results.
- Repo named `cf_ai_standards_guardrail` with `README.md` (design note + run instructions + live URL) and
  `PROMPTS.md` (generated from Claude Code session logs, user prompts only, plus the app's runtime prompts).

## Non-goals (today)

- Real Cloudflare Engineering Codex content — we use a short sample catalog written for this demo.
- Auth, multi-tenant accounts, private repos.
- Auto-fixing by pushing commits.

## Stretch (only after the core is deployed and the README is done)

1. GitHub App webhook that comments findings on PRs to a public demo repo.
2. MCP endpoint exposing `review_pr` and `list_rules`.
3. `/stats` page: which rules fire most, which get exceptions most.

## Anti-goals

- A demo that only works on the happy path: a bad URL, a huge PR, or a model returning junk must give a
  clear message, never a blank screen or 500.
- An LLM doing what a regex does reliably. Deterministic checks run first; the LLM only gets rules that
  need judgment.
- Leaking private context into `PROMPTS.md` (other job applications, memory files, system reminders,
  subagent briefs, shell output, tokens).
- A public demo that can be vandalised (global exceptions) or exploited (XSS through LLM/diff text).
- Evals that only prove the author agrees with themselves: include cases from real public PRs and say
  what the eval does not show.

## Constraints

- **Free Cloudflare plan** (decided by Naresh). It caps CPU at ~10 ms per invocation/step, Workers AI
  at 10k neurons/day (≈ 12 reviews with the 70B model), and keeps Workflow instances ~3 days. The design
  works within that: small per-step work, a daily LLM review cap with static-only fallback, long-lived
  cache for sample PRs, and review results persisted in the DO.
- **A read-only GitHub token is required** (`GITHUB_TOKEN` secret, fine-grained, public repos only).
  Unauthenticated calls share Cloudflare's egress IPs and hit GitHub's 60/hour limit almost at once.
- Budget protection: cache results in KV keyed by `sha256(RULES_VERSION + LLM_MODEL + promptHash + diff)`;
  5 reviews/min and 10 chats/min per IP; global cap of 12 LLM reviews/day (`DAILY_LLM_REVIEWS`), after which reviews run in
  **static-only mode** with a banner.
- Size limits: diff ≤ 100 KB; ≤ 10 files and ≤ 300 added lines per file reviewed; each line cut to
  500 chars; ≤ 12 KB of code per file sent to the LLM. Lockfiles, binaries, and minified files
  (`*.min.js` or average line > 1,000 chars) are skipped and listed.
- Public demo safety: anything from the diff, the LLM, or users is rendered as text, never HTML, under a
  strict CSP. Exceptions on the shared sample repo are scoped to each visitor so one person can't hide
  findings from everyone. Exception globs can't be catch-alls (`*`, `**`, `**/*`).
- TypeScript, Wrangler, Vitest. No frontend framework (plain HTML/CSS/JS).

## Approaches considered

| Approach | Trade-off | Decision |
|---|---|---|
| Enhance the portfolio chat (RAG + evals + MCP) | Live with real users, but off the team's mission | Rejected |
| **Standards guardrail, web app first, GitHub bot as stretch** | Mirrors the team's work; zero-setup to test; bot needs GitHub App setup | **Chosen** |
| Standards guardrail as GitHub bot only | Realistic, but reviewers must fork/open PRs, and no "chat" input | Rejected |
| Agents SDK (`AIChatAgent`) vs plain Durable Object | SDK is idiomatic but adds API surface and version risk on a same-day deadline | Plain DO with RPC (my call) |
| Streaming over WebSocket vs polling | Polling every 1.5 s is enough for a 20–60 s review | Polling (my call) |

The README states the Agents SDK choice explicitly, so it reads as a trade-off, not unfamiliarity.

## The design

**Standards catalog** (`RULES_VERSION = "2026.11.1"`), 7 rules:

| ID | Rule | Check |
|---|---|---|
| STD-001 | No hardcoded secrets or credentials | static |
| STD-002 | No silently swallowed errors (empty `catch`) | static |
| STD-003 | TODO/FIXME must reference a ticket (`ABC-123`) | static |
| STD-004 | Source changes ship with tests | static (file list) |
| STD-005 | Outbound network calls have a timeout and handle failure | llm |
| STD-006 | User-facing errors are actionable and don't leak internals | llm |
| STD-007 | Logs are structured, with no secrets or PII | llm |

**Review flow.** The Worker validates the input and loads the diff (sample, or GitHub API) *before*
starting a Workflow, so bad URLs fail fast with a clear message and never start one. Then
`ReviewWorkflow` runs: `parse` → `cache-lookup` → `static-checks` → `llm-check:<i>` (one step per
file, 4 in parallel, 2 retries each) → `cache-store` → `apply-exceptions` (from repo DO) → `persist`
(DO). Output: `ReviewResult`.

**Degrade, don't fail.** If a file's LLM step still fails after retries (bad JSON, truncation, quota),
that file is marked *degraded*, its static findings are kept, the UI says "LLM check unavailable for N
files", and the result is not cached. A review only ends in an error when the input itself is unusable.

**Exceptions are applied after the cache**, so a new exception takes effect on the very next run.
Results are persisted in the DO, so a review link keeps working after the Workflow instance expires.

**Chat:** `POST /api/reviews/:id/chat` loads the review and that review's chat history from the repo DO,
calls Llama with the findings + relevant patches as context, stores both turns. Exceptions are added
with an explicit button on each finding (rule + path glob + reason), not inferred from chat — a
guardrail's exceptions must be deliberate and auditable.

**Prompt-injection stance:** diff content is wrapped as data, the model is constrained to a JSON schema,
rule IDs and line numbers outside the catalog/added lines are dropped, and static rules never depend on
the model.

## Revision 3 notes

- **Control Durable Object.** One global SQLite DO holds the review index, stored diffs, in-flight dedupe and the daily review/chat counters. Free-plan KV allows 1,000 writes/day, so KV now only caches results of full, non-degraded reviews. Counters are reserved atomically before a Workflow starts.
- **Exceptions are visitor-scoped everywhere** (not just on the sample repo), so nobody can add exceptions to a real repo's memory for other people. Anonymous visitors are read-only.
- **Chat has its own budget:** 10 questions per review, `DAILY_CHAT_TURNS` (60) per day, and no chat for static-only reviews.
- **Cost controls:** test files are never sent to the LLM (static rules still apply); a reply that cannot be parsed degrades the file without a retry; private repos are refused; glob matching is linear-time and rejects broad globs.

## Left to the builder

UI styling, exact regexes beyond the cases in the plan's tests, sample PR contents beyond the listed
violations, eval case wording.
