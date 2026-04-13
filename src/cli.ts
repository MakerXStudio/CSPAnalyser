#!/usr/bin/env node

import { parseArgs as nodeParseArgs } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './utils/logger.js';
import { validateTargetUrl } from './utils/url-utils.js';
import {
  createDatabase,
  getSession,
  getLatestSession,
  listSessions,
  getViolations,
  getViolationSummary,
  getPermissionsPolicies,
} from './db/repository.js';
import { runSession, runInteractiveSession } from './session-manager.js';
import { generatePolicy } from './policy-generator.js';
import { optimizePolicy } from './policy-optimizer.js';
import { formatPolicy } from './policy-formatter.js';
import {
  setNoColor,
  red,
  cyan,
  formatCrawlProgress,
  formatElapsed,
  formatSummaryTable,
} from './utils/terminal.js';

import { getDataDir, detectProjectName } from './utils/file-utils.js';
import { compareSessions, formatDiff } from './policy-diff.js';
import { scoreCspPolicy, formatScore } from './policy-scorer.js';
import type { StrictnessLevel, ExportFormat, SessionConfig } from './types.js';

const logger = createLogger();

// ── Version ─────────────────────────────────────────────────────────────

function getVersion(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
  return pkg.version;
}

// ── Types ───────────────────────────────────────────────────────────────

export type Command =
  | 'crawl'
  | 'interactive'
  | 'generate'
  | 'export'
  | 'diff'
  | 'score'
  | 'permissions'
  | 'sessions'
  | 'setup'
  | 'help'
  | 'version';

export interface ParsedArgs {
  command: Command;
  url?: string;
  sessionId?: string;
  sessionIdB?: string;
  depth: number;
  maxPages: number;
  strictness: StrictnessLevel;
  format: ExportFormat;
  storageState?: string;
  saveStorageState?: string;
  reportOnly: boolean;
  violationLimit?: number;
  nonce: boolean;
  strictDynamic: boolean;
  hash: boolean;
}

// ── Valid values ─────────────────────────────────────────────────────────

const VALID_STRICTNESS: ReadonlySet<string> = new Set(['strict', 'moderate', 'permissive']);
const VALID_FORMATS: ReadonlySet<string> = new Set([
  'header',
  'meta',
  'nginx',
  'apache',
  'cloudflare',
  'cloudflare-pages',
  'azure-frontdoor',
  'helmet',
  'json',
]);
// ── Help text ───────────────────────────────────────────────────────────

export const HELP_TEXT = `csp-analyser — Generate Content Security Policy headers by crawling websites

Usage:
  csp-analyser setup                     Install Playwright browser + dependencies
  csp-analyser crawl <url>               Headless auto-crawl
  csp-analyser interactive <url>         Headed manual browsing
  csp-analyser generate [session-id]     Regenerate policy (defaults to latest session)
  csp-analyser export [session-id]       Export policy in a format (defaults to latest)
  csp-analyser diff <id-a> <id-b>        Compare two sessions
  csp-analyser score [session-id]        Score policy (defaults to latest session)
  csp-analyser sessions                  List all analysis sessions
  csp-analyser permissions [session-id]  Show Permissions-Policy headers (defaults to latest)

Options:
  --depth <n>            Crawl depth (default: 1, crawl only)
  --max-pages <n>        Max pages to visit (default: 10, crawl only)
  --strictness <level>   strict | moderate | permissive (default: moderate)
  --format <fmt>         header | meta | nginx | apache | cloudflare | cloudflare-pages
                         | azure-frontdoor | helmet | json (default: header)
  --storage-state <path> Playwright storage state file for auth
  --save-storage-state <path>  Export session cookies/state after interactive browsing
  --violation-limit <n>  Max violations per session (default: 10000, 0 for unlimited)
  --nonce                Replace 'unsafe-inline' with nonce placeholders
  --strict-dynamic       Add 'strict-dynamic' with nonces (implies --nonce)
  --hash                 Remove 'unsafe-inline' when hash sources are available
  --report-only          Generate report-only policy
  --no-color             Disable colored output (also respects NO_COLOR env)
  --help, -h             Show this help
  --version, -v          Show version
`;

// ── Argument parsing ────────────────────────────────────────────────────

export function parseCliArgs(argv: string[]): ParsedArgs {
  // Handle --help / -h and --version / -v before parseArgs
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return {
      command: 'help',
      depth: 1,
      maxPages: 10,
      strictness: 'moderate',
      format: 'header',
      reportOnly: false,
      nonce: false,
      strictDynamic: false,
      hash: false,
    };
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    return {
      command: 'version',
      depth: 1,
      maxPages: 10,
      strictness: 'moderate',
      format: 'header',
      reportOnly: false,
      nonce: false,
      strictDynamic: false,
      hash: false,
    };
  }

  const { values, positionals } = nodeParseArgs({
    args: argv,
    options: {
      depth: { type: 'string' },
      'max-pages': { type: 'string' },
      strictness: { type: 'string' },
      format: { type: 'string' },
      'storage-state': { type: 'string' },
      'save-storage-state': { type: 'string' },
      'violation-limit': { type: 'string' },
      nonce: { type: 'boolean', default: false },
      'strict-dynamic': { type: 'boolean', default: false },
      hash: { type: 'boolean', default: false },
      'report-only': { type: 'boolean', default: false },
      'no-color': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  // Apply --no-color flag
  if (values['no-color']) {
    setNoColor(true);
  }

  const command = positionals[0] as string | undefined;
  if (
    !command ||
    ![
      'crawl',
      'interactive',
      'generate',
      'export',
      'diff',
      'score',
      'permissions',
      'sessions',
      'setup',
    ].includes(command)
  ) {
    throw new Error(`Unknown command: ${command ?? '(none)'}. Run with --help for usage.`);
  }

  // setup and sessions take no positional args
  if (command === 'setup' || command === 'sessions') {
    return {
      command: command as Command,
      depth: 1,
      maxPages: 10,
      strictness: 'moderate',
      format: 'header',
      reportOnly: false,
      nonce: false,
      strictDynamic: false,
      hash: false,
    };
  }

  const positionalArg = positionals[1] as string | undefined;

  // crawl and interactive always require a URL
  if ((command === 'crawl' || command === 'interactive') && !positionalArg) {
    throw new Error(`Missing URL for "${command}". Run with --help for usage.`);
  }

  // diff requires both session IDs
  if (command === 'diff') {
    if (!positionalArg) {
      throw new Error('Missing session IDs for "diff". Usage: diff <session-id-a> <session-id-b>');
    }
    const positionalArgB = positionals[2] as string | undefined;
    if (!positionalArgB) {
      throw new Error(
        'Missing second session ID for "diff". Usage: diff <session-id-a> <session-id-b>',
      );
    }
  }

  // Other session commands (generate, export, score, permissions) allow optional session ID
  // — they auto-resolve to the latest session when omitted

  // Validate options
  const depth =
    values.depth !== undefined ? parseNonNegativeInt(values.depth as string, 'depth') : 1;
  const maxPages =
    values['max-pages'] !== undefined
      ? parsePositiveInt(values['max-pages'] as string, 'max-pages')
      : 10;

  const strictness = (values.strictness as string | undefined) ?? 'moderate';
  if (!VALID_STRICTNESS.has(strictness)) {
    throw new Error(
      `Invalid strictness: "${strictness}". Must be strict, moderate, or permissive.`,
    );
  }

  const format = (values.format as string | undefined) ?? 'header';
  if (!VALID_FORMATS.has(format)) {
    throw new Error(
      `Invalid format: "${format}". Must be header, meta, nginx, apache, cloudflare, cloudflare-pages, azure-frontdoor, helmet, or json.`,
    );
  }

  const parsed: ParsedArgs = {
    command: command as Command,
    depth,
    maxPages,
    strictness: strictness as StrictnessLevel,
    format: format as ExportFormat,
    reportOnly: (values['report-only'] as boolean | undefined) ?? false,
    strictDynamic: (values['strict-dynamic'] as boolean | undefined) ?? false,
    nonce: ((values.nonce as boolean | undefined) ?? false) || ((values['strict-dynamic'] as boolean | undefined) ?? false),
    hash: (values.hash as boolean | undefined) ?? false,
  };

  if ((command === 'crawl' || command === 'interactive') && positionalArg) {
    validateTargetUrl(positionalArg);
    parsed.url = positionalArg;
  } else if (command === 'diff') {
    parsed.sessionId = positionalArg;
    parsed.sessionIdB = positionals[2];
  } else {
    parsed.sessionId = positionalArg;
  }

  const storageState = values['storage-state'] as string | undefined;
  if (storageState !== undefined) {
    parsed.storageState = storageState;
  }

  const saveStorageState = values['save-storage-state'] as string | undefined;
  if (saveStorageState !== undefined) {
    parsed.saveStorageState = saveStorageState;
  }

  const violationLimitStr = values['violation-limit'] as string | undefined;
  if (violationLimitStr !== undefined) {
    parsed.violationLimit = parseNonNegativeInt(violationLimitStr, 'violation-limit');
  }

  return parsed;
}

function parseNonNegativeInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid --${name}: "${value}". Must be a non-negative integer.`);
  }
  return n;
}

function parsePositiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid --${name}: "${value}". Must be a positive integer.`);
  }
  return n;
}

// ── Shared helpers ──────────────────────────────────────────────────────

function initDb(): ReturnType<typeof createDatabase> {
  const dbPath = join(getDataDir(), 'data.db');
  return createDatabase(dbPath);
}

/**
 * Resolves a session ID: returns the explicit ID if provided, otherwise
 * finds the most recent completed session (scoped to the current project).
 */
function resolveSessionId(
  db: ReturnType<typeof createDatabase>,
  explicitId: string | undefined,
): string {
  if (explicitId) return explicitId;

  const project = detectProjectName();
  const latest = getLatestSession(db, project);

  if (latest) {
    process.stderr.write(
      cyan(`Using latest session: ${latest.id}`) +
        (latest.project ? ` (project: ${latest.project})` : '') +
        '\n',
    );
    return latest.id;
  }

  throw new Error(
    'No session ID provided and no completed sessions found. ' +
      'Run "csp-analyser crawl <url>" or "csp-analyser interactive <url>" first.',
  );
}

function generateAndFormat(
  db: ReturnType<typeof createDatabase>,
  sessionId: string,
  args: ParsedArgs,
  targetUrl?: string,
): string {
  const directives = generatePolicy(db, sessionId, {
    strictness: args.strictness,
    includeHashes: true,
  });
  const optimized = optimizePolicy(directives, targetUrl, {
    useNonces: args.nonce,
    useStrictDynamic: args.strictDynamic,
    useHashes: args.hash,
  });
  return formatPolicy(optimized, args.format, args.reportOnly);
}

// ── Command execution ───────────────────────────────────────────────────

async function runCrawlCommand(args: ParsedArgs): Promise<void> {
  if (!args.url) {
    throw new Error('URL is required for the crawl command');
  }
  const db = initDb();
  try {
    const project = detectProjectName() ?? undefined;
    const config: SessionConfig = {
      targetUrl: args.url,
      crawlConfig: { depth: args.depth, maxPages: args.maxPages },
      storageStatePath: args.storageState,
      violationLimit: args.violationLimit,
      project,
    };

    const startTime = Date.now();
    let pageCount = 0;

    const result = await runSession(db, config, {
      headless: true,
      onProgress: (msg) => {
        if (msg.startsWith('Visited: ')) {
          pageCount++;
          const url = msg.slice('Visited: '.length);
          process.stderr.write(formatCrawlProgress(pageCount, args.maxPages, url) + '\n');
        } else {
          process.stderr.write(cyan(msg) + '\n');
        }
      },
    });

    const elapsed = formatElapsed(Date.now() - startTime);

    // Build summary with top violated directives
    const summary = getViolationSummary(db, result.session.id);
    const directiveCounts = new Map<string, number>();
    for (const entry of summary) {
      const prev = directiveCounts.get(entry.effectiveDirective) ?? 0;
      directiveCounts.set(entry.effectiveDirective, prev + entry.count);
    }
    const topDirectives = [...directiveCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([directive, count]) => ({ directive, count }));

    const directives = generatePolicy(db, result.session.id, {
      strictness: args.strictness,
      includeHashes: true,
    });
    const uniqueDirectives = Object.keys(directives).length;

    process.stderr.write(
      formatSummaryTable({
        pagesVisited: result.pagesVisited,
        violationsFound: result.violationsFound,
        uniqueDirectives,
        elapsed,
        topDirectives,
      }) + '\n',
    );

    const optimized = optimizePolicy(directives, result.session.targetUrl, {
      useNonces: args.nonce,
      useStrictDynamic: args.strictDynamic,
      useHashes: args.hash,
    });
    const output = formatPolicy(optimized, args.format, args.reportOnly);
    process.stdout.write(output + '\n');
  } finally {
    db.close();
  }
}

async function runInteractiveCommand(args: ParsedArgs): Promise<void> {
  if (!args.url) {
    throw new Error('URL is required for the interactive command');
  }
  const db = initDb();
  try {
    const project = detectProjectName() ?? undefined;
    const config: SessionConfig = {
      targetUrl: args.url,
      storageStatePath: args.storageState,
      violationLimit: args.violationLimit,
      project,
    };

    const startTime = Date.now();

    const result = await runInteractiveSession(db, config, {
      saveStorageStatePath: args.saveStorageState,
      onProgress: (msg) => {
        if (msg.startsWith('Visited: ')) {
          const url = msg.slice('Visited: '.length);
          process.stderr.write(`${cyan('Visited')} ${url}\n`);
        } else {
          process.stderr.write(cyan(msg) + '\n');
        }
      },
    });

    const elapsed = formatElapsed(Date.now() - startTime);

    const summary = getViolationSummary(db, result.session.id);
    const directiveCounts = new Map<string, number>();
    for (const entry of summary) {
      const prev = directiveCounts.get(entry.effectiveDirective) ?? 0;
      directiveCounts.set(entry.effectiveDirective, prev + entry.count);
    }
    const topDirectives = [...directiveCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([directive, count]) => ({ directive, count }));

    const directives = generatePolicy(db, result.session.id, {
      strictness: args.strictness,
      includeHashes: true,
    });
    const uniqueDirectives = Object.keys(directives).length;

    process.stderr.write(
      formatSummaryTable({
        pagesVisited: result.pagesVisited,
        violationsFound: result.violationsFound,
        uniqueDirectives,
        elapsed,
        topDirectives,
      }) + '\n',
    );

    const optimized = optimizePolicy(directives, result.session.targetUrl, {
      useNonces: args.nonce,
      useStrictDynamic: args.strictDynamic,
      useHashes: args.hash,
    });
    const output = formatPolicy(optimized, args.format, args.reportOnly);
    process.stdout.write(output + '\n');
  } finally {
    db.close();
  }
}

async function runGenerateCommand(args: ParsedArgs): Promise<void> {
  const db = initDb();
  try {
    const sessionId = resolveSessionId(db, args.sessionId);
    const session = getSession(db, sessionId);
    const output = generateAndFormat(db, sessionId, args, session?.targetUrl);
    process.stdout.write(output + '\n');
  } finally {
    db.close();
  }
}

async function runExportCommand(args: ParsedArgs): Promise<void> {
  const db = initDb();
  try {
    const sessionId = resolveSessionId(db, args.sessionId);
    const session = getSession(db, sessionId);
    const output = generateAndFormat(db, sessionId, args, session?.targetUrl);
    process.stdout.write(output + '\n');
  } finally {
    db.close();
  }
}

async function runDiffCommand(args: ParsedArgs): Promise<void> {
  if (!args.sessionId || !args.sessionIdB) {
    throw new Error('Both session IDs are required for the diff command');
  }
  const db = initDb();
  try {
    const comparison = compareSessions(db, args.sessionId, args.sessionIdB, args.strictness);
    process.stdout.write(formatDiff(comparison) + '\n');
  } finally {
    db.close();
  }
}

async function runScoreCommand(args: ParsedArgs): Promise<void> {
  const db = initDb();
  try {
    const sessionId = resolveSessionId(db, args.sessionId);
    const session = getSession(db, sessionId);
    const directives = generatePolicy(db, sessionId, {
      strictness: args.strictness,
      includeHashes: false,
    });
    const optimized = optimizePolicy(directives, session?.targetUrl, {
      useNonces: args.nonce,
      useStrictDynamic: args.strictDynamic,
      useHashes: args.hash,
    });
    const score = scoreCspPolicy(optimized);
    process.stdout.write(formatScore(score) + '\n');
  } finally {
    db.close();
  }
}

async function runPermissionsCommand(args: ParsedArgs): Promise<void> {
  const db = initDb();
  try {
    const sessionId = resolveSessionId(db, args.sessionId);
    const session = getSession(db, sessionId);
    if (!session) {
      process.stderr.write(`${red('Error:')} Session not found: ${sessionId}\n`);
      process.exitCode = 1;
      return;
    }

    const policies = getPermissionsPolicies(db, sessionId);
    if (policies.length === 0) {
      process.stderr.write('No Permissions-Policy headers captured for this session.\n');
      return;
    }

    // Group by directive
    const byDirective = new Map<
      string,
      Array<{ allowlist: string[]; headerType: string; sourceUrl: string }>
    >();
    for (const p of policies) {
      const existing = byDirective.get(p.directive) ?? [];
      existing.push({ allowlist: p.allowlist, headerType: p.headerType, sourceUrl: p.sourceUrl });
      byDirective.set(p.directive, existing);
    }

    const lines: string[] = [`Permissions-Policy for session ${sessionId}`, ''];
    for (const [directive, entries] of [...byDirective.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      lines.push(`  ${cyan(directive)}`);
      for (const entry of entries) {
        const allowStr = entry.allowlist.length > 0 ? entry.allowlist.join(' ') : '(none)';
        lines.push(`    ${allowStr}  [${entry.headerType}] from ${entry.sourceUrl}`);
      }
    }

    process.stdout.write(lines.join('\n') + '\n');
  } finally {
    db.close();
  }
}

async function runSessionsCommand(): Promise<void> {
  const db = initDb();
  try {
    const sessions = listSessions(db);
    if (sessions.length === 0) {
      process.stderr.write('No sessions found.\n');
      return;
    }

    const lines: string[] = [];
    for (const s of sessions) {
      const date = new Date(s.createdAt).toLocaleString();
      const violations = getViolations(db, s.id);
      const statusColor =
        s.status === 'complete' ? cyan : s.status === 'failed' ? red : (v: string) => v;
      lines.push(
        `${s.id}  ${statusColor(s.status.padEnd(10))}  ${date.padEnd(24)}  ${String(violations.length).padStart(5)} violations  ${s.targetUrl}`,
      );
    }

    process.stdout.write(lines.join('\n') + '\n');
  } finally {
    db.close();
  }
}

// ── Setup & browser check ──────────────────────────────────────────────

/**
 * Detects the OS/distro to provide platform-specific guidance for
 * installing Playwright's system dependencies.
 */
function detectPlatform(): { os: string; distro: string } {
  const { platform } = process;
  if (platform === 'darwin') return { os: 'macos', distro: 'macos' };
  if (platform === 'win32') return { os: 'windows', distro: 'windows' };
  if (platform !== 'linux') return { os: platform, distro: 'unknown' };

  // Detect Linux distro
  try {
    const osRelease = readFileSync('/etc/os-release', 'utf-8');
    const idMatch = osRelease.match(/^ID=(.+)$/m);
    const id = idMatch ? idMatch[1].replace(/"/g, '').toLowerCase() : '';
    const idLikeMatch = osRelease.match(/^ID_LIKE=(.+)$/m);
    const idLike = idLikeMatch ? idLikeMatch[1].replace(/"/g, '').toLowerCase() : '';

    if (id === 'arch' || idLike.includes('arch')) return { os: 'linux', distro: 'arch' };
    if (id === 'ubuntu' || id === 'debian' || idLike.includes('debian'))
      return { os: 'linux', distro: 'debian' };
    if (id === 'fedora' || idLike.includes('fedora') || idLike.includes('rhel'))
      return { os: 'linux', distro: 'fedora' };
    return { os: 'linux', distro: id || 'unknown' };
  } catch {
    return { os: 'linux', distro: 'unknown' };
  }
}

/**
 * Extracts missing shared library names from a Playwright launch error.
 * Playwright errors typically include lines like:
 *   "error while loading shared libraries: libXfoo.so.0: cannot open shared object file"
 */
function extractMissingLibs(errorMessage: string): string[] {
  const libPattern = /lib[A-Za-z0-9_-]+\.so[.\d]*/g;
  const matches = errorMessage.match(libPattern);
  return matches ? [...new Set(matches)] : [];
}

/**
 * Returns platform-specific instructions for installing missing dependencies.
 */
function getMissingDepsGuidance(distro: string, missingLibs: string[]): string {
  const libList = missingLibs.length > 0 ? `\nMissing libraries: ${missingLibs.join(', ')}\n` : '';

  switch (distro) {
    case 'arch':
      return (
        libList +
        '\nOn Arch Linux, Playwright system deps must be installed manually:\n\n' +
        '  # Option 1: Install common Chromium deps\n' +
        '  sudo pacman -S nss alsa-lib at-spi2-core cups libdrm mesa libxkbcommon\n\n' +
        '  # Option 2: Use the AUR package (includes all deps)\n' +
        '  yay -S playwright\n\n' +
        '  # Option 3: If specific libraries are missing, search for them\n' +
        '  pacman -F libXmissing.so  # find which package provides a library\n'
      );
    case 'debian':
      return (
        libList +
        '\nOn Debian/Ubuntu, install system deps automatically:\n\n' +
        '  npx playwright install-deps chromium\n'
      );
    case 'fedora':
      return (
        libList +
        '\nOn Fedora/RHEL, install system deps automatically:\n\n' +
        '  npx playwright install-deps chromium\n'
      );
    case 'macos':
      return '\nOn macOS, no additional system dependencies are typically needed.\n';
    case 'windows':
      return '\nOn Windows, no additional system dependencies are typically needed.\n';
    default:
      return (
        libList +
        '\nInstall system dependencies for your platform:\n\n' +
        '  # On supported distros (Debian/Ubuntu/Fedora):\n' +
        '  npx playwright install-deps chromium\n\n' +
        '  # On other distros, install Chromium deps manually.\n' +
        '  # Search for missing libraries with your package manager.\n'
      );
  }
}

async function runSetupCommand(): Promise<void> {
  const { execFileSync } = await import('node:child_process');
  const platform = detectPlatform();

  // Step 1: Install browser binary (works on all platforms, no root needed)
  process.stderr.write(cyan('Step 1/2: Installing Playwright Chromium browser...\n\n'));

  try {
    execFileSync('npx', ['playwright', 'install', 'chromium'], {
      stdio: 'inherit',
      timeout: 300_000,
    });
  } catch {
    process.stderr.write(
      red('\nFailed to install Chromium browser. Try running manually:\n') +
        '  npx playwright install chromium\n',
    );
    process.exitCode = 1;
    return;
  }

  // Step 2: Test if the browser actually launches
  process.stderr.write('\n' + cyan('Step 2/2: Verifying browser launches...\n'));

  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    process.stderr.write(cyan('\nSetup complete! You can now use csp-analyser.\n'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const missingLibs = extractMissingLibs(message);

    process.stderr.write(
      red('\nBrowser installed but cannot launch — missing system dependencies.\n') +
        getMissingDepsGuidance(platform.distro, missingLibs) +
        '\nAfter installing dependencies, run "csp-analyser setup" again to verify.\n',
    );
    process.exitCode = 1;
  }
}

/**
 * Checks if Playwright's Chromium browser is installed and launchable.
 * Gives a helpful, platform-specific error message if not.
 */
async function ensureBrowserInstalled(): Promise<void> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isMissingBrowser =
      message.includes("Executable doesn't exist") ||
      message.includes('browserType.launch') ||
      message.includes('ENOENT');
    const isMissingDeps =
      message.includes('shared libraries') ||
      message.includes('cannot open shared object');

    if (isMissingBrowser) {
      process.stderr.write(
        red('Error: Playwright browser is not installed.\n\n') +
          'Run the following command to set up:\n\n' +
          '  csp-analyser setup\n',
      );
    } else if (isMissingDeps) {
      const platform = detectPlatform();
      const missingLibs = extractMissingLibs(message);
      process.stderr.write(
        red('Error: Browser is installed but system dependencies are missing.\n') +
          getMissingDepsGuidance(platform.distro, missingLibs) +
          '\nOr run "csp-analyser setup" for guided installation.\n',
      );
    } else {
      process.stderr.write(
        red('Error: Failed to launch browser.\n\n') +
          `Details: ${message}\n\n` +
          'Try running "csp-analyser setup" to reinstall.\n',
      );
    }

    process.exitCode = 1;
    throw new Error('Browser not available', { cause: err });
  }
}

// ── Main ────────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  // Check for --no-color early (before parseCliArgs, which may throw)
  if (argv.includes('--no-color')) {
    setNoColor(true);
  }

  let args: ParsedArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${red('Error:')} ${message}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    switch (args.command) {
      case 'help':
        process.stdout.write(HELP_TEXT);
        return;
      case 'version':
        process.stdout.write(`csp-analyser ${getVersion()}\n`);
        return;
      case 'setup':
        return await runSetupCommand();
      case 'crawl':
        await ensureBrowserInstalled();
        return await runCrawlCommand(args);
      case 'interactive':
        await ensureBrowserInstalled();
        return await runInteractiveCommand(args);
      case 'generate':
        return await runGenerateCommand(args);
      case 'export':
        return await runExportCommand(args);
      case 'diff':
        return await runDiffCommand(args);
      case 'score':
        return await runScoreCommand(args);
      case 'sessions':
        return await runSessionsCommand();
      case 'permissions':
        return await runPermissionsCommand(args);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${red('Error:')} ${message}\n`);
    process.exitCode = 1;
  }
}

// Run when executed directly
const __cli_url = new URL(import.meta.url).pathname;
const isDirectExecution =
  process.argv[1] &&
  __cli_url === new URL(`file://${realpathSync(process.argv[1])}`).pathname;

if (isDirectExecution) {
  main().catch((err: unknown) => {
    logger.error('Unhandled error', { error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  });
}
