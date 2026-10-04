import type Addon from "../../addon";
import {
  runWrite,
  type WriteContext,
  type WriteResult,
} from "../../utils/writeGate";

export interface BulkTagResult extends WriteResult {
  /** Number of items the tags were actually applied to. */
  updated: number;
  /** Items that could not be written (locked, deleted, or not loaded). */
  failed: number;
  /** Tag names that no longer exist anywhere in the library. */
  missing?: string[];
}

/**
 * Manages tag operations and suggestions for Hermes Agent.
 *
 * All mutations route through `runWrite` so approval and audit behave the same
 * way here as everywhere else. The legacy single-item methods keep their
 * original contracts (throw on user rejection) so existing callers and tests
 * are unaffected; the bulk methods return an outcome instead.
 */
export class TagManager {
  private readonly addon: Addon;
  private readonly approvalDialog?: any;

  constructor(addon: Addon, approvalDialog?: any) {
    this.addon = addon;
    this.approvalDialog = approvalDialog;
  }

  /** The write-gate context, resolved lazily so tests can pass a light addon. */
  private writeContext(): WriteContext {
    const hermes = this.addon?.data?.hermes as any;
    return {
      approvalDialog: this.approvalDialog ?? hermes?.approvalDialog ?? null,
      auditLog: hermes?.auditLog ?? null,
      log: (message: string, ...data: unknown[]) =>
        this.addon?.log?.(message, ...data),
    };
  }

  public async getAllTags(): Promise<Array<{ tag: string; count: number }>> {
    const tags = await Zotero.Tags.getAll(Zotero.Libraries.userLibraryID);
    return tags.map((tag: any) => ({
      tag: tag.tag,
      count: tag.count || 0,
    }));
  }

  public getItemTags(itemID: number): string[] {
    const item = Zotero.Items.get(itemID);
    if (!item) return [];
    return item.getTags().map((tag: any) => tag.tag);
  }

  public async addTags(itemID: number, tags: string[]): Promise<void> {
    const result = await this.applyTagsToItems([itemID], tags, "add");
    if (result.status === "rejected") {
      throw new Error("Tag addition cancelled by user.");
    }
    if (result.status === "failed") {
      throw new Error(result.error || "Tag addition failed.");
    }
  }

  public async removeTags(itemID: number, tags: string[]): Promise<void> {
    const result = await this.applyTagsToItems([itemID], tags, "remove");
    if (result.status === "rejected") {
      throw new Error("Tag removal cancelled by user.");
    }
    if (result.status === "failed") {
      throw new Error(result.error || "Tag removal failed.");
    }
  }

  /**
   * Add or remove tags across many items behind a single approval.
   *
   * Bulk tag work is the common case in a real library ("everything in this
   * collection is `theory/affect`"), and doing it one dialog at a time is
   * unusable past a handful of items.
   */
  public async applyTagsToItems(
    itemIDs: number[],
    tags: string[],
    mode: "add" | "remove",
  ): Promise<BulkTagResult> {
    const cleanTags = Array.from(
      new Set(tags.map((t) => t.trim()).filter(Boolean)),
    );
    const ids = itemIDs.filter((id) => Number.isInteger(id) && id > 0);

    if (cleanTags.length === 0) {
      return {
        status: "failed",
        error: "No tags supplied.",
        updated: 0,
        failed: 0,
      };
    }
    if (ids.length === 0) {
      return {
        status: "failed",
        error: "No items supplied.",
        updated: 0,
        failed: 0,
      };
    }

    const verb = mode === "add" ? "Add" : "Remove";
    const sign = mode === "add" ? "+" : "−";
    let updated = 0;
    let failed = 0;

    const target = await this.describeItems(ids);

    const outcome = await runWrite(this.writeContext(), {
      action: `${verb} tags`,
      target,
      changes: cleanTags.map((t) => `${sign} ${t}`),
      metadata: { itemIDs: ids, tags: cleanTags, mode },
      apply: async () => {
        for (const id of ids) {
          try {
            const item = await Zotero.Items.getAsync(id);
            if (!item) {
              failed += 1;
              continue;
            }
            for (const tag of cleanTags) {
              if (mode === "add") item.addTag(tag);
              else item.removeTag(tag);
            }
            await item.saveTx();
            updated += 1;
          } catch (error) {
            failed += 1;
            this.addon.log?.(
              `[tags] item ${id} ${mode} failed: ${(error as Error).message}`,
            );
          }
        }
      },
    });

    return {
      status: outcome.status,
      error: outcome.error,
      updated,
      failed,
    };
  }

  /**
   * Add many tags to many items in one approval — the "batch tag" operation.
   */
  public async bulkAddTags(
    itemIDs: number[],
    tags: string[],
  ): Promise<BulkTagResult> {
    return this.applyTagsToItems(itemIDs, tags, "add");
  }

  public async bulkRemoveTags(
    itemIDs: number[],
    tags: string[],
  ): Promise<BulkTagResult> {
    return this.applyTagsToItems(itemIDs, tags, "remove");
  }

  /**
   * Report which of the given tags actually exist in the library.
   *
   * Used to flag typos before a bulk operation, rather than silently creating a
   * new near-duplicate tag (which is how a library ends up with both
   * "sonic studies" and "sound studies").
   */
  public async findMissingTags(tags: string[]): Promise<string[]> {
    const all = await this.getAllTags();
    const known = new Set(all.map((t) => t.tag.toLowerCase()));
    return tags.filter((t) => t.trim() && !known.has(t.trim().toLowerCase()));
  }

  public async suggestTags(
    itemID: number,
  ): Promise<Array<{ tag: string; confidence: number }>> {
    const item = await Zotero.Items.getAsync(itemID);
    if (!item) return [];

    const title = (item.getField("title") as string) || "";
    const abstract = (item.getField("abstractNote") as string) || "";
    const contentText = `${title} ${abstract}`.toLowerCase();

    const allTags = await this.getAllTags();
    const existingTags = this.getItemTags(itemID);

    const suggestions: Array<{ tag: string; confidence: number }> = [];

    for (const tagObj of allTags) {
      const tag = tagObj.tag;
      if (existingTags.includes(tag)) continue;

      const tagLower = tag.toLowerCase();
      let score = 0;

      if (contentText.includes(tagLower)) {
        const escaped = this.escapeRegExp(tagLower);
        const regex = new RegExp(`\\b${escaped}\\b`, "g");
        const matches = contentText.match(regex);
        if (matches) {
          score += matches.length * 0.4;
        } else {
          score += 0.1;
        }

        const popularityBonus = Math.min(
          Math.log10(tagObj.count + 1) * 0.2,
          0.4,
        );
        score += popularityBonus;
      }

      if (score > 0) {
        suggestions.push({
          tag,
          confidence: Math.min(Math.round(score * 100) / 100, 1.0),
        });
      }
    }

    return suggestions.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Describe the target items for the approval dialog.
   *
   * The user is approving a mutation, so they must see *which* items it
   * touches. A bare count ("3 item(s)") hides that, which is exactly the
   * property the approval gate exists to provide. Titles are truncated and
   * the list is capped so a 500-item bulk edit does not produce a wall of text.
   */
  private async describeItems(ids: number[]): Promise<string> {
    const MAX_LISTED = 3;
    const titles: string[] = [];

    for (const id of ids.slice(0, MAX_LISTED)) {
      try {
        const item = await Zotero.Items.getAsync(id);
        const title =
          (item as any)?.getDisplayTitle?.() ||
          (item as any)?.getField?.("title") ||
          "";
        if (title) titles.push(`"${String(title).slice(0, 60)}"`);
      } catch {
        // A failed lookup still has to produce a describable target.
      }
    }

    if (titles.length === 0) return `${ids.length} item(s)`;

    const extra = ids.length - titles.length;
    const suffix = extra > 0 ? ` and ${extra} more` : "";
    return `${titles.join(", ")}${suffix}`;
  }

  private escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Merges or renames a tag across specified items (or library-wide) with approval gating.
   */
  public async renameTag(
    oldTag: string,
    newTag: string,
    itemIDs?: number[],
  ): Promise<number> {
    if (!oldTag || !newTag || oldTag.trim() === newTag.trim()) return 0;

    const trimmedOld = oldTag.trim();
    const trimmedNew = newTag.trim();

    let itemsToProcess: Zotero.Item[] = [];
    if (itemIDs && itemIDs.length > 0) {
      const items = await Zotero.Items.getAsync(itemIDs);
      itemsToProcess = items.filter((i) => {
        if (!i || !i.isRegularItem()) return false;
        return typeof (i as any).hasTag === "function"
          ? (i as any).hasTag(trimmedOld)
          : i.getTags().some((t: any) => t.tag === trimmedOld);
      }) as Zotero.Item[];
    } else {
      const s = new Zotero.Search();
      s.addCondition("tag", "is", trimmedOld);
      const foundIDs = await s.search();
      if (foundIDs && foundIDs.length > 0) {
        itemsToProcess = (await Zotero.Items.getAsync(
          foundIDs,
        )) as Zotero.Item[];
      }
    }

    if (itemsToProcess.length === 0) {
      return 0;
    }

    let updatedCount = 0;

    const outcome = await runWrite(this.writeContext(), {
      action: "Rename tag",
      target: `"${trimmedOld}" → "${trimmedNew}" on ${itemsToProcess.length} item(s)`,
      changes: [`− ${trimmedOld}`, `+ ${trimmedNew}`],
      metadata: {
        oldTag: trimmedOld,
        newTag: trimmedNew,
        itemIDs: itemsToProcess.map((i) => i.id),
      },
      apply: async () => {
        for (const item of itemsToProcess) {
          try {
            item.removeTag(trimmedOld);
            item.addTag(trimmedNew);
            await item.saveTx();
            updatedCount++;
          } catch (e) {
            this.addon.log(`TagManager: Error updating item ${item.id}:`, e);
          }
        }
      },
    });

    if (outcome.status === "rejected") {
      throw new Error("Tag rename cancelled by user.");
    }

    return updatedCount;
  }

  /**
   * Detects duplicate casing, formatting variants, and hierarchical structures in tags.
   */
  public detectTaxonomyClusters(tags: string[]): {
    duplicates: Array<{ canonical: string; variants: string[] }>;
    hierarchical: Array<{ category: string; tags: string[] }>;
  } {
    const normMap = new Map<string, string[]>();

    for (const tag of tags) {
      const key = tag.toLowerCase().replace(/[-_\s]+/g, "");
      if (!normMap.has(key)) {
        normMap.set(key, []);
      }
      normMap.get(key)!.push(tag);
    }

    const duplicates: Array<{ canonical: string; variants: string[] }> = [];
    for (const [, variants] of normMap) {
      const uniqueVariants = Array.from(new Set(variants));
      if (uniqueVariants.length > 1) {
        // Use the shortest or most cleanly formatted variant as canonical
        const canonical = uniqueVariants.reduce((best, cur) =>
          cur.length <= best.length ? cur : best,
        );
        duplicates.push({
          canonical,
          variants: uniqueVariants,
        });
      }
    }

    const hierMap = new Map<string, string[]>();
    for (const tag of tags) {
      if (tag.includes("/")) {
        const parts = tag.split("/");
        const cat = parts[0].trim();
        const sub = parts.slice(1).join("/").trim();
        if (!hierMap.has(cat)) {
          hierMap.set(cat, []);
        }
        if (sub) {
          hierMap.get(cat)!.push(sub);
        }
      }
    }

    const hierarchical: Array<{ category: string; tags: string[] }> = [];
    for (const [category, subTags] of hierMap) {
      hierarchical.push({ category, tags: Array.from(new Set(subTags)) });
    }

    return { duplicates, hierarchical };
  }
}
