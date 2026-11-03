import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))

// The browser build of the emulator page. scripts/build-web.mjs adds the emulator itself to dist-web/emulator.
export default defineConfig({
  root: resolve('src/web'),
  base: './',
  resolve: { alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') } },
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { outDir: resolve('dist-web'), emptyOutDir: false }
})
