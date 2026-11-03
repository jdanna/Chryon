#!/usr/bin/env node
// Serves dist-web on 127.0.0.1, the way a plain web host would. Run with `npm run preview:web`.

import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SITE = resolve(HERE, '../../dist-web')
const PORT = 8137
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm'
}

export function serve(port = PORT, onRequest = () => {}) {
  const server = createServer((request, response) => {
    const url = decodeURIComponent(new URL(request.url, 'http://x').pathname)
    onRequest(url)
    const path = join(SITE, normalize(url))
    const file = path.endsWith('/') ? join(path, 'index.html') : path
    const size = path.startsWith(SITE) && statSync(file, { throwIfNoEntry: false })?.size
    if (!size) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-length': size })
    createReadStream(file).pipe(response)
  })
  return new Promise((done) => server.listen(port, '127.0.0.1', () => done(server)))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await serve()
  console.log(`http://127.0.0.1:${PORT}/`)
}
