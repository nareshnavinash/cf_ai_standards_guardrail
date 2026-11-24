#!/usr/bin/env node
/**
 * Local test attestation.
 *   node scripts/attest.mjs            run typecheck, unit tests and e2e; on success write .ci/attestation.json
 *   node scripts/attest.mjs --verify   recompute the tree hash and compare (exit 0 match, 10 mismatch, with the reason)
 *
 * The tree hash covers every git-tracked file (path and contents) except .ci/attestation.json itself and anything under examples/, so it changes
 * when any tracked file changes and does not change when the attestation is committed. Untracked files are ignored.
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ATTESTATION = '.ci/attestation.json'
const sha = (b) => createHash('sha256').update(b).digest('hex')

function fileDigest(root, path) {
  const full = join(root, path)
  return existsSync(full) ? sha(readFileSync(full)) : 'missing'
}

/** Per-file digests of the given paths, minus the attestation file, sorted by path. */
export function fileHashes(files, root = process.cwd()) {
  const out = {}
  for (const f of [...new Set(files)].filter((f) => f !== ATTESTATION).sort()) out[f] = fileDigest(root, f)
  return out
}

/** sha256 over sorted `path\0contents` of the given files, excluding the attestation file. */
export function computeTreeHash(files, root = process.cwd()) {
  const h = createHash('sha256')
  for (const f of [...new Set(files)].filter((f) => f !== ATTESTATION).sort()) {
    const full = join(root, f)
    h.update(f + '\0')
    h.update(existsSync(full) ? readFileSync(full) : 'missing')
    h.update('\0')
  }
  return h.digest('hex')
}

/** Demo code under examples/ is not app code: it is the target of example pull requests and must not invalidate the attestation. */
export const isHashed = (f) => !f.startsWith('examples/')

export function trackedFiles(root = process.cwd()) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).filter(isHashed)
}

/** Explains why an attestation no longer matches, or returns null when it does. */
export function mismatchReason(att, files, root = process.cwd()) {
  if (!att) return `no ${ATTESTATION} found`
  if (att.passed !== true) return 'the recorded run did not pass'
  const now = computeTreeHash(files, root)
  if (att.treeHash === now) return null
  const cur = fileHashes(files, root)
  const old = att.fileHashes ?? {}
  const changed = Object.keys(cur).filter((f) => old[f] !== undefined && old[f] !== cur[f])
  const added = Object.keys(cur).filter((f) => old[f] === undefined)
  const removed = Object.keys(old).filter((f) => cur[f] === undefined)
  const parts = []
  if (changed.length) parts.push(`changed: ${changed.join(', ')}`)
  if (added.length) parts.push(`added: ${added.join(', ')}`)
  if (removed.length) parts.push(`removed: ${removed.join(', ')}`)
  return `tree hash differs (attested ${att.treeHash.slice(0, 12)}, now ${now.slice(0, 12)})${parts.length ? '; ' + parts.join('; ') : ''}`
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false })
  process.stdout.write(r.stdout ?? '')
  process.stderr.write(r.stderr ?? '')
  return { ok: r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

const count = (out, re) => {
  const m = out.match(re)
  return m ? Number(m[1]) : null
}

function attest(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const testsRun = {}
  for (const [name, script, re] of [
    ['typecheck', 'typecheck', null],
    ['unit', 'test', /Tests\s+(?:\d+ failed \| )?(\d+) passed/],
    ['e2e', 'test:e2e', /(\d+) passed/],
  ]) {
    if (!pkg.scripts?.[script]) continue
    console.log(`\n> npm run ${script}`)
    const r = run('npm', ['run', script])
    if (!r.ok) {
      console.error(`\nattest: "npm run ${script}" failed, attestation not written`)
      process.exit(1)
    }
    testsRun[name] = re ? count(r.out.replace(/\x1b\[[0-9;]*m/g, ''), re) : true
  }
  const files = trackedFiles(root)
  const att = {
    treeHash: computeTreeHash(files, root),
    node: process.version,
    passed: true,
    testsRun,
    at: new Date().toISOString(),
    fileHashes: fileHashes(files, root),
  }
  mkdirSync(join(root, '.ci'), { recursive: true })
  writeFileSync(join(root, ATTESTATION), JSON.stringify(att, null, 2) + '\n')
  console.log(`\nattest: wrote ${ATTESTATION} (tree ${att.treeHash.slice(0, 12)}, ${JSON.stringify(testsRun)})`)
}

function verify(root) {
  const p = join(root, ATTESTATION)
  const att = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
  const why = mismatchReason(att, trackedFiles(root), root)
  if (why === null) {
    console.log(`tests attested locally at ${att.at}`)
    return 0
  }
  console.log(`attestation does not match: ${why}`)
  return 10
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  if (process.argv.includes('--verify')) process.exit(verify(root))
  attest(root)
}
