import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies for command execution tests
const mockRunSession = vi.fn();
const mockRunInteractiveSession = vi.fn();
const mockGeneratePolicy = vi.fn().mockReturnValue({ 'default-src': ["'self'"] });
const mockOptimizePolicy = vi.fn().mockImplementation((d) => d);
const mockFormatPolicy = vi.fn().mockReturnValue("Content-Security-Policy: default-src 'self'");
const mockCreateDatabase = vi.fn().mockReturnValue({ close: vi.fn() });
const mockGetSession = vi.fn().mockReturnValue({ targetUrl: 'https://example.com' });
const mockGetViolationSummary = vi.fn().mockReturnValue([]);

vi.mock('../src/session-manager.js', () => ({
  runSession: (...args: unknown[]) => mockRunSession(...args),
  runInteractiveSession: (...args: unknown[]) => mockRunInteractiveSession(...args),
}));

vi.mock('../src/policy-generator.js', () => ({
  generatePolicy: (...args: unknown[]) => mockGeneratePolicy(...args),
}));

vi.mock('../src/policy-optimizer.js', () => ({
  optimizePolicy: (...args: unknown[]) => mockOptimizePolicy(...args),
}));

vi.mock('../src/policy-formatter.js', () => ({
  formatPolicy: (...args: unknown[]) => mockFormatPolicy(...args),
}));

const mockCompareSessions = vi.fn().mockReturnValue({
  sessionA: 'id-a',
  sessionB: 'id-b',
  policyDiff: { addedDirectives: [], removedDirectives: [], changedDirectives: [], unchangedDirectives: [] },
  violationDiff: { newViolations: [], resolvedViolations: [], unchangedViolations: [] },
});
const mockFormatDiff = vi.fn().mockReturnValue('Session comparison: id-a → id-b\n\n=== Policy Changes ===\n  No policy changes.');
vi.mock('../src/policy-diff.js', () => ({
  compareSessions: (...args: unknown[]) => mockCompareSessions(...args),
  formatDiff: (...args: unknown[]) => mockFormatDiff(...args),
}));

const mockScoreCspPolicy = vi.fn().mockReturnValue({
  overall: 85,
  grade: 'B',
  findings: [],
});
const mockFormatScore = vi.fn().mockReturnValue('CSP Score: 85/100 (Grade: B)');
vi.mock('../src/policy-scorer.js', () => ({
  scoreCspPolicy: (...args: unknown[]) => mockScoreCspPolicy(...args),
  formatScore: (...args: unknown[]) => mockFormatScore(...args),
}));

const mockGetPermissionsPolicies = vi.fn().mockReturnValue([]);
vi.mock('../src/db/repository.js', () => ({
  createDatabase: (...args: unknown[]) => mockCreateDatabase(...args),
  getSession: (...args: unknown[]) => mockGetSession(...args),
  getViolationSummary: (...args: unknown[]) => mockGetViolationSummary(...args),
  getPermissionsPolicies: (...args: unknown[]) => mockGetPermissionsPolicies(...args),
}));

import { parseCliArgs, HELP_TEXT, main } from '../src/cli.js';
import type { ParsedArgs } from '../src/cli.js';
import { setNoColor } from '../src/utils/terminal.js';

// ── parseCliArgs ────────────────────────────────────────────────────────

describe('parseCliArgs', () => {
  describe('help and version', () => {
    it('returns help command for empty args', () => {
      const result = parseCliArgs([]);
      expect(result.command).toBe('help');
    });

    it('returns help command for --help', () => {
      const result = parseCliArgs(['--help']);
      expect(result.command).toBe('help');
    });

    it('returns help command for -h', () => {
      const result = parseCliArgs(['-h']);
      expect(result.command).toBe('help');
    });

    it('returns version command for --version', () => {
      const result = parseCliArgs(['--version']);
      expect(result.command).toBe('version');
    });

    it('returns version command for -v', () => {
      const result = parseCliArgs(['-v']);
      expect(result.command).toBe('version');
    });

    it('--help takes precedence even with other args', () => {
      const result = parseCliArgs(['crawl', 'https://example.com', '--help']);
      expect(result.command).toBe('help');
    });
  });

  describe('crawl command', () => {
    it('parses minimal crawl args', () => {
      const result = parseCliArgs(['crawl', 'https://example.com']);
      expect(result).toMatchObject({
        command: 'crawl',
        url: 'https://example.com',
        depth: 1,
        maxPages: 10,
        strictness: 'moderate',
        format: 'header',
        reportOnly: false,
      });
    });

    it('parses all crawl options', () => {
      const result = parseCliArgs([
        'crawl', 'https://example.com',
        '--depth', '3',
        '--max-pages', '20',
        '--strictness', 'strict',
        '--format', 'nginx',
        '--mode', 'mitm',
        '--storage-state', '/tmp/state.json',
        '--report-only',
      ]);
      expect(result).toMatchObject({
        command: 'crawl',
        url: 'https://example.com',
        depth: 3,
        maxPages: 20,
        strictness: 'strict',
        format: 'nginx',
        mode: 'mitm',
        storageState: '/tmp/state.json',
        reportOnly: true,
      });
    });
  });

  describe('interactive command', () => {
    it('parses interactive args', () => {
      const result = parseCliArgs(['interactive', 'https://example.com']);
      expect(result).toMatchObject({
        command: 'interactive',
        url: 'https://example.com',
      });
    });

    it('accepts format and strictness', () => {
      const result = parseCliArgs([
        'interactive', 'https://example.com',
        '--strictness', 'permissive',
        '--format', 'json',
      ]);
      expect(result.strictness).toBe('permissive');
      expect(result.format).toBe('json');
    });
  });

  describe('generate command', () => {
    it('parses generate args with session-id', () => {
      const result = parseCliArgs(['generate', 'abc-123']);
      expect(result).toMatchObject({
        command: 'generate',
        sessionId: 'abc-123',
      });
    });

    it('accepts strictness and format', () => {
      const result = parseCliArgs([
        'generate', 'abc-123',
        '--strictness', 'strict',
        '--format', 'apache',
        '--report-only',
      ]);
      expect(result).toMatchObject({
        command: 'generate',
        sessionId: 'abc-123',
        strictness: 'strict',
        format: 'apache',
        reportOnly: true,
      });
    });
  });

  describe('diff command', () => {
    it('parses diff args with two session IDs', () => {
      const result = parseCliArgs(['diff', 'session-a', 'session-b']);
      expect(result).toMatchObject({
        command: 'diff',
        sessionId: 'session-a',
        sessionIdB: 'session-b',
      });
    });

    it('parses diff args with strictness', () => {
      const result = parseCliArgs(['diff', 'session-a', 'session-b', '--strictness', 'strict']);
      expect(result).toMatchObject({
        command: 'diff',
        sessionId: 'session-a',
        sessionIdB: 'session-b',
        strictness: 'strict',
      });
    });

    it('throws on missing second session ID', () => {
      expect(() => parseCliArgs(['diff', 'session-a'])).toThrow('Missing second session ID');
    });
  });

  describe('score command', () => {
    it('parses score args with session ID', () => {
      const result = parseCliArgs(['score', 'session-id']);
      expect(result).toMatchObject({
        command: 'score',
        sessionId: 'session-id',
      });
    });
  });

  describe('permissions command', () => {
    it('parses permissions args with session ID', () => {
      const result = parseCliArgs(['permissions', 'session-id']);
      expect(result).toMatchObject({
        command: 'permissions',
        sessionId: 'session-id',
      });
    });
  });

  describe('export command', () => {
    it('parses export args with session-id and format', () => {
      const result = parseCliArgs(['export', 'abc-123', '--format', 'cloudflare']);
      expect(result).toMatchObject({
        command: 'export',
        sessionId: 'abc-123',
        format: 'cloudflare',
      });
    });
  });

  describe('validation errors', () => {
    it('throws on unknown command', () => {
      expect(() => parseCliArgs(['unknown'])).toThrow('Unknown command: unknown');
    });

    it('throws on missing url for crawl', () => {
      expect(() => parseCliArgs(['crawl'])).toThrow('Missing argument');
    });

    it('throws on missing session-id for generate', () => {
      expect(() => parseCliArgs(['generate'])).toThrow('Missing argument');
    });

    it('throws on invalid strictness', () => {
      expect(() => parseCliArgs(['crawl', 'https://example.com', '--strictness', 'bad'])).toThrow(
        'Invalid strictness: "bad"',
      );
    });

    it('throws on invalid format', () => {
      expect(() => parseCliArgs(['crawl', 'https://example.com', '--format', 'yaml'])).toThrow(
        'Invalid format: "yaml"',
      );
    });

    it('throws on invalid mode', () => {
      expect(() => parseCliArgs(['crawl', 'https://example.com', '--mode', 'remote'])).toThrow(
        'Invalid mode: "remote"',
      );
    });

    it('throws on non-integer depth', () => {
      expect(() => parseCliArgs(['crawl', 'https://example.com', '--depth', 'abc'])).toThrow(
        'Invalid --depth: "abc"',
      );
    });

    it('allows zero depth', () => {
      const result = parseCliArgs(['crawl', 'https://example.com', '--depth', '0']);
      expect(result.depth).toBe(0);
    });

    it('throws on negative depth', () => {
      expect(() => parseCliArgs(['crawl', 'https://example.com', '--depth', '-1'])).toThrow(
        'Invalid --depth: "-1"',
      );
    });

    it('throws on negative max-pages', () => {
      expect(() => parseCliArgs(['crawl', 'https://example.com', '--max-pages', '-1'])).toThrow(
        'Invalid --max-pages: "-1"',
      );
    });
  });
});

// ── HELP_TEXT ────────────────────────────────────────────────────────────

describe('HELP_TEXT', () => {
  it('mentions all commands', () => {
    expect(HELP_TEXT).toContain('crawl');
    expect(HELP_TEXT).toContain('interactive');
    expect(HELP_TEXT).toContain('generate');
    expect(HELP_TEXT).toContain('export');
  });

  it('mentions key options', () => {
    expect(HELP_TEXT).toContain('--depth');
    expect(HELP_TEXT).toContain('--max-pages');
    expect(HELP_TEXT).toContain('--strictness');
    expect(HELP_TEXT).toContain('--format');
    expect(HELP_TEXT).toContain('--report-only');
  });
});

// ── main ────────────────────────────────────────────────────────────────

describe('main', () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;
  let stderrWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.exitCode = undefined;
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    process.exitCode = undefined;
    setNoColor(undefined);
  });

  it('prints help text for --help', async () => {
    await main(['--help']);
    expect(stdoutWrite).toHaveBeenCalledWith(HELP_TEXT);
  });

  it('prints version for --version', async () => {
    await main(['--version']);
    const output = (stdoutWrite.mock.calls[0] as [string])[0];
    expect(output).toMatch(/^csp-analyser \d+\.\d+\.\d+\n$/);
  });

  it('prints error for unknown command', async () => {
    await main(['bogus']);
    expect(process.exitCode).toBe(1);
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('Unknown command'));
  });

  it('prints error for missing arg', async () => {
    await main(['crawl']);
    expect(process.exitCode).toBe(1);
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('Missing argument'));
  });

  it('runs crawl command and outputs policy', async () => {
    mockRunSession.mockResolvedValue({
      session: { id: 'test-session-id' },
      pagesVisited: 3,
      violationsFound: 5,
      errors: [],
    });

    await main(['crawl', 'https://example.com']);

    expect(mockRunSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetUrl: 'https://example.com',
        crawlConfig: { depth: 1, maxPages: 10 },
      }),
      expect.objectContaining({ headless: true }),
    );
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('Pages crawled:'));
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('Violations found:'));
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('Content-Security-Policy'));
  });

  it('runs interactive command using runInteractiveSession', async () => {
    mockRunInteractiveSession.mockResolvedValue({
      session: { id: 'test-session-id', targetUrl: 'https://example.com' },
      pagesVisited: 3,
      violationsFound: 5,
    });

    await main(['interactive', 'https://example.com']);

    expect(mockRunInteractiveSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetUrl: 'https://example.com',
      }),
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
    // No crawlConfig should be passed (interactive doesn't use the crawler)
    const configArg = mockRunInteractiveSession.mock.calls[0][1] as Record<string, unknown>;
    expect(configArg.crawlConfig).toBeUndefined();
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('Pages crawled:'));
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('Violations found:'));
  });

  it('runs generate command and outputs formatted policy', async () => {
    await main(['generate', 'abc-123']);

    expect(mockGeneratePolicy).toHaveBeenCalledWith(
      expect.anything(),
      'abc-123',
      expect.objectContaining({ strictness: 'moderate' }),
    );
    expect(mockOptimizePolicy).toHaveBeenCalled();
    expect(mockFormatPolicy).toHaveBeenCalled();
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('Content-Security-Policy'));
  });

  it('runs export command and outputs formatted policy', async () => {
    await main(['export', 'abc-123', '--format', 'nginx']);

    expect(mockGeneratePolicy).toHaveBeenCalled();
    expect(mockFormatPolicy).toHaveBeenCalledWith(
      expect.anything(),
      'nginx',
      false,
    );
    expect(stdoutWrite).toHaveBeenCalled();
  });

  it('runs diff command and outputs comparison', async () => {
    await main(['diff', 'session-a', 'session-b']);

    expect(mockCompareSessions).toHaveBeenCalledWith(
      expect.anything(),
      'session-a',
      'session-b',
      'moderate',
    );
    expect(mockFormatDiff).toHaveBeenCalled();
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('Session comparison'));
  });

  it('runs diff command with strictness option', async () => {
    await main(['diff', 'session-a', 'session-b', '--strictness', 'strict']);

    expect(mockCompareSessions).toHaveBeenCalledWith(
      expect.anything(),
      'session-a',
      'session-b',
      'strict',
    );
  });

  it('prints error when diff is missing second session ID', async () => {
    await main(['diff', 'session-a']);
    expect(process.exitCode).toBe(1);
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('Missing second session ID'));
  });

  it('runs score command and outputs score', async () => {
    await main(['score', 'session-id']);

    expect(mockGeneratePolicy).toHaveBeenCalledWith(
      expect.anything(),
      'session-id',
      expect.objectContaining({ strictness: 'moderate' }),
    );
    expect(mockScoreCspPolicy).toHaveBeenCalled();
    expect(mockFormatScore).toHaveBeenCalled();
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('CSP Score'));
  });

  it('runs permissions command with policies', async () => {
    mockGetPermissionsPolicies.mockReturnValueOnce([
      {
        id: '1',
        sessionId: 'session-id',
        pageId: null,
        directive: 'camera',
        allowlist: ['self'],
        headerType: 'permissions-policy',
        sourceUrl: 'https://example.com/',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]);

    await main(['permissions', 'session-id']);

    expect(mockGetPermissionsPolicies).toHaveBeenCalledWith(expect.anything(), 'session-id');
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('camera'));
  });

  it('runs permissions command with no policies found', async () => {
    mockGetPermissionsPolicies.mockReturnValueOnce([]);

    await main(['permissions', 'session-id']);

    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('No Permissions-Policy'));
  });

  it('runs permissions command with nonexistent session', async () => {
    mockGetSession.mockReturnValueOnce(null);

    await main(['permissions', 'session-id']);

    expect(process.exitCode).toBe(1);
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('Session not found'));
  });

  it('passes crawl options through to runSession', async () => {
    mockRunSession.mockResolvedValue({
      session: { id: 'sid' },
      pagesVisited: 1,
      violationsFound: 0,
      errors: [],
    });

    await main([
      'crawl', 'https://example.com',
      '--depth', '3',
      '--max-pages', '20',
      '--mode', 'mitm',
      '--storage-state', '/tmp/state.json',
    ]);

    expect(mockRunSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetUrl: 'https://example.com',
        mode: 'mitm',
        crawlConfig: { depth: 3, maxPages: 20 },
        storageStatePath: '/tmp/state.json',
      }),
      expect.anything(),
    );
  });
});
