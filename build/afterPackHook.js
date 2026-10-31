const path = require('path')
const fs = require('fs')

exports.default = async function(context) {
  if (context.electronPlatformName !== 'linux') return

  const appOutDir = context.appOutDir
  const name = context.packager.executableName
  const binPath = path.join(appOutDir, name)
  const realBinPath = path.join(appOutDir, `${name}-bin`)

  fs.renameSync(binPath, realBinPath)

  const wrapper = `#!/bin/sh\nexec "$(dirname "$0")/${name}-bin" --no-sandbox "$@"\n`
  fs.writeFileSync(binPath, wrapper, { mode: 0o755 })
}
