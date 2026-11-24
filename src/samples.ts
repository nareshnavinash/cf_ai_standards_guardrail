export interface Sample {
  id: string
  title: string
  description: string
  diff: string
  expectedStatic: string[]
}

/** Builds a unified diff that adds each file in full. */
export function addFiles(files: { path: string; lines: string[] }[]): string {
  return (
    files
      .map(
        (f) =>
          [
            `diff --git a/${f.path} b/${f.path}`,
            'new file mode 100644',
            'index 0000000..1111111',
            '--- /dev/null',
            `+++ b/${f.path}`,
            `@@ -0,0 +1,${f.lines.length} @@`,
            ...f.lines.map((l) => '+' + l),
          ].join('\n'),
      )
      .join('\n') + '\n'
  )
}

export const SAMPLES: Sample[] = [
  {
    id: 'leaky-config',
    title: 'leaky-config',
    description: 'A config module with hardcoded credentials and a log line that prints personal data.',
    expectedStatic: ['STD-001'],
    diff: addFiles([
      {
        path: 'src/config.ts',
        lines: [
          "export const config = {",
          "  region: 'eu-west-1',",
          '  api_key: "demo-0000-not-a-real-key",',
          '}',
          '',
          "export const awsAccessKey = 'AKIAIOSFODNN7EXAMPLE'",
          '',
          'export function onLogin(user: { email: string; token: string }) {',
          '  console.log(`login ok for ${user.email} token=${user.token}`)',
          '}',
        ],
      },
      {
        path: 'test/config.test.ts',
        lines: ["import { config } from '../src/config'", '', "test('has a region', () => expect(config.region).toBeTruthy())"],
      },
    ]),
  },
  {
    id: 'swallowed-errors',
    title: 'swallowed-errors',
    description: 'A payment handler that swallows errors and returns a raw stack trace to the user.',
    expectedStatic: ['STD-002'],
    diff: addFiles([
      {
        path: 'src/payments.ts',
        lines: [
          'export async function charge(order: Order) {',
          '  try {',
          '    await gateway.charge(order)',
          '  } catch (e) {}',
          '}',
          '',
          'export function toResponse(err: Error) {',
          '  return new Response(`Payment failed: ${err.stack}`, { status: 500 })',
          '}',
        ],
      },
      {
        path: 'test/payments.test.ts',
        lines: ["import { charge } from '../src/payments'", '', "test('exports charge', () => expect(charge).toBeDefined())"],
      },
    ]),
  },
  {
    id: 'untested-endpoint',
    title: 'untested-endpoint',
    description: 'A new endpoint with an untracked TODO, no tests, and an outbound call with no timeout.',
    expectedStatic: ['STD-003', 'STD-004'],
    diff: addFiles([
      {
        path: 'src/handlers/weather.ts',
        lines: [
          '// TODO cache this response',
          'export async function weather(city: string) {',
          '  const res = await fetch(`https://api.example.com/weather?city=${city}`)',
          '  return res.json()',
          '}',
        ],
      },
    ]),
  },
  {
    id: 'clean-change',
    title: 'clean-change',
    description: 'A small, tested utility that follows every standard.',
    expectedStatic: [],
    diff: addFiles([
      {
        path: 'src/slugify.ts',
        lines: [
          'export function slugify(input: string): string {',
          "  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')",
          '}',
        ],
      },
      {
        path: 'test/slugify.test.ts',
        lines: [
          "import { slugify } from '../src/slugify'",
          '',
          "test('slugifies', () => expect(slugify(' Hello World! ')).toBe('hello-world'))",
        ],
      },
    ]),
  },
]
