import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = {
  LOG_DIR: process.env.LOG_DIR,
  LOG_FILE: process.env.LOG_FILE,
  LOG_TO_FILE: process.env.LOG_TO_FILE,
};

describe("logger default config", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.LOG_DIR = undefined;
    process.env.LOG_FILE = undefined;
    process.env.LOG_TO_FILE = undefined;
  });

  afterEach(() => {
    vi.resetModules();
    if (ORIGINAL_ENV.LOG_DIR === undefined) {
      process.env.LOG_DIR = undefined;
    } else {
      process.env.LOG_DIR = ORIGINAL_ENV.LOG_DIR;
    }
    if (ORIGINAL_ENV.LOG_FILE === undefined) {
      process.env.LOG_FILE = undefined;
    } else {
      process.env.LOG_FILE = ORIGINAL_ENV.LOG_FILE;
    }
    if (ORIGINAL_ENV.LOG_TO_FILE === undefined) {
      process.env.LOG_TO_FILE = undefined;
    } else {
      process.env.LOG_TO_FILE = ORIGINAL_ENV.LOG_TO_FILE;
    }
  });

  it("respects LOG_DIR and LOG_FILE for auto-initialized logger state", async () => {
    process.env.LOG_DIR = "/tmp/yepanywhere-test-logs";
    process.env.LOG_FILE = "custom.log";

    const loggerModule = await import("../../src/logging/logger.js");

    expect(loggerModule.getLogFilePath()).toBe(
      path.join("/tmp/yepanywhere-test-logs", "custom.log"),
    );
  });

  it("respects LOG_TO_FILE=false in the default config path", async () => {
    const logDir = path.join(
      os.tmpdir(),
      `yepanywhere-logger-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    process.env.LOG_DIR = logDir;
    process.env.LOG_TO_FILE = "false";

    const loggerModule = await import("../../src/logging/logger.js");
    const logger = loggerModule.initLogger();

    expect(loggerModule.getLogDir()).toBe(logDir);
    expect(fs.existsSync(logDir)).toBe(false);
    expect(logger).toBeDefined();
  });
});
