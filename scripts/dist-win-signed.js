#!/usr/bin/env node
// Dispatches .github/workflows/dist-win-signed.yml on the self-hosted Windows
// runner, waits for it, then downloads the signed installer into dist/.

const { execSync, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { downloadWinSigned } = require('./lib/minio')

// gh's update-notifier forks a background process that can hold this script's
// stdio pipe open after it has finished.
process.env.GH_NO_UPDATE_NOTIFIER = '1'

const REPO     = 'jdanna/Chryon'
const WORKFLOW = 'dist-win-signed.yml'

function gh(...args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim()
}

const rootDir = path.join(__dirname, '..')
const distDir = path.join(rootDir, 'dist')
const pkg     = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'))

try { execSync('git fetch origin main --quiet', { cwd: rootDir, stdio: 'ignore' }) } catch {}
try {
  const localHead  = execSync('git rev-parse HEAD',        { cwd: rootDir, encoding: 'utf8' }).trim()
  const remoteHead = execSync('git rev-parse origin/main', { cwd: rootDir, encoding: 'utf8' }).trim()
  if (localHead !== remoteHead) {
    console.warn(`\nWarning: local HEAD (${localHead.slice(0, 7)}) != origin/main (${remoteHead.slice(0, 7)}).`)
    console.warn('The Windows CI build signs origin/main HEAD — push first if this build should include local commits.')
  }
} catch {}

console.log('\nDispatching Windows signed build...')

let preDispatchRunId = null
try {
  const pre = JSON.parse(gh('run', 'list', '--repo', REPO, '--workflow', WORKFLOW, '--limit', '1', '--json', 'databaseId'))
  if (pre.length) preDispatchRunId = pre[0].databaseId
} catch {}

execSync(`gh workflow run ${WORKFLOW} --repo ${REPO}`, { stdio: 'inherit' })

let winRun = null
for (let attempt = 0; attempt < 24; attempt++) {
  execSync('sleep 5')
  try {
    const [run] = JSON.parse(gh('run', 'list', '--repo', REPO, '--workflow', WORKFLOW, '--limit', '1', '--json', 'databaseId,url'))
    if (run && run.databaseId !== preDispatchRunId) { winRun = run; break }
  } catch {}
}
if (!winRun) { console.error('\nTimed out waiting for Windows workflow run to appear.'); process.exit(1) }
console.log(`Windows run #${winRun.databaseId}: ${winRun.url}\n`)

console.log('Waiting for build to complete...')
try {
  execSync(`gh run watch ${winRun.databaseId} --repo ${REPO}`, { stdio: 'inherit' })
} catch {}

const result = JSON.parse(
  gh('run', 'view', String(winRun.databaseId), '--repo', REPO, '--json', 'conclusion,url')
)
if (result.conclusion !== 'success') {
  console.error(`\nWindows build failed (${result.conclusion}). Logs: ${result.url}`)
  process.exit(1)
}

fs.mkdirSync(distDir, { recursive: true })
console.log('\nDownloading signed Windows installer...')
downloadWinSigned(winRun.databaseId, distDir)
  .then((exePath) => {
    const expected = `${pkg.name}-${pkg.version}-setup.exe`
    const actual   = path.basename(exePath)
    if (actual !== expected) {
      console.error(`\nSigned installer version mismatch: expected ${expected}, got ${actual}.`)
      console.error('CI builds origin/main HEAD — push the version bump and re-run.')
      process.exit(1)
    }
    console.log(`\nDone: dist/${actual}`)
  })
  .catch((err) => {
    console.error(`\nFailed to download signed installer: ${err.message || err}`)
    process.exit(1)
  })
