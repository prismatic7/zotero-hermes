import type Addon from "../../addon";

/** Output formats the CSL engine can produce. */
export type CitationFormat = "text" | "html";

/**
 * Which flavour of citation to produce.
 *
 * `in-text` is `previewCitationCluster` — "(Schafer, 1977)" style.
 * `note` is the *bibliography entry for one item* — "Schafer, R. M. (1977).
 * The soundscape…" — which is what a footnote-style citation actually needs.
 */
export type CitationKind = "in-text" | "note";

export interface CitationResult {
  /** The rendered citation string, or null when generation failed. */
  value: string | null;
  /** The style actually used, for display. */
  styleName: string;
  styleID: string;
  format: CitationFormat;
  kind: CitationKind;
  /** Populated when `value` is null. */
  error?: string;
}

/** Zotero's own default when no style is configured. */
export const DEFAULT_STYLE_ID = "http://www.zotero.org/styles/apa";

/**
 * Manages citation generation using Zotero's configured citation style.
 *
 * API NOTE (verified against Zotero 10.0.5 source)
 * ------------------------------------------------
 * Citations are produced with `previewCitationCluster(citation, [], [], format)`,
 * which is what Zotero's own `quickCopy.js` and `cite.js` use. It does not
 * mutate engine state, so repeated calls for different items are independent.
 *
 * The previous implementation called `appendCitationCluster(citation, true)`
 * and assumed the citeproc-js return shape `[[id, string], …]`. Zotero 10 uses
 * the citeproc-rs bridge, whose `appendCitationCluster(citation)` takes **one**
 * argument and returns a differently-shaped object — so that call was silently
 * unusable. Do not reintroduce it.
 *
 * The engine is `free()`d after use: a cite-process engine holds a wasm
 * instance, and leaking one per citation is a real cost in a long session.
 */
export class CitationManager {
  private readonly addon: Addon;

  constructor(addon: Addon) {
    this.addon = addon;
  }

  public getCurrentStyle(): string {
    return (Zotero.Prefs.get("export.lastStyle") as string) || DEFAULT_STYLE_ID;
  }

  public getCurrentStyleName(): string {
    const styleID = this.getCurrentStyle();
    const style = Zotero.Styles.get(styleID);
    return style?.title || "Unknown Style";
  }

  public generateCitation(itemID: number): string | null {
    const item = Zotero.Items.get(itemID);
    if (!item) return null;
    const citations = this.generateCitations([item]);
    return citations.length > 0 ? citations[0] : null;
  }

  /** Render a cite-process engine string and always release the engine. */
  private withEngine<T>(
    styleID: string,
    format: CitationFormat,
    fn: (cslEngine: any) => T,
  ): T | null {
    let cslEngine: any = null;
    try {
      const style = Zotero.Styles.get(styleID);
      if (!style) throw new Error(`Citation style not found: ${styleID}`);
      // `getCiteProc(locale, format, { cache })` — matches quickCopy.js:46.
      cslEngine = style.getCiteProc(undefined, format, { cache: true });
      return fn(cslEngine);
    } catch (error) {
      this.addon.log("Citation generation failed:", error);
      return null;
    } finally {
      try {
        cslEngine?.free?.();
      } catch {
        // A failure to free must not mask the real result.
      }
    }
  }

  /**
   * Render a citation for each item, individually ("Schafer 1977; Ingold 2000"
   * as separate strings rather than one merged cluster).
   */
  public generateCitations(
    items: Zotero.Item[],
    opts: { format?: CitationFormat; styleID?: string } = {},
  ): string[] {
    if (items.length === 0) return [];
    const format = opts.format ?? "text";
    const styleID = opts.styleID ?? this.getCurrentStyle();

    const result = this.withEngine(styleID, format, (cslEngine) => {
      cslEngine.updateItems(items.map((item) => item.id));
      return items.map((item) =>
        String(
          cslEngine.previewCitationCluster(
            { citationItems: [{ id: item.id }], properties: {} },
            [],
            [],
            format,
          ),
        ),
      );
    });

    return result ?? [];
  }

  /** Render items as one merged citation cluster, e.g. "(Schafer 1977; Ingold 2000)". */
  public generateCitationCluster(
    items: Zotero.Item[],
    opts: { format?: CitationFormat; styleID?: string } = {},
  ): string | null {
    if (items.length === 0) return null;
    const format = opts.format ?? "text";
    const styleID = opts.styleID ?? this.getCurrentStyle();

    return this.withEngine(styleID, format, (cslEngine) => {
      cslEngine.updateItems(items.map((item) => item.id));
      return String(
        cslEngine.previewCitationCluster(
          {
            citationItems: items.map((item) => ({ id: item.id })),
            properties: {},
          },
          [],
          [],
          format,
        ),
      );
    });
  }

  public generateBibliography(items: Zotero.Item[]): string | null {
    if (items.length === 0) return null;
    return this.generateBibliographyWithStyle(items, this.getCurrentStyle());
  }

  /**
   * Full bibliography, one entry per item, as an array of rendered strings.
   *
   * The citeproc-rs bridge's `makeBibliography()` returns
   * `[meta, strings]` in citeproc-js shape (see `citeprocRsBridge.js:247`),
   * so `bib[1]` is the entry array.
   */
  public generateBibliographyEntries(
    items: Zotero.Item[],
    opts: { format?: CitationFormat; styleID?: string } = {},
  ): string[] {
    if (items.length === 0) return [];
    const format = opts.format ?? "text";
    const styleID = opts.styleID ?? this.getCurrentStyle();

    const result = this.withEngine(styleID, format, (cslEngine) => {
      cslEngine.updateItems(items.map((item) => item.id));
      const bib = cslEngine.makeBibliography();
      const entries = bib?.[1];
      if (!Array.isArray(entries)) return [];
      return entries.map((e: unknown) =>
        String(e)
          .replace(/<[^>]+>/g, "")
          .trim(),
      );
    });

    return result ?? [];
  }

  public getStyleByIDOrName(name: string): string | null {
    const query = name.toLowerCase().trim();
    if (!query) return null;

    // A full styleID URI resolves directly. Zotero may map a *renamed* style,
    // so return the style's own `styleID`, never the raw query the caller typed.
    const direct = Zotero.Styles.get(query);
    if (direct) return direct.styleID;

    const styles = Zotero.Styles.getVisible();
    for (const style of styles) {
      if (
        style.title.toLowerCase() === query ||
        (style.shortTitle && style.shortTitle.toLowerCase() === query)
      ) {
        return style.styleID;
      }
    }

    for (const style of styles) {
      if (
        style.title.toLowerCase().includes(query) ||
        (style.shortTitle && style.shortTitle.toLowerCase().includes(query))
      ) {
        return style.styleID;
      }
    }

    return null;
  }

  public generateCitationWithStyle(
    itemID: number,
    styleID: string,
    opts: { format?: CitationFormat } = {},
  ): string | null {
    const item = Zotero.Items.get(itemID);
    if (!item) return null;
    const citations = this.generateCitations([item], {
      styleID,
      format: opts.format,
    });
    return citations.length > 0 ? citations[0] : null;
  }

  public generateBibliographyWithStyle(
    items: Zotero.Item[],
    styleID: string,
    opts: { format?: CitationFormat } = {},
  ): string | null {
    const entries = this.generateBibliographyEntries(items, {
      styleID,
      format: opts.format,
    });
    return entries.length > 0 ? entries.join("\n") : null;
  }

  /**
   * The full citation picture for an item: in-text form plus its bibliography
   * entry, in a named style, with the style actually resolved.
   *
   * This is the entry point the UI and slash commands should use — it answers
   * "give me a clear citation" rather than requiring the caller to know which
   * of six methods to call.
   */
  public formatCitation(
    item: Zotero.Item,
    opts: {
      styleName?: string;
      format?: CitationFormat;
      kind?: CitationKind;
    } = {},
  ): CitationResult {
    const format = opts.format ?? "text";
    const kind = opts.kind ?? "in-text";

    // Accept a style *name* ("apa", "chicago-author-date") as well as an ID,
    // because that is what a user types.
    let styleID = this.getCurrentStyle();
    if (opts.styleName) {
      const resolved = this.getStyleByIDOrName(opts.styleName);
      if (!resolved) {
        return {
          value: null,
          styleName: opts.styleName,
          styleID: "",
          format,
          kind,
          error: `Unknown citation style "${opts.styleName}".`,
        };
      }
      styleID = resolved;
    }

    const styleName =
      Zotero.Styles.get(styleID)?.title || this.getCurrentStyleName();

    if (kind === "note") {
      const entries = this.generateBibliographyEntries([item], {
        styleID,
        format,
      });
      return {
        value: entries[0] ?? null,
        styleName,
        styleID,
        format,
        kind,
        error:
          entries.length === 0 ? "No bibliography entry produced." : undefined,
      };
    }

    const citations = this.generateCitations([item], { styleID, format });
    return {
      value: citations[0] ?? null,
      styleName,
      styleID,
      format,
      kind,
      error:
        citations.length === 0
          ? "No citation produced by the CSL engine."
          : undefined,
    };
  }

  public getCitekey(item: Zotero.Item): string {
    let citekey = "";
    try {
      if (typeof (item as any).getField === "function") {
        const raw = item.getField("citationKey" as any);
        if (raw && typeof raw === "string") citekey = raw;
      }
    } catch {
      // ignore
    }
    if (!citekey) {
      try {
        const bbt = (Zotero as any).BetterBibTeX?.KeyManager?.get?.(item.id);
        if (bbt?.citationKey) citekey = bbt.citationKey;
      } catch {
        // ignore
      }
    }
    if (!citekey) {
      try {
        const extra = (item.getField("extra") as string) || "";
        const m = extra.match(/(?:citation key|bibtex):\s*([^\s\n\r]+)/i);
        if (m && m[1]) citekey = m[1];
      } catch {
        // ignore
      }
    }
    if (!citekey) {
      const creator = item.getCreators?.()?.[0];
      const lastName =
        (creator as any)?.lastName || (creator as any)?.firstName || "Item";
      const rawDate = (item.getField("date") as string) || "";
      const year = rawDate.match(/\d{4}/)?.[0] || "";
      citekey = `${lastName.replace(/\W/g, "")}${year || "nd"}`;
    }
    return citekey;
  }

  public getCitationSnippets(item: Zotero.Item): {
    citekey: string;
    pandoc: string;
    latex: string;
    typst: string;
  } {
    const key = this.getCitekey(item);
    return {
      citekey: key,
      pandoc: `[@${key}]`,
      latex: `\\cite{${key}}`,
      typst: `@${key}`,
    };
  }
}
