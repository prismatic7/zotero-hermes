import type Addon from "../../addon";
import type { ContextItem } from "../../views/types";
import {
  runWrite,
  trashItems as trashItemsTx,
  type WriteContext,
  type WriteResult,
} from "../../utils/writeGate";

export interface AttachedItem {
  id: number;
  key: string;
  title: string;
  itemType: string;
  creators: string[];
  date: string;
  abstract: string;
  tags: string[];
  url?: string;
  doi?: string;
  storagePath?: string;
  attachmentKey?: string;
  annotations?: Array<{
    page: number;
    type: string;
    text: string;
    comment?: string;
  }>;
  notes?: Array<{
    title?: string;
    content: string;
  }>;
  fulltext?: string;
  citekey?: string;
}

/**
 * Manages Zotero item context extraction for Hermes Agent.
 */
export class ItemManager {
  private readonly addon: Addon;
  private attachedItems: AttachedItem[] = [];
  /**
   * Key returned by `Zotero.MenuManager.registerMenu`, which is the
   * *namespaced* key (`CSS.escape(pluginID + "-" + menuID)`), not the raw
   * `menuID`. Stored so `unregisterItemContextMenu` can actually match it.
   */
  private itemMenuRegistrationKey: string | false = false;

  constructor(addon: Addon) {
    this.addon = addon;
  }

  /**
   * Resolve the reader instance for the currently selected tab.
   *
   * Zotero exposes `Zotero.Reader.getByTabID(tabID)`; there is no
   * `Zotero.Reader.getReader()`. Falling back to the first open reader
   * matches the previous behaviour for single-reader sessions.
   */
  public getActiveReader(): any | null {
    try {
      const readerAPI = (Zotero as any).Reader;
      if (!readerAPI) return null;

      const selectedID = (globalThis as any).Zotero_Tabs?.selectedID;
      if (selectedID && typeof readerAPI.getByTabID === "function") {
        const byTab = readerAPI.getByTabID(selectedID);
        if (byTab) return byTab;
      }
      const readers = readerAPI._readers;
      if (Array.isArray(readers) && readers.length > 0) {
        return readers[0];
      }
    } catch {
      // ignore
    }
    return null;
  }

  public getActiveReaderSelection(): {
    text: string;
    page?: number;
    item?: Zotero.Item;
  } | null {
    try {
      const reader = this.getActiveReader();
      if (!reader) return null;

      // Zotero 10: selection text lives in the reader's iframe window.
      // ReaderInstance has NO `getSelectedText()` method (verified against
      // Zotero 10.0.5) — reading the iframe's Selection is the only source.
      let text = "";
      try {
        const selection = reader._iframeWindow?.getSelection?.();
        if (selection) {
          text =
            typeof selection.toString === "function"
              ? selection.toString()
              : "";
        }
      } catch {
        // ignore — fall through to the empty-text guard below
      }

      if (!text || !text.trim()) return null;

      let page: number | undefined;
      try {
        page =
          reader._internalReader?._primaryView?._currentPageNumber ??
          reader.state?.pageIndex ??
          undefined;
      } catch {
        // ignore
      }

      let item: Zotero.Item | undefined;
      if (reader.itemID) {
        const fetched = Zotero.Items.get(reader.itemID);
        if (fetched) {
          item = fetched;
        }
      }
      return { text: text.trim(), page, item };
    } catch {
      return null;
    }
  }

  /**
   * Build the prompt sent when the user asks about library items. Kept
   * pure so it can be unit-tested without a live Zotero.
   */
  public buildItemPrompt(titles: string[], fallback = "this item"): string {
    const clean = titles.map((t) => t.trim()).filter(Boolean);
    if (clean.length === 0) {
      return `Tell me about ${fallback} — give me a brief overview of what it is, its main argument, and how it might relate to my research.`;
    }
    if (clean.length === 1) {
      return `Tell me about "${clean[0]}" — give me a brief overview of what it is, its main argument, and how it might relate to my research.`;
    }
    const list = clean.map((t) => `"${t}"`).join(", ");
    return `Compare and discuss how these works in my library relate to each other: ${list}. Highlight shared themes, tensions, and gaps.`;
  }

  /**
   * Build the prompt for a reader explain/critique action. Pure and
   * testable.
   */
  public buildReaderPrompt(
    actionType: "explain" | "critique",
    opts: { text: string; page?: number; title?: string },
  ): string {
    const { text, page, title } = opts;
    const itemTitle = title ? `"${title}"` : "the current document";
    const pageStr = page ? ` (page ${page})` : "";
    if (actionType === "critique") {
      return `Please critically examine and critique the following argument from ${itemTitle}${pageStr}:\n\n> "${text}"\n\nEvaluate its assumptions, logical rigor, evidence strength, and identify potential counter-arguments or edge cases.`;
    }
    return `Please explain the following passage from ${itemTitle}${pageStr}:\n\n> "${text}"\n\nProvide a clear conceptual explanation, define key terminology, and explain why this matters in the context of the work.`;
  }

  /**
   * Register the "Ask Hermes About Item" entry on the library item
   * context menu.
   *
   * Uses Zotero's supported `MenuManager` API (Zotero 8+), which is how
   * Zotero 10 builds `#zotero-itemmenu` via `updateMenuPopup(..., "main/
   * library/item")`. The previous implementation appended a `menuitem`
   * directly to `#zotero-itemmenu`; Zotero 10 hides every child it does
   * not own, so that item was never shown and the command never fired —
   * a silent failure.
   *
   * @returns true when the menu registered successfully.
   */
  public registerItemContextMenu(
    onAsk: (payload: {
      items: Zotero.Item[];
      titles: string[];
      contextItems: ContextItem[];
    }) => void,
  ): boolean {
    const menuManager = (Zotero as any).MenuManager;
    if (!menuManager || typeof menuManager.registerMenu !== "function") {
      this.addon.log(
        "Ask Hermes About Item not registered: Zotero.MenuManager is unavailable (requires Zotero 8+).",
      );
      return false;
    }

    const addonRef = this.addon.data?.config?.addonRef || "hermes";
    const pluginID =
      this.addon.data?.config?.addonID || "hermes@techne-tools.org";
    const menuID = `${addonRef}-item-context-menu`;

    try {
      this.itemMenuRegistrationKey = menuManager.registerMenu({
        menuID,
        pluginID,
        target: "main/library/item",
        menus: [
          {
            menuType: "menuitem",
            l10nID: "hermes-itemmenu-ask",
            icon: `chrome://${addonRef}/content/icons/hermes-sidenav.svg`,
            onCommand: async (_event: Event, context: any) => {
              try {
                const selected: Zotero.Item[] = (context?.items || []).filter(
                  (it: any) => it && typeof it.getField === "function",
                );
                if (selected.length === 0) {
                  return;
                }

                // Populate ItemManager.attachedItems so slash commands
                // (/annotations, /cite, /tag, /savechat) can resolve the item.
                // Build context items so the answer stays grounded in the
                // item's metadata.
                const titles: string[] = [];
                const contextItems: ContextItem[] = [];
                for (const item of selected) {
                  const attached = await this.attachItem(item);
                  const title = attached?.title || this.getItemPromptText(item);
                  titles.push(title);
                  contextItems.push({
                    id: `item-${item.id}`,
                    type: "item",
                    text: title,
                    data: item,
                    extracted: attached,
                  });
                }
                onAsk({ items: selected, titles, contextItems });
              } catch (err) {
                this.addon.log(
                  `Ask Hermes About Item failed: ${(err as Error).message}`,
                );
              }
            },
          },
        ],
      });

      if (this.itemMenuRegistrationKey) {
        this.addon.log(
          `Registered item context menu entry "${menuID}" as ${this.itemMenuRegistrationKey}`,
        );
        return true;
      }
      this.addon.log(`Failed to register item context menu "${menuID}"`);
      return false;
    } catch (err) {
      this.addon.log(
        `Failed to register item context menu: ${(err as Error).message}`,
      );
      return false;
    }
  }

  public unregisterItemContextMenu(): void {
    try {
      const menuManager = (Zotero as any).MenuManager;
      const key =
        this.itemMenuRegistrationKey ||
        `${this.addon.data?.config?.addonRef || "hermes"}-item-context-menu`;
      menuManager?.unregisterMenu?.(key);
      this.itemMenuRegistrationKey = false;
    } catch {
      // ignore
    }
  }

  public getSelectedItems(): Zotero.Item[] {
    try {
      const reader = this.getActiveReader();
      if (reader && reader.itemID) {
        const item = Zotero.Items.get(reader.itemID);
        if (item) {
          if (
            typeof item.isAttachment === "function" &&
            item.isAttachment() &&
            item.parentItemID
          ) {
            const parent = Zotero.Items.get(item.parentItemID);
            if (parent) return [parent];
          }
          return [item];
        }
      }
    } catch {
      // fallback to pane selection
    }

    const zoteroPane = Zotero.getActiveZoteroPane();
    if (!zoteroPane) return [];
    return zoteroPane.getSelectedItems() || [];
  }

  public getSelectedCollection(): any | null {
    try {
      const pane = Zotero.getActiveZoteroPane?.();
      if (pane && typeof (pane as any).getSelectedCollection === "function") {
        return (pane as any).getSelectedCollection() || null;
      }
    } catch {
      // ignore
    }
    return null;
  }

  public async attachCollection(
    collectionOrId: any,
    limit = 25,
  ): Promise<AttachedItem[]> {
    let collection: any = null;
    if (
      typeof collectionOrId === "number" ||
      typeof collectionOrId === "string"
    ) {
      try {
        collection = (Zotero.Collections as any)?.get?.(collectionOrId);
      } catch {
        // ignore
      }
    } else {
      collection = collectionOrId;
    }
    if (!collection) return [];

    let items: Zotero.Item[] = [];
    try {
      if (typeof collection.getChildItems === "function") {
        items = collection.getChildItems(true) || [];
      }
    } catch (err) {
      this.addon.log("attachCollection error:", err);
    }

    const attached: AttachedItem[] = [];
    for (const item of items) {
      if (attached.length >= limit) break;
      if (
        (typeof item.isAttachment === "function" && item.isAttachment()) ||
        (typeof item.isNote === "function" && item.isNote()) ||
        (item.itemType as string) === "attachment" ||
        (item.itemType as string) === "note"
      ) {
        continue;
      }
      const attachedItem = await this.extractItemData(item);
      if (attachedItem) {
        this.addAttachedItem(attachedItem);
        attached.push(attachedItem);
      }
    }
    return attached;
  }

  public async attachSelectedItems(): Promise<AttachedItem[]> {
    const items = this.getSelectedItems();
    const attached: AttachedItem[] = [];
    for (const item of items) {
      const attachedItem = await this.extractItemData(item);
      if (attachedItem) {
        this.attachedItems.push(attachedItem);
        attached.push(attachedItem);
      }
    }
    return attached;
  }

  public async extractItemData(
    item: Zotero.Item,
  ): Promise<AttachedItem | null> {
    try {
      // Resolve the best attachment's storage path.
      // getBestAttachment() is async in Zotero's API — must be awaited.
      let storagePath: string | undefined;
      let attachmentKey: string | undefined;
      let bestAttachment: Zotero.Item | false | undefined;
      try {
        bestAttachment = (await (item as any).getBestAttachment?.()) as
          Zotero.Item | false | undefined;
        if (bestAttachment) {
          attachmentKey = bestAttachment.key;
          const file = (bestAttachment as any).getFilePath?.() as
            string | undefined;
          if (file) {
            storagePath = file;
          }
        }
      } catch {
        // ignore attachment resolution errors
      }

      // 1. Extract PDF annotations if enabled
      let annotations:
        | Array<{ page: number; type: string; text: string; comment?: string }>
        | undefined;
      const enableAnnotations =
        this.addon.data?.hermes?.preferences?.get("enableAnnotations", true) ??
        true;
      if (enableAnnotations && this.addon.data?.hermes?.annotations) {
        try {
          const rawAnns =
            await this.addon.data.hermes.annotations.getAnnotations(item.id);
          if (rawAnns && rawAnns.length > 0) {
            annotations = rawAnns.slice(0, 25).map((a) => ({
              page: a.page,
              type: a.type,
              text: a.text,
              comment: a.comment,
            }));
          }
        } catch {
          // ignore annotation extraction failure
        }
      }

      // 2. Extract child notes if present
      let notes: Array<{ title?: string; content: string }> | undefined;
      try {
        const noteIDs =
          typeof item.getNotes === "function" ? item.getNotes() : [];
        if (noteIDs && noteIDs.length > 0) {
          const extractedNotes: Array<{ title?: string; content: string }> = [];
          for (const nid of noteIDs.slice(0, 10)) {
            const noteItem = await Zotero.Items.getAsync(nid);
            if (noteItem && typeof noteItem.getNote === "function") {
              const rawNote = noteItem.getNote() || "";
              const cleanText = rawNote
                .replace(/<[^>]*>/g, " ")
                .replace(/\s+/g, " ")
                .trim();
              if (cleanText) {
                const noteTitle =
                  typeof (noteItem as any).getNoteTitle === "function"
                    ? (noteItem as any).getNoteTitle()
                    : undefined;
                extractedNotes.push({
                  // Zotero derives a note's title from its first line, so the
                  // title is usually a PREFIX of the content. Only drop it when
                  // it is redundant (identical to the whole note); a
                  // prefix-match is the normal case and must be kept.
                  title:
                    noteTitle && noteTitle !== cleanText
                      ? noteTitle
                      : undefined,
                  content:
                    cleanText.length > 1000
                      ? cleanText.slice(0, 1000) + "..."
                      : cleanText,
                });
              }
            }
          }
          if (extractedNotes.length > 0) {
            notes = extractedNotes;
          }
        }
      } catch {
        // ignore note extraction failure
      }

      // 3. Extract full-text indexed content if available
      let fulltext: string | undefined;
      try {
        if (
          bestAttachment &&
          typeof (Zotero as any).Fulltext?.getItemText === "function"
        ) {
          const rawText = await (Zotero as any).Fulltext.getItemText(
            bestAttachment.id,
          );
          if (rawText && typeof rawText === "string") {
            const cleanText = rawText.replace(/\s+/g, " ").trim();
            if (cleanText) {
              fulltext =
                cleanText.length > 3000
                  ? cleanText.slice(0, 3000) + "..."
                  : cleanText;
            }
          }
        }
      } catch {
        // ignore fulltext extraction failure
      }

      // 4. Extract citekey (Better BibTeX / extra / author-year fallback)
      let citekey: string | undefined;
      try {
        if (typeof (item as any).getField === "function") {
          const rawKey = item.getField("citationKey" as any);
          if (rawKey && typeof rawKey === "string") {
            citekey = rawKey;
          }
        }
      } catch {
        // ignore
      }
      if (!citekey) {
        try {
          const bbt = (Zotero as any).BetterBibTeX?.KeyManager?.get?.(item.id);
          if (bbt?.citationKey) {
            citekey = bbt.citationKey;
          }
        } catch {
          // ignore
        }
      }
      if (!citekey) {
        try {
          const extra = (item.getField("extra") as string) || "";
          const m = extra.match(/(?:citation key|bibtex):\s*([^\s\n\r]+)/i);
          if (m && m[1]) {
            citekey = m[1];
          }
        } catch {
          // ignore
        }
      }
      if (!citekey) {
        const creator = item.getCreators?.()?.[0];
        const lastName =
          (creator as any)?.lastName || (creator as any)?.firstName || "";
        const rawDate = (item.getField("date") as string) || "";
        const year = rawDate.match(/\d{4}/)?.[0] || "";
        if (lastName && year) {
          citekey = `${lastName.replace(/\W/g, "")}${year}`;
        }
      }

      return {
        id: item.id,
        key: item.key,
        title: (item.getField("title") as string) || "Untitled",
        itemType: item.itemType,
        creators: this.formatCreators(item),
        date: (item.getField("date") as string) || "",
        abstract: (item.getField("abstractNote") as string) || "",
        tags: item.getTags().map((t: any) => t.tag),
        url: (item.getField("url") as string) || undefined,
        doi: (item.getField("DOI") as string) || undefined,
        storagePath,
        attachmentKey,
        annotations,
        notes,
        fulltext,
        citekey,
      };
    } catch {
      return null;
    }
  }

  /**
   * Attach a single item (used by the add-context: link handler and the
   * slash-command flow). Extracts metadata and records it in attachedItems
   * so slash commands (/annotations, /cite, /tag, /savechat) can find it.
   */
  public async attachItem(item: Zotero.Item): Promise<AttachedItem | null> {
    const attachedItem = await this.extractItemData(item);
    if (attachedItem) {
      this.addAttachedItem(attachedItem);
    }
    return attachedItem;
  }

  /**
   * Resolve a human-readable title for an item, preferring the extracted
   * metadata recorded by `attachItem`.
   */
  public getItemPromptText(item: Zotero.Item): string {
    const existing = this.attachedItems.find((a) => a.id === item.id);
    if (existing?.title) return existing.title;
    if (typeof (item as any).getDisplayTitle === "function") {
      return (item as any).getDisplayTitle() || "Untitled";
    }
    return (item.getField("title") as string) || "Untitled";
  }

  /**
   * Record an already-extracted AttachedItem, deduping by item id.
   */
  public addAttachedItem(attachedItem: AttachedItem): void {
    if (!this.attachedItems.some((a) => a.id === attachedItem.id)) {
      this.attachedItems.push(attachedItem);
    }
  }

  /**
   * Remove an item from attachedItems by item ID or key.
   */
  public removeAttachedItem(idOrKey: number | string): void {
    this.attachedItems = this.attachedItems.filter((item) => {
      if (typeof idOrKey === "number") {
        return item.id !== idOrKey;
      }
      return item.key !== idOrKey && String(item.id) !== idOrKey;
    });
  }

  public clearAttachedItems(): void {
    this.attachedItems = [];
  }

  public getAttachedItems(): AttachedItem[] {
    return [...this.attachedItems];
  }

  private formatCreators(item: Zotero.Item): string[] {
    const creators = item.getCreators();
    return creators.map((c: any) => {
      if (c.firstName && c.lastName) {
        return `${c.firstName} ${c.lastName}`;
      }
      return c.name || "";
    });
  }

  /**
   * Protected fields that must never be touched by an agent-driven update.
   * `deleted` is on the list because trashing is a separate, deliberate
   * operation (`metadataDeleteValue` / `trashItems`), not a field write.
   */
  private static readonly PROTECTED_FIELDS = new Set([
    "id",
    "key",
    "libraryID",
    "version",
    "itemTypeID",
    "itemType",
    "dateAdded",
    "dateModified",
    "deleted",
  ]);

  private static readonly FIELD_ALIASES: Record<string, string> = {
    abstract: "abstractNote",
    doi: "DOI",
    publication: "publicationTitle",
    journal: "publicationTitle",
    isbn: "ISBN",
    issn: "ISSN",
    url: "url",
    title: "title",
    date: "date",
    language: "language",
    pages: "pages",
    volume: "volume",
    issue: "issue",
    publisher: "publisher",
    place: "place",
  };

  /**
   * Normalise a caller-supplied field map: resolve aliases, drop protected
   * fields, and discard empty keys. Shared by the single-item and bulk paths.
   */
  private cleanFieldUpdates(updates: Record<string, any>): Record<string, any> {
    const clean: Record<string, any> = {};
    for (const [key, val] of Object.entries(updates)) {
      if (key.trim() === "") continue;
      const field = ItemManager.FIELD_ALIASES[key.toLowerCase()] || key.trim();
      if (ItemManager.PROTECTED_FIELDS.has(field)) continue;
      if (ItemManager.PROTECTED_FIELDS.has(key)) continue;
      clean[field] = val;
    }
    return clean;
  }

  /** Build the approval-dialog diff lines for a set of field updates. */
  private buildMetadataDiff(
    item: Zotero.Item,
    cleanUpdates: Record<string, any>,
  ): string[] {
    const diffLines: string[] = [];
    for (const [field, newVal] of Object.entries(cleanUpdates)) {
      if (field === "creators") {
        const oldCreators = this.formatCreators(item).join(", ") || "(none)";
        const newCreatorsStr = Array.isArray(newVal)
          ? newVal
              .map((c) =>
                typeof c === "string"
                  ? c
                  : c.name || `${c.firstName || ""} ${c.lastName || ""}`.trim(),
              )
              .join(", ")
          : String(newVal);
        diffLines.push(`creators: "${oldCreators}" → "${newCreatorsStr}"`);
      } else {
        const oldVal = (item.getField(field as any) as string) || "(empty)";
        diffLines.push(`${field}: "${oldVal}" → "${newVal}"`);
      }
    }
    return diffLines;
  }

  /** Apply a cleaned field map to an item and persist it. */
  private applyFieldUpdates(
    item: Zotero.Item,
    cleanUpdates: Record<string, any>,
  ): void {
    for (const [field, val] of Object.entries(cleanUpdates)) {
      if (field === "creators") {
        if (Array.isArray(val)) {
          item.setCreators(this.parseCreators(val));
        }
      } else {
        item.setField(field as any, String(val));
      }
    }
  }

  /** Parse creator input in either object or "First Last" string form. */
  private parseCreators(val: any[]): any[] {
    return val.map((c) => {
      if (typeof c === "object" && c !== null) {
        return { creatorType: (c as any).creatorType || "author", ...c };
      }
      const str = String(c).trim();
      const parts = str.split(/\s+/);
      if (parts.length === 1) {
        return { lastName: parts[0], firstName: "", creatorType: "author" };
      }
      const lastName = parts.pop()!;
      const firstName = parts.join(" ");
      return { firstName, lastName, creatorType: "author" };
    });
  }

  /** Refresh the in-memory attached-items cache after a mutation. */
  private async refreshAttachedItem(item: Zotero.Item): Promise<void> {
    const existingIndex = this.attachedItems.findIndex((a) => a.id === item.id);
    if (existingIndex === -1) return;
    const updated = await this.extractItemData(item);
    if (updated) {
      this.attachedItems[existingIndex] = updated;
    }
  }

  /** The write-gate context, resolved lazily so tests can pass a light addon. */
  private writeContext(): WriteContext {
    const hermes = this.addon.data?.hermes as any;
    return {
      approvalDialog: hermes?.approvalDialog ?? null,
      auditLog: hermes?.auditLog ?? null,
      log: (message: string, ...data: unknown[]) =>
        this.addon.log?.(message, ...data),
    };
  }

  /**
   * Update metadata fields on a Zotero library item.
   * Gated through ApprovalDialog for user confirmation and recorded in AuditLog.
   *
   * Legacy contract: returns `true` on success, `false` when there were no
   * valid fields, and **throws** when the user rejects the change. Callers that
   * want to distinguish rejection from failure should use
   * `updateItemMetadataGated` instead.
   */
  public async updateItemMetadata(
    itemID: number,
    updates: Record<string, any>,
  ): Promise<boolean> {
    const result = await this.updateItemMetadataGated(itemID, updates);
    if (result.status === "rejected") {
      throw new Error("Metadata update cancelled by user.");
    }
    return result.status === "success";
  }

  /**
   * As `updateItemMetadata`, but returns the full outcome so callers can tell
   * a user rejection apart from a failure. Throws only when the item is
   * missing — a missing target is a caller bug, not a user decision.
   */
  public async updateItemMetadataGated(
    itemID: number,
    updates: Record<string, any>,
  ): Promise<WriteResult> {
    const item = await Zotero.Items.getAsync(itemID);
    if (!item) {
      throw new Error(`Item with ID ${itemID} not found.`);
    }

    const cleanUpdates = this.cleanFieldUpdates(updates);
    if (Object.keys(cleanUpdates).length === 0) {
      return { status: "failed", error: "No valid or modifiable fields." };
    }

    const displayName = (item as any).getDisplayTitle?.() || `Item ${itemID}`;

    const outcome = await runWrite(this.writeContext(), {
      action: "Update metadata",
      target: displayName,
      changes: this.buildMetadataDiff(item, cleanUpdates),
      metadata: { itemID, fields: Object.keys(cleanUpdates) },
      apply: async () => {
        this.applyFieldUpdates(item, cleanUpdates);
        await item.saveTx();
        await this.refreshAttachedItem(item);
      },
    });

    return { status: outcome.status, error: outcome.error };
  }

  /**
   * Update the same field(s) across many items with one approval.
   *
   * The diff names the field and how many items change; the per-item old values
   * are intentionally not listed, because a bulk operation on a large selection
   * would produce an unreadable prompt. Failures are counted, not thrown, so a
   * partial success is reported honestly rather than silently.
   */
  public async bulkUpdateMetadata(
    itemIDs: number[],
    updates: Record<string, any>,
  ): Promise<WriteResult & { updated: number; failed: number }> {
    const cleanUpdates = this.cleanFieldUpdates(updates);
    const ids = itemIDs.filter((id) => Number.isInteger(id) && id > 0);
    if (Object.keys(cleanUpdates).length === 0 || ids.length === 0) {
      return {
        status: "failed",
        error: "No valid fields or items to update.",
        updated: 0,
        failed: 0,
      };
    }

    const changes = Object.entries(cleanUpdates).map(
      ([field, val]) => `${field} → "${val}" on ${ids.length} item(s)`,
    );

    let updated = 0;
    let failed = 0;

    const outcome = await runWrite(this.writeContext(), {
      action: "Bulk update metadata",
      target: `${ids.length} item(s)`,
      changes,
      metadata: { itemIDs: ids, fields: Object.keys(cleanUpdates) },
      apply: async () => {
        for (const id of ids) {
          try {
            const item = await Zotero.Items.getAsync(id);
            if (!item) {
              failed += 1;
              continue;
            }
            this.applyFieldUpdates(item, cleanUpdates);
            await item.saveTx();
            await this.refreshAttachedItem(item);
            updated += 1;
          } catch (error) {
            failed += 1;
            this.addon.log?.(
              `[bulkUpdateMetadata] item ${id} failed: ${(error as Error).message}`,
            );
          }
        }
      },
    });

    return { status: outcome.status, error: outcome.error, updated, failed };
  }

  /**
   * Clear a metadata field on one or more items (set to empty / remove creators).
   *
   * This is the "delete metadata" operation. It is destructive-but-reversible
   * in the ordinary sense — the old value goes into the approval diff, so it is
   * recoverable from the audit trail while the dialog is on screen.
   */
  public async deleteMetadataValue(
    itemIDs: number[],
    field: string,
  ): Promise<WriteResult & { updated: number; failed: number }> {
    const ids = itemIDs.filter((id) => Number.isInteger(id) && id > 0);
    const resolved =
      ItemManager.FIELD_ALIASES[field.toLowerCase()] || field.trim();

    if (ids.length === 0) {
      return {
        status: "failed",
        error: "No items supplied.",
        updated: 0,
        failed: 0,
      };
    }
    if (ItemManager.PROTECTED_FIELDS.has(resolved) || resolved === "") {
      return {
        status: "failed",
        error: `Field "${field}" cannot be cleared.`,
        updated: 0,
        failed: 0,
      };
    }
    if (resolved === "creators") {
      return {
        status: "failed",
        error:
          "Clearing creators is not supported — provide a replacement creator " +
          "list with updateItemMetadata instead.",
        updated: 0,
        failed: 0,
      };
    }

    // Capture the values being discarded so the approval diff is a real
    // before/after, and so the operator can recover them from the log.
    const previous: Array<{ id: number; value: string }> = [];
    for (const id of ids.slice(0, 50)) {
      const item = Zotero.Items.get(id);
      if (!item) continue;
      const value = (item.getField(resolved as any) as string) || "";
      if (value) previous.push({ id, value });
    }

    const preview = previous.map((p) => `${resolved}: "${p.value}" → (empty)`);
    if (previous.length < ids.length) {
      preview.push(
        `… and ${ids.length - previous.length} item(s) with no value set`,
      );
    }

    let updated = 0;
    let failed = 0;

    const outcome = await runWrite(this.writeContext(), {
      action: `Clear ${resolved}`,
      target: `${ids.length} item(s)`,
      changes:
        preview.length > 0
          ? preview
          : [`${resolved} → (empty) on ${ids.length} item(s)`],
      metadata: { itemIDs: ids, field: resolved, previous },
      apply: async () => {
        for (const id of ids) {
          try {
            const item = await Zotero.Items.getAsync(id);
            if (!item) {
              failed += 1;
              continue;
            }
            item.setField(resolved as any, "");
            await item.saveTx();
            await this.refreshAttachedItem(item);
            updated += 1;
          } catch (error) {
            failed += 1;
            this.addon.log?.(
              `[deleteMetadataValue] item ${id} failed: ${(error as Error).message}`,
            );
          }
        }
      },
    });

    return { status: outcome.status, error: outcome.error, updated, failed };
  }

  /**
   * Move items to the trash — the plugin's only destructive operation.
   *
   * Trash, never erase: the fleet invariant reserves permanent deletion for the
   * operator. Items are recoverable from Zotero's trash until they empty it.
   */
  public async trashItems(
    itemIDs: number[],
  ): Promise<WriteResult & { trashed: number }> {
    const ids = itemIDs.filter((id) => Number.isInteger(id) && id > 0);
    if (ids.length === 0) {
      return {
        status: "failed",
        error: "No items supplied.",
        trashed: 0,
      };
    }

    const titles: string[] = [];
    for (const id of ids.slice(0, 20)) {
      const item = Zotero.Items.get(id);
      if (item) titles.push((item as any).getDisplayTitle?.() || `Item ${id}`);
    }

    const outcome = await runWrite(this.writeContext(), {
      action: "Move to trash",
      target: `${ids.length} item(s)`,
      changeAction: "delete",
      changes:
        titles.length > 0
          ? titles.map((t) => `→ trash: ${t}`)
          : [`→ trash ${ids.length} item(s)`],
      metadata: { itemIDs: ids },
      apply: async () => {
        const items = ids
          .map((id) => Zotero.Items.get(id))
          .filter(Boolean) as Zotero.Item[];
        await trashItemsTx(items);
      },
    });

    return {
      status: outcome.status,
      error: outcome.error,
      trashed: outcome.status === "success" ? ids.length : 0,
    };
  }
}
