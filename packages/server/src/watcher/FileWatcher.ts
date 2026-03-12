import * as fs from "node:fs";
import * as path from "node:path";
import { getLogger } from "../logging/logger.js";
import type {
  EventBus,
  FileChangeEvent,
  FileChangeType,
  WatchProvider,
} from "./EventBus.js";

export interface FileWatcherOptions {
  /** Directory to watch (e.g., ~/.claude) */
  watchDir: string;
  /** Provider that owns this directory */
  provider: WatchProvider;
  /** EventBus to emit events to */
  eventBus: EventBus;
  /** Debounce delay in ms (default: 200) */
  debounceMs?: number;
  /**
   * Optional periodic full-tree rescan interval (ms).
   * Useful on platforms where fs.watch may miss deep file writes.
   */
  periodicRescanMs?: number;
  /**
   * Optional fallback full-tree rescan interval (ms) used when native fs.watch
   * is unavailable or starts failing (for example EMFILE / ENOSPC).
   */
  fallbackRescanMs?: number;
  /** Optional watch factory for testing. Defaults to node:fs.watch */
  watchFactory?: typeof fs.watch;
  /** Disable native fs.watch and use rescan-only mode instead. */
  disableNativeWatch?: boolean;
}

export class FileWatcher {
  private watchDir: string;
  private provider: WatchProvider;
  private eventBus: EventBus;
  private debounceMs: number;
  private periodicRescanMs: number;
  private fallbackRescanMs: number;
  private watchFactory: typeof fs.watch;
  private disableNativeWatch: boolean;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private rescanTimer: NodeJS.Timeout | null = null;
  private rescanInProgress = false;
  private periodicRescanTimer: NodeJS.Timeout | null = null;
  private activeRescanIntervalMs = 0;
  private activeRescanMode: "configured" | "fallback" | null = null;
  private knownFiles: Set<string> = new Set();
  private knownFileMtimes: Map<string, number> = new Map();

  constructor(options: FileWatcherOptions) {
    this.watchDir = options.watchDir;
    this.provider = options.provider;
    this.eventBus = options.eventBus;
    this.debounceMs = options.debounceMs ?? 200;
    this.periodicRescanMs = options.periodicRescanMs ?? 0;
    this.fallbackRescanMs = options.fallbackRescanMs ?? 5000;
    this.watchFactory = options.watchFactory ?? fs.watch;
    this.disableNativeWatch =
      options.disableNativeWatch ??
      process.env.FILE_WATCH_DISABLE_NATIVE === "true";
  }

  /**
   * Start watching for file changes.
   */
  start(): void {
    if (this.watcher) {
      return; // Already watching
    }

    // Build initial file list for detecting create vs modify
    this.scanExistingFiles();

    if (this.disableNativeWatch) {
      getLogger().info(
        `[FileWatcher] Native fs.watch disabled provider=${this.provider} path=${this.watchDir}`,
      );
      if (this.periodicRescanMs <= 0) {
        this.enableFallbackRescan(
          this.fallbackRescanMs,
          "native watcher disabled by configuration",
        );
      }
    } else if (!this.startNativeWatcher()) {
      this.enableFallbackRescan(
        this.fallbackRescanMs,
        "native watcher unavailable at startup",
      );
    }

    if (this.periodicRescanMs > 0) {
      this.ensureRescanTimer(this.periodicRescanMs, "configured");
    }
  }

  /**
   * Stop watching for file changes.
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = null;
    }
    if (this.periodicRescanTimer) {
      clearInterval(this.periodicRescanTimer);
      this.periodicRescanTimer = null;
    }
    this.activeRescanIntervalMs = 0;
    this.activeRescanMode = null;
    this.knownFiles.clear();
    this.knownFileMtimes.clear();

    getLogger().info("[FileWatcher] Stopped");
  }

  /**
   * Check if watcher is active.
   */
  get isWatching(): boolean {
    return this.watcher !== null || this.periodicRescanTimer !== null;
  }

  private startNativeWatcher(): boolean {
    try {
      this.watcher = this.watchFactory(
        this.watchDir,
        { recursive: true },
        (eventType, filename) => {
          if (!filename) {
            getLogger().debug(
              `[FileWatcher] Raw event provider=${this.provider} type=${eventType} file=<null> path=${this.watchDir}`,
            );
            this.scheduleRescan();
            return;
          }
          this.handleFileEvent(eventType, filename);
        },
      );

      this.watcher.on("error", (error) => {
        this.handleWatcherError(error);
      });

      getLogger().info(
        `[FileWatcher] Watching provider=${this.provider} path=${this.watchDir}`,
      );

      return true;
    } catch (error) {
      this.logWatcherError("Failed to start", error);
      return false;
    }
  }

  private handleWatcherError(error: unknown): void {
    this.logWatcherError("Error", error);

    if (this.isRecoverableWatchError(error)) {
      this.closeNativeWatcher();
      this.enableFallbackRescan(
        this.fallbackRescanMs,
        "native watcher hit descriptor limit",
      );
    }
  }

  private logWatcherError(prefix: string, error: unknown): void {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    getLogger().warn(
      `[FileWatcher] ${prefix} provider=${this.provider} path=${this.watchDir} error=${message}`,
    );
  }

  private isRecoverableWatchError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }

    const code = "code" in error ? error.code : undefined;
    return code === "EMFILE" || code === "ENOSPC";
  }

  private closeNativeWatcher(): void {
    if (!this.watcher) {
      return;
    }

    try {
      this.watcher.close();
    } catch {
      // Ignore close errors during degraded-mode transition.
    }
    this.watcher = null;
  }

  private enableFallbackRescan(intervalMs: number, reason: string): void {
    if (intervalMs <= 0) {
      getLogger().warn(
        `[FileWatcher] Fallback rescan disabled provider=${this.provider} path=${this.watchDir} reason=${reason}`,
      );
      return;
    }

    this.ensureRescanTimer(intervalMs, "fallback");
    getLogger().warn(
      `[FileWatcher] Fallback rescan enabled provider=${this.provider} path=${this.watchDir} intervalMs=${intervalMs} reason=${reason}`,
    );
  }

  private ensureRescanTimer(
    intervalMs: number,
    mode: "configured" | "fallback",
  ): void {
    if (
      this.periodicRescanTimer &&
      this.activeRescanIntervalMs === intervalMs &&
      this.activeRescanMode === mode
    ) {
      return;
    }

    if (this.periodicRescanTimer) {
      clearInterval(this.periodicRescanTimer);
    }

    this.periodicRescanTimer = setInterval(() => {
      this.rescanAndEmit();
    }, intervalMs);
    this.activeRescanIntervalMs = intervalMs;
    this.activeRescanMode = mode;

    const label =
      mode === "configured"
        ? "Periodic rescan enabled"
        : "Fallback rescan active";
    getLogger().info(
      `[FileWatcher] ${label} provider=${this.provider} intervalMs=${intervalMs} path=${this.watchDir}`,
    );
  }

  private scanExistingFiles(): void {
    this.knownFiles.clear();
    this.knownFileMtimes.clear();
    this.scanDir(this.watchDir, this.knownFileMtimes);
    this.knownFiles = new Set(this.knownFileMtimes.keys());
  }

  private scanDir(dir: string, index: Map<string, number>): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          this.scanDir(fullPath, index);
        } else {
          try {
            const stats = fs.statSync(fullPath);
            index.set(fullPath, stats.mtimeMs);
          } catch {
            // File may have disappeared between readdir/stat
          }
        }
      }
    } catch {
      // Ignore errors (e.g., permission denied)
    }
  }

  private handleFileEvent(eventType: string, filename: string): void {
    const fullPath = path.join(this.watchDir, filename);

    getLogger().debug(
      `[FileWatcher] Raw event provider=${this.provider} type=${eventType} file=${filename} path=${fullPath}`,
    );

    // Debounce per-file
    const existingTimer = this.debounceTimers.get(fullPath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(fullPath);
      this.emitEvent(fullPath, eventType);
    }, this.debounceMs);

    this.debounceTimers.set(fullPath, timer);
  }

  private emitEvent(fullPath: string, _eventType: string): void {
    // Determine change type
    let changeType: FileChangeType;
    const fileExists = fs.existsSync(fullPath);

    if (!fileExists) {
      if (this.knownFiles.has(fullPath)) {
        changeType = "delete";
        this.knownFiles.delete(fullPath);
        this.knownFileMtimes.delete(fullPath);
      } else {
        // File never existed from our POV, skip
        return;
      }
    } else {
      let mtimeMs = Date.now();
      try {
        mtimeMs = fs.statSync(fullPath).mtimeMs;
      } catch {
        // File disappeared between existsSync and statSync
        return;
      }

      if (this.knownFiles.has(fullPath)) {
        const previousMtime = this.knownFileMtimes.get(fullPath);
        if (previousMtime === mtimeMs) {
          // No meaningful change; skip duplicate callback.
          return;
        }
        changeType = "modify";
      } else {
        changeType = "create";
        this.knownFiles.add(fullPath);
      }
      this.knownFileMtimes.set(fullPath, mtimeMs);
    }

    const relativePath = path.relative(this.watchDir, fullPath);

    const event: FileChangeEvent = {
      type: "file-change",
      provider: this.provider,
      path: fullPath,
      relativePath,
      changeType,
      timestamp: new Date().toISOString(),
      fileType: this.parseFileType(relativePath),
    };

    getLogger().debug(
      `[FileWatcher] Emitting file-change provider=${event.provider} changeType=${event.changeType} fileType=${event.fileType} relativePath=${event.relativePath}`,
    );

    this.eventBus.emit(event);
  }

  /**
   * When fs.watch provides no filename (common on macOS under load),
   * rescan the tree and synthesize events from mtime/delete deltas.
   */
  private scheduleRescan(): void {
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
    }

    getLogger().debug(
      `[FileWatcher] Scheduling fallback rescan provider=${this.provider}`,
    );

    this.rescanTimer = setTimeout(
      () => {
        this.rescanTimer = null;
        this.rescanAndEmit();
      },
      Math.max(this.debounceMs * 2, 400),
    );
  }

  private rescanAndEmit(): void {
    if (this.rescanInProgress) {
      return;
    }
    this.rescanInProgress = true;

    try {
      getLogger().debug(
        `[FileWatcher] Running fallback rescan provider=${this.provider}`,
      );
      const current = new Map<string, number>();
      this.scanDir(this.watchDir, current);

      // Create/modify events
      for (const [fullPath, mtimeMs] of current.entries()) {
        const prevMtime = this.knownFileMtimes.get(fullPath);
        if (prevMtime === undefined || prevMtime !== mtimeMs) {
          this.emitEvent(fullPath, "change");
        }
      }

      // Delete events
      for (const fullPath of this.knownFileMtimes.keys()) {
        if (!current.has(fullPath)) {
          this.emitEvent(fullPath, "rename");
        }
      }

      this.knownFileMtimes = current;
      this.knownFiles = new Set(current.keys());
    } finally {
      this.rescanInProgress = false;
    }
  }

  private parseFileType(relativePath: string): FileChangeEvent["fileType"] {
    switch (this.provider) {
      case "claude":
        return this.parseClaudeFileType(relativePath);
      case "gemini":
        return this.parseGeminiFileType(relativePath);
      case "codex":
        return this.parseCodexFileType(relativePath);
    }
  }

  private parseClaudeFileType(
    relativePath: string,
  ): FileChangeEvent["fileType"] {
    // Watching ~/.claude/projects - relativePath is {hash}/{session}.jsonl
    if (relativePath.endsWith(".jsonl")) {
      if (path.basename(relativePath).startsWith("agent-")) {
        return "agent-session";
      }
      return "session";
    }
    return "other";
  }

  private parseGeminiFileType(
    relativePath: string,
  ): FileChangeEvent["fileType"] {
    // Watching ~/.gemini/tmp - relativePath is {hash}/chats/session-*.json
    // On Windows, path.relative() returns backslashes
    if (
      (relativePath.includes("/chats/") ||
        relativePath.includes("\\chats\\")) &&
      relativePath.endsWith(".json")
    ) {
      return "session";
    }
    return "other";
  }

  private parseCodexFileType(
    relativePath: string,
  ): FileChangeEvent["fileType"] {
    // Watching ~/.codex/sessions - relativePath is {year}/{month}/{day}/rollout-*.jsonl
    if (relativePath.endsWith(".jsonl")) {
      return "session";
    }
    return "other";
  }
}
