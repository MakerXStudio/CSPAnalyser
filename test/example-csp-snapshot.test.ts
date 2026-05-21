import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  diffPolicies,
  formatPolicyDiff,
  normalizePolicy,
  readNormalizedPolicy,
  writeNormalizedPolicy,
} from '../examples/vite-react-client/scripts/compare-csp-policy.mjs';

describe('Vite React CSP snapshot comparison', () => {
  it('normalizes directive and source ordering', () => {
    expect(
      normalizePolicy({
        isReportOnly: false,
        directives: {
          'script-src': ['https://z.example.com', "'self'", "'self'"],
          'default-src': ["'self'"],
        },
      }),
    ).toEqual({
      isReportOnly: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", 'https://z.example.com'],
      },
    });
  });

  it('reports added and removed sources', () => {
    const changes = diffPolicies(
      {
        isReportOnly: false,
        directives: {
          'script-src': ["'self'", 'https://old.example.com'],
        },
      },
      {
        isReportOnly: false,
        directives: {
          'script-src': ["'self'", 'https://new.example.com'],
          'img-src': ['data:'],
        },
      },
    );

    expect(formatPolicyDiff(changes)).toContain('CSP snapshot drift detected');
    expect(changes).toEqual([
      { directive: 'img-src', added: ['data:'], removed: [] },
      {
        directive: 'script-src',
        added: ['https://new.example.com'],
        removed: ['https://old.example.com'],
      },
    ]);
  });

  it('writes and reads normalized snapshots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csp-snapshot-'));
    const file = join(dir, 'csp-policy.json');

    writeNormalizedPolicy(file, {
      isReportOnly: false,
      directives: {
        'style-src': ["'sha256-style'"],
      },
    });

    expect(readNormalizedPolicy(file)).toEqual({
      isReportOnly: false,
      directives: {
        'style-src': ["'sha256-style'"],
      },
    });

    rmSync(dir, { recursive: true, force: true });
  });
});
