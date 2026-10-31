// Signed + notarized macOS build, used through `npm run dist:mac-signed`.
//
// A .js config so the certificate comes from CSC_NAME in .env: this repo is
// public, and electron-builder.yml stays signing-free so `npm run dist:mac`
// works with no credentials. Don't redeclare arrays here, since `extends`
// merges them by concatenation.
if (!process.env.CSC_NAME) {
  throw new Error('CSC_NAME is not set. Use `npm run dist:mac-signed`, which loads .env.')
}

module.exports = {
  extends: 'file:electron-builder.yml',
  afterSign: 'build/notarize.js',
  mac: {
    identity: process.env.CSC_NAME,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    notarize: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
  },
}
