/**
 * The log file the server owns, and what keeps it from filling the disk.
 *
 * Rotation by size rather than by date: what matters is the space it takes, and
 * a quiet week should not cost a file. Nothing in here is allowed to throw —
 * a logger that dies takes the process with it during the very incident the log
 * exists to explain.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Config } from '../config.js';
import type { Logger } from '../types.js';

type Level = 'INFO' | 'WARN' | 'ERROR';

function stamp(level: Level, message: string): string {
  return `${new Date().toISOString()}  ${level.padEnd(5)}  ${message}\n`;
}

export function createLogger(options: Config['logging']): Logger {
  const { file, maxBytes, keep } = options;

  // Started by hand, or with logging deliberately switched off: the terminal is
  // the log. Warnings and errors go to stderr so a supervisor can separate them.
  if (!file) {
    return {
      info: (message) => void process.stdout.write(stamp('INFO', message)),
      warn: (message) => void process.stderr.write(stamp('WARN', message)),
      error: (message) => void process.stderr.write(stamp('ERROR', message)),
      close: () => {},
    };
  }

  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    // Falling through to the write below, which will fail the same way and be
    // swallowed there. Refusing to boot over a log directory would be worse.
  }

  /**
   * Shuffle the old files along: .2 becomes .3, .1 becomes .2, the live one
   * becomes .1. Walked from the oldest backwards so nothing is overwritten
   * before it has been moved.
   */
  function rotate(): void {
    try {
      const oldest = `${file}.${keep}`;
      if (existsSync(oldest)) rmSync(oldest, { force: true });
      for (let index = keep - 1; index >= 1; index -= 1) {
        const from = `${file}.${index}`;
        if (existsSync(from)) renameSync(from, `${file}.${index + 1}`);
      }
      renameSync(file, `${file}.1`);
    } catch {
      // A rotation that fails must not take the logging with it.
    }
  }

  function write(level: Level, message: string): void {
    const line = stamp(level, message);
    // Echoed as well, so running the server by hand still shows what happens.
    if (level === 'INFO') process.stdout.write(line);
    else process.stderr.write(line);
    try {
      if (existsSync(file) && statSync(file).size + line.length > maxBytes) rotate();
      appendFileSync(file, line);
    } catch {
      // Losing a line is survivable.
    }
  }

  return {
    info: (message) => write('INFO', message),
    warn: (message) => write('WARN', message),
    error: (message) => write('ERROR', message),
    // appendFileSync opens and closes per line, so there is no handle to give
    // back. close() exists for the shutdown path to call unconditionally.
    close: () => {},
  };
}
