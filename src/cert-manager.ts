import * as path from 'node:path';
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
 * http-mitm-proxy will auto-generate the CA certificate and keys inside this
 * directory when the proxy starts.
 *
 * Returns the cert paths for use with MitmProxyOptions.
 */
export async function ensureCACertificate(dataDir: string): Promise<CertPaths> {
  const certPaths = getCertPaths(dataDir);

  // Ensure the sslCaDir base exists with secure permissions.
  // http-mitm-proxy creates the certs/ and keys/ subdirectories itself.
  ensureDataDirectory(certPaths.sslCaDir);

  logger.info('CA certificate directory ready', { sslCaDir: certPaths.sslCaDir });

  return certPaths;
}

/**
 * Sets secure file permissions (0o600) on CA certificate and private key files.
 * Call this after the MITM proxy has started and http-mitm-proxy has generated
 * the CA files, since it creates them with default (insecure) permissions.
 */
export function secureCertFiles(certPaths: CertPaths): void {
  setSecureFilePermissions(certPaths.caKeyPath);
  setSecureFilePermissions(certPaths.caCertPath);
  logger.info('Secured CA certificate file permissions');
}
