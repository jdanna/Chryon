const fs = require('fs')
const path = require('path')

// Load .env into a copy of process.env. Real environment wins over .env;
// quoted values may contain '#', unquoted values strip trailing comments.
function loadEnv(rootDir) {
  const env = { ...process.env }
  const envPath = path.join(rootDir, '.env')
  if (!fs.existsSync(envPath)) return env

  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/)
    if (!m) continue
    let value = m[2].trim()
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1)
    } else {
      value = value.replace(/\s+#.*$/, '').trim()
    }
    if (!(m[1] in process.env)) env[m[1]] = value
  }
  return env
}

module.exports = { loadEnv }
