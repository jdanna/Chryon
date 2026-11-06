import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))

// Unfurlers want og:image as an absolute URL. It's in public/, so Vite doesn't hash its name, and ?v= stands in.
const ogImage = readFileSync(resolve('src/web/public/icon-512.png'))
const OG_IMAGE = `https://maxine.retrograde.tools/icon-512.png?v=${createHash('sha256').update(ogImage).digest('hex').slice(0, 10)}`

// The browser build of the emulator page. scripts/build-web.mjs adds the emulator itself to dist-web/emulator.
export default defineConfig({
  root: resolve('src/web'),
  base: './',
  resolve: { alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') } },
  plugins: [react(), { name: 'og-image', transformIndexHtml: (html) => html.replace('%OG_IMAGE%', OG_IMAGE) }],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { outDir: resolve('dist-web'), emptyOutDir: false }
})
