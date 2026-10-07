import { expect } from "chai";
import { ItemManager } from "../src/modules/hermes/ItemManager";
import type Addon from "../src/addon";

/**
 * Build a minimal mock Zotero.Item. extractItemData only touches the
 * passed item object (no Zotero globals), so a plain object cast is
 * sufficient and deterministic.
 */
function mockItem(overrides: Record<string, unknown> = {}) {
  const fields = new Map<string, string>(
    Object.entries((overrides.fields as Record<string, string>) || {}),
  );
  let creators = (overrides.creators as any[]) || [];
  const tags = (overrides.tags as any[]) || [];
  const bestAttachment = overrides.bestAttachment as
    { key: string; getFilePath?: () => string } | false | undefined;

  let saved = false;

  return {
    id: (overrides.id as number) ?? 1,
    key: (overrides.key as string) ?? "ABC123",
    itemType: (overrides.itemType as string) ?? "journalArticle",
    getField: (name: string) => fields.get(name) || "",
    setField: (name: string, val: string) => {
      fields.set(name, val);
    },
    getCreators: () => creators,
    setCreators: (newCreators: any[]) => {
      creators = newCreators;
    },
    getTags: () => tags,
    getBestAttachment: bestAttachment
      ? async () => bestAttachment
      : async () => false,
    getDisplayTitle: () => fields.get("title") || "Untitled",
    saveTx: async () => {
      saved = true;
    },
    isSaved: () => saved,
  } as unknown as Zotero.Item;
}

function mockAddon(): Addon {
  return {
    log: () => {},
  } as unknown as Addon;
}

describe("ItemManager.extractItemData", function () {
  it("should extract core fields from an item", async function () {
    const manager = new ItemManager(mockAddon());
    const item = mockItem({
      id: 42,
      key: "ABC123",
      itemType: "book",
      fields: {
        title: "The Soundscape",
        date: "1977",
        abstractNote: "A classic.",
        url: "https://example.com/soundscape",
        DOI: "10.1234/soundscape",
      },
      creators: [{ firstName: "R.", lastName: "Murray" }],
      tags: [{ tag: "acoustic-ecology" }],
    });

    const result = await manager.extractItemData(item);
    expect(result).to.not.be.null;
    expect(result?.id).to.equal(42);
    expect(result?.key).to.equal("ABC123");
    expect(result?.itemType).to.equal("book");
    expect(result?.title).to.equal("The Soundscape");
    expect(result?.date).to.equal("1977");
    expect(result?.abstract).to.equal("A classic.");
    expect(result?.url).to.equal("https://example.com/soundscape");
    expect(result?.doi).to.equal("10.1234/soundscape");
    expect(result?.creators).to.deep.equal(["R. Murray"]);
    expect(result?.tags).to.deep.equal(["acoustic-ecology"]);
  });

  it("should default title to Untitled when missing", async function () {
    const manager = new ItemManager(mockAddon());
    const item = mockItem({ fields: {} });
    const result = await manager.extractItemData(item);
    expect(result?.title).to.equal("Untitled");
  });

  it("should resolve the best attachment key and file path", async function () {
    const manager = new ItemManager(mockAddon());
    const item = mockItem({
      bestAttachment: {
        key: "XYZ789",
        getFilePath: () => "/Users/test/Zotero/storage/XYZ789/paper.pdf",
      },
    });
    const result = await manager.extractItemData(item);
    expect(result?.attachmentKey).to.equal("XYZ789");
    expect(result?.storagePath).to.equal(
      "/Users/test/Zotero/storage/XYZ789/paper.pdf",
    );
  });

  it("should leave attachment fields undefined when no attachment exists", async function () {
    const manager = new ItemManager(mockAddon());
    const item = mockItem({ bestAttachment: false });
    const result = await manager.extractItemData(item);
    expect(result?.attachmentKey).to.be.undefined;
    expect(result?.storagePath).to.be.undefined;
  });

  it("should tolerate a throwing getBestAttachment", async function () {
    const manager = new ItemManager(mockAddon());
    const item = mockItem({
      bestAttachment: undefined,
    });
    // Force getBestAttachment to throw
    (item as any).getBestAttachment = async () => {
      throw new Error("boom");
    };
    const result = await manager.extractItemData(item);
    expect(result).to.not.be.null;
    expect(result?.attachmentKey).to.be.undefined;
  });

  it("should handle creators with only a name (institutional)", async function () {
    const manager = new ItemManager(mockAddon());
    const item = mockItem({
      creators: [{ name: "World Health Organization" }],
    });
    const result = await manager.extractItemData(item);
    expect(result?.creators).to.deep.equal(["World Health Organization"]);
  });

  it("should extract child notes when available", async function () {
    const manager = new ItemManager(mockAddon());
    const item = mockItem({
      fields: { title: "Note Test Item" },
    });
    (item as any).getNotes = () => [101];

    const realZotero = (globalThis as any).Zotero;
    (globalThis as any).__realZotero = realZotero;
    (globalThis as any).Zotero = {
      ...realZotero,
      Items: {
        getAsync: async (id: number) => {
          if (id === 101) {
            return {
              isNote: () => true,
              getNote: () => "<p>Key insight from reading chapter 1.</p>",
              getNoteTitle: () => "Key insight",
            };
          }
          return null;
        },
      },
    };

    try {
      const result = await manager.extractItemData(item);
      expect(result?.notes).to.deep.equal([
        {
          title: "Key insight",
          content: "Key insight from reading chapter 1.",
        },
      ]);
    } finally {
      (globalThis as any).Zotero = (globalThis as any).__realZotero;
      delete (globalThis as any).__realZotero;
    }
  });

  it("should return null when item access throws", async function () {
    const manager = new ItemManager(mockAddon());
    const item = mockItem({});
    (item as any).getField = () => {
      throw new Error("boom");
    };
    const result = await manager.extractItemData(item);
    expect(result).to.be.null;
  });
});

describe("ItemManager.attachSelectedItems", function () {
  after(function () {
    // Restore the real Zotero global (the reporter needs Zotero.HTTP).
    (globalThis as any).Zotero = (globalThis as any).__realZotero;
    delete (globalThis as any).__realZotero;
  });

  function stubZoteroPane(items: unknown[] | null) {
    // Build a mock Zotero by SPREADING the real object and overriding
    // only getActiveZoteroPane. Replacing the whole object breaks the
    // test runner's reporter, which calls Zotero.HTTP.request to stream
    // results back to the server.
    const realZotero = (globalThis as any).Zotero;
    (globalThis as any).__realZotero = realZotero;
    (globalThis as any).Zotero = {
      ...realZotero,
      getActiveZoteroPane: () =>
        items === null
          ? null
          : {
              getSelectedItems: () => items,
            },
    };
  }

  it("should attach all selected items and track them", async function () {
    const manager = new ItemManager(mockAddon());
    const itemA = mockItem({ id: 1, key: "AAA", fields: { title: "A" } });
    const itemB = mockItem({ id: 2, key: "BBB", fields: { title: "B" } });

    stubZoteroPane([itemA, itemB]);

    const attached = await manager.attachSelectedItems();
    expect(attached).to.have.length(2);
    expect(attached[0].key).to.equal("AAA");
    expect(attached[1].key).to.equal("BBB");
    expect(manager.getAttachedItems()).to.have.length(2);
  });

  it("should attach a single item via attachItem (C1 regression)", async function () {
    const manager = new ItemManager(mockAddon());
    const item = mockItem({ id: 7, key: "CCC", fields: { title: "C" } });

    const attached = await manager.attachItem(item);
    expect(attached).to.not.be.null;
    expect(attached?.id).to.equal(7);
    expect(manager.getAttachedItems()).to.have.length(1);
    expect(manager.getAttachedItems()[0].key).to.equal("CCC");
  });

  it("should dedupe items attached twice via addAttachedItem (C1 regression)", async function () {
    const manager = new ItemManager(mockAddon());
    const item = mockItem({ id: 7, key: "CCC", fields: { title: "C" } });

    await manager.attachItem(item);
    await manager.attachItem(item);
    expect(manager.getAttachedItems()).to.have.length(1);
  });

  it("should clear attached items", async function () {
    const manager = new ItemManager(mockAddon());
    const item = mockItem({ id: 1, key: "AAA", fields: { title: "A" } });
    stubZoteroPane([item]);
    await manager.attachSelectedItems();
    manager.clearAttachedItems();
    expect(manager.getAttachedItems()).to.have.length(0);
  });

  it("should return empty when no pane is active", async function () {
    const manager = new ItemManager(mockAddon());
    stubZoteroPane(null);
    const attached = await manager.attachSelectedItems();
    expect(attached).to.have.length(0);
  });
});

describe("ItemManager.updateItemMetadata", function () {
  after(function () {
    if ((globalThis as any).__realZotero) {
      (globalThis as any).Zotero = (globalThis as any).__realZotero;
      delete (globalThis as any).__realZotero;
    }
  });

  function stubGetAsync(itemMap: Map<number, any>) {
    const realZotero = (globalThis as any).Zotero;
    if (!(globalThis as any).__realZotero) {
      (globalThis as any).__realZotero = realZotero;
    }
    (globalThis as any).Zotero = {
      ...realZotero,
      Items: {
        ...(realZotero?.Items || {}),
        getAsync: async (id: number) => itemMap.get(id) || null,
      },
    };
  }

  it("should update scalar fields and map aliases", async function () {
    const manager = new ItemManager(mockAddon());
    const item = mockItem({
      id: 10,
      fields: {
        title: "Old Title",
        abstractNote: "Old Abstract",
        DOI: "old-doi",
      },
    });
    stubGetAsync(new Map([[10, item]]));

    const result = await manager.updateItemMetadata(10, {
      title: "New Title",
      abstract: "New Abstract",
      doi: "10.1234/new-doi",
    });

    expect(result).to.be.true;
    expect(item.getField("title")).to.equal("New Title");
    expect(item.getField("abstractNote")).to.equal("New Abstract");
    expect(item.getField("DOI")).to.equal("10.1234/new-doi");
    expect((item as any).isSaved()).to.be.true;
  });

  it("should parse and set creators from string array", async function () {
    const manager = new ItemManager(mockAddon());
    const item = mockItem({
      id: 11,
      fields: { title: "Paper" },
      creators: [{ firstName: "Old", lastName: "Author" }],
    });
    stubGetAsync(new Map([[11, item]]));

    const result = await manager.updateItemMetadata(11, {
      creators: ["Alice Walker", "SingleNameAuthor"],
    });

    expect(result).to.be.true;
    const creators = item.getCreators();
    expect(creators).to.have.length(2);
    expect(creators[0]).to.deep.equal({
      firstName: "Alice",
      lastName: "Walker",
      creatorType: "author",
    });
    expect(creators[1]).to.deep.equal({
      firstName: "",
      lastName: "SingleNameAuthor",
      creatorType: "author",
    });
  });

  it("should ignore protected system fields and return false if no valid updates", async function () {
    const manager = new ItemManager(mockAddon());
    const item = mockItem({
      id: 12,
      key: "KEY123",
      fields: { title: "Untouched" },
    });
    stubGetAsync(new Map([[12, item]]));

    const result = await manager.updateItemMetadata(12, {
      id: 999,
      key: "NEWKEY",
      itemType: "book",
    });

    expect(result).to.be.false;
    expect(item.id).to.equal(12);
    expect(item.key).to.equal("KEY123");
    expect((item as any).isSaved()).to.be.false;
  });

  it("should gate with ApprovalDialog when present and reject if denied", async function () {
    let dialogCalled = false;
    const mockApproval = {
      addPendingChange: async () => {
        dialogCalled = true;
        return false; // Denied by user
      },
    };
    const addon = mockAddon();
    (addon as any).data = { hermes: { approvalDialog: mockApproval } };
    const manager = new ItemManager(addon);
    const item = mockItem({ id: 13, fields: { title: "Before" } });
    stubGetAsync(new Map([[13, item]]));

    let threw = false;
    try {
      await manager.updateItemMetadata(13, { title: "After" });
    } catch {
      threw = true;
    }

    expect(dialogCalled).to.be.true;
    expect(threw).to.be.true;
    expect(item.getField("title")).to.equal("Before");
    expect((item as any).isSaved()).to.be.false;
  });
});

describe("ItemManager prompt builders", function () {
  it("builds a single-item overview prompt", function () {
    const manager = new ItemManager(mockAddon());
    const prompt = manager.buildItemPrompt(["The Soundscape"]);
    expect(prompt).to.contain('"The Soundscape"');
    expect(prompt).to.contain("overview");
  });

  it("builds a comparison prompt for multiple items", function () {
    const manager = new ItemManager(mockAddon());
    const prompt = manager.buildItemPrompt(["A", "B"]);
    expect(prompt).to.contain('"A"');
    expect(prompt).to.contain('"B"');
    expect(prompt).to.contain("Compare");
  });

  it("falls back when no titles are provided", function () {
    const manager = new ItemManager(mockAddon());
    const prompt = manager.buildItemPrompt([], "the selected item");
    expect(prompt).to.contain("the selected item");
  });

  it("builds an explain prompt with page and title", function () {
    const manager = new ItemManager(mockAddon());
    const prompt = manager.buildReaderPrompt("explain", {
      text: "the argument",
      page: 4,
      title: "Soundscape",
    });
    expect(prompt).to.contain('"Soundscape"');
    expect(prompt).to.contain("(page 4)");
    expect(prompt).to.contain("the argument");
    expect(prompt).to.contain("explain");
  });

  it("builds a critique prompt from the current document when no title", function () {
    const manager = new ItemManager(mockAddon());
    const prompt = manager.buildReaderPrompt("critique", { text: "x" });
    expect(prompt).to.contain("the current document");
    expect(prompt).to.contain("critique");
  });

  it("resolves the prompt title from extracted metadata", async function () {
    const manager = new ItemManager(mockAddon());
    const item = mockItem({ id: 3, key: "K3", fields: { title: "From Meta" } });
    await manager.attachItem(item);
    expect(manager.getItemPromptText(item)).to.equal("From Meta");
  });
});

describe("ItemManager.registerItemContextMenu", function () {
  function stubMenuManager(registerMenu: (opts: any) => any) {
    const realZotero = (globalThis as any).Zotero;
    (globalThis as any).__realZotero = realZotero;
    (globalThis as any).Zotero = {
      ...realZotero,
      MenuManager: { registerMenu, unregisterMenu: () => true },
    };
  }

  afterEach(function () {
    if ((globalThis as any).__realZotero) {
      (globalThis as any).Zotero = (globalThis as any).__realZotero;
      delete (globalThis as any).__realZotero;
    }
  });

  it("registers a menuitem on the library item context menu target", function () {
    let captured: any = null;
    stubMenuManager((opts: any) => {
      captured = opts;
      return opts.menuID;
    });
    const manager = new ItemManager(mockAddon());
    const ok = manager.registerItemContextMenu(() => {});
    expect(ok).to.be.true;
    expect(captured.target).to.equal("main/library/item");
    expect(captured.menus).to.have.length(1);
    expect(captured.menus[0].menuType).to.equal("menuitem");
    expect(captured.menus[0].l10nID).to.equal("hermes-itemmenu-ask");
    expect(captured.menus[0].icon).to.contain("hermes-sidenav.svg");
  });

  it("returns false when Zotero.MenuManager is unavailable", function () {
    const realZotero = (globalThis as any).Zotero;
    (globalThis as any).__realZotero = realZotero;
    (globalThis as any).Zotero = { ...realZotero, MenuManager: undefined };
    const manager = new ItemManager(mockAddon());
    expect(manager.registerItemContextMenu(() => {})).to.be.false;
  });

  it("attaches the clicked item and passes grounded context to onAsk", async function () {
    let captured: any = null;
    stubMenuManager((opts: any) => {
      captured = opts;
      return opts.menuID;
    });
    const manager = new ItemManager(mockAddon());
    let payload: any = null;
    manager.registerItemContextMenu((p) => {
      payload = p;
    });

    const item = mockItem({ id: 5, key: "K5", fields: { title: "Grounded" } });
    await captured.menus[0].onCommand({}, { items: [item] });

    expect(payload.titles).to.deep.equal(["Grounded"]);
    expect(payload.contextItems).to.have.length(1);
    expect(payload.contextItems[0].id).to.equal("item-5");
    expect(payload.contextItems[0].type).to.equal("item");
    expect(manager.getAttachedItems()).to.have.length(1);
  });
});

describe("ItemManager.getActiveReaderSelection", function () {
  afterEach(function () {
    if ((globalThis as any).__realZotero) {
      (globalThis as any).Zotero = (globalThis as any).__realZotero;
      delete (globalThis as any).__realZotero;
    }
  });

  it("returns the iframe selection text and page", function () {
    const realZotero = (globalThis as any).Zotero;
    (globalThis as any).__realZotero = realZotero;
    const reader = {
      itemID: 0,
      _iframeWindow: {
        getSelection: () => ({ toString: () => "  selected passage  " }),
      },
      _internalReader: { _primaryView: { _currentPageNumber: 7 } },
    };
    (globalThis as any).Zotero = {
      ...realZotero,
      Reader: { _readers: [reader], getByTabID: () => null },
    };

    const manager = new ItemManager(mockAddon());
    const sel = manager.getActiveReaderSelection();
    expect(sel).to.not.be.null;
    expect(sel?.text).to.equal("selected passage");
    expect(sel?.page).to.equal(7);
  });

  it("returns null when there is no selection", function () {
    const realZotero = (globalThis as any).Zotero;
    (globalThis as any).__realZotero = realZotero;
    const reader = {
      itemID: 0,
      _iframeWindow: { getSelection: () => null },
    };
    (globalThis as any).Zotero = {
      ...realZotero,
      Reader: { _readers: [reader], getByTabID: () => null },
    };

    const manager = new ItemManager(mockAddon());
    expect(manager.getActiveReaderSelection()).to.be.null;
  });
});

/**
 * Live-runtime integration: these run inside the actual Zotero 10 process
 * the test harness boots, so they prove the fix against
 * `Zotero.MenuManager` itself rather than a hand-written mock. If the
 * MenuManager registration path were wrong (the original silent failure),
 * `registerMenu` would reject the option and these assertions would fail.
 */
describe("ItemManager MenuManager integration (live Zotero runtime)", function () {
  const TARGET = "main/library/item";
  const menuOptions = () =>
    (globalThis as any).Zotero.MenuManager._menuManager.getCustomMenuOptions(
      TARGET,
    );
  const findOurs = () =>
    menuOptions().find((o: any) =>
      String(o.menuID).includes("item-context-menu"),
    );

  after(function () {
    // Leave no residue in the live MenuManager cache.
    const existing = findOurs();
    if (existing) {
      (globalThis as any).Zotero.MenuManager.unregisterMenu(existing.menuID);
    }
  });

  it("registers and unregisters the item context menu against real Zotero.MenuManager", function () {
    const zotero = (globalThis as any).Zotero;
    const menuManager = zotero.MenuManager;
    expect(menuManager, "Zotero.MenuManager exists in Zotero 10").to.exist;

    // Clear any registration left by the plugin's own boot sequence so the
    // assertion is deterministic.
    const preexisting = findOurs();
    if (preexisting) menuManager.unregisterMenu(preexisting.menuID);
    expect(findOurs(), "clean slate before registering").to.be.undefined;

    const manager = new ItemManager(mockAddon());
    const ok = manager.registerItemContextMenu(() => {});
    expect(ok, "registerMenu accepted the option").to.be.true;

    const mine = findOurs();
    expect(mine, "registration visible in live MenuManager").to.exist;
    expect(mine.target).to.equal(TARGET);
    expect(mine.pluginID).to.equal("hermes@techne-tools.org");
    expect(mine.menus[0].menuType).to.equal("menuitem");
    expect(mine.menus[0].l10nID).to.equal("hermes-itemmenu-ask");

    // The namespaced-key bug: unregister must use the key registerMenu
    // returned, not the bare menuID.
    manager.unregisterItemContextMenu();
    expect(
      findOurs(),
      "unregister removes the registration from live MenuManager",
    ).to.be.undefined;
  });

  it("confirms the reader APIs Hermes depends on exist in this runtime", function () {
    const R = (globalThis as any).Zotero.Reader;
    expect(R, "Zotero.Reader exists").to.exist;
    expect(R.getByTabID, "getByTabID (getReader() does not exist)").to.be.a(
      "function",
    );
    expect(R.registerEventListener).to.be.a("function");
    expect(R._registeredListeners).to.be.an("array");
    // getByTabID must tolerate an unknown id without throwing, since
    // getActiveReader() calls it with the selected tab id before falling back.
    expect(() => R.getByTabID("__hermes_nonexistent_tab__")).to.not.throw();
  });
});

describe("ItemManager bulk metadata operations", function () {
  after(function () {
    if ((globalThis as any).__realZotero) {
      (globalThis as any).Zotero = (globalThis as any).__realZotero;
      delete (globalThis as any).__realZotero;
    }
  });

  /**
   * Install a Zotero stub with both getAsync and the synchronous get, because
   * the bulk paths read titles for the diff via `Zotero.Items.get`.
   */
  function stubItems(map: Map<number, any>, trashCalls?: number[][]) {
    const realZotero = (globalThis as any).Zotero;
    if (!(globalThis as any).__realZotero) {
      (globalThis as any).__realZotero = realZotero;
    }
    (globalThis as any).Zotero = {
      ...realZotero,
      Items: {
        ...(realZotero?.Items || {}),
        getAsync: async (id: number) => map.get(id) || null,
        get: (id: number) => map.get(id) || null,
        trashTx: async (ids: number[]) => {
          trashCalls?.push(ids);
        },
      },
    };
  }

  function addonWith(approve: boolean) {
    const approvals: any[] = [];
    const audits: any[] = [];
    const addon = mockAddon();
    (addon as any).data = {
      hermes: {
        approvalDialog: {
          addPendingChange: async (change: any) => {
            approvals.push(change);
            return approve;
          },
        },
        auditLog: {
          record: (action: string, details: string, status: string) =>
            audits.push({ action, details, status }),
        },
      },
    };
    return { addon, approvals, audits };
  }

  it("bulk-updates one field across many items in a single approval", async function () {
    const items = new Map<number, any>([
      [1, mockItem({ id: 1, fields: { title: "A" } })],
      [2, mockItem({ id: 2, fields: { title: "B" } })],
      [3, mockItem({ id: 3, fields: { title: "C" } })],
    ]);
    stubItems(items);
    const { addon, approvals } = addonWith(true);
    const manager = new ItemManager(addon);

    const result = await manager.bulkUpdateMetadata([1, 2, 3], {
      publication: "Sound Studies",
    });

    expect(result.status).to.equal("success");
    expect(result.updated).to.equal(3);
    expect(result.failed).to.equal(0);
    expect(approvals).to.have.length(1);
    expect(items.get(1).getField("publicationTitle")).to.equal("Sound Studies");
    expect(items.get(3).getField("publicationTitle")).to.equal("Sound Studies");
  });

  it("does not touch any item when the bulk change is rejected", async function () {
    const items = new Map<number, any>([
      [1, mockItem({ id: 1, fields: { title: "A" } })],
    ]);
    stubItems(items);
    const { addon } = addonWith(false);
    const manager = new ItemManager(addon);

    const result = await manager.bulkUpdateMetadata([1], { date: "2020" });

    expect(result.status).to.equal("rejected");
    expect(result.updated).to.equal(0);
    expect(items.get(1).getField("date")).to.equal("");
  });

  it("counts a per-item failure without aborting the whole batch", async function () {
    const broken = mockItem({ id: 2, fields: { title: "B" } });
    (broken as any).saveTx = async () => {
      throw new Error("locked");
    };
    const items = new Map<number, any>([
      [1, mockItem({ id: 1, fields: { title: "A" } })],
      [2, broken],
    ]);
    stubItems(items);
    const { addon } = addonWith(true);
    const manager = new ItemManager(addon);

    const result = await manager.bulkUpdateMetadata([1, 2], { volume: "3" });

    expect(result.status).to.equal("success");
    expect(result.updated).to.equal(1);
    expect(result.failed).to.equal(1);
    expect(items.get(1).getField("volume")).to.equal("3");
  });

  it("reports failure when no items or no valid fields are supplied", async function () {
    stubItems(new Map());
    const { addon } = addonWith(true);
    const manager = new ItemManager(addon);

    const noItems = await manager.bulkUpdateMetadata([], { title: "x" });
    expect(noItems.status).to.equal("failed");
    expect(noItems.updated).to.equal(0);

    const noFields = await manager.bulkUpdateMetadata([1], { id: 5 });
    expect(noFields.status).to.equal("failed");
  });

  it("clears a metadata field and records the discarded value in the diff", async function () {
    const items = new Map<number, any>([
      [1, mockItem({ id: 1, fields: { title: "A", DOI: "10.1/abc" } })],
    ]);
    stubItems(items);
    const { addon, approvals } = addonWith(true);
    const manager = new ItemManager(addon);

    const result = await manager.deleteMetadataValue([1], "doi");

    expect(result.status).to.equal("success");
    expect(result.updated).to.equal(1);
    expect(items.get(1).getField("DOI")).to.equal("");
    // The discarded value must be visible in the approval prompt.
    expect(approvals[0].newContent).to.include("10.1/abc");
  });

  it("refuses to clear a protected field", async function () {
    stubItems(new Map([[1, mockItem({ id: 1 })]]));
    const { addon, approvals } = addonWith(true);
    const manager = new ItemManager(addon);

    const result = await manager.deleteMetadataValue([1], "dateAdded");

    expect(result.status).to.equal("failed");
    expect(approvals).to.have.length(0);
  });

  it("refuses to clear creators rather than silently emptying them", async function () {
    stubItems(new Map([[1, mockItem({ id: 1 })]]));
    const { addon } = addonWith(true);
    const manager = new ItemManager(addon);

    const result = await manager.deleteMetadataValue([1], "creators");

    expect(result.status).to.equal("failed");
    expect(result.error).to.include("replacement creator");
  });

  it("trashes items (never erases) when approved", async function () {
    const trashCalls: number[][] = [];
    const items = new Map<number, any>([
      [1, mockItem({ id: 1, fields: { title: "A" } })],
      [2, mockItem({ id: 2, fields: { title: "B" } })],
    ]);
    stubItems(items, trashCalls);
    const { addon, approvals } = addonWith(true);
    const manager = new ItemManager(addon);

    const result = await manager.trashItems([1, 2]);

    expect(result.status).to.equal("success");
    expect(result.trashed).to.equal(2);
    expect(trashCalls).to.deep.equal([[1, 2]]);
    // Destructive action must be presented as a delete, not a modify.
    expect(approvals[0].action).to.equal("delete");
  });

  it("does not trash anything when the user rejects", async function () {
    const trashCalls: number[][] = [];
    stubItems(new Map([[1, mockItem({ id: 1 })]]), trashCalls);
    const { addon } = addonWith(false);
    const manager = new ItemManager(addon);

    const result = await manager.trashItems([1]);

    expect(result.status).to.equal("rejected");
    expect(result.trashed).to.equal(0);
    expect(trashCalls).to.have.length(0);
  });

  it("returns failure for trashItems with no valid ids", async function () {
    stubItems(new Map());
    const { addon } = addonWith(true);
    const manager = new ItemManager(addon);

    const result = await manager.trashItems([0, -1]);

    expect(result.status).to.equal("failed");
    expect(result.trashed).to.equal(0);
  });
});
