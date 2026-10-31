// CI-only Windows build config: electron-builder.yml plus Azure Trusted Signing.
// Used by `npm run dist:win-ci` on the self-hosted runner. A .js config because
// electron-builder doesn't expand `${env.X}` macros inside win.azureSignOptions.
// All of it, including the publisher name, comes from repo secrets (AZURE_*),
// since this repo is public. Don't redeclare arrays here, since `extends`
// merges them by concatenation.
const SIGNING_ENV = {
  endpoint: 'AZURE_ENDPOINT',
  codeSigningAccountName: 'AZURE_CODE_SIGNING_ACCOUNT_NAME',
  certificateProfileName: 'AZURE_CERT_PROFILE_NAME',
  publisherName: 'AZURE_PUBLISHER_NAME',
}

// Consumed by the TrustedSigning PowerShell module, not by electron-builder.
const CREDENTIAL_ENV = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']

const missing = [...Object.values(SIGNING_ENV), ...CREDENTIAL_ENV].filter((name) => !process.env[name])

if (missing.length > 0) {
  throw new Error(
    'Azure Trusted Signing is not configured — missing env var(s): ' +
      `${missing.join(', ')}.\n` +
      'This config is for the signed CI build only; use `npm run dist:win` for an unsigned local build.'
  )
}

module.exports = {
  extends: 'file:electron-builder.yml',
  win: {
    // electron-builder only warns on a signing failure, which would ship an
    // unsigned installer from a green build.
    forceCodeSigning: true,
    azureSignOptions: {
      endpoint: process.env[SIGNING_ENV.endpoint],
      codeSigningAccountName: process.env[SIGNING_ENV.codeSigningAccountName],
      certificateProfileName: process.env[SIGNING_ENV.certificateProfileName],
      publisherName: process.env[SIGNING_ENV.publisherName],
      fileDigest: 'SHA256',
      timestampRfc3161: 'http://timestamp.acs.microsoft.com',
      timestampDigest: 'SHA256',
    },
  },
}
