import type Addon from "../../addon";
import type { ContextItem } from "../../views/types";

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
          | Zotero.Item
          | false
          | undefined;
        if (bestAttachment) {
          attachmentKey = bestAttachment.key;
          const file = (bestAttachment as any).getFilePath?.() as
            | string
            | undefined;
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
                  title:
                    noteTitle &&
                    noteTitle !== cleanText.slice(0, noteTitle.length)
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
   * Update metadata fields on a Zotero library item.
   * Gated through ApprovalDialog for user confirmation and recorded in AuditLog.
   */
  public async updateItemMetadata(
    itemID: number,
    updates: Record<string, any>,
  ): Promise<boolean> {
    const item = await Zotero.Items.getAsync(itemID);
    if (!item) {
      throw new Error(`Item with ID ${itemID} not found.`);
    }

    const PROTECTED_FIELDS = new Set([
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

    const FIELD_ALIASES: Record<string, string> = {
      abstract: "abstractNote",
      doi: "DOI",
      publication: "publicationTitle",
      journal: "publicationTitle",
      isbn: "ISBN",
      issn: "ISSN",
    };

    const cleanUpdates: Record<string, any> = {};
    for (const [key, val] of Object.entries(updates)) {
      const field = FIELD_ALIASES[key.toLowerCase()] || key;
      if (!PROTECTED_FIELDS.has(field) && !PROTECTED_FIELDS.has(key)) {
        cleanUpdates[field] = val;
      }
    }

    if (Object.keys(cleanUpdates).length === 0) {
      return false;
    }

    // Build diff for approval dialog
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
        diffLines.push(`Creators: "${oldCreators}" -> "${newCreatorsStr}"`);
      } else {
        const oldVal = (item.getField(field as any) as string) || "(empty)";
        diffLines.push(`${field}: "${oldVal}" -> "${newVal}"`);
      }
    }

    const displayName = (item as any).getDisplayTitle?.() || `Item ${itemID}`;
    const approvalDialog = (this.addon.data?.hermes as any)?.approvalDialog;
    if (approvalDialog) {
      const changeId = `meta-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const approved = await approvalDialog.addPendingChange({
        action: "modify",
        id: changeId,
        newContent: diffLines.join("\n"),
        path: `Metadata for "${displayName}"`,
        status: "pending",
        timestamp: Date.now(),
      });
      if (!approved) {
        throw new Error("Metadata update cancelled by user.");
      }
    }

    // Apply updates
    for (const [field, val] of Object.entries(cleanUpdates)) {
      if (field === "creators") {
        if (Array.isArray(val)) {
          const parsedCreators = val.map((c) => {
            if (typeof c === "object" && c !== null) {
              return {
                creatorType: (c as any).creatorType || "author",
                ...c,
              };
            }
            const str = String(c).trim();
            const parts = str.split(/\s+/);
            if (parts.length === 1) {
              return {
                lastName: parts[0],
                firstName: "",
                creatorType: "author",
              };
            }
            const lastName = parts.pop()!;
            const firstName = parts.join(" ");
            return { firstName, lastName, creatorType: "author" };
          });
          item.setCreators(parsedCreators);
        }
      } else {
        item.setField(field as any, String(val));
      }
    }

    await item.saveTx();

    // Update in-memory attached items if present
    const existingIndex = this.attachedItems.findIndex((a) => a.id === itemID);
    if (existingIndex !== -1) {
      const updated = await this.extractItemData(item);
      if (updated) {
        this.attachedItems[existingIndex] = updated;
      }
    }

    this.addon.data?.hermes?.auditLog?.record(
      "file_change",
      `Update metadata for "${displayName}"`,
      "success",
      { itemID, fields: Object.keys(cleanUpdates) },
    );

    return true;
  }
}
