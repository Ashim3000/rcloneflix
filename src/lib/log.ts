/**
 * Frontend logging bridge.
 *
 * Forwards to the Rust logger so frontend and backend events land in one file
 * in real time order. Also installs global handlers, because the failures that
 * matter most are the ones nobody wrote a try/catch for.
 */

import { invoke } from "@tauri-apps/api/core";

type Level = "debug" | "info" | "warn" | "error";

function send(level: Level, target: string, message: string) {
  invoke("log_message", { level, target, message }).catch(() => {
    // Logging must never break the caller.
  });
}

function format(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ""}`;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

export const log = {
  debug: (target: string, ...args: unknown[]) => send("debug", target, format(args)),
  info: (target: string, ...args: unknown[]) => send("info", target, format(args)),
  warn: (target: string, ...args: unknown[]) => send("warn", target, format(args)),
  error: (target: string, ...args: unknown[]) => send("error", target, format(args)),
};

/** Mirror console output and unhandled failures into the log file. */
export function installGlobalLogging() {
  const originalError = console.error;
  const originalWarn = console.warn;

  console.error = (...args: unknown[]) => {
    send("error", "console", format(args));
    originalError(...args);
  };
  console.warn = (...args: unknown[]) => {
    send("warn", "console", format(args));
    originalWarn(...args);
  };

  window.addEventListener("error", (e) => {
    send("error", "window", `${e.message} (${e.filename}:${e.lineno}:${e.colno})`);
  });

  window.addEventListener("unhandledrejection", (e) => {
    send("error", "unhandled-rejection", format([e.reason]));
  });
}

export async function getLogPath(): Promise<string> {
  return invoke<string>("get_log_path");
}

export async function readLogTail(lines = 400): Promise<string> {
  return invoke<string>("read_log_tail", { lines });
}
