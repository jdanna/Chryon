#!/usr/bin/env node
// Runs on the self-hosted Windows runner after signing. Uploads dist/*-setup.exe
// to MinIO (keyed by GITHUB_RUN_ID) instead of GitHub Actions artifact storage.

const fs = require('fs')
const path = require('path')
const { uploadWinSigned, makeClient, BUCKET } = require('./lib/minio')

const runId = process.env.GITHUB_RUN_ID
if (!runId) {
  console.error('GITHUB_RUN_ID is not set — cannot key the upload.')
  process.exit(1)
}

const distDir = path.join(__dirname, '..', 'dist')
const exe = fs.existsSync(distDir)
  ? fs.readdirSync(distDir).find((f) => f.endsWith('-setup.exe'))
  : null
if (!exe) {
  console.error('No *-setup.exe found in dist/ — nothing to upload.')
  process.exit(1)
}

async function main() {
  const client = makeClient()
  const key = await uploadWinSigned(runId, path.join(distDir, exe), client)
  console.log(`Uploaded signed installer to ${BUCKET}/${key}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
