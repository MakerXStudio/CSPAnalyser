import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { validateDbPath, ensureDataDirectory, setSecureFilePermissions, detectProjectName } from '../../src/utils/file-utils.js';

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

describe('detectProjectName', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-detect-project-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns name from package.json in the given directory', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'my-app' }));
    expect(detectProjectName(tmpDir)).toBe('my-app');
  });

  it('walks up to find package.json in parent directory', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'root-app' }));
    const nested = path.join(tmpDir, 'src', 'components');
    fs.mkdirSync(nested, { recursive: true });
    expect(detectProjectName(nested)).toBe('root-app');
  });

  it('returns null when no package.json exists', () => {
    // tmpDir has no package.json and we stop at filesystem root
    expect(detectProjectName(tmpDir)).toBeNull();
  });

  it('returns null when package.json has no name field', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    expect(detectProjectName(tmpDir)).toBeNull();
  });

  it('returns null when package.json has empty name', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: '' }));
    expect(detectProjectName(tmpDir)).toBeNull();
  });

  it('returns null when package.json is invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), 'not json');
    expect(detectProjectName(tmpDir)).toBeNull();
  });

  it('finds nearest package.json (child over parent)', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'parent' }));
    const child = path.join(tmpDir, 'packages', 'child');
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(child, 'package.json'), JSON.stringify({ name: 'child' }));
    expect(detectProjectName(child)).toBe('child');
  });
});
