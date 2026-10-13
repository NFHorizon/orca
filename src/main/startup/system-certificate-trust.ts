import { getCACertificates, setDefaultCACertificates } from 'node:tls'

export function initializeSystemCertificateTrust(): void {
  if (process.platform !== 'darwin') {
    return
  }
  // Finder launches do not inherit NODE_USE_SYSTEM_CA from the user's shell.
  setDefaultCACertificates([...getCACertificates('default'), ...getCACertificates('system')])
}
