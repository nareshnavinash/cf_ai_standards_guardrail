import type { DiffFile, Finding } from '../types'

const SECRET_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /AKIA[A-Z0-9]{16}/, what: 'an AWS access key id' },
  { re: /ghp_[A-Za-z0-9]{36}/, what: 'a GitHub personal access token' },
  { re: /github_pat_[A-Za-z0-9_]{82}/, what: 'a GitHub fine-grained token' },
  { re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, what: 'a private key' },
  {
    re: /(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|auth)[\w-]*["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i,
    what: 'a hardcoded credential',
  },
]

const EMPTY_CATCH_INLINE = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/
const CATCH_OPEN = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*$/
const TODO_RE = /(?:\/\/|#|\/\*|^\s*\*|<!--|--)[^]*?\b(?:TODO|FIXME)\b/
const TICKET_RE = /\b[A-Z][A-Z0-9]+-\d+\b/
const TEST_PATH = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/
const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rb|java|kt|rs|php|cs|swift|c|cc|cpp|h|hpp|scala|sh)$/i

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path)
}

function isSourcePath(path: string): boolean {
  return CODE_EXT.test(path) && !isTestPath(path) && !/(^|\/)docs\//.test(path)
}

export function runStaticChecks(files: DiffFile[], allPaths: string[]): Finding[] {
  const out: Finding[] = []
  const anyTest = allPaths.some(isTestPath)

  for (const f of files) {
    if (f.status === 'deleted' || f.status === 'binary') continue
    const byLine = new Map(f.added.map((l) => [l.line, l.text]))

    for (const { line, text } of f.added) {
      const secret = SECRET_PATTERNS.find((p) => p.re.test(text))
      if (secret) {
        out.push({
          ruleId: 'STD-001',
          path: f.path,
          line,
          message: `This line appears to contain ${secret.what}.`,
          suggestion: 'Remove it from the code, rotate the credential, and load it from the environment or a secret manager.',
          source: 'static',
        })
      }

      if (EMPTY_CATCH_INLINE.test(text) || (CATCH_OPEN.test(text) && byLine.get(line + 1)?.trim() === '}')) {
        out.push({
          ruleId: 'STD-002',
          path: f.path,
          line,
          message: 'This catch block is empty, so the error is silently swallowed.',
          suggestion: 'Log the error with context, handle it, or rethrow it.',
          source: 'static',
        })
      }

      if (TODO_RE.test(text) && !TICKET_RE.test(text)) {
        out.push({
          ruleId: 'STD-003',
          path: f.path,
          line,
          message: 'This TODO/FIXME does not reference a ticket.',
          suggestion: 'Add a ticket id such as TODO(ABC-123) or file a ticket and link it.',
          source: 'static',
        })
      }
    }

    if (f.added.length > 0 && !anyTest && isSourcePath(f.path)) {
      out.push({
        ruleId: 'STD-004',
        path: f.path,
        line: null,
        message: 'Source code changed but this pull request contains no test changes.',
        suggestion: 'Add or update a test that covers this change in the same pull request.',
        source: 'static',
      })
    }
  }
  return out
}
