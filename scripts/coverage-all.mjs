#!/usr/bin/env node
/**
 * Coverage of the studio across both test suites.
 *
 * Unit tests run in Node and the browser suite runs the real app in Chromium,
 * so each sees code the other cannot: unit tests reach error branches no
 * browser run triggers, and the browser suite runs the hooks, pages and
 * components that only make sense with a real DOM, media stack and server.
 *
 *   1. Vitest with V8 coverage writes coverage/coverage-final.json.
 *   2. The browser suite runs with LIVEDECK_E2E_COVERAGE=1; e2e/test.ts records
 *      V8 coverage of every page into coverage-e2e/.
 *   3. monocart-coverage-reports maps the browser coverage back to the
 *      TypeScript sources through the dev server's source maps.
 *   4. A line counts as covered when either suite executed it. The set of
 *      executable lines is the unit report's (it includes every file under
 *      src/, tested or not), so the browser suite can only cover lines the
 *      unit report also counts.
 *
 * The two reports come from different instrumenters, so their statement and
 * branch maps do not line up; only lines and functions are merged. Each
 * suite's own branch numbers are printed beside the merged ones.
 *
 *   node scripts/coverage-all.mjs            # run both suites, then merge
 *   node scripts/coverage-all.mjs --merge    # merge existing results only
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import MCR from 'monocart-coverage-reports'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UNIT_JSON = path.join(ROOT, 'coverage', 'coverage-final.json')
// Outside coverage/, which Vitest empties at the start of every run.
const E2E_DIR = path.join(ROOT, 'coverage-e2e')
const E2E_JSON = path.join(E2E_DIR, 'coverage-final.json')
const MERGED_JSON = path.join(ROOT, 'coverage', 'merged-summary.json')
const THRESHOLD_LINES = Number(process.env.LIVEDECK_COVERAGE_LINES ?? 80)

const mergeOnly = process.argv.includes('--merge')

function run(label, args, env = {}) {
  console.log(`\n▶ ${label}`)
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } })
  if (result.status !== 0) {
    console.error(`✖ ${label} failed (exit ${result.status}).`)
    process.exit(result.status ?? 1)
  }
}

/** `C:\\x\\livedeck\\src\\a.ts`, `/src/a.ts`, `webpack://x/src/a.ts` → `src/a.ts` */
function normalize(file) {
  const unix = file.replace(/\\/g, '/').split('?')[0]
  const match = /(?:^|\/)(src\/.+)$/.exec(unix)
  return match ? match[1] : null
}

/** Per file: executable lines with hit counts, and functions by declaration line. */
function summarize(istanbul) {
  const files = new Map()
  for (const [key, data] of Object.entries(istanbul)) {
    const file = normalize(data.path ?? key)
    if (!file) continue
    const lines = new Map()
    for (const [id, location] of Object.entries(data.statementMap)) {
      const line = location.start.line
      lines.set(line, Math.max(lines.get(line) ?? 0, data.s[id] ?? 0))
    }
    const functions = new Map()
    for (const [id, fn] of Object.entries(data.fnMap)) {
      const line = (fn.decl ?? fn.loc).start.line
      functions.set(line, Math.max(functions.get(line) ?? 0, data.f[id] ?? 0))
    }
    const branches = { total: 0, covered: 0 }
    for (const counts of Object.values(data.b ?? {})) {
      branches.total += counts.length
      branches.covered += counts.filter((count) => count > 0).length
    }
    files.set(file, { lines, functions, branches })
  }
  return files
}

async function convertBrowserCoverage() {
  if (!existsSync(path.join(E2E_DIR, '.cache'))) {
    console.warn('No browser coverage was recorded; merging unit coverage alone.')
    return {}
  }
  await MCR({
    name: 'LiveDeck browser suite',
    outputDir: E2E_DIR,
    reports: [['json', { file: 'coverage-final.json' }]],
    // The dev server's source maps name each source by its bare file name,
    // so modules are chosen by URL and named by the module they came from.
    entryFilter: (entry) => /\/src\//.test(entry.url) && !entry.url.includes('node_modules'),
    sourcePath: (filePath, info) => normalize(info.distFile ?? '') ?? normalize(filePath) ?? filePath,
    logging: 'error',
  }).generate()
  return JSON.parse(readFileSync(E2E_JSON, 'utf8'))
}

function percent(covered, total) {
  return total === 0 ? 100 : Math.round((covered / total) * 10000) / 100
}

async function main() {
  if (!mergeOnly) {
    rmSync(path.join(ROOT, 'coverage'), { recursive: true, force: true })
    rmSync(E2E_DIR, { recursive: true, force: true })
    run('Unit tests with coverage', [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--coverage',
      '--coverage.reporter=json',
      '--coverage.reporter=text-summary',
    ])
    run('Browser suite with coverage', ['node_modules/@playwright/test/cli.js', 'test', '--reporter=line'], {
      LIVEDECK_E2E_COVERAGE: '1',
    })
  }

  const unit = summarize(JSON.parse(readFileSync(UNIT_JSON, 'utf8')))
  const browser = summarize(await convertBrowserCoverage())

  const totals = { lines: [0, 0], functions: [0, 0], unitLines: [0, 0], browserLines: [0, 0], unitBranches: [0, 0], browserBranches: [0, 0] }
  const byDirectory = new Map()
  for (const [file, own] of unit) {
    const other = browser.get(file)
    const directory = file.split('/').slice(0, file.startsWith('src/services/') || file.startsWith('src/components/') ? 3 : 2).join('/')
    const bucket = byDirectory.get(directory) ?? { covered: 0, total: 0, unit: 0 }
    for (const [line, hits] of own.lines) {
      const byBrowser = (other?.lines.get(line) ?? 0) > 0
      const covered = hits > 0 || byBrowser
      totals.lines[1] += 1
      totals.unitLines[1] += 1
      totals.browserLines[1] += 1
      bucket.total += 1
      if (covered) {
        totals.lines[0] += 1
        bucket.covered += 1
      }
      if (hits > 0) {
        totals.unitLines[0] += 1
        bucket.unit += 1
      }
      if (byBrowser) totals.browserLines[0] += 1
    }
    for (const [line, hits] of own.functions) {
      totals.functions[1] += 1
      if (hits > 0 || (other?.functions.get(line) ?? 0) > 0) totals.functions[0] += 1
    }
    totals.unitBranches[0] += own.branches.covered
    totals.unitBranches[1] += own.branches.total
    if (other) {
      totals.browserBranches[0] += other.branches.covered
      totals.browserBranches[1] += other.branches.total
    }
    byDirectory.set(directory, bucket)
  }

  const summary = {
    merged: {
      lines: percent(...totals.lines),
      functions: percent(...totals.functions),
      linesCovered: totals.lines[0],
      linesTotal: totals.lines[1],
    },
    unitOnly: { lines: percent(...totals.unitLines), branches: percent(...totals.unitBranches) },
    browserOnly: { lines: percent(...totals.browserLines), branches: percent(...totals.browserBranches) },
    directories: Object.fromEntries(
      [...byDirectory].sort().map(([directory, bucket]) => [
        directory,
        { merged: percent(bucket.covered, bucket.total), unitOnly: percent(bucket.unit, bucket.total), lines: bucket.total },
      ]),
    ),
  }
  writeFileSync(MERGED_JSON, JSON.stringify(summary, null, 2))

  console.log('\nCoverage of src/ across unit and browser tests (lines)')
  console.log('directory'.padEnd(34), 'merged'.padStart(8), 'unit'.padStart(8), 'lines'.padStart(7))
  for (const [directory, row] of Object.entries(summary.directories)) {
    console.log(directory.padEnd(34), `${row.merged}%`.padStart(8), `${row.unitOnly}%`.padStart(8), String(row.lines).padStart(7))
  }
  console.log('')
  console.log(`Merged     lines ${summary.merged.lines}% (${totals.lines[0]}/${totals.lines[1]})  functions ${summary.merged.functions}%`)
  console.log(`Unit only  lines ${summary.unitOnly.lines}%  branches ${summary.unitOnly.branches}%`)
  console.log(`Browser    lines ${summary.browserOnly.lines}%  branches ${summary.browserOnly.branches}% (of files it loaded)`)

  if (summary.merged.lines < THRESHOLD_LINES) {
    console.error(`\n✖ Merged line coverage ${summary.merged.lines}% is below ${THRESHOLD_LINES}%.`)
    process.exit(1)
  }
  console.log(`\n✔ Merged line coverage meets ${THRESHOLD_LINES}%.`)
}

await main()
