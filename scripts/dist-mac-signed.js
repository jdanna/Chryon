#!/usr/bin/env node

const { execSync } = require('child_process')
const path = require('path')
const { loadEnv } = require('./lib/env')

const rootDir = path.join(__dirname, '..')
const env = loadEnv(rootDir)

const REQUIRED = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'CSC_NAME']
const missing = REQUIRED.filter((k) => !env[k])
if (missing.length) {
  console.error(`\nMissing required env vars: ${missing.join(', ')}`)
  console.error('Populate .env with these values before building.\n')
  process.exit(1)
}

execSync('npx electron-vite build', { stdio: 'inherit', cwd: rootDir, env })
execSync('npx electron-builder --mac --config electron-builder.signed.js', { stdio: 'inherit', cwd: rootDir, env })
