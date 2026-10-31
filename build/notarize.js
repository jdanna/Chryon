const { execSync, spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = `${context.appOutDir}/${appName}.app`
  const start = Date.now()

  console.log(`\n[notarize] appPath:  ${appPath}`)

  // notarytool requires a zip, dmg, or pkg — zip the .app with ditto
  const zipPath = path.join(os.tmpdir(), `${appName}-${Date.now()}.zip`)
  console.log(`[notarize] Zipping to ${zipPath}...`)
  execSync(`ditto -c -k --keepParent "${appPath}" "${zipPath}"`)
  const sizeMB = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)
  console.log(`[notarize] Zip ready (${sizeMB} MB), submitting...`)

  try {
    await new Promise((resolve, reject) => {
      const proc = spawn('xcrun', [
        'notarytool', 'submit', zipPath,
        '--apple-id', process.env.APPLE_ID,
        '--password', process.env.APPLE_APP_SPECIFIC_PASSWORD,
        '--team-id', process.env.APPLE_TEAM_ID,
        '--wait',
        '--verbose',
      ])

      const log = (data) =>
        data.toString().split('\n').forEach(l => l.trim() && console.log(`[notarize] ${l}`))

      proc.stdout.on('data', log)
      proc.stderr.on('data', log)

      proc.on('close', (code) => {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1)
        if (code === 0) {
          console.log(`[notarize] Accepted. Total time: ${elapsed}s`)
          resolve()
        } else {
          reject(new Error(`notarytool exited with code ${code} after ${elapsed}s`))
        }
      })
    })
  } finally {
    fs.rmSync(zipPath, { force: true })
  }

  console.log(`[notarize] Stapling ticket to ${appPath}...`)
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      execSync(`xcrun stapler staple "${appPath}"`, { stdio: 'inherit' })
      console.log(`[notarize] Stapled.`)
      break
    } catch (err) {
      if (attempt === 5) throw err
      console.log(`[notarize] Staple attempt ${attempt} failed, retrying in 15s...`)
      await new Promise(r => setTimeout(r, 15000))
    }
  }
}
