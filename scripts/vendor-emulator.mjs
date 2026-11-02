#!/usr/bin/env node
/**
 * Builds the emulator for a package and assembles everything it needs in
 * resources/emulator/<platform>-<arch>/, which electron-builder copies in as
 * resources/emulator. Fails if anything's missing, so a package can't ship without it.
 *
 *   node scripts/vendor-emulator.mjs linux x64
 *   node scripts/vendor-emulator.mjs darwin arm64
 *
 * Linux builds in Docker on Ubuntu 22.04 (emulator/Dockerfile.linux), which works from a Mac as well
 * and keeps the binary off this computer's newer glibc. MAXINE_NATIVE_BUILD=1 builds here instead.
 * A Mac build is arm64 only, and builds natively.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EMULATOR = join(ROOT, 'emulator')
const DOCKER_IMAGE = 'maxine-emulator-build'
const REQUIRED_LINUX_LIB = 'libSDL2-2.0.so.0'

const run = (cmd, args, options = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...options })
const read = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' })
const dockerWorks = () => spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0

/** A Mac can start Docker Desktop itself, which takes up to a few minutes. */
function ensureDocker() {
  if (dockerWorks()) return true
  if (process.platform !== 'darwin') return false
  console.log('  Starting Docker Desktop')
  if (spawnSync('open', ['-a', 'Docker']).status !== 0) return false
  for (let attempt = 0; attempt < 60; attempt++) {
    if (dockerWorks()) return true
    spawnSync('sleep', ['3'])
  }
  return false
}

function docker(tree, command) {
  const user = process.getuid ? ['-u', `${process.getuid()}:${process.getgid()}`] : []
  run('docker', [
    'run', '--rm', '--platform', 'linux/amd64', ...user,
    '-e', 'HOME=/tmp', '-e', `MAXINE_MAME_DIR=/src/${tree}`,
    '-v', `${ROOT}:/src`, '-w', '/src', DOCKER_IMAGE, 'sh', '-c', command
  ])
}

/** Copies what's the same on every platform. The binary goes in by its plain name. */
function assemble(dest, tree) {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(join(dest, 'roms'), { recursive: true })
  mkdirSync(join(dest, 'artwork'), { recursive: true })
  copyFileSync(join(ROOT, tree, 'maxine'), join(dest, 'maxine'))
  chmodSync(join(dest, 'maxine'), 0o755)
  cpSync(join(ROOT, tree, 'plugins'), join(dest, 'plugins'), { recursive: true })
  cpSync(join(EMULATOR, 'artwork', 'maxine'), join(dest, 'artwork', 'maxine'), { recursive: true })
  for (const file of readdirSync(join(EMULATOR, 'roms'))) {
    if (file.endsWith('.chd')) copyFileSync(join(EMULATOR, 'roms', file), join(dest, 'roms', file))
  }
  for (const script of ['net-up.sh', 'net-down.sh']) copyFileSync(join(EMULATOR, script), join(dest, script))
}

function vendorLinux(dest) {
  const relDest = relative(ROOT, dest)
  if (process.env.MAXINE_NATIVE_BUILD) {
    if (process.platform !== 'linux') throw new Error('MAXINE_NATIVE_BUILD only works on Linux.')
    run(join(EMULATOR, 'build.sh'), [])
    assemble(dest, 'emulator/mame')
    run(join(EMULATOR, 'collect-libs.sh'), [join(dest, 'maxine'), join(dest, 'lib')])
    return
  }
  if (!ensureDocker()) {
    throw new Error('The Linux emulator builds in Docker, and Docker is not running. On Linux, set MAXINE_NATIVE_BUILD=1 to build on this computer instead, which ties the package to its glibc or newer.')
  }
  const tree = 'emulator/mame-linux-x64'
  run('docker', ['build', '--platform', 'linux/amd64', '-t', DOCKER_IMAGE, '-f', join(EMULATOR, 'Dockerfile.linux'), EMULATOR])
  docker(tree, 'emulator/build.sh')
  assemble(dest, tree)
  docker(tree, `emulator/collect-libs.sh ${relDest}/maxine ${relDest}/lib`)
}

/** Points the binary at private copies of the Homebrew libraries it uses, such as SDL2. */
function bundleDylibs(dest) {
  const libDir = join(dest, 'lib')
  mkdirSync(libDir, { recursive: true })
  const external = (path) => path.startsWith('/opt/homebrew/') || path.startsWith('/usr/local/')
  const dependencies = (file) =>
    read('otool', ['-L', file]).split('\n').slice(1).map((line) => line.trim().split(' ')[0]).filter(Boolean)

  const seen = new Set()
  const visit = (file) => {
    for (const dep of dependencies(file)) {
      if (!external(dep)) continue
      const name = basename(dep)
      if (!seen.has(name)) {
        seen.add(name)
        const copy = join(libDir, name)
        copyFileSync(realpathSync(dep), copy)
        chmodSync(copy, 0o755)
        run('install_name_tool', ['-id', `@executable_path/lib/${name}`, copy])
        visit(copy)
      }
      run('install_name_tool', ['-change', dep, `@executable_path/lib/${name}`, file])
    }
  }
  const binary = join(dest, 'maxine')
  visit(binary)

  // Editing a Mach-O invalidates its signature, and Apple Silicon won't run an unsigned one
  const files = [...readdirSync(libDir).map((name) => join(libDir, name)), binary]
  for (const file of files) {
    const left = dependencies(file).filter((dep) => external(dep) || dep.startsWith('@rpath/'))
    if (left.length) throw new Error(`${basename(file)} still needs ${left.join(', ')}`)
    run('codesign', ['--force', '-s', '-', file])
  }
}

function vendorMac(dest) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('The Mac emulator has to be built on an Apple Silicon Mac.')
  run(join(EMULATOR, 'build.sh'), [])
  assemble(dest, 'emulator/mame')
  bundleDylibs(dest)
}

/** Runs the finished binary when this computer can, so a missing library fails here and not for a user. */
function check(dest, platform, arch) {
  for (const path of ['maxine', 'plugins/boot.lua', 'plugins/layout/init.lua', 'artwork/maxine/default.lay', 'roms/maxine-default.chd', 'roms/maxine-v11.01.chd', 'net-up.sh', 'net-down.sh']) {
    if (!existsSync(join(dest, path))) throw new Error(`Missing from the package: ${path}`)
  }
  if (platform === 'linux' && !existsSync(join(dest, 'lib', REQUIRED_LINUX_LIB))) throw new Error(`Missing from the package: lib/${REQUIRED_LINUX_LIB}`)
  if (platform !== process.platform || arch !== process.arch) return
  const env = { ...process.env, LD_LIBRARY_PATH: join(dest, 'lib') }
  const version = execFileSync(join(dest, 'maxine'), ['-version'], { cwd: dest, env, encoding: 'utf8' }).trim()
  console.log(`  runs: ${version}`)
}

const [platform, arch] = process.argv.slice(2)
if (!(platform === 'darwin' && arch === 'arm64') && !(platform === 'linux' && ['x64', 'arm64'].includes(arch))) {
  console.error('Usage: vendor-emulator.mjs darwin arm64 | linux <x64|arm64>')
  process.exit(1)
}

const dest = join(ROOT, 'resources', 'emulator', `${platform}-${arch}`)
console.log(`Emulator for ${platform}-${arch}`)
if (platform === 'linux') vendorLinux(dest)
else vendorMac(dest)
check(dest, platform, arch)
console.log(`  ${relative(ROOT, dest)}`)
