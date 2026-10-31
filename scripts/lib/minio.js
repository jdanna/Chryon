// Transport for the signed Windows installer between the self-hosted CI runner
// and this machine. The endpoint comes from the environment because this repo
// is public.
const fs = require('fs')
const path = require('path')
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3')
const { Upload } = require('@aws-sdk/lib-storage')
const { loadEnv } = require('./env')

const env = loadEnv(path.join(__dirname, '..', '..'))
const ENDPOINT = env.MINIO_ENDPOINT
const BUCKET = env.MINIO_BUCKET || 'dev'
const ACCESS_KEY = env.MINIO_ACCESS_KEY
const SECRET_KEY = env.MINIO_SECRET_KEY
const PREFIX = 'win-signed'

function makeClient() {
  if (!ENDPOINT || !ACCESS_KEY || !SECRET_KEY) {
    console.error(
      'Missing MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY.\n' +
      'CI: set them as repo secrets. Local: add them to .env.'
    )
    process.exit(1)
  }
  return new S3Client({
    region: 'us-east-1',
    endpoint: ENDPOINT,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  })
}

function keyPrefix(runId) {
  return `${PREFIX}/${runId}/`
}

async function streamToFile(body, destPath) {
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath)
    body.on('error', reject)
    out.on('error', reject)
    out.on('finish', resolve)
    body.pipe(out)
  })
}

async function uploadWinSigned(runId, exePath, client = makeClient()) {
  const key = `${keyPrefix(runId)}${path.basename(exePath)}`
  const upload = new Upload({
    client,
    params: { Bucket: BUCKET, Key: key, Body: fs.createReadStream(exePath) },
  })
  let lastPct = -10
  upload.on('httpUploadProgress', (p) => {
    if (!p.total) return
    const pct = Math.floor((p.loaded / p.total) * 100)
    if (pct >= lastPct + 10) {
      lastPct = pct
      console.log(`  upload ${pct}%`)
    }
  })
  await upload.done()
  return key
}

async function downloadWinSigned(runId, destDir, client = makeClient()) {
  const Prefix = keyPrefix(runId)
  const listed = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix }))
  const objects = listed.Contents || []
  const exe = objects.find((o) => o.Key && o.Key.endsWith('.exe'))
  if (!exe) {
    throw new Error(`No signed .exe found under ${BUCKET}/${Prefix}`)
  }
  fs.mkdirSync(destDir, { recursive: true })
  const destPath = path.join(destDir, path.basename(exe.Key))
  const res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: exe.Key }))
  await streamToFile(res.Body, destPath)
  console.log(`Downloaded ${exe.Key} → ${destPath}`)

  try {
    for (const o of objects) {
      if (o.Key) await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: o.Key }))
    }
    console.log(`Deleted ${objects.length} object(s) from MinIO.`)
  } catch (e) {
    console.warn(`Warning: could not delete MinIO object(s): ${e.message || e}`)
  }

  return destPath
}

module.exports = { BUCKET, makeClient, uploadWinSigned, downloadWinSigned }
