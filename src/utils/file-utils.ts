import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Validates a database path to prevent path traversal attacks.
 * Returns the resolved, validated path.
 */
export function validateDbPath(dbPath: string): string {
  // Allow in-memory databases (used in tests)
  if (dbPath === ':memory:') {
    return dbPath;
  }

  const resolved = path.resolve(dbPath);

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
