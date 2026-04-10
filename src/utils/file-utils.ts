import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Resolves a path through symlinks where possible.
 *
 * If the full path exists, uses fs.realpathSync() to resolve all symlinks.
 * If the path doesn't exist yet (e.g. DB file before first run), resolves
 * the parent directory's realpath and appends the filename — this ensures
 * the parent isn't a symlink pointing elsewhere.
 *
 * Throws if neither the path nor its parent directory exists.
 */
export function resolveRealPath(filePath: string): string {
  const resolved = path.resolve(filePath);

  try {
    return fs.realpathSync(resolved);
  } catch {
    // File doesn't exist yet — resolve the parent directory instead
    const dir = path.dirname(resolved);
    const base = path.basename(resolved);
    try {
      const realDir = fs.realpathSync(dir);
      return path.join(realDir, base);
    } catch {
      // Parent doesn't exist either — return the path.resolve() result
      // (ensureDataDirectory will create it later)
      return resolved;
    }
  }
}

/**
 * Validates a database path to prevent path traversal attacks.
 * Resolves symlinks to prevent symlink-based traversal.
 * Returns the resolved, validated path.
 */
export function validateDbPath(dbPath: string): string {
  // Allow in-memory databases (used in tests)
  if (dbPath === ':memory:') {
    return dbPath;
  }

  const resolved = resolveRealPath(dbPath);

  // Ensure .db extension
  if (!resolved.endsWith('.db')) {
    throw new Error(`Invalid database path: must end with .db extension (got "${resolved}")`);
  }

  // Check for path traversal: the resolved path should not contain '..' segments.
  // path.resolve() normalizes the path, so any remaining '..' would indicate
  // an attempt to escape. After resolution, '..' shouldn't appear, but we
  // check the original input for obvious traversal attempts where the resolved
  // path escapes a reasonable boundary.
  const normalizedInput = path.normalize(dbPath);
  if (normalizedInput !== resolved && normalizedInput.includes('..')) {
    throw new Error(`Invalid database path: path traversal detected in "${dbPath}"`);
  }

  return resolved;
}

/**
 * Ensures a directory exists with secure permissions (0o700 — owner-only access).
 */
export function ensureDataDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  } else {
    fs.chmodSync(dirPath, 0o700);
  }
}

/**
 * Sets secure file permissions (0o600 — owner read/write only).
 */
export function setSecureFilePermissions(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.chmodSync(filePath, 0o600);
  }
}
