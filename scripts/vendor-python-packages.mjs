#!/usr/bin/env node
/**
 * Vendors the converter's dependencies (resources/requirements-prod.txt) into
 * a previously-downloaded bundled Python interpreter's site-packages, so
 * electron-builder's `python -> python` extraResources copy bundles them.
 * Must run AFTER download-python.mjs for the same target.
 *
 * Runs pip in cross-platform download mode through a HOST interpreter (this
 * machine's own, from download-python.mjs), so one Mac can vendor for every
 * target without being able to execute that target's binaries. Only wheels
 * are used (--only-binary=:all:), so nothing built for the target ever runs.
 *
 * Usage:
 *   node scripts/vendor-python-packages.mjs <platform> <arch>
 *   (same values as download-python.mjs, e.g. "darwin arm64" or "win32 x64")
 *
 * Exit codes:
 *   0 — success
 *   1 — error (unsupported target, missing interpreter, pip download failure)
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import extractZip from 'extract-zip'
import { PYTHON_VERSION } from './python-version.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// platformTags: the pip --platform value(s) for this target, passed as repeated
// flags. pip widens a macosx tag to older macOS versions itself, but manylinux
// tags are exact, and wheels land on any of several glibc tags, so list them.
const TARGETS = {
  'darwin-arm64': { platformTags: ['macosx_14_0_arm64'] },
  'win32-x64': { platformTags: ['win_amd64'] },
  'linux-x64': { platformTags: ['manylinux_2_17_x86_64', 'manylinux2014_x86_64', 'manylinux_2_27_x86_64', 'manylinux_2_28_x86_64'] }
}
const PYTHON_BIN_SEGMENTS = { win32: ['python.exe'] } // everything else: ['bin', 'python3']

function pythonBinFor (key) {
  const platform = key.split('-')[0]
  return join(ROOT, 'resources', 'python', key, 'python', ...(PYTHON_BIN_SEGMENTS[platform] || ['bin', 'python3']))
}

// pip's cross-platform download mode needs --python-version/--implementation/
// --abi spelled out explicitly alongside --platform -- without all four, pip
// falls back to matching the RUNNING interpreter's own tags, which is the
// entire problem when the host and target differ.
const [pyMajor, pyMinor] = PYTHON_VERSION.split('.')
const PY_VERSION_TAG = `${pyMajor}.${pyMinor}`
const PY_ABI_TAG = `cp${pyMajor}${pyMinor}`

const [platform, arch] = process.argv.slice(2)
const key = `${platform}-${arch}`
const target = TARGETS[key]

if (!target) {
  console.error(`[vendor-python-packages] Unsupported target: "${key}". Supported: ${Object.keys(TARGETS).join(', ')}`)
  process.exit(1)
}

const pythonDir = join(ROOT, 'resources', 'python', key, 'python')
if (!existsSync(pythonDir)) {
  console.error(`[vendor-python-packages] ${pythonDir} doesn't exist -- run "node scripts/download-python.mjs ${platform} ${arch}" first.`)
  process.exit(1)
}

// The interpreter that actually RUNS pip -- this machine's own, downloading
// it first if this is the first thing on this host to need one. Only
// coincides with the vendoring target above when host and target are the
// same machine (e.g. the Windows CI runner vendoring win32-x64); otherwise
// (e.g. a Mac vendoring win32-x64 as part of `npm run release`) this is a
// different interpreter that pip's cross-platform flags point at the target.
const hostKey = `${process.platform}-${process.arch}`
const hostPythonDir = join(ROOT, 'resources', 'python', hostKey, 'python')
if (!existsSync(hostPythonDir)) {
  console.log(`[vendor-python-packages] Host interpreter (${hostKey}) not found -- downloading it to run pip...`)
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'download-python.mjs'), process.platform, process.arch], { stdio: 'inherit' })
}
const hostPythonBin = pythonBinFor(hostKey)
if (!existsSync(hostPythonBin)) {
  console.error(`[vendor-python-packages] Expected host interpreter not found at ${hostPythonBin}`)
  process.exit(1)
}

// Unix installs version this directory by Python minor version
// (lib/python3.14/site-packages); Windows does not (Lib/site-packages,
// unversioned). Discovered via a glob rather than hardcoding "3.14" a
// second time, so a future PYTHON_VERSION bump in python-version.mjs
// doesn't silently break this script.
function resolveSitePackagesDir () {
    if (platform === 'win32') return join(pythonDir, 'Lib', 'site-packages')
    const libDir = join(pythonDir, 'lib')
    const versionedDir = readdirSync(libDir).find((name) => /^python3\.\d+$/.test(name))
    if (!versionedDir) throw new Error(`Couldn't find a python3.x directory under ${libDir}`)
    return join(libDir, versionedDir, 'site-packages')
}

const sitePackagesDir = resolveSitePackagesDir()
const tmpDownloadDir = join(ROOT, `.vendor-tmp-${key}`)
const requirementsFile = join(ROOT, 'resources', 'requirements-prod.txt')

if (existsSync(tmpDownloadDir)) rmSync(tmpDownloadDir, { recursive: true, force: true })
mkdirSync(tmpDownloadDir, { recursive: true })

console.log(`[vendor-python-packages] Downloading wheels for ${key} (platform tag(s) ${target.platformTags.join(', ')}) using host interpreter ${hostKey}...`)
try {
  execFileSync(hostPythonBin, [
    '-m', 'pip', 'download',
    '--no-input',
    '--only-binary=:all:',
    ...target.platformTags.flatMap((tag) => ['--platform', tag]),
    '--python-version', PY_VERSION_TAG,
    '--implementation', 'cp',
    '--abi', PY_ABI_TAG,
    '-d', tmpDownloadDir,
    '-r', requirementsFile
  ], { stdio: 'inherit' })
} catch (err) {
  console.error(`[vendor-python-packages] pip download failed: ${err.message}`)
  rmSync(tmpDownloadDir, { recursive: true, force: true })
  process.exit(1)
}

const wheels = readdirSync(tmpDownloadDir).filter((f) => f.endsWith('.whl'))
if (wheels.length === 0) {
  console.error('[vendor-python-packages] pip download reported success but produced no .whl files -- unexpected.')
  rmSync(tmpDownloadDir, { recursive: true, force: true })
  process.exit(1)
}
console.log(`[vendor-python-packages] Downloaded ${wheels.length} wheel(s):`)
for (const wheel of wheels) console.log(`  ${wheel}`)

// A wheel is just a zip file, and the converter only ever does plain imports,
// so unpacking is enough. Each top-level entry REPLACES any same-named entry in
// site-packages, so a pin bump can't leave stale modules behind, while the
// interpreter's own pip survives for the next run.
mkdirSync(sitePackagesDir, { recursive: true })
for (const wheel of wheels) {
  console.log(`[vendor-python-packages] Extracting ${wheel} -> ${sitePackagesDir}`)
  const stagingDir = join(tmpDownloadDir, `extract-${wheel}`)
  mkdirSync(stagingDir, { recursive: true })
  await extractZip(join(tmpDownloadDir, wheel), { dir: stagingDir })
  for (const entry of readdirSync(stagingDir)) {
    const dest = join(sitePackagesDir, entry)
    rmSync(dest, { recursive: true, force: true })
    renameSync(join(stagingDir, entry), dest)
  }
  rmSync(stagingDir, { recursive: true, force: true })
}

rmSync(tmpDownloadDir, { recursive: true, force: true })

// The packaged app writes nothing to its install folder, so .pyc files ship in the
// package instead of being compiled on every launch. Bytecode only depends on the
// Python version, so the host interpreter can compile for any target.
// unchecked-hash means an installer changing file times can't invalidate them.
console.log(`[vendor-python-packages] Compiling bytecode for ${key}...`)
execFileSync(hostPythonBin, [
  '-m', 'compileall', '-q', '-f', '-j', '0',
  '--invalidation-mode', 'unchecked-hash',
  '-s', pythonDir,
  '-x', '[/\\\\](pip|test|tests|idlelib|tkinter|turtledemo)[/\\\\]',
  dirname(sitePackagesDir)
], { stdio: 'inherit' })

console.log(`[vendor-python-packages] Done. Vendored into resources/python/${key}/python/`)
