import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mergePlaywrightCspArtifacts } from '../src/playwright-reporter.js';

function writeArtifact(dir: string, name: string, directives: Record<string, string[]>): void {
  writeFileSync(
    join(dir, name),
    JSON.stringify({ directives, policyString: '', isReportOnly: false }, null, 2),
    'utf8',
  );
}

describe('mergePlaywrightCspArtifacts', () => {
  it('merges directive source sets deterministically and writes JSON plus header outputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csp-playwright-reporter-'));
    const artifactsDir = join(dir, 'artifacts');
    const outputDir = join(dir, 'out');
    mkdirSync(artifactsDir, { recursive: true });
    writeArtifact(artifactsDir, 'csp-policy-worker-b.json', {
      'script-src': ['https://z.example.com', 'https://a.example.com'],
      'img-src': ['data:'],
    });
    writeArtifact(artifactsDir, 'csp-policy-worker-a.json', {
      'script-src': ['https://a.example.com', 'https://cdn.example.com'],
      'style-src': ["'unsafe-inline'", "'sha256-stylehash'"],
    });

    const result = mergePlaywrightCspArtifacts({ artifactsDir, outputDir, useHashes: true });

    expect(result.artifactCount).toBe(2);
    expect(result.directives['script-src']).toEqual([
      'https://a.example.com',
      'https://cdn.example.com',
      'https://z.example.com',
    ]);
    expect(result.directives['style-src']).toEqual(["'sha256-stylehash'"]);

    const json = JSON.parse(readFileSync(join(outputDir, 'csp-policy.json'), 'utf8'));
    expect(json.directives).toEqual(result.directives);
    expect(readFileSync(join(outputDir, 'csp-header.txt'), 'utf8')).toContain(
      'Content-Security-Policy:',
    );

    rmSync(dir, { recursive: true, force: true });
  });

  it('skips its own aggregate JSON when outputDir equals artifactsDir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csp-playwright-reporter-'));
    writeArtifact(dir, 'csp-policy-worker.json', {
      'script-src': ['https://current.example.com'],
    });
    writeArtifact(dir, 'csp-policy.json', {
      'script-src': ['https://stale.example.com'],
      'img-src': ['https://stale-images.example.com'],
    });

    const result = mergePlaywrightCspArtifacts({ artifactsDir: dir, outputDir: dir });

    expect(result.artifactCount).toBe(1);
    expect(result.directives['script-src']).toEqual(['https://current.example.com']);
    expect(result.directives['img-src']).toBeUndefined();

    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores non-worker JSON artifacts under artifactsDir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csp-playwright-reporter-'));
    writeArtifact(dir, 'csp-policy-worker.json', {
      'script-src': ['https://current.example.com'],
    });
    writeArtifact(dir, 'crafted.json', {
      'script-src': ["'unsafe-inline'"],
      'default-src': ['*'],
    });

    const result = mergePlaywrightCspArtifacts({ artifactsDir: dir, outputDir: dir });

    expect(result.artifactCount).toBe(1);
    expect(result.directives['script-src']).toEqual(['https://current.example.com']);
    expect(result.directives['default-src']).toEqual(["'self'"]);

    rmSync(dir, { recursive: true, force: true });
  });

  it('throws a clear error for malformed worker artifact JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csp-playwright-reporter-'));
    writeFileSync(join(dir, 'csp-policy-worker.json'), '{ not-json', 'utf8');

    expect(() => mergePlaywrightCspArtifacts({ artifactsDir: dir, outputDir: dir })).toThrow(
      /Failed to parse CSP artifact .*csp-policy-worker\.json/,
    );

    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects path traversal in aggregate output filenames', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csp-playwright-reporter-'));
    writeArtifact(dir, 'csp-policy-worker.json', {
      'script-src': ['https://current.example.com'],
    });

    expect(() =>
      mergePlaywrightCspArtifacts({ artifactsDir: dir, outputDir: dir, jsonFileName: '../csp-policy.json' }),
    ).toThrow('Invalid jsonFileName');
    expect(() =>
      mergePlaywrightCspArtifacts({ artifactsDir: dir, outputDir: dir, headerFileName: 'nested/csp-header.txt' }),
    ).toThrow('Invalid headerFileName');

    rmSync(dir, { recursive: true, force: true });
  });
});
