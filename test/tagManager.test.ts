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
