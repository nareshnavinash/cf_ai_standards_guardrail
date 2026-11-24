import type { Rule } from './types'

export const RULES_VERSION = '2026.11.1'

export const RULES: Rule[] = [
  {
    id: 'STD-001',
    title: 'No hardcoded secrets or credentials',
    rationale: 'Secrets committed to source control are leaked to everyone with read access and are hard to rotate.',
    severity: 'error',
    kind: 'static',
    guidance: 'Load secrets from the environment or a secret manager; never commit keys, tokens, passwords or private keys.',
  },
  {
    id: 'STD-002',
    title: 'No silently swallowed errors',
    rationale: 'An empty catch block hides failures and makes incidents much harder to diagnose.',
    severity: 'error',
    kind: 'static',
    guidance: 'Handle the error, log it with context, or rethrow it. Never leave a catch block empty.',
  },
  {
    id: 'STD-003',
    title: 'TODO/FIXME must reference a ticket',
    rationale: 'Untracked TODOs rot; a ticket reference makes the debt visible and owned.',
    severity: 'warning',
    kind: 'static',
    guidance: 'Reference a ticket such as ABC-123 next to every TODO or FIXME.',
  },
  {
    id: 'STD-004',
    title: 'Source changes ship with tests',
    rationale: 'Changes without tests regress silently and are harder to review.',
    severity: 'warning',
    kind: 'static',
    guidance: 'Add or update tests in the same pull request as the source change.',
  },
  {
    id: 'STD-005',
    title: 'Outbound network calls have a timeout and handle failure',
    rationale: 'A call without a timeout can hang a request indefinitely, and unhandled failures cascade.',
    severity: 'warning',
    kind: 'llm',
    guidance:
      'Flag outbound network calls (fetch, HTTP clients, RPC) that have no timeout or abort signal, or whose failure (network error, non-2xx status) is not handled. Do not flag code that already sets a timeout and handles failure.',
  },
  {
    id: 'STD-006',
    title: "User-facing errors are actionable and don't leak internals",
    rationale: 'Stack traces and raw exception text leak implementation details and do not help the user recover.',
    severity: 'warning',
    kind: 'llm',
    guidance:
      'Flag error responses or messages shown to users that include stack traces, raw exception messages, SQL, file paths or other internals, or that give the user no way to act (e.g. just "Error"). Do not flag internal logging.',
  },
  {
    id: 'STD-007',
    title: 'Logs are structured, with no secrets or PII',
    rationale: 'Unstructured logs are hard to query, and logging secrets or personal data creates compliance and security risk.',
    severity: 'warning',
    kind: 'llm',
    guidance:
      'Flag log statements that print secrets, tokens, passwords or personal data (emails, names, phone numbers), or that use ad-hoc string logging (console.log of interpolated strings) where a structured logger or key/value fields should be used.',
  },
]

export function ruleById(id: string): Rule | undefined {
  return RULES.find((r) => r.id === id)
}
