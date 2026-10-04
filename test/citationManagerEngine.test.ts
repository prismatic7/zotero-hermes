import { expect } from "chai";
import {
  CitationManager,
  DEFAULT_STYLE_ID,
  type CitationFormat,
} from "../src/modules/hermes/CitationManager";

/**
 * A stand-in for Zotero's CSL engine.
 *
 * The methods and call signatures here are copied from how Zotero 10 itself
 * drives the engine — `quickCopy.js:46` (`getCiteProc(locale, format, {cache})`)
 * and `cite.js:17` (`previewCitationCluster({citationItems, properties}, [], [], format)`).
 * The point of the fake is to catch a regression back to the old
 * `appendCitationCluster(citation, true)` call, which does not exist in the
 * Zotero 10 bridge.
 */
class FakeEngine {
  public freed = false;
  public items: number[] = [];
  public format: CitationFormat;
  /** Every previewCitationCluster call, so argument shape is assertable. */
  public previews: Array<{ citation: any; pre: any[]; post: any[] }> = [];
  public bibliography: [any, string[]] | null = null;

  constructor(format: CitationFormat) {
    this.format = format;
  }

  updateItems(ids: number[]): void {
    this.items = ids;
  }

  previewCitationCluster(
    citation: any,
    pre: any[],
    post: any[],
    _format?: string,
  ): string {
    this.previews.push({ citation, pre, post });
    const ids = (citation.citationItems || []).map((c: any) => c.id);
    return ids.map((id: number) => `Cite(${id})`).join("; ");
  }

  makeBibliography(): [any, string[]] | null {
    return this.bibliography;
  }

  free(): void {
    this.freed = true;
  }
}

/** Install a Zotero stub whose Styles.get returns a fake cite-process engine. */
function stubZotero(opts: {
  visibleStyles?: Array<{
    styleID: string;
    title: string;
    shortTitle?: string;
  }>;
  lastStyle?: string;
  bibliography?: [any, string[]] | null;
}) {
  const realZotero = (globalThis as any).Zotero;
  const engines: FakeEngine[] = [];

  const visible = opts.visibleStyles ?? [
    {
      styleID: DEFAULT_STYLE_ID,
      title: "American Psychological Association 7th edition",
      shortTitle: "APA",
    },
    {
      styleID: "http://www.zotero.org/styles/chicago-author-date",
      title: "Chicago Manual of Style 17th edition (author-date)",
      shortTitle: "Chicago",
    },
  ];

  (globalThis as any).Zotero = {
    ...realZotero,
    Prefs: {
      ...(realZotero?.Prefs || {}),
      get: (key: string) =>
        key === "export.lastStyle"
          ? (opts.lastStyle ?? DEFAULT_STYLE_ID)
          : undefined,
    },
    Styles: {
      ...(realZotero?.Styles || {}),
      // Real Zotero.Styles.get() is keyed on the styleID URI only — it does
      // NOT accept a short title. The stub must match, or it hides the fact
      // that "chicago" has to be resolved through getVisible().
      get: (id: string) => {
        const found = visible.find((s) => s.styleID === id);
        if (!found) return null;
        return {
          styleID: found.styleID,
          title: found.title,
          shortTitle: found.shortTitle,
          getCiteProc: (locale: unknown, format: CitationFormat) => {
            const engine = new FakeEngine(format || "text");
            engine.bibliography = opts.bibliography ?? null;
            engines.push(engine);
            return engine;
          },
        };
      },
      getVisible: () => visible,
    },
    Items: {
      ...(realZotero?.Items || {}),
      get: (id: number) => ({ id }),
    },
  };

  return { engines, restore: () => ((globalThis as any).Zotero = realZotero) };
}

const mockAddon: any = { data: {}, log: () => {} };

describe("CitationManager engine handling", function () {
  let restore: () => void;

  afterEach(function () {
    restore?.();
  });

  it("uses previewCitationCluster, not appendCitationCluster", function () {
    const stub = stubZotero({});
    restore = stub.restore;
    const manager = new CitationManager(mockAddon);

    const citations = manager.generateCitations([{ id: 5 } as Zotero.Item]);

    expect(citations).to.deep.equal(["Cite(5)"]);
    const engine = stub.engines[0];
    expect(engine.previews).to.have.length(1);
    // Argument shape copied from cite.js:17 — properties must be present.
    expect(engine.previews[0].citation.citationItems).to.deep.equal([
      { id: 5 },
    ]);
    expect(engine.previews[0].citation.properties).to.deep.equal({});
    expect(engine.previews[0].pre).to.deep.equal([]);
    expect(engine.previews[0].post).to.deep.equal([]);
  });

  it("frees the cite-process engine after use", function () {
    const stub = stubZotero({});
    restore = stub.restore;
    const manager = new CitationManager(mockAddon);

    manager.generateCitations([{ id: 1 } as Zotero.Item]);

    expect(stub.engines[0].freed).to.equal(true);
  });

  it("frees the engine even when rendering throws", function () {
    const stub = stubZotero({});
    restore = stub.restore;
    const manager = new CitationManager(mockAddon);
    // Make updateItems blow up after the engine exists.
    const original = FakeEngine.prototype.updateItems;
    FakeEngine.prototype.updateItems = function () {
      throw new Error("engine exploded");
    };

    try {
      const result = manager.generateCitations([{ id: 1 } as Zotero.Item]);
      expect(result).to.deep.equal([]);
      expect(stub.engines[0].freed).to.equal(true);
    } finally {
      FakeEngine.prototype.updateItems = original;
    }
  });

  it("renders each item as its own citation", function () {
    const stub = stubZotero({});
    restore = stub.restore;
    const manager = new CitationManager(mockAddon);

    const citations = manager.generateCitations([
      { id: 1 } as Zotero.Item,
      { id: 2 } as Zotero.Item,
    ]);

    expect(citations).to.deep.equal(["Cite(1)", "Cite(2)"]);
    expect(stub.engines[0].previews).to.have.length(2);
  });

  it("merges items into a single cluster on request", function () {
    const stub = stubZotero({});
    restore = stub.restore;
    const manager = new CitationManager(mockAddon);

    const cluster = manager.generateCitationCluster([
      { id: 1 } as Zotero.Item,
      { id: 2 } as Zotero.Item,
    ]);

    expect(cluster).to.equal("Cite(1); Cite(2)");
    expect(stub.engines[0].previews).to.have.length(1);
  });

  it("returns null when the style cannot be resolved", function () {
    const stub = stubZotero({ lastStyle: "http://example.org/missing" });
    restore = stub.restore;
    const manager = new CitationManager(mockAddon);

    expect(
      manager.generateCitationCluster([{ id: 1 } as Zotero.Item]),
    ).to.equal(null);
    expect(manager.generateCitations([{ id: 1 } as Zotero.Item])).to.deep.equal(
      [],
    );
  });
});

describe("CitationManager bibliographies", function () {
  let restore: () => void;

  afterEach(function () {
    restore?.();
  });

  it("returns the entry array from makeBibliography's [meta, entries] shape", function () {
    const stub = stubZotero({
      bibliography: [{}, ["Schafer, R. M. (1977). <i>The soundscape</i>."]],
    });
    restore = stub.restore;
    const manager = new CitationManager(mockAddon);

    const entries = manager.generateBibliographyEntries([
      { id: 1 } as Zotero.Item,
    ]);

    expect(entries).to.have.length(1);
    // Markup must be stripped for a text-format consumer.
    expect(entries[0]).to.equal("Schafer, R. M. (1977). The soundscape.");
  });

  it("returns [] when the engine yields no bibliography", function () {
    const stub = stubZotero({ bibliography: null });
    restore = stub.restore;
    const manager = new CitationManager(mockAddon);

    expect(
      manager.generateBibliographyEntries([{ id: 1 } as Zotero.Item]),
    ).to.deep.equal([]);
  });

  it("joins entries for the string convenience method", function () {
    const stub = stubZotero({ bibliography: [{}, ["First.", "Second."]] });
    restore = stub.restore;
    const manager = new CitationManager(mockAddon);

    expect(
      manager.generateBibliographyWithStyle(
        [{ id: 1 } as Zotero.Item],
        DEFAULT_STYLE_ID,
      ),
    ).to.equal("First.\nSecond.");
  });
});

describe("CitationManager.formatCitation", function () {
  let restore: () => void;

  afterEach(function () {
    restore?.();
  });

  it("resolves a style by short name (what a user types)", function () {
    const stub = stubZotero({});
    restore = stub.restore;
    const manager = new CitationManager(mockAddon);

    const result = manager.formatCitation({ id: 7 } as Zotero.Item, {
      styleName: "chicago",
    });

    expect(result.error).to.equal(undefined);
    expect(result.value).to.equal("Cite(7)");
    expect(result.styleID).to.equal(
      "http://www.zotero.org/styles/chicago-author-date",
    );
    expect(result.styleName).to.include("Chicago");
  });

  it("reports an unknown style instead of silently using a default", function () {
    const stub = stubZotero({});
    restore = stub.restore;
    const manager = new CitationManager(mockAddon);

    const result = manager.formatCitation({ id: 7 } as Zotero.Item, {
      styleName: "harvard-does-not-exist",
    });

    expect(result.value).to.equal(null);
    expect(result.error).to.include("Unknown citation style");
  });

  it("produces a bibliography entry for kind=note", function () {
    const stub = stubZotero({
      bibliography: [{}, ["Schafer, R. M. (1977). The soundscape."]],
    });
    restore = stub.restore;
    const manager = new CitationManager(mockAddon);

    const result = manager.formatCitation({ id: 3 } as Zotero.Item, {
      kind: "note",
    });

    expect(result.kind).to.equal("note");
    expect(result.value).to.equal("Schafer, R. M. (1977). The soundscape.");
  });

  it("defaults to an in-text citation in the configured style", function () {
    const stub = stubZotero({});
    restore = stub.restore;
    const manager = new CitationManager(mockAddon);

    const result = manager.formatCitation({ id: 9 } as Zotero.Item);

    expect(result.kind).to.equal("in-text");
    expect(result.styleID).to.equal(DEFAULT_STYLE_ID);
    expect(result.value).to.equal("Cite(9)");
  });
});
