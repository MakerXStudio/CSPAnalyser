#!/usr/bin/env node

import { parseArgs as nodeParseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './utils/logger.js';
import { createDatabase } from './db/repository.js';
import { runSession } from './session-manager.js';
import { generatePolicy } from './policy-generator.js';
import { optimizePolicy } from './policy-optimizer.js';
import { formatPolicy } from './policy-formatter.js';

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

export type Command = 'crawl' | 'interactive' | 'generate' | 'export' | 'help' | 'version';

export interface ParsedArgs {
  command: Command;
  url?: string;
  sessionId?: string;
  depth: number;
  maxPages: number;
  strictness: StrictnessLevel;
  format: ExportFormat;
  mode?: 'local' | 'mitm';
  storageState?: string;
  reportOnly: boolean;
}

// ── Valid values ─────────────────────────────────────────────────────────

const VALID_STRICTNESS: ReadonlySet<string> = new Set(['strict', 'moderate', 'permissive']);
const VALID_FORMATS: ReadonlySet<string> = new Set(['header', 'meta', 'nginx', 'apache', 'cloudflare', 'json']);
const VALID_MODES: ReadonlySet<string> = new Set(['local', 'mitm']);

// ── Help text ───────────────────────────────────────────────────────────

export const HELP_TEXT = `csp-analyser — Generate Content Security Policy headers by crawling websites

Usage:
  csp-analyser crawl <url>              Headless auto-crawl
  csp-analyser interactive <url>        Headed manual browsing
  csp-analyser generate <session-id>    Regenerate policy from session
  csp-analyser export <session-id>      Export policy in a format

Options:
  --depth <n>            Crawl depth (default: 1, crawl only)
  --max-pages <n>        Max pages to visit (default: 10, crawl only)
  --strictness <level>   strict | moderate | permissive (default: moderate)
  --format <fmt>         header | meta | nginx | apache | cloudflare | json (default: header)
  --mode <mode>          local | mitm (default: auto-detect)
  --storage-state <path> Playwright storage state file for auth
  --report-only          Generate report-only policy
  --help, -h             Show this help
  --version, -v          Show version
`;

// ── Argument parsing ────────────────────────────────────────────────────

export function parseCliArgs(argv: string[]): ParsedArgs {
  // Handle --help / -h and --version / -v before parseArgs
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return { command: 'help', depth: 1, maxPages: 10, strictness: 'moderate', format: 'header', reportOnly: false };
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    return { command: 'version', depth: 1, maxPages: 10, strictness: 'moderate', format: 'header', reportOnly: false };
  }

  const { values, positionals } = nodeParseArgs({
    args: argv,
    options: {
      depth: { type: 'string' },
      'max-pages': { type: 'string' },
      strictness: { type: 'string' },
      format: { type: 'string' },
      mode: { type: 'string' },
      'storage-state': { type: 'string' },
      'report-only': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const command = positionals[0] as string | undefined;
  if (!command || !['crawl', 'interactive', 'generate', 'export'].includes(command)) {
    throw new Error(`Unknown command: ${command ?? '(none)'}. Run with --help for usage.`);
  }

  const positionalArg = positionals[1] as string | undefined;
  if (!positionalArg) {
    throw new Error(`Missing argument for "${command}". Run with --help for usage.`);
  }

  // Validate options
  const depth = values.depth !== undefined ? parseNonNegativeInt(values.depth as string, 'depth') : 1;
  const maxPages = values['max-pages'] !== undefined ? parsePositiveInt(values['max-pages'] as string, 'max-pages') : 10;

  const strictness = (values.strictness as string | undefined) ?? 'moderate';
  if (!VALID_STRICTNESS.has(strictness)) {
    throw new Error(`Invalid strictness: "${strictness}". Must be strict, moderate, or permissive.`);
  }

  const format = (values.format as string | undefined) ?? 'header';
  if (!VALID_FORMATS.has(format)) {
    throw new Error(`Invalid format: "${format}". Must be header, meta, nginx, apache, cloudflare, or json.`);
  }

  const mode = values.mode as string | undefined;
  if (mode !== undefined && !VALID_MODES.has(mode)) {
    throw new Error(`Invalid mode: "${mode}". Must be local or mitm.`);
  }

  const parsed: ParsedArgs = {
    command: command as Command,
    depth,
    maxPages,
    strictness: strictness as StrictnessLevel,
    format: format as ExportFormat,
    reportOnly: (values['report-only'] as boolean | undefined) ?? false,
  };

  if (command === 'crawl' || command === 'interactive') {
    parsed.url = positionalArg;
  } else {
    parsed.sessionId = positionalArg;
  }

  if (mode !== undefined) {
    parsed.mode = mode as 'local' | 'mitm';
  }

  const storageState = values['storage-state'] as string | undefined;
  if (storageState !== undefined) {
    parsed.storageState = storageState;
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
  const dbPath = join(process.cwd(), '.csp-analyser', 'data.db');
  return createDatabase(dbPath);
}

function generateAndFormat(
  db: ReturnType<typeof createDatabase>,
  sessionId: string,
  args: ParsedArgs,
): string {
  const directives = generatePolicy(db, sessionId, {
    strictness: args.strictness,
    includeHashes: true,
  });
  const optimized = optimizePolicy(directives);
  return formatPolicy(optimized, args.format, args.reportOnly);
}

// ── Command execution ───────────────────────────────────────────────────

async function runCrawlCommand(args: ParsedArgs): Promise<void> {
  const db = initDb();
  try {
    const config: SessionConfig = {
      targetUrl: args.url!,
      mode: args.mode,
      crawlConfig: { depth: args.depth, maxPages: args.maxPages },
      storageStatePath: args.storageState,
    };

    const result = await runSession(db, config, {
      headless: true,
      onProgress: (msg) => process.stderr.write(`${msg}\n`),
    });

    process.stderr.write(
      `Crawled ${result.pagesVisited} pages, found ${result.violationsFound} violations\n`,
    );

    const output = generateAndFormat(db, result.session.id, args);
    process.stdout.write(output + '\n');
  } finally {
    db.close();
  }
}

async function runInteractiveCommand(args: ParsedArgs): Promise<void> {
  const db = initDb();
  try {
    const config: SessionConfig = {
      targetUrl: args.url!,
      mode: args.mode,
      crawlConfig: { depth: 0, maxPages: 1 },
      storageStatePath: args.storageState,
    };

    const result = await runSession(db, config, {
      headless: false,
      onProgress: (msg) => process.stderr.write(`${msg}\n`),
    });

    process.stderr.write(
      `Session complete. Found ${result.violationsFound} violations\n`,
    );

    const output = generateAndFormat(db, result.session.id, args);
    process.stdout.write(output + '\n');
  } finally {
    db.close();
  }
}

async function runGenerateCommand(args: ParsedArgs): Promise<void> {
  const db = initDb();
  try {
    const output = generateAndFormat(db, args.sessionId!, args);
    process.stdout.write(output + '\n');
  } finally {
    db.close();
  }
}

async function runExportCommand(args: ParsedArgs): Promise<void> {
  const db = initDb();
  try {
    const output = generateAndFormat(db, args.sessionId!, args);
    process.stdout.write(output + '\n');
  } finally {
    db.close();
  }
}

// ── Main ────────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  switch (args.command) {
    case 'help':
      process.stdout.write(HELP_TEXT);
      return;
    case 'version':
      process.stdout.write(`csp-analyser ${getVersion()}\n`);
      return;
    case 'crawl':
      return runCrawlCommand(args);
    case 'interactive':
      return runInteractiveCommand(args);
    case 'generate':
      return runGenerateCommand(args);
    case 'export':
      return runExportCommand(args);
  }
}

// Run when executed directly
const __cli_url = new URL(import.meta.url).pathname;
const isDirectExecution = process.argv[1] &&
  (__cli_url === new URL(`file://${process.argv[1]}`).pathname);

if (isDirectExecution) {
  main().catch((err: unknown) => {
    logger.error('Unhandled error', { error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  });
}
