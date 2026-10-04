import { expect } from "chai";
import { TagManager } from "../src/modules/hermes/TagManager";
import type Addon from "../src/addon";

function mockTagItem(initialTags: string[] = []) {
  let tags = [...initialTags];
  let saved = false;
  return {
    id: 1,
    getTags: () => tags.map((t) => ({ tag: t })),
    addTag: (t: string) => {
      if (!tags.includes(t)) tags.push(t);
    },
    removeTag: (t: string) => {
      tags = tags.filter((x) => x !== t);
    },
    getDisplayTitle: () => "Test Paper",
    getField: (name: string) => {
      if (name === "title") return "Neural Networks in Robotics";
      if (name === "abstractNote")
        return "A study on reinforcement learning for robot navigation.";
      return "";
    },
    saveTx: async () => {
      saved = true;
    },
    isSaved: () => saved,
  };
}

function mockAddon(): Addon {
  return {
    log: () => {},
    data: {},
  } as unknown as Addon;
}

describe("TagManager", function () {
  after(function () {
    if ((globalThis as any).__realZotero) {
      (globalThis as any).Zotero = (globalThis as any).__realZotero;
      delete (globalThis as any).__realZotero;
    }
  });

  function stubZotero(
    item: any,
    globalTags: Array<{ tag: string; count?: number }> = [],
  ) {
    const realZotero = (globalThis as any).Zotero;
    if (!(globalThis as any).__realZotero) {
      (globalThis as any).__realZotero = realZotero;
    }
    (globalThis as any).Zotero = {
      ...realZotero,
      Items: {
        ...(realZotero?.Items || {}),
        get: (_id: number) => item,
        // Real Zotero.Items.getAsync returns an ARRAY for an array of ids and
        // the object itself for a single id (dataObjects.js:152-211).
        // renameTag passes an array and calls .filter() on the result, so the
        // stub must preserve that shape.
        getAsync: async (ids: unknown) => (Array.isArray(ids) ? [item] : item),
      },
      Tags: {
        ...(realZotero?.Tags || {}),
        getAll: async () => globalTags,
      },
      Libraries: {
        userLibraryID: 1,
      },
    };
  }

  it("should add tags without approval dialog", async function () {
    const item = mockTagItem(["ai"]);
    stubZotero(item);
    const manager = new TagManager(mockAddon());

    await manager.addTags(1, ["robotics", "neural-networks"]);
    expect(item.getTags().map((t) => t.tag)).to.deep.equal([
      "ai",
      "robotics",
      "neural-networks",
    ]);
    expect(item.isSaved()).to.be.true;
  });

  it("should gate addTags through ApprovalDialog when provided", async function () {
    const item = mockTagItem(["ai"]);
    stubZotero(item);

    let approvedChange: any = null;
    const approvalDialog = {
      addPendingChange: async (change: any) => {
        approvedChange = change;
        return true;
      },
    };

    const manager = new TagManager(mockAddon(), approvalDialog);
    await manager.addTags(1, ["robotics"]);

    expect(approvedChange).to.not.be.null;
    expect(approvedChange.path).to.include("Test Paper");
    expect(item.getTags().map((t) => t.tag)).to.include("robotics");
  });

  it("should abort addTags and throw if user denies approval", async function () {
    const item = mockTagItem(["ai"]);
    stubZotero(item);

    const approvalDialog = {
      addPendingChange: async () => false,
    };

    const manager = new TagManager(mockAddon(), approvalDialog);
    let threw = false;
    try {
      await manager.addTags(1, ["robotics"]);
    } catch {
      threw = true;
    }

    expect(threw).to.be.true;
    expect(item.getTags().map((t) => t.tag)).to.deep.equal(["ai"]);
  });

  it("should remove tags and gate through ApprovalDialog", async function () {
    const item = mockTagItem(["ai", "robotics"]);
    stubZotero(item);

    let approvedChange: any = null;
    const approvalDialog = {
      addPendingChange: async (change: any) => {
        approvedChange = change;
        return true;
      },
    };

    const manager = new TagManager(mockAddon(), approvalDialog);
    await manager.removeTags(1, ["ai"]);

    expect(approvedChange).to.not.be.null;
    expect(item.getTags().map((t) => t.tag)).to.deep.equal(["robotics"]);
    expect(item.isSaved()).to.be.true;
  });

  it("should suggest tags based on title/abstract content matching", async function () {
    const item = mockTagItem([]);
    stubZotero(item, [
      { count: 10, tag: "robotics" },
      { count: 5, tag: "quantum" },
      { count: 2, tag: "neural" },
    ]);

    const manager = new TagManager(mockAddon());
    const suggestions = await manager.suggestTags(item.id);

    expect(suggestions).to.be.an("array");
    const suggestedNames = suggestions.map((s) => s.tag);
    expect(suggestedNames).to.include("robotics");
    expect(suggestedNames).to.not.include("quantum");
  });

  it("should detect duplicate variants and hierarchical tags in detectTaxonomyClusters", function () {
    const manager = new TagManager(mockAddon());
    const tags = [
      "machine-learning",
      "Machine Learning",
      "machine learning",
      "deep learning",
      "method/transformer",
      "method/lstm",
      "domain/nlp",
    ];

    const result = manager.detectTaxonomyClusters(tags);

    expect(result.duplicates).to.have.lengthOf(1);
    expect(result.duplicates[0].variants).to.include("machine-learning");
    expect(result.duplicates[0].variants).to.include("Machine Learning");

    expect(result.hierarchical).to.have.lengthOf(2);
    const methodCat = result.hierarchical.find((h) => h.category === "method");
    expect(methodCat).to.exist;
    expect(methodCat?.tags).to.include("transformer");
    expect(methodCat?.tags).to.include("lstm");
  });

  it("should rename and merge tags across items with renameTag", async function () {
    const item = mockTagItem(["ML", "robotics"]);
    (item as any).isRegularItem = () => true;
    stubZotero(item);

    const manager = new TagManager(mockAddon());
    const count = await manager.renameTag("ML", "machine-learning", [1]);

    expect(count).to.equal(1);
    expect(item.getTags().map((t) => t.tag)).to.deep.equal([
      "robotics",
      "machine-learning",
    ]);
    expect(item.isSaved()).to.be.true;
  });
});

describe("TagManager bulk operations", function () {
  after(function () {
    if ((globalThis as any).__realZotero) {
      (globalThis as any).Zotero = (globalThis as any).__realZotero;
      delete (globalThis as any).__realZotero;
    }
  });

  /** Several distinct tag items, keyed by id, with a shared Zotero stub. */
  function stubMany(ids: number[]) {
    const realZotero = (globalThis as any).Zotero;
    if (!(globalThis as any).__realZotero) {
      (globalThis as any).__realZotero = realZotero;
    }
    const items = new Map<number, any>();
    for (const id of ids) {
      const item = mockTagItem([]);
      item.id = id;
      items.set(id, item);
    }
    (globalThis as any).Zotero = {
      ...realZotero,
      Libraries: { userLibraryID: 1 },
      Items: {
        ...(realZotero?.Items || {}),
        getAsync: async (id: number | number[]) =>
          Array.isArray(id)
            ? id.map((i) => items.get(i)).filter(Boolean)
            : items.get(id) || null,
        get: (id: number) => items.get(id) || null,
      },
      Tags: {
        ...(realZotero?.Tags || {}),
        getAll: async () => [
          { tag: "theory/affect", count: 10 },
          { tag: "method/par", count: 4 },
        ],
      },
    };
    return items;
  }

  function addonWith(approve: boolean) {
    const approvals: any[] = [];
    const addon = mockAddon();
    (addon as any).data = {
      hermes: {
        approvalDialog: {
          addPendingChange: async (c: any) => {
            approvals.push(c);
            return approve;
          },
        },
        auditLog: { record: () => {} },
      },
    };
    return { addon, approvals };
  }

  it("adds tags to many items behind one approval", async function () {
    const items = stubMany([1, 2, 3]);
    const { addon, approvals } = addonWith(true);
    const manager = new TagManager(addon);

    const result = await manager.bulkAddTags([1, 2, 3], ["theory/affect"]);

    expect(result.status).to.equal("success");
    expect(result.updated).to.equal(3);
    expect(result.failed).to.equal(0);
    expect(approvals).to.have.length(1);
    expect(
      items
        .get(1)
        .getTags()
        .map((t: any) => t.tag),
    ).to.include("theory/affect");
    expect(
      items
        .get(3)
        .getTags()
        .map((t: any) => t.tag),
    ).to.include("theory/affect");
  });

  it("removes tags from many items behind one approval", async function () {
    const items = stubMany([1, 2]);
    items.get(1).addTag("theory/affect");
    items.get(2).addTag("theory/affect");
    const { addon } = addonWith(true);
    const manager = new TagManager(addon);

    const result = await manager.bulkRemoveTags([1, 2], ["theory/affect"]);

    expect(result.status).to.equal("success");
    expect(result.updated).to.equal(2);
    expect(
      items
        .get(1)
        .getTags()
        .map((t: any) => t.tag),
    ).to.not.include("theory/affect");
  });

  it("changes nothing when the bulk tag change is rejected", async function () {
    const items = stubMany([1, 2]);
    const { addon } = addonWith(false);
    const manager = new TagManager(addon);

    const result = await manager.bulkAddTags([1, 2], ["method/par"]);

    expect(result.status).to.equal("rejected");
    expect(result.updated).to.equal(0);
    expect(items.get(1).getTags()).to.have.length(0);
  });

  it("de-duplicates and trims the tag list before applying", async function () {
    const items = stubMany([1]);
    const { addon, approvals } = addonWith(true);
    const manager = new TagManager(addon);

    await manager.bulkAddTags([1], ["  method/par  ", "method/par", ""]);

    // The diff should show the tag once, not three times.
    expect(approvals[0].newContent).to.equal("+ method/par");
  });

  it("counts a per-item failure without aborting the batch", async function () {
    const items = stubMany([1, 2]);
    items.get(2).saveTx = async () => {
      throw new Error("locked");
    };
    const { addon } = addonWith(true);
    const manager = new TagManager(addon);

    const result = await manager.bulkAddTags([1, 2], ["method/par"]);

    expect(result.status).to.equal("success");
    expect(result.updated).to.equal(1);
    expect(result.failed).to.equal(1);
  });

  it("fails fast with no items or no tags", async function () {
    stubMany([]);
    const { addon, approvals } = addonWith(true);
    const manager = new TagManager(addon);

    expect((await manager.bulkAddTags([], ["x"])).status).to.equal("failed");
    expect((await manager.bulkAddTags([1], [])).status).to.equal("failed");
    expect(approvals).to.have.length(0);
  });

  it("keeps the legacy addTags contract: throws when the user rejects", async function () {
    stubMany([1]);
    const { addon } = addonWith(false);
    const manager = new TagManager(addon);

    let threw = false;
    try {
      await manager.addTags(1, ["method/par"]);
    } catch {
      threw = true;
    }

    expect(threw).to.equal(true);
  });

  it("reports tags that do not exist in the library", async function () {
    stubMany([1]);
    const { addon } = addonWith(true);
    const manager = new TagManager(addon);

    const missing = await manager.findMissingTags([
      "theory/affect",
      "sonic-studies",
    ]);

    expect(missing).to.deep.equal(["sonic-studies"]);
  });
});
