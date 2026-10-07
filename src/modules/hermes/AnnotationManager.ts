import type Addon from "../../addon";
import {
  runWrite,
  type WriteContext,
  type WriteResult,
} from "../../utils/writeGate";

export interface AnnotationData {
  /** Zotero's 8-character item key for the annotation. */
  id: string;
  /** Numeric item id, needed to target an edit. */
  itemID?: number;
  page: number;
  /** `highlight` | `underline` | `note` | `text` | `image` | `ink`. */
  type: string;
  text: string;
  comment?: string;
  color?: string;
  position?: any;
  sortIndex?: string;
}

/** Editable annotation properties. A partial patch. */
export interface AnnotationPatch {
  /** Only legal on highlight/underline annotations. */
  text?: string;
  comment?: string;
  /** Must be a 6-digit hex colour, e.g. `#ffd400`. */
  color?: string;
  pageLabel?: string;
}

export interface AnnotationQuery {
  /** Substring match on annotation text. */
  text?: string;
  /** Substring match on the annotation comment. */
  comment?: string;
  type?: "highlight" | "underline" | "note" | "text" | "image" | "ink";
  color?: string;
  /** Restrict to annotations under these items (or their attachments). */
  itemIDs?: number[];
  limit?: number;
}

/** Verified against Zotero 10.0.5 `data/item.js:4530`. */
const TEXT_BEARING_TYPES = ["highlight", "underline"];
const VALID_TYPES = ["highlight", "underline", "note", "text", "image", "ink"];

/** Zotero rejects anything that is not a 6-digit hex colour (`item.js:4537`). */
const HEX_COLOUR = /^#[a-f0-9]{6}$/i;

const DEFAULT_COLOUR = "#ffd400";

/**
 * Manages annotation extraction, creation, editing and search.
 *
 * API CONTRACT (verified against Zotero 10.0.5 source)
 * ---------------------------------------------------
 * Creating an annotation by hand is order-sensitive, and getting it wrong
 * throws or produces a corrupt item:
 *
 *   1. `annotationType` MUST be set before any other property
 *      (`data/item.js:4510`).
 *   2. `annotationText` is only legal on `highlight`/`underline`
 *      (`data/item.js:4530`).
 *   3. `annotationColor` must match `/#[a-f0-9]{6}/` (`data/item.js:4537`).
 *   4. `annotationPosition` is the *only* geometry: there is no default rect,
 *      so a text annotation must supply one. Fabricating `rects: [[0,0,100,20]]`
 *      (as an earlier version did) writes a highlight somewhere it does not
 *      exist. This manager therefore refuses without a real position rather
 *      than inventing one.
 *
 * `Zotero.Annotations.saveFromJSON` is an *importer* — it requires an existing
 * key (`annotations.js:221`) — so it is not used for creation.
 */
export class AnnotationManager {
  private readonly addon: Addon;

  constructor(addon: Addon) {
    this.addon = addon;
  }

  private writeContext(): WriteContext {
    const hermes = this.addon.data?.hermes as any;
    return {
      approvalDialog: hermes?.approvalDialog ?? null,
      auditLog: hermes?.auditLog ?? null,
      log: (message: string, ...data: unknown[]) =>
        this.addon.log?.(message, ...data),
    };
  }

  /** Resolve the PDF attachment for an item, or the item itself if it is one. */
  private async resolveAttachment(itemID: number): Promise<Zotero.Item | null> {
    const item = await Zotero.Items.getAsync(itemID);
    if (!item) return null;
    if (item.isPDFAttachment?.()) return item;
    if (item.isRegularItem?.()) {
      try {
        const best = (await (item as any).getBestAttachment?.()) as
          Zotero.Item | false | undefined;
        if (best && best.isPDFAttachment?.()) return best;
      } catch (err) {
        this.addon.log("AnnotationManager: error getting best attachment", err);
      }
    }
    return null;
  }

  /** Normalise a Zotero annotation item into `AnnotationData`. */
  private toAnnotationData(ann: any): AnnotationData {
    return {
      id: ann.key,
      itemID: ann.id,
      page: ann.annotationPageLabel
        ? parseInt(ann.annotationPageLabel, 10) || 0
        : 0,
      type: ann.annotationType || "highlight",
      text: ann.annotationText || "",
      comment: ann.annotationComment || "",
      color: ann.annotationColor || "",
      sortIndex: ann.annotationSortIndex || undefined,
    };
  }

  /**
   * All annotations under an item (or a PDF attachment), sorted by page.
   */
  public async getAnnotations(itemID: number): Promise<AnnotationData[]> {
    const pdfItem = await this.resolveAttachment(itemID);
    if (!pdfItem) return [];

    const annotations: AnnotationData[] = [];
    try {
      if (typeof (pdfItem as any).getAnnotations === "function") {
        const nativeAnns = (pdfItem as any).getAnnotations() as any[];
        for (const ann of nativeAnns) {
          annotations.push(this.toAnnotationData(ann));
        }
      } else {
        const childIDs = pdfItem.getNotes();
        for (const childID of childIDs) {
          const child = await Zotero.Items.getAsync(childID);
          if (child && child.isAnnotation()) {
            annotations.push(this.toAnnotationData(child));
          }
        }
      }
    } catch (error) {
      this.addon.log("Error getting annotations:", error);
    }

    return annotations.sort((a, b) => a.page - b.page);
  }

  /** Read one annotation in full, by numeric id or by key. */
  public async readAnnotation(
    ref: number | string,
  ): Promise<AnnotationData | null> {
    try {
      const item =
        typeof ref === "number"
          ? await Zotero.Items.getAsync(ref)
          : Zotero.Items.getByLibraryAndKey(
              Zotero.Libraries.userLibraryID,
              ref,
            );
      if (!item || !item.isAnnotation?.()) return null;
      return this.toAnnotationData(item);
    } catch (error) {
      this.addon.log(`Error reading annotation ${ref}:`, error);
      return null;
    }
  }

  /** All annotations across several items, grouped by their parent item id. */
  public async getAnnotationsForItems(
    itemIDs: number[],
  ): Promise<Map<number, AnnotationData[]>> {
    const result = new Map<number, AnnotationData[]>();
    for (const id of itemIDs) {
      result.set(id, await this.getAnnotations(id));
    }
    return result;
  }

  /**
   * Library-wide annotation search.
   *
   * Uses Zotero's own search conditions (`annotationText`, `annotationComment`,
   * `annotationType`, `annotationColor`) rather than filtering in JS, so it
   * scales to a large library and matches Zotero's own search semantics.
   */
  public async searchAnnotations(
    query: AnnotationQuery,
  ): Promise<AnnotationData[]> {
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);

    let ids: number[];
    try {
      const search = new Zotero.Search();
      if (query.text)
        search.addCondition("annotationText", "contains", query.text);
      if (query.comment)
        search.addCondition("annotationComment", "contains", query.comment);
      if (query.type) search.addCondition("annotationType", "is", query.type);
      if (query.color)
        search.addCondition("annotationColor", "is", query.color);

      ids = (await search.search()) || [];
    } catch (error) {
      this.addon.log(`Annotation search failed: ${(error as Error).message}`);
      return [];
    }

    const items = (await Zotero.Items.getAsync(ids.slice(0, limit))) as any[];
    let annotations = items
      .filter((i) => i && i.isAnnotation?.())
      .map((i) => this.toAnnotationData(i));

    // Narrow to the requested parents' attachments when asked. Done in JS
    // because an annotation's parent relationship is not a search condition.
    if (query.itemIDs && query.itemIDs.length > 0) {
      const attachmentIDs = new Set<number>();
      for (const itemID of query.itemIDs) {
        const pdf = await this.resolveAttachment(itemID);
        if (pdf) attachmentIDs.add(pdf.id);
      }
      // An annotation's parentItemID is the attachment it lives on.
      annotations = annotations.filter(
        (a) => a.itemID != null && attachmentIDs.has(a.itemID),
      );
    }

    return annotations;
  }

  /**
   * Edit an existing annotation's text, comment, colour or page label.
   */
  public async updateAnnotationById(
    ref: number | string,
    patch: AnnotationPatch,
  ): Promise<WriteResult> {
    return this.updateAnnotation(ref, patch);
  }

  /**
   * Create an annotation.
   *
   * `position` is required for text-bearing annotations: without real geometry
   * the highlight cannot be drawn, and inventing a rect is worse than failing.
   */
  public async writeAnnotation(
    parentItemID: number,
    text: string,
    comment?: string,
    page: number = 0,
    type: string = "highlight",
    color: string = DEFAULT_COLOUR,
    position?: string,
  ): Promise<string> {
    const result = await this.createAnnotation({
      parentItemID,
      text,
      comment,
      page,
      type,
      color,
      position,
    });
    if (result.status === "rejected") {
      throw new Error("Annotation creation cancelled by user.");
    }
    if (result.status === "failed") {
      throw new Error(result.error || "Annotation creation failed.");
    }
    return result.value!;
  }

  /** Outcome-aware annotation creation. */
  public async createAnnotation(opts: {
    parentItemID: number;
    text: string;
    comment?: string;
    page?: number;
    type?: string;
    color?: string;
    position?: string;
  }): Promise<WriteResult & { value?: string }> {
    const {
      parentItemID,
      text,
      comment = "",
      page = 0,
      type = "highlight",
      color = DEFAULT_COLOUR,
      position,
    } = opts;

    if (!VALID_TYPES.includes(type)) {
      return { status: "failed", error: `Unknown annotation type "${type}".` };
    }
    if (!HEX_COLOUR.test(color)) {
      return {
        status: "failed",
        error: `Invalid annotation colour "${color}" — expected a 6-digit hex like #ffd400.`,
      };
    }
    // Annotations that carry a picture rather than text cannot be made here.
    if (type === "image" || type === "ink") {
      return {
        status: "failed",
        error: `Annotations of type "${type}" require an image or ink payload and cannot be created from text.`,
      };
    }
    // Only highlight/underline can carry text (item.js:4530); a text/note
    // annotation is a bare comment, so `text` is ignored rather than rejected.
    if (TEXT_BEARING_TYPES.includes(type) && text.trim() === "") {
      return {
        status: "failed",
        error: `A ${type} annotation needs text.`,
      };
    }

    const pdfItem = await this.resolveAttachment(parentItemID);
    if (!pdfItem) {
      return {
        status: "failed",
        error: `No PDF attachment found for item ${parentItemID}.`,
      };
    }

    // Text-bearing types need real geometry; do not fabricate a rect.
    if (TEXT_BEARING_TYPES.includes(type) && !position) {
      return {
        status: "failed",
        error:
          "A text annotation needs an explicit position (annotationPosition JSON). " +
          "Refusing rather than writing a highlight at a fabricated location.",
      };
    }

    const pdfName = pdfItem.getDisplayTitle();
    const displayName = `${type.toUpperCase()} annotation on "${pdfName}" (Page ${page})`;

    return runWrite(this.writeContext(), {
      action: "Create annotation",
      target: displayName,
      changeAction: "create",
      changes: [
        `type: ${type}`,
        `page: ${page}`,
        `text: "${text}"`,
        `comment: "${comment}"`,
      ],
      metadata: { parentItemID, page, type, colour: color },
      apply: async () => {
        const annotation = new Zotero.Item("annotation");
        annotation.parentItemID = pdfItem.id;
        annotation.libraryID = pdfItem.libraryID;

        // ORDER MATTERS: type first, then the rest (item.js:4510).
        annotation.annotationType = type as any;
        if (TEXT_BEARING_TYPES.includes(type)) {
          annotation.annotationText = text;
        }
        annotation.annotationComment = comment;
        annotation.annotationColor = color;
        annotation.annotationPageLabel = page.toString();
        if (position) {
          annotation.annotationPosition = position;
        }

        await annotation.saveTx();
        return annotation.key;
      },
    });
  }

  /**
   * Edit an existing annotation's text, comment, colour or page label.
   *
   * Only highlight/underline annotations can carry text; the guard matches
   * Zotero's own (`item.js:4530`) so the failure is a clear message rather than
   * an exception from deep inside the data layer.
   */
  public async updateAnnotation(
    ref: number | string,
    patch: AnnotationPatch,
  ): Promise<WriteResult> {
    const item =
      typeof ref === "number"
        ? await Zotero.Items.getAsync(ref)
        : Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, ref);

    if (!item || !item.isAnnotation?.()) {
      return { status: "failed", error: `Annotation ${ref} not found.` };
    }

    const current = this.toAnnotationData(item);
    const changes: string[] = [];

    if (patch.text !== undefined) {
      if (!TEXT_BEARING_TYPES.includes(current.type)) {
        return {
          status: "failed",
          error: `Annotation text can only be set on highlight or underline annotations (this is "${current.type}").`,
        };
      }
      changes.push(`text: "${current.text}" → "${patch.text}"`);
    }
    if (patch.comment !== undefined) {
      changes.push(`comment: "${current.comment || ""}" → "${patch.comment}"`);
    }
    if (patch.color !== undefined) {
      if (!HEX_COLOUR.test(patch.color)) {
        return {
          status: "failed",
          error: `Invalid annotation colour "${patch.color}" — expected a 6-digit hex like #ffd400.`,
        };
      }
      changes.push(`colour: "${current.color}" → "${patch.color}"`);
    }
    if (patch.pageLabel !== undefined) {
      changes.push(
        `page: "${item.annotationPageLabel || ""}" → "${patch.pageLabel}"`,
      );
    }

    if (changes.length === 0) {
      return { status: "failed", error: "No annotation changes supplied." };
    }

    return runWrite(this.writeContext(), {
      action: "Edit annotation",
      target: `"${(current.text || current.comment || current.id).slice(0, 60)}"`,
      changes,
      metadata: { annotationKey: current.id, patch: Object.keys(patch) },
      apply: async () => {
        if (patch.text !== undefined) item.annotationText = patch.text;
        if (patch.comment !== undefined) item.annotationComment = patch.comment;
        if (patch.color !== undefined) item.annotationColor = patch.color;
        if (patch.pageLabel !== undefined) {
          item.annotationPageLabel = patch.pageLabel;
        }
        await item.saveTx();
      },
    });
  }

  /**
   * Move annotations to the trash.
   *
   * Trash, never erase — the fleet invariant. `Zotero.Items.trashTx` is the
   * same reversible path used for items.
   */
  public async deleteAnnotations(
    refs: Array<number | string>,
  ): Promise<WriteResult & { trashed: number }> {
    const items: any[] = [];
    for (const ref of refs) {
      const item =
        typeof ref === "number"
          ? await Zotero.Items.getAsync(ref)
          : Zotero.Items.getByLibraryAndKey(
              Zotero.Libraries.userLibraryID,
              ref,
            );
      if (item && item.isAnnotation?.()) items.push(item);
    }

    if (items.length === 0) {
      return {
        status: "failed",
        error: "No annotations to trash.",
        trashed: 0,
      };
    }

    const outcome = await runWrite(this.writeContext(), {
      action: "Move annotations to trash",
      target: `${items.length} annotation(s)`,
      changeAction: "delete",
      changes: items
        .slice(0, 20)
        .map(
          (i) => `→ trash: "${String(i.annotationText || i.key).slice(0, 60)}"`,
        ),
      metadata: { annotationKeys: items.map((i) => i.key) },
      apply: async () => {
        await Zotero.Items.trashTx(items.map((i) => i.id));
      },
    });

    return {
      status: outcome.status,
      error: outcome.error,
      trashed: outcome.status === "success" ? items.length : 0,
    };
  }
}
