import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../../src/utils/logger.js';

describe('createLogger', () => {
  let stderrWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stderrWrite.mockRestore();
    delete process.env['CSP_ANALYSER_LOG_LEVEL'];
  });

  it('respects CSP_ANALYSER_LOG_LEVEL env var', () => {
    process.env['CSP_ANALYSER_LOG_LEVEL'] = 'error';
    const logger = createLogger();

    logger.info('should be suppressed');
    logger.warn('should be suppressed');
    logger.error('should appear');

    expect(stderrWrite).toHaveBeenCalledTimes(1);
    const output = stderrWrite.mock.calls[0][0] as string;
    expect(output).toContain('"level":"error"');
  });

  it('defaults to info level when env var is not set', () => {
    const logger = createLogger();

    logger.debug('should be suppressed');
    logger.info('should appear');

    expect(stderrWrite).toHaveBeenCalledTimes(1);
    const output = stderrWrite.mock.calls[0][0] as string;
    expect(output).toContain('should appear');
  });

  it('ignores invalid env var values', () => {
    process.env['CSP_ANALYSER_LOG_LEVEL'] = 'invalid';
    const logger = createLogger();

    logger.info('should appear at default info level');
    expect(stderrWrite).toHaveBeenCalledTimes(1);
  });

  it('logs error level messages', () => {
    const logger = createLogger();
    logger.error('test error', { code: 500 });

    expect(stderrWrite).toHaveBeenCalledTimes(1);
    const output = stderrWrite.mock.calls[0][0] as string;
    expect(output).toContain('"level":"error"');
    expect(output).toContain('"code":500');
  });

  it('accepts explicit level parameter', () => {
    const logger = createLogger('warn');

    logger.info('suppressed');
    logger.warn('visible');

    expect(stderrWrite).toHaveBeenCalledTimes(1);
    const output = stderrWrite.mock.calls[0][0] as string;
    expect(output).toContain('visible');
  });

  it('debug level shows all messages', () => {
    const logger = createLogger('debug');

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(stderrWrite).toHaveBeenCalledTimes(4);
  });

  it('omits data key when data is empty', () => {
    const logger = createLogger();
    logger.info('no data', {});

    const output = stderrWrite.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.data).toBeUndefined();
  });
});
