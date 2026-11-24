# Eval results

27 cases (5 from real public GitHub PRs, 22 synthetic). Labels were written by hand by the author from the diffs; the real diffs are stored in `evals/cases/` with their `origin` URL.

## Static rules (STD-001 to STD-004), static-only mode

Run 2026-11-24T08:19:01.355Z against https://cf-ai-standards-guardrail.nareshnavinash.workers.dev, rules version 2026.11.2. No AI spend.

| Rule | TP | FP | FN | Precision | Recall | F1 | Cases |
|---|---|---|---|---|---|---|---|
| STD-001 | 3 | 0 | 0 | 1.00 | 1.00 | 1.00 | 27 |
| STD-002 | 3 | 0 | 0 | 1.00 | 1.00 | 1.00 | 27 |
| STD-003 | 3 | 0 | 0 | 1.00 | 1.00 | 1.00 | 27 |
| STD-004 | 3 | 1 | 0 | 0.75 | 1.00 | 0.86 | 27 |

| Case | Source | Expected | Found | Result | Seconds |
|---|---|---|---|---|---|
| catch-variants | synthetic | STD-002 | STD-002 | match | 3.0 |
| clean-docs-only | synthetic | - | - | match | 3.0 |
| clean-small-refactor | synthetic | - | - | match | 3.0 |
| injection-fake-findings | synthetic | STD-002 | STD-002 | match | 2.5 |
| injection-ignore-instructions | synthetic | STD-001 | STD-001 | match | 2.6 |
| llm-error-friendly | synthetic | - | - | match | 2.6 |
| llm-error-leaks-stack | synthetic | - | - | match | 2.6 |
| llm-fetch-no-timeout | synthetic | - | - | match | 2.6 |
| llm-fetch-with-timeout | synthetic | - | - | match | 2.5 |
| llm-log-pii | synthetic | - | - | match | 2.6 |
| llm-log-structured | synthetic | - | - | match | 2.6 |
| lockfile-only | synthetic | - | - | match | 2.5 |
| near-miss-secrets | synthetic | - | - | match | 2.6 |
| real-express-7459 | real | - | - | match | 2.5 |
| real-express-7512 | real | - | STD-004 | MISMATCH | 2.5 |
| real-fastify-7233 | real | - | - | match | 2.6 |
| real-hono-5542 | real | STD-004 | STD-004 | match | 2.6 |
| real-hono-5669 | real | - | - | match | 2.6 |
| rename-only | synthetic | - | - | match | 2.6 |
| sample-clean-change | synthetic | - | - | match | 2.5 |
| sample-leaky-config | synthetic | STD-001 | STD-001 | match | 2.5 |
| sample-swallowed-errors | synthetic | STD-002 | STD-002 | match | 2.5 |
| sample-untested-endpoint | synthetic | STD-003, STD-004 | STD-003, STD-004 | match | 2.6 |
| secret-patterns | synthetic | STD-001 | STD-001 | match | 2.5 |
| todo-tickets | synthetic | STD-003 | STD-003 | match | 2.5 |
| untested-source-only | synthetic | STD-004 | STD-004 | match | 2.5 |
| xss-payload | synthetic | STD-003 | STD-003 | match | 2.6 |

## LLM rules (STD-005 to STD-007), full mode, run once

Run 2026-11-24T08:19:21.654Z against https://cf-ai-standards-guardrail.nareshnavinash.workers.dev, rules version 2026.11.2. 8 cases sent to the model. Degraded: 0. Errors: 0.

| Rule | TP | FP | FN | Precision | Recall | F1 | Cases |
|---|---|---|---|---|---|---|---|
| STD-005 | 1 | 0 | 0 | 1.00 | 1.00 | 1.00 | 8 |
| STD-006 | 1 | 0 | 0 | 1.00 | 1.00 | 1.00 | 8 |
| STD-007 | 1 | 0 | 0 | 1.00 | 1.00 | 1.00 | 8 |

| Case | Source | Expected | Found | Result | Seconds |
|---|---|---|---|---|---|
| llm-error-friendly | synthetic | - | - | match | 4.2 |
| llm-error-leaks-stack | synthetic | STD-006 | STD-006 | match | 5.9 |
| llm-fetch-no-timeout | synthetic | STD-005 | STD-005 | match | 12.9 |
| llm-fetch-with-timeout | synthetic | - | - | match | 4.0 |
| llm-log-pii | synthetic | STD-007 | STD-007 | match | 9.8 |
| llm-log-structured | synthetic | - | - | match | 4.0 |
| real-fastify-7233 | real | - | - | match | 4.1 |
| real-hono-5669 | real | - | - | match | 4.0 |

## Timing

Mean seconds per review: static-only 2.6, with LLM 6.1.

## What this eval does not show

- **Small n.** 27 cases in total, and the LLM rules saw only 8, with exactly one positive example each (STD-005, STD-006, STD-007). A perfect LLM score here is 3 for 3 on positives and 5 correct silences, which is far too little to claim a precision or recall. These are smoke-test numbers, not estimates of production accuracy.
- **Author-labelled.** One person wrote the standards, the cases and the labels, with no second rater, so the scores measure agreement with the author, not with a team.
- **Synthetic bias.** Most cases were written to exercise a rule, which makes them easier than organic code. Static rules scoring 1.00 on them mostly proves the regexes match the cases they were written for.
- **Real PRs are mostly clean.** The five real PRs come from well-run open source projects and are mostly violation-free, so they test false positives far more than recall. One (`real-express-7512`, comment-only edits) deliberately records a known static false positive on STD-004.
- **LLM variance.** The model ran once per case at low temperature. Re-running could change results, and the Llama 3.3 70B behaviour can shift with Cloudflare model updates.
- **No line-level scoring.** A case matches when the set of rule ids matches; whether the right line was flagged is not scored.
- **Not the real standards.** The catalog is a seven-rule demo, not any company policy.
