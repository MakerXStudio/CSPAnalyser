#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultCurrentPath = 'examples/vite-react-client/test-results/csp-analyser/csp-policy.json';
const defaultBaselinePath = 'examples/vite-react-client/csp-baseline/csp-policy.json';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizePolicy(policy) {
  if (!isRecord(policy) || !isRecord(policy.directives)) {
    throw new Error('Expected a CSP policy JSON object with a directives object');
  }

  const directives = {};
  for (const directive of Object.keys(policy.directives).sort()) {
    const sources = policy.directives[directive];
    if (!Array.isArray(sources) || !sources.every((source) => typeof source === 'string')) {
      throw new Error(`Directive ${directive} must be an array of strings`);
    }
    directives[directive] = [...new Set(sources)].sort();
  }

  return {
    directives,
    isReportOnly: policy.isReportOnly === true,
  };
}

export function readNormalizedPolicy(path) {
  return normalizePolicy(JSON.parse(readFileSync(path, 'utf8')));
}

export function diffPolicies(baseline, current) {
  const changes = [];
  const directiveNames = new Set([
    ...Object.keys(baseline.directives),
    ...Object.keys(current.directives),
  ]);

  for (const directive of [...directiveNames].sort()) {
    const before = new Set(baseline.directives[directive] ?? []);
    const after = new Set(current.directives[directive] ?? []);
    const added = [...after].filter((source) => !before.has(source)).sort();
    const removed = [...before].filter((source) => !after.has(source)).sort();
    if (added.length > 0 || removed.length > 0) {
      changes.push({ directive, added, removed });
    }
  }

  if (baseline.isReportOnly !== current.isReportOnly) {
    changes.push({
      directive: 'isReportOnly',
      added: [String(current.isReportOnly)],
      removed: [String(baseline.isReportOnly)],
    });
  }

  return changes;
}

export function formatPolicyDiff(changes) {
  if (changes.length === 0) return 'CSP snapshot matches baseline.';

  const lines = ['CSP snapshot drift detected:'];
  for (const change of changes) {
    lines.push(`- ${change.directive}`);
    for (const source of change.added) lines.push(`  + ${source}`);
    for (const source of change.removed) lines.push(`  - ${source}`);
  }
  return lines.join('\n');
}

export function writeNormalizedPolicy(path, policy) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
}

export function runCompare(argv = process.argv.slice(2)) {
  const update = argv.includes('--update');
  const currentPath = resolve(defaultCurrentPath);
  const baselinePath = resolve(defaultBaselinePath);

  if (!existsSync(currentPath)) {
    throw new Error(`Current CSP policy not found: ${currentPath}`);
  }

  const current = readNormalizedPolicy(currentPath);
  if (update || !existsSync(baselinePath)) {
    writeNormalizedPolicy(baselinePath, current);
    return `Updated CSP baseline: ${baselinePath}`;
  }

  const baseline = readNormalizedPolicy(baselinePath);
  const changes = diffPolicies(baseline, current);
  if (changes.length > 0) {
    const message = formatPolicyDiff(changes);
    const error = new Error(message);
    error.exitCode = 1;
    throw error;
  }

  return formatPolicyDiff(changes);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    console.log(runCompare());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode =
      error && typeof error === 'object' && 'exitCode' in error ? Number(error.exitCode) : 1;
  }
}
