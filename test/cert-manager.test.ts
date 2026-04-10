import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getCertPaths, ensureCACertificate, secureCertFiles } from '../src/cert-manager.js';

describe('getCertPaths', () => {
  it('returns correct paths relative to data directory', () => {
    const result = getCertPaths('/tmp/test-data');

    expect(result.sslCaDir).toBe('/tmp/test-data/certs');
    expect(result.caCertPath).toBe('/tmp/test-data/certs/certs/ca.pem');
    expect(result.caKeyPath).toBe('/tmp/test-data/certs/keys/ca.private.key');
  });

  it('handles nested data directories', () => {
    const result = getCertPaths('/home/user/.csp-analyser/data');

    expect(result.sslCaDir).toBe('/home/user/.csp-analyser/data/certs');
  });

  it('returns all required fields', () => {
    const result = getCertPaths('/tmp/test');

    expect(result).toHaveProperty('sslCaDir');
    expect(result).toHaveProperty('caCertPath');
    expect(result).toHaveProperty('caKeyPath');
  });
});

describe('ensureCACertificate', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-manager-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates the sslCaDir with secure permissions', async () => {
    const result = await ensureCACertificate(tempDir);

    expect(fs.existsSync(result.sslCaDir)).toBe(true);

    const stats = fs.statSync(result.sslCaDir);
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it('returns cert paths consistent with getCertPaths', async () => {
    const expected = getCertPaths(tempDir);
    const result = await ensureCACertificate(tempDir);

    expect(result).toEqual(expected);
  });

  it('is idempotent — can be called multiple times', async () => {
    const first = await ensureCACertificate(tempDir);
    const second = await ensureCACertificate(tempDir);

    expect(first).toEqual(second);
    expect(fs.existsSync(first.sslCaDir)).toBe(true);
  });

  it('sets secure permissions even if directory already exists', async () => {
    const sslCaDir = path.join(tempDir, 'certs');
    fs.mkdirSync(sslCaDir, { mode: 0o755 });

    await ensureCACertificate(tempDir);

    const stats = fs.statSync(sslCaDir);
    expect(stats.mode & 0o777).toBe(0o700);
  });
});

describe('secureCertFiles', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-secure-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('sets 0o600 permissions on CA key and cert files', () => {
    const certPaths = getCertPaths(tempDir);

    // Simulate http-mitm-proxy generating files with default permissions
    fs.mkdirSync(path.dirname(certPaths.caCertPath), { recursive: true });
    fs.mkdirSync(path.dirname(certPaths.caKeyPath), { recursive: true });
    fs.writeFileSync(certPaths.caCertPath, 'fake-cert', { mode: 0o644 });
    fs.writeFileSync(certPaths.caKeyPath, 'fake-key', { mode: 0o644 });

    secureCertFiles(certPaths);

    expect(fs.statSync(certPaths.caCertPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(certPaths.caKeyPath).mode & 0o777).toBe(0o600);
  });

  it('does not throw if files do not exist yet', () => {
    const certPaths = getCertPaths(tempDir);

    // Should not throw — setSecureFilePermissions is a no-op for missing files
    expect(() => secureCertFiles(certPaths)).not.toThrow();
  });
});
