import path from 'node:path';
import { ConfigError } from './errors.js';
import { parseLogLevel } from './logger.js';
import type { LogLevelName } from './types.js';

export interface AppConfig {
  apiId: number;
  apiHash: string;
  botToken: string;
  allowedUserId: string;
  sessionPath: string;
  databasePath: string;
  logLevel: LogLevelName;
}

type Env = Record<string, string | undefined>;

const RESERVED_NAMES = new Set(['.env', '.env.example', 'package.json', 'pnpm-lock.yaml']);

export function loadConfig(env: Env): AppConfig {
  const apiId = readApiId(env.TG_API_ID);
  const apiHash = readApiHash(env.TG_API_HASH);
  const botToken = readBotToken(env.BOT_TOKEN);
  const allowedUserId = readUserId(env.ALLOWED_USER_ID);
  const sessionPath = readPath(env.SESSION_PATH, './data/telesyncra.session', 'SESSION_PATH');
  const databasePath = readPath(env.DATABASE_PATH, './data/telesyncra.db', 'DATABASE_PATH');
  if (sessionPath === databasePath) {
    throw new ConfigError('SESSION_PATH and DATABASE_PATH must be different files.');
  }
  let logLevel: LogLevelName;
  try {
    logLevel = parseLogLevel(env.LOG_LEVEL ?? 'info');
  } catch {
    throw new ConfigError('LOG_LEVEL must be debug, info, warn, or error.');
  }
  return { apiId, apiHash, botToken, allowedUserId, sessionPath, databasePath, logLevel };
}

function readApiId(value: string | undefined): number {
  if (!value || !/^[1-9]\d{1,9}$/.test(value.trim())) {
    throw new ConfigError('TG_API_ID must be the numeric id from https://my.telegram.org.');
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed)) throw new ConfigError('TG_API_ID is not a valid integer.');
  return parsed;
}

function readApiHash(value: string | undefined): string {
  const hash = value?.trim() ?? '';
  if (!/^[a-fA-F0-9]{32}$/.test(hash)) {
    throw new ConfigError('TG_API_HASH must be the 32-character hash from https://my.telegram.org.');
  }
  return hash;
}

function readBotToken(value: string | undefined): string {
  const token = value?.trim() ?? '';
  if (!/^\d{8,12}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    throw new ConfigError('BOT_TOKEN must be the token from @BotFather.');
  }
  return token;
}

function readUserId(value: string | undefined): string {
  const id = value?.trim() ?? '';
  if (!/^[1-9]\d{0,19}$/.test(id)) {
    throw new ConfigError('ALLOWED_USER_ID must be your numeric Telegram user id.');
  }
  return id;
}

function readPath(value: string | undefined, fallback: string, name: string): string {
  const raw = (value ?? fallback).trim();
  if (!raw || raw.includes('\0')) throw new ConfigError(`${name} is empty or invalid.`);
  const resolved = path.resolve(raw);
  if (RESERVED_NAMES.has(path.basename(resolved).toLowerCase())) {
    throw new ConfigError(`${name} must not point at ${path.basename(resolved)}.`);
  }
  return resolved;
}
