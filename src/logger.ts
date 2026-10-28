import type { LogLevelName } from './types.js';

const RANK: Record<LogLevelName, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY = /hash|token|password|session|phone|authorization|secret|code/i;

export interface Logger {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export function parseLogLevel(value: string | undefined): LogLevelName {
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;
  throw new Error('LOG_LEVEL must be debug, info, warn, or error.');
}

export function createLogger(level: LogLevelName, secrets: readonly string[] = []): Logger {
  const scrubber = createScrubber(secrets);
  const write = (entryLevel: LogLevelName, fields: Record<string, unknown>, message: string): void => {
    if (RANK[entryLevel] < RANK[level]) return;
    const payload: Record<string, unknown> = {
      time: new Date().toISOString(),
      level: entryLevel,
      message: scrubber(message),
    };
    for (const [key, value] of Object.entries(fields)) {
      payload[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : scrubValue(value, scrubber);
    }
    const line = `${JSON.stringify(payload)}\n`;
    if (entryLevel === 'error') process.stderr.write(line);
    else process.stdout.write(line);
  };
  return {
    debug: (fields, message) => write('debug', fields, message),
    info: (fields, message) => write('info', fields, message),
    warn: (fields, message) => write('warn', fields, message),
    error: (fields, message) => write('error', fields, message),
  };
}

function createScrubber(secrets: readonly string[]): (value: string) => string {
  const needles = secrets.filter((secret) => secret.length >= 8);
  return (value: string) => {
    let output = value;
    for (const secret of needles) output = output.split(secret).join('[redacted]');
    return output;
  };
}

function scrubValue(value: unknown, scrubber: (value: string) => string): unknown {
  if (typeof value === 'string') return scrubber(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (value instanceof Error) return scrubber(value.name);
  return scrubber(String(value));
}
