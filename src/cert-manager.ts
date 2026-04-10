import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { X509Certificate } from 'node:crypto';
import { ensureDataDirectory, setSecureFilePermissions } from './utils/file-utils.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger();

/**
 * Paths to the CA certificate directory used by http-mitm-proxy.
 * The proxy auto-generates CA cert/key files inside this directory.
 */
export interface CertPaths {
  /** Base directory for all CA/cert files (passed as sslCaDir to http-mitm-proxy) */
  sslCaDir: string;
  /** Path where the CA certificate PEM will be generated */
  caCertPath: string;
  /** Path where the CA private key will be generated */
  caKeyPath: string;
}

/**
 * Returns the expected certificate file paths for a given data directory.
 */
export function getCertPaths(dataDir: string): CertPaths {
  const sslCaDir = path.join(dataDir, 'certs');
  return {
    sslCaDir,
    caCertPath: path.join(sslCaDir, 'certs', 'ca.pem'),
    caKeyPath: path.join(sslCaDir, 'keys', 'ca.private.key'),
  };
}

/**
 * Ensures the CA certificate directory exists with secure permissions (0o700).
 * Sets a restrictive umask (0o077) before directory creation to prevent
 * the TOCTOU race where files are briefly world-readable between creation
 * and chmod. The umask is always restored, even on error.
 *
 * Returns the cert paths for use with MitmProxyOptions.
 */
export async function ensureCACertificate(dataDir: string): Promise<CertPaths> {
  const certPaths = getCertPaths(dataDir);

  // Set restrictive umask so http-mitm-proxy creates cert/key files with
  // 0o600 permissions from the start, eliminating the TOCTOU window where
  // files exist with default (potentially world-readable) permissions.
  const previousUmask = process.umask(0o077);
  try {
    // Ensure the sslCaDir base exists with secure permissions.
    // http-mitm-proxy creates the certs/ and keys/ subdirectories itself.
    ensureDataDirectory(certPaths.sslCaDir);
  } finally {
    process.umask(previousUmask);
  }

  logger.info('CA certificate directory ready', { sslCaDir: certPaths.sslCaDir });

  return certPaths;
}

/**
 * Computes the SPKI (Subject Public Key Info) hash of the CA certificate.
 * This hash is used with Chromium's --ignore-certificate-errors-spki-list
 * flag to trust only the MITM proxy's CA, leaving all other TLS validation
 * intact.
 *
 * Returns the base64-encoded SHA-256 hash, or null if the cert doesn't exist.
 */
export function computeCaSpkiHash(certPaths: CertPaths): string | null {
  if (!fs.existsSync(certPaths.caCertPath)) {
    return null;
  }

  const pem = fs.readFileSync(certPaths.caCertPath, 'utf-8');
  const cert = new X509Certificate(pem);
  const spkiDer = cert.publicKey.export({ type: 'spki', format: 'der' });
  const hash = createHash('sha256').update(spkiDer).digest('base64');

  logger.info('Computed CA SPKI hash for certificate pinning');
  return hash;
}

/**
 * Sets secure file permissions (0o600) on CA certificate and private key files.
 * Call this after the MITM proxy has started and http-mitm-proxy has generated
 * the CA files. While the restrictive umask in ensureCACertificate() should
 * ensure files are created securely, this serves as a defense-in-depth measure.
 */
export function secureCertFiles(certPaths: CertPaths): void {
  setSecureFilePermissions(certPaths.caKeyPath);
  setSecureFilePermissions(certPaths.caCertPath);
  logger.info('Secured CA certificate file permissions');
}
