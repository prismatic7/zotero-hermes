/**
 * Shared write path for every Zotero mutation the plugin performs.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this helper, each manager invented its own mutation path: some built
 * an approval change inline, some logged to the audit log, some did neither,
 * and the approval/audit metadata differed per call site. With the plugin about
 * to gain bulk operations and (later) an MCP tool surface, that inconsistency
 * becomes a safety problem — a write path that forgets its approval gate is an
 * unsupervised mutation of the user's library.
 *
 * So: all mutations go through `runWrite`. It enforces three things in one
 * place, in this order:
 *
 *   1. APPROVE  — the user sees a human-readable diff and accepts it.
 *   2. APPLY    — the caller's `apply()` runs only if approval succeeded.
 *   3. RECORD   — the outcome is written to the audit log either way, so a
 *                 rejected mutation leaves a trace too.
 *
 * FLEET INVARIANT: this helper never erases. `trashItems` moves items to the
 * trash; permanent erasure is the operator's explicit call, made outside the
 * plugin. Do not add an `eraseTx` path here.
 */

import type { PendingFileChange } from "../modules/hermes/types";

export interface WriteResult {
  status: "success" | "rejected" | "failed";
  /** Populated when status is `failed`. */
  error?: string;
}

export interface RunWriteOptions<T> {
  /** Action name recorded in the audit log, e.g. `Update metadata`. */
  action: string;
  /** Target description shown to the user and recorded, e.g. the item title. */
  target: string;
  /** Diff lines shown in the approval dialog. */
  changes: string[];
  /** Approval-dialog verb. Library mutations use `modify`; new items `create`. */
  changeAction?: PendingFileChange["action"];
  /** Extra structured audit metadata. */
  metadata?: Record<string, unknown>;
  /**
   * When true, apply without prompting. Reserved for non-destructive internal
   * bookkeeping; user-visible library mutations must leave this false.
   */
  skipApproval?: boolean;
  /** The mutation. Only called once approved. */
  apply: () => Promise<T>;
}

/**
 * Minimal shape of the pieces `runWrite` needs. Declared structurally rather
 * than importing `Addon` so tests can pass a light mock.
 */
export interface WriteContext {
  approvalDialog?: {
    addPendingChange(change: PendingFileChange): Promise<boolean>;
  } | null;
  auditLog?: {
    record(
      action: "file_change" | "permission" | "tool_call",
      details: string,
      status: "success" | "failure" | "blocked" | "pending",
      metadata?: Record<string, unknown>,
    ): void;
  } | null;
  log?: (message: string, ...data: unknown[]) => void;
}

let changeCounter = 0;

/** Monotonic id so two identical changes in the same millisecond never collide. */
function nextChangeId(): string {
  changeCounter += 1;
  return `write-${Date.now()}-${changeCounter}`;
}

/** Render the preview lines into the diff text shown in the approval dialog. */
export function formatDiff(changes: string[]): string {
  const lines = changes.filter((c) => c.trim().length > 0);
  if (lines.length === 0) return "(no changes described)";
  return lines.join("\n");
}

/**
 * Run a Zotero mutation under the approval gate, then record the outcome.
 *
 * Never throws for a rejected or failed mutation — returns the outcome so the
 * caller can surface a user-facing message (fail visibly, never silently).
 *
 * Note: `ApprovalDialog.addPendingChange` records its own `permission` audit
 * entry, so a rejection is double-covered (permission + file_change). That
 * mirrors the existing call-site convention and is deliberate — the two entries
 * answer different questions ("was it allowed?" vs "what happened?").
 */
export async function runWrite<T>(
  ctx: WriteContext,
  opts: RunWriteOptions<T>,
): Promise<WriteResult & { value?: T }> {
  const { action, target, changes, metadata, apply } = opts;
  const diff = formatDiff(changes);

  let approved = true;
  if (!opts.skipApproval && ctx.approvalDialog) {
    try {
      approved = await ctx.approvalDialog.addPendingChange({
        action: opts.changeAction ?? "modify",
        id: nextChangeId(),
        newContent: diff,
        path: `${action} — ${target}`,
        status: "pending",
        timestamp: Date.now(),
      });
    } catch (error) {
      // An approval-dialog failure must not silently permit the write.
      ctx.log?.(
        `[write] Approval prompt failed, refusing mutation: ${(error as Error).message}`,
      );
      return { status: "failed", error: (error as Error).message };
    }
  }

  if (!approved) {
    ctx.auditLog?.record(
      "permission",
      `${action} for "${target}" rejected by user`,
      "blocked",
      metadata,
    );
    return { status: "rejected" };
  }

  try {
    const value = await apply();
    ctx.auditLog?.record(
      "file_change",
      `${action} for "${target}"`,
      "success",
      metadata,
    );
    return { status: "success", value };
  } catch (error) {
    const message = (error as Error).message;
    ctx.auditLog?.record(
      "file_change",
      `${action} for "${target}" failed: ${message}`,
      "failure",
      metadata,
    );
    ctx.log?.(`[write] ${action} failed: ${message}`);
    return { status: "failed", error: message };
  }
}

/**
 * Move items to the trash — the plugin's only destructive operation.
 *
 * Never erases. `Zotero.Items.trashTx` (`data/items.js:1138`) is transactional
 * and reversible from the Zotero UI; an `eraseTx` is not, and the fleet
 * invariant reserves that for the operator.
 */
export async function trashItems(
  items: Zotero.Item[],
): Promise<{ trashed: number }> {
  const ids = items
    .map((i) => i.id)
    .filter((id): id is number => typeof id === "number" && id > 0);
  if (ids.length === 0) return { trashed: 0 };
  await Zotero.Items.trashTx(ids);
  return { trashed: ids.length };
}
