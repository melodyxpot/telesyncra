import './polyfill/local-storage.js';
import dotenv from 'dotenv';
import { main } from './app.js';
import { AppError } from './errors.js';

dotenv.config();

main().catch((error: unknown) => {
  if (error instanceof AppError) process.stderr.write(`${error.message}\n`);
  else process.stderr.write('Telesyncra stopped because of an unexpected error.\n');
  process.exitCode = 1;
});
