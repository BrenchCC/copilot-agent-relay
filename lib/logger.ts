export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "debug",
  [LogLevel.INFO]: "info",
  [LogLevel.WARN]: "warn",
  [LogLevel.ERROR]: "error",
};

export function parseLogLevel(s: string): LogLevel {
  switch (s.toLowerCase()) {
    case "debug": return LogLevel.DEBUG;
    case "info": return LogLevel.INFO;
    case "warn": return LogLevel.WARN;
    case "error": return LogLevel.ERROR;
    default: return LogLevel.INFO;
  }
}

export function createLogger(level: LogLevel): Logger {
  function emit(lvl: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (lvl < level) return;
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      level: LEVEL_NAMES[lvl],
      msg,
      ...data,
    });
    const out = lvl >= LogLevel.ERROR ? process.stderr : process.stdout;
    out.write(entry + "\n");
  }

  return {
    debug: (msg, data) => emit(LogLevel.DEBUG, msg, data),
    info: (msg, data) => emit(LogLevel.INFO, msg, data),
    warn: (msg, data) => emit(LogLevel.WARN, msg, data),
    error: (msg, data) => emit(LogLevel.ERROR, msg, data),
  };
}
