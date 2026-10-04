import { expect } from "chai";
import { AnnotationManager } from "../src/modules/hermes/AnnotationManager";
import type Addon from "../src/addon";

function mockAddon(hermes: Record<string, unknown> = {}): Addon {
  return {
    log: () => {},
    data: { hermes },
  } as unknown as Addon;
}

/**
 * Record the order in which annotation properties are assigned.
 *
 * Zotero requires `annotationType` to be set before any other field
 * (`data/item.js:4510`), so the *order* of assignment is part of the contract
 * and has to be assertable, not just the final values.
 */
function mockAnnotationItemClass(assignOrder: string[]) {
  return class MockAnnotationItem {
    public id = 101;
    public key = "ANNOTKEY";
    public parentItemID = 0;
    public libraryID = 1;
    public saved = false;

    constructor(public itemType: string) {}

    private _type = "";
    set annotationType(v: string) {
      assignOrder.push("annotationType");
      this._type = v;
    }
    get annotationType() {
      return this._type;
    }
    set annotationText(v: string) {
      assignOrder.push("annotationText");
      // Real Zotero throws here for types that cannot carry text.
      if (this._type !== "highlight" && this._type !== "underline") {
        throw new Error("annotationText is not valid for this annotation type");
      }
    }
    set annotationComment(_v: string) {
      assignOrder.push("annotationComment");
    }
    set annotationColor(v: string) {
      assignOrder.push("annotationColor");
      if (!/^#[a-f0-9]{6}$/i.test(v)) {
        throw new Error("Invalid annotation colour");
      }
    }
    set annotationPageLabel(_v: string) {
      assignOrder.push("annotationPageLabel");
    }
    set annotationPosition(_v: string) {
      assignOrder.push("annotationPosition");
    }

    async saveTx() {
      this.saved = true;
    }
  };
}

/** A PDF attachment carrying annotations. */
function mockPdfAttachment(annotations: any[] = []) {
  return {
    id: 55,
    key: "PDFKEY",
    libraryID: 1,
    isPDFAttachment: () => true,
    isRegularItem: () => false,
    getDisplayTitle: () => "Schafer - The Soundscape.pdf",
    getAnnotations: () => annotations,
    getNotes: () => annotations.map((a) => a.id),
  };
}

/** A regular parent item whose best attachment is the PDF above. */
function mockParentItem(pdf: any) {
  return {
    id: 42,
    key: "PARENTKEY",
    libraryID: 1,
    isPDFAttachment: () => false,
    isRegularItem: () => true,
    getDisplayTitle: () => "The Soundscape",
    getField: (name: string) => (name === "title" ? "The Soundscape" : ""),
    getBestAttachment: async () => pdf,
  };
}

function mockAnnotation(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    key: "ANNOTKEY",
    isAnnotation: () => true,
    annotationType: "highlight",
    annotationText: "a soundmark",
    annotationComment: "key term",
    annotationColor: "#ffd400",
    annotationPageLabel: "12",
    annotationSortIndex: "00012|000000|0",
    ...overrides,
  };
}

describe("AnnotationManager", function () {
  after(function () {
    if ((globalThis as any).__realZotero) {
      (globalThis as any).Zotero = (globalThis as any).__realZotero;
      delete (globalThis as any).__realZotero;
    }
  });

  function stubZotero(opts: {
    items?: Record<number, any>;
    annotationClass?: any;
    searchIDs?: number[];
    onTrash?: (ids: number[]) => void;
    onCondition?: (field: string, op: string, value: unknown) => void;
  }) {
    const realZotero = (globalThis as any).Zotero;
    if (!(globalThis as any).__realZotero) {
      (globalThis as any).__realZotero = realZotero;
    }
    const items = opts.items ?? {};

    class MockSearch {
      addCondition(field: string, op: string, value: unknown) {
        opts.onCondition?.(field, op, value);
      }
      async search() {
        return opts.searchIDs ?? [];
      }
    }

    (globalThis as any).Zotero = {
      ...realZotero,
      Items: {
        ...(realZotero?.Items || {}),
        getAsync: async (ids: unknown) =>
          Array.isArray(ids)
            ? ids.map((id) => items[id]).filter(Boolean)
            : (items[ids as number] ?? false),
        getByLibraryAndKey: (_lib: number, key: string) =>
          Object.values(items).find((i: any) => i.key === key) ?? false,
        trashTx: async (ids: number[]) => {
          opts.onTrash?.(ids);
        },
      },
      Item:
        opts.annotationClass ??
        class {
          constructor(public itemType: string) {}
        },
      Search: MockSearch,
      Libraries: { userLibraryID: 1 },
    };
  }

  describe("reading annotations", function () {
    it("returns annotations under a PDF attachment, sorted by page", async function () {
      const pdf = mockPdfAttachment([
        mockAnnotation({ id: 102, key: "B", annotationPageLabel: "9" }),
        mockAnnotation({ id: 101, key: "A", annotationPageLabel: "3" }),
      ]);
      const parent = mockParentItem(pdf);
      stubZotero({ items: { 42: parent, 55: pdf } });

      const manager = new AnnotationManager(mockAddon());
      const annotations = await manager.getAnnotations(42);

      expect(annotations).to.have.length(2);
      expect(annotations[0].page).to.equal(3);
      expect(annotations[1].page).to.equal(9);
      expect(annotations[0].text).to.equal("a soundmark");
    });

    it("returns [] when the item has no PDF attachment", async function () {
      const parent = {
        ...mockParentItem(null),
        getBestAttachment: async () => false,
      };
      stubZotero({ items: { 42: parent } });

      const manager = new AnnotationManager(mockAddon());
      expect(await manager.getAnnotations(42)).to.deep.equal([]);
    });

    it("resolves attachment-key lookups for readAnnotation", async function () {
      const ann = mockAnnotation();
      stubZotero({ items: { 101: ann } });

      const manager = new AnnotationManager(mockAddon());
      const read = await manager.readAnnotation("ANNOTKEY");

      expect(read).to.not.be.null;
      expect(read?.id).to.equal("ANNOTKEY");
      expect(read?.comment).to.equal("key term");
    });

    it("returns null for a non-annotation item", async function () {
      const parent = mockParentItem(null);
      stubZotero({ items: { 42: parent } });

      const manager = new AnnotationManager(mockAddon());
      expect(await manager.readAnnotation(42)).to.be.null;
    });
  });

  describe("searching annotations", function () {
    it("uses Zotero's own annotation search conditions", async function () {
      const conditions: Array<[string, string, unknown]> = [];
      const ann = mockAnnotation();
      stubZotero({
        items: { 101: ann },
        searchIDs: [101],
        onCondition: (f, o, v) => conditions.push([f, o, v]),
      });

      const manager = new AnnotationManager(mockAddon());
      await manager.searchAnnotations({ text: "soundmark", type: "highlight" });

      const fields = conditions.map((c) => c[0]);
      expect(fields).to.include("annotationText");
      expect(fields).to.include("annotationType");
      // Verified operators against searchConditions.js:725-795 — `contains`,
      // not `is`, for the text field.
      const textCond = conditions.find((c) => c[0] === "annotationText");
      expect(textCond?.[1]).to.equal("contains");
    });

    it("returns [] instead of throwing when the search fails", async function () {
      const realZotero = (globalThis as any).Zotero;
      if (!(globalThis as any).__realZotero) {
        (globalThis as any).__realZotero = realZotero;
      }
      (globalThis as any).Zotero = {
        ...realZotero,
        Search: class {
          addCondition() {}
          async search() {
            throw new Error("search exploded");
          }
        },
        Libraries: { userLibraryID: 1 },
      };

      const manager = new AnnotationManager(mockAddon());
      expect(await manager.searchAnnotations({ text: "x" })).to.deep.equal([]);
    });
  });

  describe("creating annotations (Zotero field contract)", function () {
    it("sets annotationType before any other property", async function () {
      const assignOrder: string[] = [];
      const pdf = mockPdfAttachment();
      const parent = mockParentItem(pdf);
      const ItemClass = mockAnnotationItemClass(assignOrder);
      stubZotero({
        items: { 42: parent, 55: pdf },
        annotationClass: ItemClass,
      });

      const manager = new AnnotationManager(mockAddon());
      const result = await manager.createAnnotation({
        parentItemID: 42,
        text: "a soundmark",
        comment: "key term",
        page: 12,
        position: '{"pageIndex":12,"rects":[[1,2,3,4]]}',
      });

      expect(result.status).to.equal("success");
      expect(assignOrder[0]).to.equal("annotationType");
    });

    it("REFUSES a text annotation with no position rather than inventing a rect", async function () {
      const assignOrder: string[] = [];
      const pdf = mockPdfAttachment();
      const parent = mockParentItem(pdf);
      stubZotero({
        items: { 42: parent, 55: pdf },
        annotationClass: mockAnnotationItemClass(assignOrder),
      });

      const manager = new AnnotationManager(mockAddon());
      const result = await manager.createAnnotation({
        parentItemID: 42,
        text: "a soundmark",
        // position deliberately omitted
      });

      expect(result.status).to.equal("failed");
      expect(result.error).to.include("position");
      // The critical assertion: nothing was written.
      expect(assignOrder).to.deep.equal([]);
    });

    it("refuses an invalid colour before touching Zotero", async function () {
      const pdf = mockPdfAttachment();
      const parent = mockParentItem(pdf);
      stubZotero({ items: { 42: parent, 55: pdf } });

      const manager = new AnnotationManager(mockAddon());
      const result = await manager.createAnnotation({
        parentItemID: 42,
        text: "x",
        color: "yellow",
        position: '{"pageIndex":1,"rects":[[1,1,2,2]]}',
      });

      expect(result.status).to.equal("failed");
      expect(result.error).to.include("colour");
    });

    it("refuses a text annotation with empty text", async function () {
      const pdf = mockPdfAttachment();
      const parent = mockParentItem(pdf);
      stubZotero({ items: { 42: parent, 55: pdf } });

      const manager = new AnnotationManager(mockAddon());
      const result = await manager.createAnnotation({
        parentItemID: 42,
        text: "   ",
        position: '{"pageIndex":1,"rects":[[1,1,2,2]]}',
      });

      expect(result.status).to.equal("failed");
      expect(result.error).to.include("needs text");
    });

    it("refuses image/ink annotations created from text", async function () {
      const pdf = mockPdfAttachment();
      const parent = mockParentItem(pdf);
      stubZotero({ items: { 42: parent, 55: pdf } });

      const manager = new AnnotationManager(mockAddon());
      const result = await manager.createAnnotation({
        parentItemID: 42,
        text: "x",
        type: "image",
      });

      expect(result.status).to.equal("failed");
      expect(result.error).to.include("image or ink");
    });

    it("fails when the parent has no PDF attachment", async function () {
      const parent = {
        ...mockParentItem(null),
        getBestAttachment: async () => false,
      };
      stubZotero({ items: { 42: parent } });

      const manager = new AnnotationManager(mockAddon());
      const result = await manager.createAnnotation({
        parentItemID: 42,
        text: "x",
        position: '{"pageIndex":1,"rects":[[1,1,2,2]]}',
      });

      expect(result.status).to.equal("failed");
      expect(result.error).to.include("No PDF attachment");
    });
  });

  describe("approval gating", function () {
    it("does not write when the user rejects the change", async function () {
      const assignOrder: string[] = [];
      const pdf = mockPdfAttachment();
      const parent = mockParentItem(pdf);
      stubZotero({
        items: { 42: parent, 55: pdf },
        annotationClass: mockAnnotationItemClass(assignOrder),
      });

      const requested: any[] = [];
      const manager = new AnnotationManager(
        mockAddon({
          approvalDialog: {
            addPendingChange: async (change: any) => {
              requested.push(change);
              return false;
            },
          },
        }),
      );

      const result = await manager.createAnnotation({
        parentItemID: 42,
        text: "a soundmark",
        position: '{"pageIndex":1,"rects":[[1,1,2,2]]}',
      });

      expect(result.status).to.equal("rejected");
      expect(assignOrder).to.deep.equal([]);
      // The user must be shown WHAT they are approving.
      expect(requested[0].path).to.include("Schafer - The Soundscape.pdf");
    });

    it("shows the annotation text in the approval diff", async function () {
      const pdf = mockPdfAttachment();
      const parent = mockParentItem(pdf);
      stubZotero({
        items: { 42: parent, 55: pdf },
        annotationClass: mockAnnotationItemClass([]),
      });

      const requested: any[] = [];
      const manager = new AnnotationManager(
        mockAddon({
          approvalDialog: {
            addPendingChange: async (change: any) => {
              requested.push(change);
              return false;
            },
          },
        }),
      );

      await manager.createAnnotation({
        parentItemID: 42,
        text: "the soundmark of a place",
        position: '{"pageIndex":1,"rects":[[1,1,2,2]]}',
      });

      expect(requested[0].newContent).to.include("the soundmark of a place");
    });

    it("legacy writeAnnotation throws on rejection (preserved contract)", async function () {
      const pdf = mockPdfAttachment();
      const parent = mockParentItem(pdf);
      stubZotero({
        items: { 42: parent, 55: pdf },
        annotationClass: mockAnnotationItemClass([]),
      });

      const manager = new AnnotationManager(
        mockAddon({ approvalDialog: { addPendingChange: async () => false } }),
      );

      let message = "";
      try {
        await manager.writeAnnotation(
          42,
          "x",
          undefined,
          1,
          "highlight",
          "#ffd400",
          '{"pageIndex":1,"rects":[[1,1,2,2]]}',
        );
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).to.equal("Annotation creation cancelled by user.");
    });
  });

  describe("editing annotations", function () {
    it("refuses to set text on a note-type annotation", async function () {
      const ann = mockAnnotation({
        annotationType: "note",
        annotationText: "",
        annotationComment: "a standalone note",
      });
      stubZotero({ items: { 101: ann } });

      const manager = new AnnotationManager(mockAddon());
      const result = await manager.updateAnnotation(101, { text: "new text" });

      expect(result.status).to.equal("failed");
      expect(result.error).to.include("highlight or underline");
    });

    it("refuses an invalid colour", async function () {
      const ann = mockAnnotation();
      stubZotero({ items: { 101: ann } });

      const manager = new AnnotationManager(mockAddon());
      const result = await manager.updateAnnotation(101, { color: "blue" });

      expect(result.status).to.equal("failed");
      expect(result.error).to.include("colour");
    });

    it("fails clearly for a non-existent annotation", async function () {
      stubZotero({ items: {} });
      const manager = new AnnotationManager(mockAddon());

      const result = await manager.updateAnnotation("NOPE", { comment: "x" });
      expect(result.status).to.equal("failed");
      expect(result.error).to.include("not found");
    });

    it("fails when no changes are supplied", async function () {
      const ann = mockAnnotation();
      stubZotero({ items: { 101: ann } });
      const manager = new AnnotationManager(mockAddon());

      const result = await manager.updateAnnotation(101, {});
      expect(result.status).to.equal("failed");
      expect(result.error).to.include("No annotation changes");
    });
  });

  describe("deleting annotations", function () {
    it("trashes annotations, never erases them", async function () {
      const ann = mockAnnotation();
      let trashed: number[] = [];
      const eraseCalls: number[][] = [];

      stubZotero({ items: { 101: ann }, onTrash: (ids) => (trashed = ids) });
      // Add an eraseTx spy to prove the manager does not reach for it.
      (globalThis as any).Zotero.Items.eraseTx = (ids: number[]) => {
        eraseCalls.push(ids);
      };

      const manager = new AnnotationManager(mockAddon());
      const result = await manager.deleteAnnotations([101]);

      expect(result.status).to.equal("success");
      expect(result.trashed).to.equal(1);
      expect(trashed).to.deep.equal([101]);
      expect(
        eraseCalls,
        "trash-only: eraseTx must never be called",
      ).to.deep.equal([]);
    });

    it("fails when no valid annotations are given", async function () {
      stubZotero({ items: {} });
      const manager = new AnnotationManager(mockAddon());

      const result = await manager.deleteAnnotations(["NOPE"]);
      expect(result.status).to.equal("failed");
      expect(result.trashed).to.equal(0);
    });
  });
});
