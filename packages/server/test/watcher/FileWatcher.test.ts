import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus, type FileChangeEvent } from "../../src/watcher/EventBus.js";
import { FileWatcher } from "../../src/watcher/FileWatcher.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEvent(
  events: FileChangeEvent[],
  timeoutMs = 1000,
): Promise<FileChangeEvent> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const first = events[0];
    if (first) {
      return first;
    }
    await delay(25);
  }

  throw new Error("Timed out waiting for file-change event");
}

describe("FileWatcher", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("falls back to rescans when fs.watch fails at startup with EMFILE", async () => {
    const root = await mkdtemp(join(tmpdir(), "file-watcher-start-"));
    tempDirs.push(root);

    const watchError = Object.assign(new Error("too many open files"), {
      code: "EMFILE",
    });
    const eventBus = new EventBus();
    const events: FileChangeEvent[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "file-change") {
        events.push(event);
      }
    });

    const watcher = new FileWatcher({
      watchDir: root,
      provider: "claude",
      eventBus,
      debounceMs: 10,
      fallbackRescanMs: 50,
      watchFactory: () => {
        throw watchError;
      },
    });

    watcher.start();
    await writeFile(join(root, "session-1.jsonl"), "{}\n");

    const event = await waitForEvent(events);
    expect(event.changeType).toBe("create");
    expect(event.fileType).toBe("session");
    expect(event.relativePath).toBe("session-1.jsonl");
    expect(watcher.isWatching).toBe(true);

    watcher.stop();
    unsubscribe();
  });

  it("falls back to rescans after runtime EMFILE errors from fs.watch", async () => {
    const root = await mkdtemp(join(tmpdir(), "file-watcher-runtime-"));
    tempDirs.push(root);

    const fakeWatcher = new EventEmitter() as EventEmitter & {
      close: ReturnType<typeof vi.fn>;
    };
    fakeWatcher.close = vi.fn();

    const eventBus = new EventBus();
    const events: FileChangeEvent[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "file-change") {
        events.push(event);
      }
    });

    const watcher = new FileWatcher({
      watchDir: root,
      provider: "codex",
      eventBus,
      debounceMs: 10,
      fallbackRescanMs: 50,
      watchFactory: () => fakeWatcher as unknown as FSWatcher,
    });

    watcher.start();
    fakeWatcher.emit(
      "error",
      Object.assign(new Error("too many open files"), { code: "EMFILE" }),
    );

    await writeFile(join(root, "rollout-test.jsonl"), "{}\n");

    const event = await waitForEvent(events);
    expect(event.changeType).toBe("create");
    expect(event.fileType).toBe("session");
    expect(event.relativePath).toBe("rollout-test.jsonl");
    expect(fakeWatcher.close).toHaveBeenCalledTimes(1);

    watcher.stop();
    unsubscribe();
  });
});
