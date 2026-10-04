/**
 * Persistent audit log for all agent actions.
 *
 * Mirrors obsidian-hermes/src/AuditLog.ts
 *
 * DESIGN DECISIONS:
 * - Entries are queued in memory and flushed in batches (500ms delay) to avoid
 *   excessive I/O on every tool call during streaming responses.
 * - The log file is a JSON array stored in Zotero's profile directory.
 * - Entries are trimmed to max 1000 to prevent unbounded file growth.
 * - Failed flushes are logged to console but do not throw — audit logging
 *   should never break the user experience.
 */

import { ensureHermesDir, getDataDir, getProfileDir } from "./zoteroPaths";

export interface AuditEntry {
  action:
    | "connection"
    | "error"
    | "file_change"
    | "permission"
    | "terminal"
    | "tool_call";
  details: string;
  metadata?: Record<string, unknown>;
  status: "blocked" | "failure" | "pending" | "success";
  timestamp: number;
}

export class AuditLog {
  private readonly FLUSH_DELAY_MS = 500;
  private flushTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly maxEntries = 1000;
  private readonly addon: any;
  private writeQueue: AuditEntry[] = [];

  private get logFilePath(): string {
    try {
      const dir = getProfileDir() || getDataDir();
      if (!dir) return "";
      return ensureHermesDir(dir, "", this.addon) + "/audit-log.json";
    } catch {
      return "";
    }
  }

  constructor(addon: any) {
    this.addon = addon;
  }

  /**
   * Record an audit entry.
   */
  public record(
    action: AuditEntry["action"],
    details: string,
    status: AuditEntry["status"] = "success",
    metadata?: Record<string, unknown>,
  ): void {
    this.writeQueue.push({
      action,
      details,
      metadata,
      status,
      timestamp: Date.now(),
    });
    this.scheduleFlush();
  }

  /**
   * Flush queued entries to the log file.
   */
  public async flush(): Promise<void> {
    if (this.writeQueue.length === 0) return;

    const entries = [...this.writeQueue];
    this.writeQueue = [];

    const filePath = this.logFilePath;
    if (!filePath) {
      this.addon.log("[AuditLog] No profile directory available");
      return;
    }

    try {
      let existing: AuditEntry[] = [];

      // Read existing entries
      const file = Zotero.File.pathToFile(filePath);
      if (file.exists()) {
        try {
          const content = Zotero.File.getContents(file) as string;
          existing = JSON.parse(content) as AuditEntry[];
        } catch {
          existing = [];
        }
      }

      // Append new entries, trim to max
      const all = [...existing, ...entries];
      const trimmed =
        all.length > this.maxEntries
          ? all.slice(all.length - this.maxEntries)
          : all;

      // Write back
      Zotero.File.putContents(file, JSON.stringify(trimmed, null, 2));
    } catch (error) {
      // Don't throw — audit logging should never break UX
      this.addon.log(`[AuditLog] Flush failed: ${(error as Error).message}`);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimeout === null) {
      this.flushTimeout = setTimeout(() => {
        this.flushTimeout = null;
        void this.flush();
      }, this.FLUSH_DELAY_MS);
    }
  }
}
