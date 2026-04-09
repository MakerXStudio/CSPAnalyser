import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { validateDbPath, ensureDataDirectory, setSecureFilePermissions } from '../../src/utils/file-utils.js';

describe('validateDbPath', () => {
  it('allows :memory: paths', () => {
    expect(validateDbPath(':memory:')).toBe(':memory:');
  });

  it('allows valid .db paths and resolves them', () => {
    const result = validateDbPath('test.db');
    expect(path.isAbsolute(result)).toBe(true);
    expect(result.endsWith('.db')).toBe(true);
  });

  it('rejects paths without .db extension', () => {
    expect(() => validateDbPath('test.sqlite')).toThrow('.db extension');
  });

  it('rejects paths without any extension', () => {
    expect(() => validateDbPath('testdb')).toThrow('.db extension');
  });

  it('allows absolute .db paths', () => {
    const absPath = '/tmp/csp-test/data.db';
    expect(validateDbPath(absPath)).toBe(absPath);
  });

  it('resolves relative paths to absolute', () => {
    const result = validateDbPath('./data/test.db');
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toBe(path.resolve('./data/test.db'));
  });

  it('rejects paths with .. traversal', () => {
    expect(() => validateDbPath('../escape/test.db')).toThrow('path traversal');
  });

  it('rejects paths with embedded .. traversal', () => {
    expect(() => validateDbPath('data/../../escape/test.db')).toThrow('path traversal');
  });
});

describe('ensureDataDirectory', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a directory with 0o700 permissions', () => {
    const dir = path.join(tmpDir, 'newdir');
    ensureDataDirectory(dir);

    expect(fs.existsSync(dir)).toBe(true);
    const stat = fs.statSync(dir);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('sets permissions on existing directory', () => {
    const dir = path.join(tmpDir, 'existingdir');
    fs.mkdirSync(dir, { mode: 0o755 });
    ensureDataDirectory(dir);

    const stat = fs.statSync(dir);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('creates nested directories', () => {
    const dir = path.join(tmpDir, 'a', 'b', 'c');
    ensureDataDirectory(dir);
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe('setSecureFilePermissions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets file permissions to 0o600', () => {
    const filePath = path.join(tmpDir, 'test.db');
    fs.writeFileSync(filePath, '');
    setSecureFilePermissions(filePath);

    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('does nothing for non-existent file', () => {
    const filePath = path.join(tmpDir, 'nonexistent.db');
    expect(() => setSecureFilePermissions(filePath)).not.toThrow();
  });
});
