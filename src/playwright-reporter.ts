import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { FullConfig, Reporter, Suite } from 'playwright/types/testReporter';
import { optimizePolicy } from './policy-optimizer.js';
import { formatPolicy } from './policy-formatter.js';
import type { StaticProfile } from './types.js';

export interface PlaywrightCspReporterOptions {
  /** Directory containing JSON artifacts emitted by createCspTest/createPlaywrightCspCapture. */
  artifactsDir?: string;
  /** Directory for aggregate outputs. Defaults to artifactsDir or the Playwright outputDir. */
  outputDir?: string;
  /** Aggregate JSON filename. */
  jsonFileName?: string;
  /** Aggregate header filename. */
  headerFileName?: string;
  /** Worker artifact filename prefix to include during aggregation. Defaults to csp-policy-. */
  artifactPrefix?: string;
  /** Optional target URL for 'self' deduplication during final optimization. */
  targetUrl?: string;
  reportOnly?: boolean;
  useHashes?: boolean;
  nonce?: boolean;
  strictDynamic?: boolean;
  stripUnsafeEval?: boolean;
  collapseHashThreshold?: number;
  staticSiteMode?: boolean;
  staticProfile?: StaticProfile;
}

export interface PlaywrightCspReporterResult {
  artifactCount: number;
  directives: Record<string, string[]>;
  jsonPath: string;
  headerPath: string;
}

interface CspJsonArtifact {
  directives: Record<string, string[]>;
  isReportOnly?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateFileName(name: string, label: string): string {
  if (name.length === 0 || name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error(`Invalid ${label}: ${name}`);
  }
  return name;
}

function parseArtifact(file: string): CspJsonArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `Failed to parse CSP artifact ${file}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isRecord(parsed) || !isRecord(parsed.directives)) {
    throw new Error(`Invalid CSP artifact ${file}: expected a directives object`);
  }
  if (Object.keys(parsed.directives).length === 0) {
    throw new Error(`Invalid CSP artifact ${file}: directives must not be empty`);
  }
  const directives: Record<string, string[]> = {};
  for (const [directive, sources] of Object.entries(parsed.directives)) {
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new Error(`Invalid CSP artifact ${file}: directive ${directive} must contain sources`);
    }
    const values: string[] = [];
    for (const source of sources) {
      if (typeof source !== 'string') {
        throw new Error(`Invalid CSP artifact ${file}: directive ${directive} contains a non-string source`);
      }
      values.push(source);
    }
    directives[directive] = values;
  }
  return {
    directives,
    isReportOnly: typeof parsed.isReportOnly === 'boolean' ? parsed.isReportOnly : undefined,
  };
}

function listJsonFiles(dir: string, artifactPrefix: string): string[] {
  if (!existsSync(dir)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listJsonFiles(path, artifactPrefix));
    } else if (entry.isFile() && entry.name.startsWith(artifactPrefix) && entry.name.endsWith('.json')) {
      result.push(path);
    }
  }
  return result.sort();
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function mergeDirectiveSets(artifacts: CspJsonArtifact[]): Record<string, string[]> {
  const merged = new Map<string, Set<string>>();
  for (const artifact of artifacts) {
    for (const [directive, sources] of Object.entries(artifact.directives)) {
      const set = merged.get(directive) ?? new Set<string>();
      for (const source of sources) {
        set.add(source);
      }
      merged.set(directive, set);
    }
  }
  const directives: Record<string, string[]> = {};
  for (const [directive, sources] of [...merged.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    directives[directive] = [...sources].sort();
  }
  return directives;
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

export function mergePlaywrightCspArtifacts(
  options: PlaywrightCspReporterOptions = {},
): PlaywrightCspReporterResult {
  const artifactsDir = resolve(options.artifactsDir ?? options.outputDir ?? 'test-results/csp-analyser');
  const outputDir = resolve(options.outputDir ?? artifactsDir);
  const jsonFileName = validateFileName(options.jsonFileName ?? 'csp-policy.json', 'jsonFileName');
  const headerFileName = validateFileName(options.headerFileName ?? 'csp-header.txt', 'headerFileName');
  const artifactPrefix = validateFileName(options.artifactPrefix ?? 'csp-policy-', 'artifactPrefix');
  const jsonPath = join(outputDir, jsonFileName);
  const headerPath = join(outputDir, headerFileName);
  const artifacts: CspJsonArtifact[] = [];

  for (const file of listJsonFiles(artifactsDir, artifactPrefix)) {
    if (samePath(file, jsonPath)) continue;
    if (basename(file) === jsonFileName || basename(file) === headerFileName) continue;
    if (statSync(file).size === 0) continue;
    artifacts.push(parseArtifact(file));
  }

  const merged = mergeDirectiveSets(artifacts);
  const directives = optimizePolicy(merged, options.targetUrl, {
    useHashes: options.useHashes,
    useNonces: options.nonce,
    useStrictDynamic: options.strictDynamic,
    stripUnsafeEval: options.stripUnsafeEval,
    collapseHashThreshold: options.collapseHashThreshold,
    staticSiteMode: options.staticSiteMode,
    staticProfile: options.staticProfile,
  });
  const reportOnly = options.reportOnly ?? artifacts.some((artifact) => artifact.isReportOnly === true);
  const json = formatPolicy(directives, 'json', reportOnly);
  const header = formatPolicy(directives, 'header', reportOnly);

  ensureParent(jsonPath);
  ensureParent(headerPath);
  writeFileSync(jsonPath, `${json}\n`, 'utf8');
  writeFileSync(headerPath, `${header}\n`, 'utf8');

  return { artifactCount: artifacts.length, directives, jsonPath, headerPath };
}

export default class PlaywrightCspReporter implements Reporter {
  private configOutputDir = 'test-results';

  constructor(private readonly options: PlaywrightCspReporterOptions = {}) {}

  onBegin(config: FullConfig, _suite: Suite): void {
    this.configOutputDir = config.projects[0]?.outputDir ?? 'test-results';
  }

  async onEnd(): Promise<void> {
    const artifactsDir = this.options.artifactsDir ?? join(this.configOutputDir, 'csp-analyser');
    const outputDir = this.options.outputDir ?? artifactsDir;
    mergePlaywrightCspArtifacts({ ...this.options, artifactsDir, outputDir });
  }
}
