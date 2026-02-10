import pino from 'pino';
import pinoPretty from 'pino-pretty';
import fs from 'fs';
import path from 'path';

let _logger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (_logger) return _logger;

  const level = process.env.LOG_LEVEL ?? 'info';
  const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
  const logFile = process.env.LOG_FILE;

  if (isTest) {
    _logger = pino({
      name: 'trade-watcher',
      level: 'silent',
      timestamp: pino.stdTimeFunctions.isoTime,
    });
    return _logger;
  }

  // Build stream destinations
  const streams: pino.StreamEntry[] = [];

  // Console: pretty-printed, writes directly to stdout
  const prettyConsole = pinoPretty({
    colorize: process.env.NODE_ENV !== 'production',
    translateTime: 'ISO',
    destination: 1, // fd 1 = stdout — avoids double-write issues
  });
  streams.push({ stream: prettyConsole });

  // Optional: tee to a log file (same content, no colors)
  if (logFile) {
    const dir = path.dirname(logFile);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const prettyFile = pinoPretty({
      colorize: false,
      translateTime: 'ISO',
      destination: logFile,
      append: true,
      mkdir: true,
    });
    streams.push({ stream: prettyFile });
  }

  _logger = pino(
    {
      name: 'trade-watcher',
      level,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams)
  );

  return _logger;
}

export function createChildLogger(bindings: Record<string, unknown>): pino.Logger {
  return getLogger().child(bindings);
}
