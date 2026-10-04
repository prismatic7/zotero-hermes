/**
 * External bibliographic lookups: DOI resolution and citation graphs.
 *
 * WHY THIS IS SHAPED THIS WAY
 * ---------------------------
 * Every API used here was verified live before the parser was written, because
 * a parser coded against a remembered JSON shape fails silently — it returns
 * `undefined` and the caller shows an empty result rather than an error. The
 * shapes below match observed responses:
 *
 *   CrossRef  GET /works/{doi}                     → { message: {...} }
 *   CrossRef  GET /works?query.bibliographic={t}   → { message: { items: [...] } }
 *   DataCite  GET /dois/{doi}                      → { data: { attributes: {...} } }
 *   S2        GET /paper/DOI:{doi}/citations       → { data: [{ citingPaper: {...} }] }
 *             fields=title,year,venue,externalIds
 *
 * Observed: CrossRef returns `type: "journal-article"`, `author[].family`,
 * `issued.date-parts`, `container-title[]`, `volume`, `page`, `publisher`.
 * Semantic Scholar returns `citingPaper.{title, year, venue, externalIds.DOI}`
 * and — importantly — responds `{error: "..."}` with HTTP 200 for an unknown
 * paper rather than a 404, so the body must be checked, not just the status.
 *
 * RATE LIMITS: Semantic Scholar throttles unauthenticated callers aggressively.
 * A single-user desktop plugin stays well under any published limit, but a bulk
 * pass would not — so bulk callers must pace themselves. No figure is asserted
 * here because none has been measured against this API from this machine.
 */

import type Addon from "../../addon";

export interface LookupAuthor {
  firstName?: string;
  lastName: string;
  creatorType: "author" | "editor" | "translator" | "director";
}

/** Normalised bibliographic record, in Zotero's vocabulary. */
export interface LookupRecord {
  doi: string;
  title: string;
  /** Zotero item type, e.g. `journalArticle`, `book`, `bookSection`. */
  itemType: string;
  creators: LookupAuthor[];
  /** Raw date string as supplied by the source (not normalised). */
  date?: string;
  year?: number;
  abstract?: string;
  publicationTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  place?: string;
  ISBN?: string;
  ISSN?: string;
  url?: string;
  /** Which service answered — useful when a field looks wrong. */
  source: "crossref" | "datacite";
}

/** One entry in a citation graph. */
export interface CitationRecord {
  title: string;
  year?: number;
  venue?: string;
  doi?: string;
  /** True when the citing work is already in the user's library. */
  inLibrary?: boolean;
  existingItemID?: number;
}

export interface LookupOptions {
  /** Override for tests; defaults to `Zotero.HTTP.request`. */
  httpRequest?: (
    method: string,
    url: string,
    options?: Record<string, unknown>,
  ) => Promise<{ status: number; responseText?: string }>;
  /** Extra seconds before giving up. Default 20. */
  timeoutMs?: number;
  /**
   * Semantic Scholar API key. When present it is sent as `x-api-key`, which
   * raises the rate limit. Absent, the calls still work but are throttled.
   */
  semanticScholarApiKey?: string;
}

const USER_AGENT =
  "hermes-zotero/0.4 (https://github.com/techne-tools/zotero-hermes)";

/**
 * Map a CrossRef/DataCite `type` to a Zotero item type.
 * Anything unrecognised falls back to `journalArticle` rather than guessing —
 * the wrong item type is visible and fixable; a silently wrong one is not.
 */
export function crossrefTypeToZotero(type: string | undefined): string {
  switch ((type || "").toLowerCase()) {
    case "journal-article":
      return "journalArticle";
    case "book":
      return "book";
    case "book-chapter":
    case "book-section":
    case "book-part":
      return "bookSection";
    case "monograph":
      return "book";
    case "proceedings-article":
      return "conferencePaper";
    case "dissertation":
      return "thesis";
    case "report":
      return "report";
    case "posted-content":
      return "preprint";
    case "dataset":
      return "dataset";
    case "peer-review":
      return "journalArticle";
    default:
      return "journalArticle";
  }
}

/** Normalise a DOI for comparison: strip resolver prefixes, lowercase. */
export function normaliseDoi(raw: string): string {
  return (raw || "")
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase();
}

/** True when a string looks like a DOI. */
export function isDoiLike(raw: string): boolean {
  return /^10\.\d{4,9}\/\S+$/.test(normaliseDoi(raw));
}

export class LookupManager {
  private readonly addon: Addon;

  constructor(addon: Addon) {
    this.addon = addon;
  }

  private request(
    opts: LookupOptions,
  ): NonNullable<LookupOptions["httpRequest"]> {
    if (opts.httpRequest) return opts.httpRequest;
    return (method, url, options) =>
      (Zotero as any).HTTP.request(method, url, options);
  }

  private headers(opts: LookupOptions): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    if (opts.semanticScholarApiKey) {
      headers["x-api-key"] = opts.semanticScholarApiKey;
    }
    return headers;
  }

  private async getJson<T>(
    url: string,
    opts: LookupOptions,
  ): Promise<T | null> {
    const request = this.request(opts);
    try {
      const response = await request("GET", url, {
        headers: this.headers(opts),
        responseType: "json",
        timeout: opts.timeoutMs ?? 20000,
        successCodes: false,
      });
      // Zotero.HTTP returns the parsed object directly when responseType is
      // "json"; fall back to parsing responseText so a mock or a non-JSON
      // response type still works.
      const body = (response as any).response ?? (response as any).body;
      if (body && typeof body === "object") return body as T;
      if (typeof (response as any).responseText === "string") {
        return JSON.parse((response as any).responseText) as T;
      }
      return null;
    } catch (error) {
      this.addon.log?.(`[lookup] ${url} failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Resolve a DOI to a bibliographic record.
   *
   * Tries CrossRef first, then DataCite — DataCite covers datasets, software
   * and some books/press titles that CrossRef does not index. Returns null when
   * neither knows the DOI, which is a legitimate outcome (a typo'd DOI), not an
   * error.
   */
  public async lookupDoi(
    doi: string,
    opts: LookupOptions = {},
  ): Promise<LookupRecord | null> {
    const clean = normaliseDoi(doi);
    if (!isDoiLike(clean)) {
      this.addon.log?.(`[lookup] not a DOI: ${doi}`);
      return null;
    }

    const crossref = await this.getJson<any>(
      `https://api.crossref.org/works/${encodeURIComponent(clean)}`,
      opts,
    );
    if (crossref?.message) {
      return this.fromCrossref(crossref.message);
    }

    const datacite = await this.getJson<any>(
      `https://api.datacite.org/dois/${encodeURIComponent(clean)}`,
      opts,
    );
    if (datacite?.data?.attributes) {
      return this.fromDatacite(datacite.data.attributes, clean);
    }

    return null;
  }

  /**
   * Find a DOI from a title (and optional author) via CrossRef's
   * bibliographic query.
   *
   * Returns the best match or null. Deliberately does NOT auto-apply: a
   * bibliographic query returns *approximate* matches, and writing an
   * approximate DOI into the user's library is worse than writing none.
   */
  public async findDoiByTitle(
    title: string,
    opts: LookupOptions & { author?: string; year?: string } = {},
  ): Promise<LookupRecord | null> {
    const query = [title, opts.author, opts.year].filter(Boolean).join(" ");
    if (!query.trim()) return null;

    const data = await this.getJson<any>(
      `https://api.crossref.org/works?rows=5&query.bibliographic=${encodeURIComponent(query)}`,
      opts,
    );
    const items: any[] = data?.message?.items || [];
    if (items.length === 0) return null;

    // Prefer the candidate whose title matches most closely, rather than
    // trusting CrossRef's ordering.
    const target = title.toLowerCase().trim();
    const scored = items
      .map((item) => {
        const candidate = ((item.title || [])[0] || "").toLowerCase().trim();
        let score = 0;
        if (candidate === target) score = 100;
        else if (candidate.startsWith(target) || target.startsWith(candidate))
          score = 75;
        else if (candidate.includes(target) || target.includes(candidate))
          score = 50;
        return { item, score };
      })
      .sort((a, b) => b.score - a.score);

    if (scored[0].score === 0) return null;
    return this.fromCrossref(scored[0].item);
  }

  /**
   * Reverse citation lookup: which works cite this DOI?
   *
   * Uses Semantic Scholar's citation graph. `inLibrary` is populated by the
   * caller-supplied matcher so the UI can show "already in your library".
   */
  public async findCitingWorks(
    doi: string,
    opts: LookupOptions & {
      limit?: number;
      isInLibrary?: (doi: string) => { id: number } | null;
    } = {},
  ): Promise<CitationRecord[]> {
    const clean = normaliseDoi(doi);
    if (!isDoiLike(clean)) return [];

    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    const data = await this.getJson<any>(
      `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(clean)}` +
        `/citations?fields=title,year,venue,externalIds&limit=${limit}`,
      opts,
    );

    // S2 answers HTTP 200 with an `error` body for an unknown paper.
    if (!data || data.error || !Array.isArray(data.data)) {
      this.addon.log?.(
        `[lookup] Semantic Scholar: ${data?.error || "no citation data"} for ${clean}`,
      );
      return [];
    }

    return data.data
      .map((entry: any) => entry?.citingPaper)
      .filter(Boolean)
      .map((paper: any): CitationRecord => {
        const citingDoi = paper.externalIds?.DOI
          ? normaliseDoi(paper.externalIds.DOI)
          : undefined;
        const match = citingDoi ? opts.isInLibrary?.(citingDoi) : null;
        return {
          title: paper.title || "(untitled)",
          year: typeof paper.year === "number" ? paper.year : undefined,
          venue: paper.venue || undefined,
          doi: citingDoi,
          inLibrary: Boolean(match),
          existingItemID: match?.id,
        };
      });
  }

  // ---- normalisers -------------------------------------------------------

  private fromCrossref(message: any): LookupRecord {
    const creators: LookupAuthor[] = (message.author || []).map((a: any) => ({
      firstName: a.given || undefined,
      lastName: a.family || a.name || "(unknown)",
      creatorType: "author" as const,
    }));

    const dateParts = message.issued?.["date-parts"]?.[0];
    const year =
      Array.isArray(dateParts) && typeof dateParts[0] === "number"
        ? dateParts[0]
        : undefined;
    const date = Array.isArray(dateParts)
      ? dateParts.filter((p: unknown) => p != null).join("-")
      : undefined;

    return {
      doi: normaliseDoi(message.DOI || ""),
      title: (message.title || [])[0] || "(untitled)",
      itemType: crossrefTypeToZotero(message.type),
      creators,
      date,
      year,
      abstract: message.abstract
        ? String(message.abstract)
            .replace(/<[^>]+>/g, "")
            .trim()
        : undefined,
      publicationTitle: (message["container-title"] || [])[0] || undefined,
      volume: message.volume || undefined,
      issue: message.issue || undefined,
      pages: message.page || undefined,
      publisher: message.publisher || undefined,
      place: message["publisher-location"] || undefined,
      ISBN: (message.ISBN || [])[0] || undefined,
      ISSN: (message.ISSN || [])[0] || undefined,
      url: message.URL || undefined,
      source: "crossref",
    };
  }

  private fromDatacite(attributes: any, doi: string): LookupRecord {
    const creators: LookupAuthor[] = (attributes.creators || []).map(
      (c: any) => ({
        firstName: c.givenName || undefined,
        lastName: c.familyName || c.name || "(unknown)",
        creatorType: "author" as const,
      }),
    );

    const year =
      typeof attributes.publicationYear === "number"
        ? attributes.publicationYear
        : undefined;

    return {
      doi: normaliseDoi(attributes.doi || doi),
      title:
        (attributes.titles || [])[0]?.title || attributes.title || "(untitled)",
      itemType: crossrefTypeToZotero(attributes.types?.resourceTypeGeneral),
      creators,
      date: year ? String(year) : undefined,
      year,
      publicationTitle: attributes.container?.title || undefined,
      publisher: attributes.publisher || undefined,
      url: attributes.url || undefined,
      source: "datacite",
    };
  }
}
