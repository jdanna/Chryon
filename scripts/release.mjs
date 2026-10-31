#!/usr/bin/env node
/**
 * Builds every platform concurrently and collects the installers into
 * dist/releases/<version>/ with a manifest.json.
 *
 * `concurrently` lets every job finish, then rejects with all results if any
 * failed, so one platform's failure can't hide another's.
 */

import { concurrently } from 'concurrently'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

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

function collect({ distDir, releaseDir, version }) {
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

  console.log(`\nRelease v${version} → ${path.relative(ROOT, releaseDir)}/`)
  for (const name of Object.values(manifest)) console.log(`  ${name}`)
  console.log('  manifest.json')
}

async function main() {
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const distDir = path.join(ROOT, 'dist')
  const releaseDir = path.join(distDir, 'releases', version)

  console.log(`\nBuilding MAXINE! Studio v${version}...\n`)
  wipeDistExceptReleases(distDir)

  // Python and the electron-vite build run once, in sequence, before the
  // fan-out. Concurrent predist steps would race on the host interpreter, and
  // a concurrent vite build could empty out/ while another platform packs it.
  execSync('npm run predist:mac', { cwd: ROOT, stdio: 'inherit' })
  execSync('npm run predist:linux', { cwd: ROOT, stdio: 'inherit' })
  execSync('npm run predist:win', { cwd: ROOT, stdio: 'inherit' })
  execSync('npx electron-vite build', { cwd: ROOT, stdio: 'inherit' })

  const jobs = [
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

  collect({ distDir, releaseDir, version })
  wipeDistExceptReleases(distDir)
  console.log('\ndist/ cleaned -- only dist/releases/ remains.')
}

main()
