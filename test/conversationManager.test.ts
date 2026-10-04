import { expect } from "chai";
import { ConversationManager } from "../src/modules/hermes/ConversationManager";
import type Addon from "../src/addon";

/**
 * In-memory nsIFile mock. Supports the subset of the nsIFile API that
 * ConversationManager uses: clone, append, exists, create, path, leafName,
 * remove, isDirectory, directoryEntries.
 */
class MockFile {
  public path: string;
  public isDirectory = false;
  public children: MockFile[] = [];
  public existsFlag = true;
  public removed = false;
  public fs: MockFs | null = null;

  constructor(path: string) {
    this.path = path;
  }

  public clone(): MockFile {
    const copy = new MockFile(this.path);
    copy.isDirectory = this.isDirectory;
    copy.children = this.children;
    copy.existsFlag = this.existsFlag;
    return copy;
  }

  public append(name: string): void {
    this.path = `${this.path}/${name}`;
  }

  public exists(): boolean {
    return this.existsFlag;
  }

  public create(): void {
    this.existsFlag = true;
  }

  public get leafName(): string {
    return this.path.split("/").pop() || "";
  }

  public remove(): void {
    this.removed = true;
    this.existsFlag = false;
    // Also remove from the in-memory filesystem so later lookups miss.
    this.fs?.files.delete(this.path);
  }

  public get directoryEntries(): {
    hasMoreElements: () => boolean;
    getNext: () => MockFile;
  } {
    let i = 0;
    return {
      hasMoreElements: () => i < this.children.length,
      getNext: () => this.children[i++],
    };
  }
}

/** In-memory filesystem keyed by path. */
class MockFs {
  public files = new Map<string, string>();
  public dirs = new Set<string>();
  public profileDir: string | null =
    "/Users/test/Library/Application Support/Zotero/Profiles/abc.default";

  public pathToFile(path: string): MockFile {
    // The real Zotero.File.pathToFile throws on an empty path; the
    // ConversationManager relies on that throw to skip persistence.
    if (!path) throw new Error("Empty path");
    const file = new MockFile(path);
    file.fs = this;
    file.existsFlag = this.files.has(path) || this.dirs.has(path);
    file.isDirectory = this.dirs.has(path);
    if (this.dirs.has(path)) {
      // Populate children from the files map
      const prefix = `${path}/`;
      file.children = [...this.files.keys()]
        .filter((p) => p.startsWith(prefix))
        .map((p) => {
          const child = new MockFile(p);
          child.fs = this;
          child.existsFlag = true;
          return child;
        });
    }
    return file;
  }

  public putContents(file: MockFile, contents: string): void {
    this.files.set(file.path, contents);
    this.dirs.add(file.path.split("/").slice(0, -1).join("/"));
  }

  public getContents(file: MockFile): string {
    return this.files.get(file.path) || "";
  }
}

function makeAddon(fs: MockFs, prefs: Record<string, unknown> = {}) {
  const addon = {
    data: {
      hermes: {
        preferences: {
          get: (key: string, fallback: unknown) =>
            key in prefs ? prefs[key] : fallback,
        },
      },
    },
    log: () => {},
  } as unknown as Addon;
  return addon;
}

function installZoteroGlobals(fs: MockFs) {
  // Build a mock Zotero by SPREADING the real object and overriding only
  // the methods ConversationManager needs. This preserves HTTP, Promise,
  // Utilities, and everything else the test runner's reporter depends on
  // (it calls Zotero.HTTP.request to stream results back to the server).
  // Direct property assignment on the real Zotero.File fails — some
  // properties (putContents/getContents) are read-only in the sandbox.
  // Components is a read-only global in the Firefox sandbox and already
  // provides nsIFile.DIRECTORY_TYPE, so it is NOT mocked here.
  const realZotero = (globalThis as any).Zotero;
  (globalThis as any).__realZotero = realZotero;
  (globalThis as any).Zotero = {
    ...realZotero,
    // Real Zotero 10 sets `Profile.dir` to a plain STRING path
    // (xpcom/profile.js:30) and `DataDirectory.dir` likewise; the plugin
    // resolves both through Zotero.File.pathToFile. Model that shape here —
    // mocking getProfileDirectory() as an nsIFile masked the production bug
    // where `.clone()` was called on the string.
    Profile: { ...(realZotero?.Profile || {}), dir: fs.profileDir || "" },
    DataDirectory: {
      ...(realZotero?.DataDirectory || {}),
      dir: fs.profileDir ? fs.profileDir : "",
    },
    // When profileDir is null there is no fallback data directory either, so
    // ConversationManager cannot persist anywhere.
    getZoteroDirectory: () =>
      fs.profileDir ? realZotero?.getZoteroDirectory?.() : null,
    File: {
      ...realZotero?.File,
      pathToFile: (path: string) => fs.pathToFile(path),
      putContents: (file: MockFile, contents: string) =>
        fs.putContents(file, contents),
      getContents: (file: MockFile) => fs.getContents(file),
    },
  };
}

function restoreZoteroGlobals() {
  // Restore the real Zotero so later test files see the real global.
  (globalThis as any).Zotero = (globalThis as any).__realZotero;
  delete (globalThis as any).__realZotero;
}

describe("ConversationManager", function () {
  after(function () {
    restoreZoteroGlobals();
  });

  it("should create a conversation and persist it to disk", function () {
    const fs = new MockFs();
    installZoteroGlobals(fs);
    const manager = new ConversationManager(makeAddon(fs));

    const conv = manager.createConversation("My conversation");
    expect(conv.id).to.match(/^conv_/);
    expect(conv.title).to.equal("My conversation");
    expect(manager.getCurrentConversation()?.id).to.equal(conv.id);

    const expectedPath = `${fs.profileDir}/zotero-hermes/hermes/${conv.id}.json`;
    expect(fs.files.has(expectedPath)).to.be.true;
  });

  it("should default the title when none is given", function () {
    const fs = new MockFs();
    installZoteroGlobals(fs);
    const manager = new ConversationManager(makeAddon(fs));
    const conv = manager.createConversation();
    expect(conv.title).to.include("Conversation");
  });

  it("should load a conversation from disk", function () {
    const fs = new MockFs();
    installZoteroGlobals(fs);
    const manager = new ConversationManager(makeAddon(fs));

    const created = manager.createConversation("Persisted");
    const loaded = manager.loadConversation(created.id);
    expect(loaded).to.not.be.null;
    expect(loaded?.title).to.equal("Persisted");
    expect(manager.getCurrentConversation()?.id).to.equal(created.id);
  });

  it("should return null when loading a missing conversation", function () {
    const fs = new MockFs();
    installZoteroGlobals(fs);
    const manager = new ConversationManager(makeAddon(fs));
    expect(manager.loadConversation("conv_missing")).to.be.null;
  });

  it("should delete a conversation and clear current", function () {
    const fs = new MockFs();
    installZoteroGlobals(fs);
    const manager = new ConversationManager(makeAddon(fs));

    const conv = manager.createConversation("To delete");
    const deleted = manager.deleteConversation(conv.id);
    expect(deleted).to.be.true;
    expect(manager.getCurrentConversation()).to.be.null;
    expect(manager.loadConversation(conv.id)).to.be.null;
  });

  it("should list all conversations sorted by updatedAt desc", function () {
    const fs = new MockFs();
    installZoteroGlobals(fs);
    const manager = new ConversationManager(makeAddon(fs));

    const older = manager.createConversation("Older");
    const newer = manager.createConversation("Newer");
    // saveConversation() resets updatedAt to Date.now(), so bump the
    // timestamps AFTER saving to simulate a later update on `newer`.
    newer.updatedAt = older.updatedAt + 1000;

    const all = manager.getAllConversations();
    expect(all.map((c) => c.title)).to.deep.equal(["Newer", "Older"]);
  });

  it("should use by-date organisation when configured", function () {
    const fs = new MockFs();
    installZoteroGlobals(fs);
    const manager = new ConversationManager(
      makeAddon(fs, { conversationOrganization: "by-date" }),
    );

    const conv = manager.createConversation("Dated");
    const now = new Date();
    const monthDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const expectedPath = `${fs.profileDir}/zotero-hermes/hermes/${monthDir}/${conv.id}.json`;
    expect(fs.files.has(expectedPath)).to.be.true;
  });

  it("should not persist when no profile or data directory exists", function () {
    const fs = new MockFs();
    fs.profileDir = null;
    installZoteroGlobals(fs);
    const manager = new ConversationManager(makeAddon(fs));

    const conv = manager.createConversation("No dir");
    // No file should be written anywhere
    expect(fs.files.size).to.equal(0);
    // In-memory state still works
    expect(manager.getCurrentConversation()?.id).to.equal(conv.id);
  });

  it("should clear messages on the current conversation", function () {
    const fs = new MockFs();
    installZoteroGlobals(fs);
    const manager = new ConversationManager(makeAddon(fs));

    const conv = manager.createConversation("Clear me");
    conv.messages = [
      {
        id: "m1",
        role: "user",
        content: "hi",
        timestamp: 1,
      } as any,
    ];
    manager.saveConversation(conv);

    manager.clearMessages();
    expect(manager.getCurrentConversation()?.messages).to.have.length(0);
  });

  it("should not mutate currentConversation when listing history (M1 regression)", function () {
    const fs = new MockFs();
    installZoteroGlobals(fs);
    const manager = new ConversationManager(makeAddon(fs));

    const current = manager.createConversation("Current");
    current.messages = [
      { id: "m1", role: "user", content: "active chat", timestamp: 1 } as any,
    ];
    manager.saveConversation(current);

    // A second conversation on disk
    const older = manager.createConversation("Older");
    manager.saveConversation(older);

    // Switch the active conversation back to "Current" — it must survive
    // a subsequent loadAllConversations() unchanged.
    manager.setCurrentConversation(current.id);

    try {
      const listed = manager.loadAllConversations();
      expect(listed.length).to.equal(2);
      // The list operation must not have clobbered the active conversation.
      expect(manager.getCurrentConversation()?.id).to.equal(current.id);
      expect(manager.getCurrentConversation()?.title).to.equal("Current");
      expect(manager.getCurrentConversation()?.messages).to.have.length(1);
    } catch (err) {
      // AGENTS.md gotcha: chai assertion messages are lost in the reporter;
      // surface the message via window.debug when available.
      (window as any).debug?.(`M1 failure: ${(err as Error).message}`);
      throw err;
    }
  });

  it("should reject path traversal in conversation IDs", function () {
    const fs = new MockFs();
    installZoteroGlobals(fs);
    const manager = new ConversationManager(makeAddon(fs));

    expect(manager.isValidId("conv_123_abc")).to.be.true;
    expect(manager.isValidId("../secret")).to.be.false;
    expect(manager.isValidId("../../etc/passwd")).to.be.false;
    expect(manager.isValidId("foo/bar")).to.be.false;
    expect(manager.isValidId("foo\\bar")).to.be.false;

    // load and delete should gracefully reject path traversal attempts
    expect(manager.loadConversation("../../etc/passwd")).to.be.null;
    expect(manager.deleteConversation("../../etc/passwd")).to.be.false;
  });
});
