export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

function getDefaultLevel(): LogLevel {
  const env = process.env['CSP_ANALYSER_LOG_LEVEL']?.toLowerCase();
  if (env && env in LOG_LEVEL_PRIORITY) {
    return env as LogLevel;
  }
  return 'info';
}

/**
 * Creates a structured logger that outputs to stderr.
 * Stdout is kept clean for MCP/CLI output.
 */
export function createLogger(level?: LogLevel): Logger {
  const minLevel = level ?? getDefaultLevel();
  const minPriority = LOG_LEVEL_PRIORITY[minLevel];

  function log(logLevel: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LOG_LEVEL_PRIORITY[logLevel] < minPriority) {
      return;
    }

    const entry = {
      timestamp: new Date().toISOString(),
      level: logLevel,
      message,
      ...(data && Object.keys(data).length > 0 ? { data } : {}),
    };

    process.stderr.write(JSON.stringify(entry) + '\n');
  }

  return {
    debug: (message, data) => log('debug', message, data),
    info: (message, data) => log('info', message, data),
    warn: (message, data) => log('warn', message, data),
    error: (message, data) => log('error', message, data),
  };
}
