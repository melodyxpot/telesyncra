import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';

export function ensurePrivateDir(dir: string, logger: Logger): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    logger.warn({ event: 'chmod_failed', target: 'directory' }, 'could not chmod the data directory');
  }
  if (process.platform === 'win32') {
    restrictWindows(dir, `${windowsPrincipal()}:(OI)(CI)F`, logger);
  }
}

export function restrictFile(filePath: string, logger: Logger): void {
  try {
    chmodSync(filePath, 0o600);
  } catch {
    logger.warn({ event: 'chmod_failed', target: 'file' }, 'could not chmod a private file');
  }
  if (process.platform === 'win32') {
    restrictWindows(filePath, `${windowsPrincipal()}:(F)`, logger);
  }
}

export function acquireProcessLock(lockPath: string, logger: Logger): () => void {
  ensurePrivateDir(path.dirname(lockPath), logger);
  if (existsSync(lockPath)) {
    const existing = readFileSync(lockPath, 'utf8').trim();
    const pid = Number(existing);
    if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) {
      throw new AppError(
        `Telesyncra is already running (pid ${pid}). Stop that process before starting another copy.`,
      );
    }
    unlinkSync(lockPath);
  }
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (code === 'EEXIST') {
      throw new AppError('Telesyncra is already running. Stop the other copy before starting again.');
    }
    throw error;
  }
  writeSync(fd, String(process.pid));
  closeSync(fd);
  restrictFile(lockPath, logger);
  return () => {
    try {
      unlinkSync(lockPath);
    } catch {
      // The lock is only a guard. Shutdown should still finish if it is already gone.
    }
  };
}

function restrictWindows(target: string, grant: string, logger: Logger): void {
  const result = spawnSync('icacls', [target, '/inheritance:r', '/grant:r', grant], {
    windowsHide: true,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    logger.warn({ event: 'acl_failed' }, 'could not restrict the Windows ACL; protect this file manually');
  }
}

function windowsPrincipal(): string {
  const info = userInfo();
  const domain = process.env.USERDOMAIN;
  if (domain && info.username && !info.username.includes('\\')) return `${domain}\\${info.username}`;
  return info.username;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    return code === 'EPERM';
  }
}
