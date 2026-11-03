#!/usr/bin/env node
/**
 * Builds the web version of the emulator into dist-web/, a static site for any web host. The emulator is
 * emulator/build.sh with MAXINE_TARGET=web, which needs Emscripten in ~/emsdk or $EMSDK. Set
 * MAXINE_SKIP_EMULATOR=1 to rebuild only the page.
 *
 * The site uses emulator/roms/maxine-web.chd when there is one, and maxine-default.chd until then. The
 * WebAssembly file is gzipped like the disk, because Cloudflare Pages refuses any file over 25 MiB.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EMULATOR = join(ROOT, 'emulator')
const TREE = join(EMULATOR, 'mame-web')
const SITE = join(ROOT, 'dist-web')
const OUT = join(SITE, 'emulator')
const IMAGES = ['maxine-web.chd', 'maxine-default.chd']
// Paths in the emulator's file system, which the page fetches and writes there before it starts
const FILES = {
  'artwork/maxine/default.lay': join(EMULATOR, 'artwork/maxine/default.lay'),
  'plugins/boot.lua': join(TREE, 'plugins/boot.lua'),
  'plugins/layout/init.lua': join(TREE, 'plugins/layout/init.lua'),
  'plugins/layout/plugin.json': join(TREE, 'plugins/layout/plugin.json')
}

const run = (cmd, args, env = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } })

if (!process.env.MAXINE_SKIP_EMULATOR) run('sh', ['emulator/build.sh'], { MAXINE_TARGET: 'web', MAXINE_MAME_DIR: TREE })

rmSync(SITE, { recursive: true, force: true })
run('npx', ['vite', 'build', '--config', 'vite.web.config.ts'])

mkdirSync(OUT, { recursive: true })
cpSync(join(TREE, 'maxine.js'), join(OUT, 'maxine.js'))
writeFileSync(join(OUT, 'maxine.wasm.gz'), gzipSync(readFileSync(join(TREE, 'maxine.wasm')), { level: 9 }))
for (const [path, source] of Object.entries(FILES)) cpSync(source, join(OUT, path))

const image = IMAGES.map((name) => join(EMULATOR, 'roms', name)).find(existsSync)
if (!image) throw new Error(`None of ${IMAGES.join(', ')} is in emulator/roms`)
const disk = readFileSync(image)
writeFileSync(join(OUT, 'disk.chd.gz'), gzipSync(disk, { level: 9 }))
writeFileSync(
  join(OUT, 'manifest.json'),
  JSON.stringify({ image: createHash('sha256').update(disk).digest('hex').slice(0, 16), disk: 'disk.chd.gz', wasm: 'maxine.wasm.gz', files: Object.keys(FILES) }, null, 2)
)
console.log(`dist-web is ready, with ${image}`)
