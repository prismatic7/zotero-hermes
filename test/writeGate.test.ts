import { expect } from "chai";
import {
  formatDiff,
  runWrite,
  trashItems,
  type WriteContext,
} from "../src/utils/writeGate";
import type { PendingFileChange } from "../src/modules/hermes/types";

/**
 * A recording context: captures every approval request and audit entry so the
 * tests can assert the ordering and content of the write path.
 */
function makeCtx(opts: { approve?: boolean; throwOnApprove?: boolean } = {}) {
  const approvals: PendingFileChange[] = [];
  const audits: Array<{
    action: string;
    details: string;
    status: string;
    metadata?: Record<string, unknown>;
  }> = [];
  const logs: string[] = [];

  const ctx: WriteContext = {
    approvalDialog: {
      addPendingChange: async (change) => {
        approvals.push(change);
        if (opts.throwOnApprove) throw new Error("dialog exploded");
        return opts.approve ?? true;
      },
    },
    auditLog: {
      record: (action, details, status, metadata) => {
        audits.push({ action, details, status, metadata });
      },
    },
    log: (message) => {
      logs.push(message);
    },
  };

  return { ctx, approvals, audits, logs };
}

describe("writeGate", function () {
  describe("formatDiff", function () {
    it("joins non-empty change lines", function () {
      expect(formatDiff(["a", "", "  ", "b"])).to.equal("a\nb");
    });

    it("never returns an empty string", function () {
      expect(formatDiff([])).to.equal("(no changes described)");
      expect(formatDiff(["   "])).to.equal("(no changes described)");
    });
  });

  describe("runWrite approval ordering", function () {
    it("does not apply the mutation when the user rejects", async function () {
      const { ctx, approvals, audits } = makeCtx({ approve: false });
      let applied = false;

      const result = await runWrite(ctx, {
        action: "Update metadata",
        target: "Some Paper",
        changes: ["DOI: (none) → 10.1/abc"],
        apply: async () => {
          applied = true;
          return "ok";
        },
      });

      expect(result.status).to.equal("rejected");
      expect(applied).to.equal(false);
      expect(approvals).to.have.length(1);
      expect(audits[0].status).to.equal("blocked");
    });

    it("applies the mutation and records success when approved", async function () {
      const { ctx, audits } = makeCtx({ approve: true });

      const result = await runWrite(ctx, {
        action: "Update metadata",
        target: "Some Paper",
        changes: ["Year: 2019 → 2020"],
        apply: async () => 42,
      });

      expect(result.status).to.equal("success");
      expect(result.value).to.equal(42);
      expect(audits[0].status).to.equal("success");
      expect(audits[0].action).to.equal("file_change");
    });

    it("passes the diff and a descriptive path to the approval dialog", async function () {
      const { ctx, approvals } = makeCtx({ approve: true });

      await runWrite(ctx, {
        action: "Add tags",
        target: "Some Paper",
        changes: ["+ method/par", "+ theory/affect"],
        apply: async () => undefined,
      });

      expect(approvals[0].newContent).to.equal("+ method/par\n+ theory/affect");
      expect(approvals[0].path).to.equal("Add tags — Some Paper");
      expect(approvals[0].action).to.equal("modify");
      expect(approvals[0].status).to.equal("pending");
    });

    it("honours an explicit changeAction of create", async function () {
      const { ctx, approvals } = makeCtx({ approve: true });

      await runWrite(ctx, {
        action: "Create note",
        target: "Some Paper",
        changes: ["new note"],
        changeAction: "create",
        apply: async () => undefined,
      });

      expect(approvals[0].action).to.equal("create");
    });

    it("refuses the mutation when the approval dialog itself throws", async function () {
      const { ctx, logs } = makeCtx({ throwOnApprove: true });
      let applied = false;

      const result = await runWrite(ctx, {
        action: "Update metadata",
        target: "Some Paper",
        changes: ["x"],
        apply: async () => {
          applied = true;
          return undefined;
        },
      });

      expect(result.status).to.equal("failed");
      expect(applied).to.equal(false);
      expect(logs.join(" ")).to.include("refusing mutation");
    });

    it("records a failure (not a success) when apply throws", async function () {
      const { ctx, audits } = makeCtx({ approve: true });

      const result = await runWrite(ctx, {
        action: "Update metadata",
        target: "Some Paper",
        changes: ["x"],
        apply: async () => {
          throw new Error("saveTx refused");
        },
      });

      expect(result.status).to.equal("failed");
      expect(result.error).to.equal("saveTx refused");
      expect(audits[0].status).to.equal("failure");
    });

    it("skips the prompt entirely when skipApproval is set", async function () {
      const { ctx, approvals } = makeCtx({ approve: false });

      const result = await runWrite(ctx, {
        action: "Internal bookkeeping",
        target: "cache",
        changes: ["y"],
        skipApproval: true,
        apply: async () => "done",
      });

      expect(result.status).to.equal("success");
      expect(approvals).to.have.length(0);
    });

    it("applies without a dialog when no approvalDialog is wired", async function () {
      const audits: Array<{ action: string; status: string }> = [];
      const ctx: WriteContext = {
        approvalDialog: null,
        auditLog: {
          record: (action, _details, status) => {
            audits.push({ action, status });
          },
        },
      };

      const result = await runWrite(ctx, {
        action: "Update metadata",
        target: "Some Paper",
        changes: ["z"],
        apply: async () => undefined,
      });

      expect(result.status).to.equal("success");
      expect(audits[0].status).to.equal("success");
    });
  });

  describe("trashItems", function () {
    let realZotero: any;

    beforeEach(function () {
      realZotero = (globalThis as any).Zotero;
    });

    afterEach(function () {
      (globalThis as any).Zotero = realZotero;
    });

    function stubTrashTx(): number[][] {
      const calls: number[][] = [];
      (globalThis as any).Zotero = {
        ...realZotero,
        Items: {
          ...(realZotero?.Items || {}),
          trashTx: async (ids: number[]) => {
            calls.push(ids);
          },
        },
      };
      return calls;
    }

    it("trashes the valid ids in one transaction", async function () {
      const calls = stubTrashTx();

      const result = await trashItems([
        { id: 1 } as Zotero.Item,
        { id: 2 } as Zotero.Item,
      ]);

      expect(result.trashed).to.equal(2);
      expect(calls).to.deep.equal([[1, 2]]);
    });

    it("filters out ids that are missing or non-positive", async function () {
      const calls = stubTrashTx();

      const result = await trashItems([
        { id: 7 } as Zotero.Item,
        {} as Zotero.Item,
        { id: 0 } as Zotero.Item,
      ]);

      expect(result.trashed).to.equal(1);
      expect(calls).to.deep.equal([[7]]);
    });

    it("does not call trashTx at all when nothing is trashable", async function () {
      const calls = stubTrashTx();

      const result = await trashItems([]);

      expect(result.trashed).to.equal(0);
      expect(calls).to.have.length(0);
    });
  });
});
