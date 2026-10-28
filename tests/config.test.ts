import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import { createLogger } from '../src/logger.js';

const valid = {
  TG_API_ID: '12345678',
  TG_API_HASH: '0123456789abcdef0123456789abcdef',
  BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyz123456',
  ALLOWED_USER_ID: '1000000000',
};

describe('configuration', () => {
  it('loads a complete environment without echoing secrets back from errors', () => {
    const config = loadConfig(valid);
    expect(config.apiId).toBe(12345678);
    expect(config.allowedUserId).toBe('1000000000');
    expect(config.logLevel).toBe('info');

    const secret = 'not-a-real-hash-value-but-secret';
    expect(() => loadConfig({ ...valid, TG_API_HASH: secret })).toThrow(ConfigError);
    try {
      loadConfig({ ...valid, TG_API_HASH: secret });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain(secret);
    }
    expect(() => loadConfig({ ...valid, SESSION_PATH: '.env' })).toThrow(/SESSION_PATH/);
    expect(() =>
      loadConfig({ ...valid, SESSION_PATH: './data/same.db', DATABASE_PATH: './data/same.db' }),
    ).toThrow(/different files/);
  });

  it('scrubs configured secrets from structured logs', () => {
    const lines: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const logger = createLogger('info', ['0123456789abcdef0123456789abcdef']);
      logger.info({ event: 'test', note: 'hash 0123456789abcdef0123456789abcdef' }, 'started');
    } finally {
      process.stdout.write = original;
    }
    expect(lines.join('')).not.toContain('0123456789abcdef0123456789abcdef');
    expect(lines.join('')).toContain('[redacted]');
  });
});
