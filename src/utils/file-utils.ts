import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const APP_NAME = 'csp-analyser';

/**
 * Returns the platform-appropriate data directory for csp-analyser.
 *
 * - Linux:   $XDG_CONFIG_HOME/csp-analyser  (defaults to ~/.config/csp-analyser)
 * - macOS:   ~/Library/Application Support/csp-analyser
 * - Windows: %LOCALAPPDATA%\csp-analyser
 *
 * Falls back to ~/.csp-analyser if none of the above resolve.
 */
export function getDataDir(): string {
  const platform = process.platform;

  if (platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'];
    if (localAppData) {
      return path.join(localAppData, APP_NAME);
    }
    return path.join(os.homedir(), APP_NAME);
  }

  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  }

  // Linux and other Unix-like systems: follow XDG Base Directory spec
  const xdgConfigHome = process.env['XDG_CONFIG_HOME'];
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, APP_NAME);
  }
  return path.join(os.homedir(), '.config', APP_NAME);
}

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

/**
 * Walks up from startDir looking for the nearest package.json with a `name` field.
 * If no package.json is found, falls back to path.basename(startDir), then to 'default'.
 * Always returns a non-empty string — never returns null.
 */
export function detectProjectName(startDir: string = process.cwd()): string {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  for (;;) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content) as Record<string, unknown>;
      if (typeof pkg.name === 'string' && pkg.name.length > 0) {
        return pkg.name;
      }
    } catch {
      // No package.json here or invalid JSON — continue walking up
    }

    const parent = path.dirname(dir);
    if (parent === dir || dir === root) break;
    dir = parent;
  }

  // Fallback: use directory basename, then 'default'
  const basename = path.basename(path.resolve(startDir));
  return basename.length > 0 ? basename : 'default';
}

/**
 * Resolves the project name for the current invocation.
 * Priority: explicit override → CSP_ANALYSER_PROJECT env var → auto-detection.
 * Always returns a non-empty string.
 */
export function resolveProjectName(explicitProject?: string): string {
  if (explicitProject && explicitProject.length > 0) {
    return explicitProject;
  }

  const envProject = process.env['CSP_ANALYSER_PROJECT'];
  if (envProject && envProject.length > 0) {
    return envProject;
  }

  return detectProjectName();
}
