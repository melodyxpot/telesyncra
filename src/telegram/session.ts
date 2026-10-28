import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import { restrictFile } from '../security/files.js';

export function readSession(filePath: string): string {
  if (!existsSync(filePath)) return '';
  return readFileSync(filePath, 'utf8').trim();
}

export function writeSession(filePath: string, session: string, logger: Logger): void {
  if (session.length < 10) throw new AppError('Refusing to save an empty Telegram session.');
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, session, { encoding: 'utf8', mode: 0o600 });
  restrictFile(temporary, logger);
  renameSync(temporary, filePath);
  restrictFile(filePath, logger);
}
