#!/usr/bin/env node
/**
 * Builds every platform concurrently and collects the installers into
 * dist/releases/<version>[-signed]/ with a manifest.json.
 *
 *   node scripts/release.mjs            # unsigned, all three local
 *   node scripts/release.mjs --signed   # mac signed + linux local, Windows signed on CI
 *
 * `concurrently` lets every job finish, then rejects with all results if any
 * failed, so one platform's failure can't hide another's.
 */

import { concurrently } from 'concurrently'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { loadEnv } = createRequire(import.meta.url)('./lib/env.js')

// dist/releases/ is a permanent archive, so a search must skip it or a stale
// installer could match before the freshly-built one.
function findFile(dir, predicate) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'releases') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findFile(full, predicate)
      if (found) return found
    } else if (predicate(entry.name)) {
      return full
    }
  }
  return null
}

function wipeDistExceptReleases(distDir) {
  if (!fs.existsSync(distDir)) return
  for (const entry of fs.readdirSync(distDir)) {
    if (entry === 'releases') continue
    fs.rmSync(path.join(distDir, entry), { recursive: true, force: true })
  }
}

function collect({ distDir, releaseDir, version, signed }) {
  const found = {
    arm64: findFile(distDir, (f) => f.endsWith('-arm64.dmg')),
    x64: findFile(distDir, (f) => f.endsWith('-x64.dmg')),
    win: findFile(distDir, (f) => f.endsWith('-setup.exe')),
    linux: findFile(distDir, (f) => f.endsWith('.AppImage')),
  }
  const missing = Object.keys(found).filter((k) => !found[k])
  if (missing.length) {
    console.error(`\nMissing installers in dist/: ${missing.join(', ')}`)
    process.exit(1)
  }

  fs.mkdirSync(releaseDir, { recursive: true })
  const manifest = {}
  for (const [key, file] of Object.entries(found)) {
    fs.copyFileSync(file, path.join(releaseDir, path.basename(file)))
    manifest[key] = path.basename(file)
  }
  fs.writeFileSync(path.join(releaseDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  console.log(`\nRelease v${version}${signed ? ' (signed)' : ''} → ${path.relative(ROOT, releaseDir)}/`)
  for (const name of Object.values(manifest)) console.log(`  ${name}`)
  console.log('  manifest.json')
}

async function main() {
  const signed = process.argv.includes('--signed')

  if (signed) {
    Object.assign(process.env, loadEnv(ROOT))
    // Checked up front, or they're first demanded after a ~20min build+notarize
    const REQUIRED = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'CSC_NAME',
      'MINIO_ENDPOINT', 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY']
    const missingVars = REQUIRED.filter((k) => !process.env[k])
    if (missingVars.length) {
      console.error(`\nMissing env vars: ${missingVars.join(', ')}. Fill in .env first.\n`)
      process.exit(1)
    }
    try {
      execSync('gh auth status', { stdio: 'ignore' })
    } catch {
      console.error('\ngh CLI is not authenticated (needed to dispatch the Windows CI build). Run: gh auth login\n')
      process.exit(1)
    }
  }

  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const distDir = path.join(ROOT, 'dist')
  const releaseDir = path.join(distDir, 'releases', signed ? `${version}-signed` : version)

  console.log(`\nBuilding MAXINE Font Studio v${version}${signed ? ' (signed)' : ''}...\n`)
  wipeDistExceptReleases(distDir)

  // Python and the electron-vite build run once, in sequence, before the
  // fan-out. Concurrent predist steps would race on the host interpreter, and
  // a concurrent vite build could empty out/ while another platform packs it.
  execSync('npm run predist:mac', { cwd: ROOT, stdio: 'inherit' })
  execSync('npm run predist:linux', { cwd: ROOT, stdio: 'inherit' })
  if (!signed) execSync('npm run predist:win', { cwd: ROOT, stdio: 'inherit' })
  execSync('npx electron-vite build', { cwd: ROOT, stdio: 'inherit' })

  const jobs = signed
    ? [
        { name: 'mac', command: 'npx electron-builder --mac --config electron-builder.signed.js' },
        { name: 'linux', command: 'npx electron-builder --linux' },
        { name: 'win', command: 'npm run dist:win-signed' },
      ]
    : [
        { name: 'mac', command: 'npx electron-builder --mac', env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } },
        { name: 'linux', command: 'npx electron-builder --linux' },
        { name: 'win', command: 'npx electron-builder --win' },
      ]

  try {
    await concurrently(jobs, { cwd: ROOT }).result
  } catch (rejected) {
    if (!Array.isArray(rejected)) {
      console.error('\nUnexpected error running builds:', rejected)
      process.exit(1)
    }
    const failed = rejected.filter((e) => e.exitCode !== 0)
    console.error(`\nBuild failed for: ${failed.map((e) => e.command.name).join(', ')}`)
    console.error('No release directory was written (incomplete build set).')
    process.exit(1)
  }

  collect({ distDir, releaseDir, version, signed })
  wipeDistExceptReleases(distDir)
  console.log('\ndist/ cleaned -- only dist/releases/ remains.')
}

main()
