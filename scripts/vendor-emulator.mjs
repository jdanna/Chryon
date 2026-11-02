#!/usr/bin/env node
/**
 * Builds the emulator for a package and assembles everything it needs in
 * resources/emulator/<platform>-<arch>/, which electron-builder copies in as
 * resources/emulator. Fails if anything's missing, so a package can't ship without it.
 *
 *   node scripts/vendor-emulator.mjs linux x64
 *   node scripts/vendor-emulator.mjs darwin arm64
 *   node scripts/vendor-emulator.mjs win32 x64
 *
 * Linux builds in Docker on Ubuntu 22.04 (emulator/Dockerfile.linux), which works from a Mac as well
 * and keeps the binary off this computer's newer glibc. MAXINE_NATIVE_BUILD=1 builds here instead.
 * A Mac build is arm64 only, and builds natively. Windows cross-compiles in Docker, from a Mac or Linux
 * (emulator/Dockerfile.windows).
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EMULATOR = join(ROOT, 'emulator')
const DOCKER_IMAGE = 'maxine-emulator-build'
const DOCKER_IMAGE_WINDOWS = 'maxine-emulator-build-windows'
const REQUIRED_LINUX_LIB = 'libSDL2-2.0.so.0'
const UNIX_SCRIPTS = ['net-up.sh', 'net-down.sh']
const WINDOWS_SCRIPTS = ['net-up.ps1', 'net-down.ps1']
const FFMPEG_NOTICES = ['FFMPEG-NOTICE.txt', 'FFMPEG-LICENSE.txt']

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

function docker(tree, command, { image = DOCKER_IMAGE, platform = ['--platform', 'linux/amd64'], env = [] } = {}) {
  const user = process.getuid ? ['-u', `${process.getuid()}:${process.getgid()}`] : []
  run('docker', [
    'run', '--rm', ...platform, ...user,
    '-e', 'HOME=/tmp', '-e', `MAXINE_MAME_DIR=/src/${tree}`, ...env,
    '-v', `${ROOT}:/src`, '-w', '/src', image, 'sh', '-c', command
  ])
}

/** Copies what's the same on every platform. The binary goes in by its plain name. */
function assemble(dest, tree, { built = 'maxine', binary = 'maxine', scripts = UNIX_SCRIPTS } = {}) {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(join(dest, 'roms'), { recursive: true })
  mkdirSync(join(dest, 'artwork'), { recursive: true })
  copyFileSync(join(ROOT, tree, built), join(dest, binary))
  chmodSync(join(dest, binary), 0o755)
  cpSync(join(ROOT, tree, 'plugins'), join(dest, 'plugins'), { recursive: true })
  cpSync(join(EMULATOR, 'artwork', 'maxine'), join(dest, 'artwork', 'maxine'), { recursive: true })
  for (const file of readdirSync(join(EMULATOR, 'roms'))) {
    if (file.endsWith('.chd')) copyFileSync(join(EMULATOR, 'roms', file), join(dest, 'roms', file))
  }
  for (const script of scripts) copyFileSync(join(EMULATOR, script), join(dest, script))
}

/** ffmpeg writes the video captures. It's LGPL and ships as a separate program, with its licence beside it. */
function addFfmpeg(dest, folder, binary = 'ffmpeg') {
  copyFileSync(join(folder, binary), join(dest, binary))
  chmodSync(join(dest, binary), 0o755)
  for (const file of FFMPEG_NOTICES) copyFileSync(join(folder, file), join(dest, file))
}

function vendorLinux(dest) {
  const relDest = relative(ROOT, dest)
  if (process.env.MAXINE_NATIVE_BUILD) {
    if (process.platform !== 'linux') throw new Error('MAXINE_NATIVE_BUILD only works on Linux.')
    run(join(EMULATOR, 'build.sh'), [])
    run(join(EMULATOR, 'build-ffmpeg.sh'), [])
    assemble(dest, 'emulator/mame')
    addFfmpeg(dest, join(EMULATOR, 'ffmpeg'))
    run(join(EMULATOR, 'collect-libs.sh'), [join(dest, 'maxine'), join(dest, 'lib')])
    return
  }
  if (!ensureDocker()) {
    throw new Error('The Linux emulator builds in Docker, and Docker is not running. On Linux, set MAXINE_NATIVE_BUILD=1 to build on this computer instead, which ties the package to its glibc or newer.')
  }
  const tree = 'emulator/mame-linux-x64'
  run('docker', ['build', '--platform', 'linux/amd64', '-t', DOCKER_IMAGE, '-f', join(EMULATOR, 'Dockerfile.linux'), EMULATOR])
  docker(tree, 'emulator/build.sh')
  docker(tree, 'emulator/build-ffmpeg.sh', { env: ['-e', 'MAXINE_FFMPEG_DIR=/src/emulator/ffmpeg-linux-x64'] })
  assemble(dest, tree)
  addFfmpeg(dest, join(EMULATOR, 'ffmpeg-linux-x64'))
  docker(tree, `emulator/collect-libs.sh ${relDest}/maxine ${relDest}/lib`)
}

/** SDL links statically here, so there are no libraries to collect. The compiler runs natively on any host. */
function vendorWindows(dest) {
  if (!ensureDocker()) throw new Error('The Windows emulator builds in Docker, and Docker is not running.')
  const tree = 'emulator/mame-win32-x64'
  run('docker', ['build', '-t', DOCKER_IMAGE_WINDOWS, '-f', join(EMULATOR, 'Dockerfile.windows'), EMULATOR])
  const windows = { image: DOCKER_IMAGE_WINDOWS, platform: [] }
  const target = ['-e', 'MAXINE_TARGET=windows']
  docker(tree, 'emulator/build.sh', { ...windows, env: target })
  docker(tree, 'emulator/build-ffmpeg.sh', { ...windows, env: [...target, '-e', 'MAXINE_FFMPEG_DIR=/src/emulator/ffmpeg-win32-x64'] })
  assemble(dest, tree, { built: 'sdlmaxine.exe', binary: 'maxine.exe', scripts: WINDOWS_SCRIPTS })
  addFfmpeg(dest, join(EMULATOR, 'ffmpeg-win32-x64'), 'ffmpeg.exe')
  docker(tree, `x86_64-w64-mingw32-strip ${relative(ROOT, dest)}/maxine.exe`, windows)
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
  run(join(EMULATOR, 'build-ffmpeg.sh'), [])
  assemble(dest, 'emulator/mame')
  bundleDylibs(dest)
  addFfmpeg(dest, join(EMULATOR, 'ffmpeg'))
  run('codesign', ['--force', '-s', '-', join(dest, 'ffmpeg')])
}

/** Runs the finished binary when this computer can, so a missing library fails here and not for a user. */
function check(dest, platform, arch) {
  const binary = platform === 'win32' ? 'maxine.exe' : 'maxine'
  const ffmpeg = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const scripts = platform === 'win32' ? WINDOWS_SCRIPTS : UNIX_SCRIPTS
  for (const path of [binary, ffmpeg, 'plugins/boot.lua', 'plugins/layout/init.lua', 'artwork/maxine/default.lay', 'roms/maxine-default.chd', 'roms/maxine-v11.01.chd', ...scripts, ...FFMPEG_NOTICES]) {
    if (!existsSync(join(dest, path))) throw new Error(`Missing from the package: ${path}`)
  }
  if (readFileSync(join(dest, 'FFMPEG-NOTICE.txt'), 'utf8').includes('--enable-gpl')) throw new Error('ffmpeg was built with --enable-gpl, which would change the licence of the package.')
  if (platform === 'linux' && !existsSync(join(dest, 'lib', REQUIRED_LINUX_LIB))) throw new Error(`Missing from the package: lib/${REQUIRED_LINUX_LIB}`)
  if (platform !== process.platform || arch !== process.arch) return
  const env = { ...process.env, LD_LIBRARY_PATH: join(dest, 'lib') }
  const version = execFileSync(join(dest, binary), ['-version'], { cwd: dest, env, encoding: 'utf8' }).trim()
  console.log(`  runs: ${version}`)
  const encoders = execFileSync(join(dest, ffmpeg), ['-hide_banner', '-encoders'], { encoding: 'utf8' })
  if (!encoders.includes('prores_ks')) throw new Error('The packaged ffmpeg has no ProRes encoder.')
}

const [platform, arch] = process.argv.slice(2)
if (!(platform === 'darwin' && arch === 'arm64') && !(platform === 'win32' && arch === 'x64') && !(platform === 'linux' && ['x64', 'arm64'].includes(arch))) {
  console.error('Usage: vendor-emulator.mjs darwin arm64 | win32 x64 | linux <x64|arm64>')
  process.exit(1)
}

const dest = join(ROOT, 'resources', 'emulator', `${platform}-${arch}`)
console.log(`Emulator for ${platform}-${arch}`)
if (platform === 'linux') vendorLinux(dest)
else if (platform === 'win32') vendorWindows(dest)
else vendorMac(dest)
check(dest, platform, arch)
console.log(`  ${relative(ROOT, dest)}`)
