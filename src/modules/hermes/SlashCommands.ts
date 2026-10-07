import type Addon from "../../addon";
import type { AnnotationQuery } from "./AnnotationManager";
import { isDoiLike, normaliseDoi } from "./LookupManager";

export type SlashCommandResult =
  null | string | { sendPrompt: string; systemMessage?: string };

export interface SlashCommand {
  description: string;
  execute: (addon: Addon, args: string) => Promise<SlashCommandResult>;
  name: string;
}

/**
 * Registry of built-in slash commands.
 * Commands are invoked with `/name [args]` in the chat input.
 */
const BUILT_IN_COMMANDS: SlashCommand[] = [
  {
    description: "Clear the current conversation",
    execute: async (addon) => {
      addon.data.hermes?.chat.clearMessages();
      return "Conversation cleared.";
    },
    name: "clear",
  },
  {
    description: "Add selected Zotero items to context",
    execute: async (addon) => {
      const items = addon.data.hermes!.items.getSelectedItems();
      if (items.length === 0) {
        return "No items selected in Zotero library.";
      }
      // C3: actually attach — populate ItemManager.attachedItems so the
      // metadata is available to slash commands AND the agent context.
      const attached = await addon.data.hermes!.items.attachSelectedItems();
      if (attached.length === 0) {
        return "Selected items could not be attached to context.";
      }
      const titles = attached.map((i) => i.title).join(", ");
      return `Added **${attached.length} item(s)** to context: ${titles}`;
    },
    name: "context",
  },
  {
    description:
      "Attach all top-level items from the selected Zotero collection into context",
    execute: async (addon, args) => {
      const col = addon.data.hermes?.items.getSelectedCollection();
      if (!col) {
        return "No collection currently selected in the Zotero collections tree. Please click a collection in the left sidebar and run `/collection` again.";
      }
      const limit = parseInt(args.trim(), 10) || 25;
      const attached = await addon.data.hermes!.items.attachCollection(
        col,
        limit,
      );
      if (attached.length === 0) {
        return `No research items found in collection **"${col.name}"**.`;
      }
      const titles = attached
        .slice(0, 5)
        .map((i) => `"${i.title}"`)
        .join(", ");
      const extra =
        attached.length > 5 ? ` and ${attached.length - 5} more...` : "";
      return `Attached **${attached.length} items** from collection **"${col.name}"** to context: ${titles}${extra}`;
    },
    name: "collection",
  },
  {
    description: "Show available slash commands",
    execute: async (_addon) => {
      const commands = getSlashCommands();
      const list = commands
        .map((cmd) => `**/${cmd.name}** — ${cmd.description}`)
        .join("\n");
      return `Available commands:\n\n${list}`;
    },
    name: "help",
  },
  {
    description: "Save current conversation as a Zotero note",
    execute: async (addon, _args) => {
      const messages = addon.data.hermes!.chat.getMessages();
      if (messages.length === 0) {
        return "No conversation to save.";
      }

      // Find parent item if any is attached in context
      const attachedItems = addon.data.hermes!.items.getAttachedItems();
      const parentItemID =
        attachedItems.length > 0 ? attachedItems[0].id : undefined;

      // Format conversation as simple HTML
      const html = messages
        .map((m: { role: string; content: string }) => {
          if (
            m.role === "system" ||
            m.role === "reasoning" ||
            m.role === "tool"
          )
            return "";
          const roleName = m.role === "user" ? "You" : "Hermes";
          const formattedContent = m.content
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\n/g, "<br/>")
            .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
          return `<p><strong>${roleName}:</strong> ${formattedContent}</p>`;
        })
        .filter(Boolean)
        .join("\n");

      if (!html) {
        return "No chat messages to save.";
      }

      const dateStr = new Date().toLocaleString();
      const title = `Hermes Chat - ${dateStr}`;

      try {
        const noteId = await addon.data.hermes!.notes.writeNote(
          null,
          html,
          title,
          parentItemID,
        );
        return `Conversation successfully saved as note (ID: ${noteId}).`;
      } catch (err) {
        return `Failed to save conversation: ${(err as Error).message}`;
      }
    },
    name: "savechat",
  },
  {
    description:
      "Export conversation as Markdown (Obsidian-ready with YAML frontmatter, wikilinks, and zotero:// links)",
    execute: async (addon, args) => {
      const conv = addon.data.hermes?.conversations.getCurrentConversation();
      if (!conv || !conv.messages || conv.messages.length === 0) {
        return "No conversation to export.";
      }
      const attached = addon.data.hermes?.items.getAttachedItems() || [];
      const trimmedArgs = args.trim();

      if (trimmedArgs.toLowerCase() === "note") {
        const res = await addon.data.hermes!.exports.exportToZoteroNote(
          conv,
          attached,
        );
        return res.message;
      }

      // Check if Obsidian vault is configured
      const vaultPath =
        addon.data.hermes?.preferences?.get<string>("obsidianVaultPath", "") ||
        "";
      if (vaultPath && vaultPath.trim()) {
        const customName =
          trimmedArgs && !trimmedArgs.toLowerCase().startsWith("obsidian")
            ? trimmedArgs
            : undefined;
        const res = await addon.data.hermes!.exports.exportToObsidianVault(
          conv,
          attached,
          customName,
        );
        if (res.success) {
          return `${res.message}\n\n*Saved to Obsidian vault with YAML frontmatter and Zotero deep links.*`;
        }
      }

      // If no Obsidian path configured or explicit fallback, use file picker
      const res = await addon.data.hermes!.exports.exportWithFilePicker(
        conv,
        attached,
      );
      if (res.success) {
        return `${res.message}\n\n*Tip: Set your Obsidian Vault path in Settings → Hermes to export directly with a single command!*`;
      }
      return res.message;
    },
    name: "export",
  },
  {
    description:
      "Perform a structured comparative synthesis across all attached research items (matrix table, consensus, divergences)",
    execute: async (addon, args) => {
      const attached = addon.data.hermes?.items.getAttachedItems() || [];
      if (attached.length < 2) {
        return `Comparison requires at least 2 items in context (currently ${attached.length} attached). Select multiple items and run \`/context\` or \`/collection\` first.`;
      }
      const focus = args.trim();
      const focusPrompt = focus
        ? `Focus specifically on: "${focus}".`
        : "Provide a comprehensive cross-paper analysis.";

      const prompt = `Please provide a rigorous comparative synthesis and analysis across the ${attached.length} attached research papers. ${focusPrompt}

Structure your response with:
1. **Comparative Matrix Table**: Include columns for Paper (Title & @Citekey), Research Question / Core Aim, Methodology / Dataset, Key Empirical Findings, and Limitations.
2. **Consensus & Theoretical Convergence**: Where do these authors agree or reinforce each other's claims?
3. **Divergences & Debates**: What are the key points of disagreement, conflicting evidence, or competing theoretical frameworks?
4. **Methodological Trade-offs**: Compare their empirical strategies (e.g. experimental vs observational, sample sizes, validity).

Cite each paper using its citation key (\`@citekey\`) or author-year throughout.`;

      return {
        sendPrompt: prompt,
        systemMessage: `Starting comparative synthesis across **${attached.length} attached papers**...`,
      };
    },
    name: "compare",
  },
  {
    description:
      "Analyze the attached literature to identify unaddressed research questions, methodological limitations, and future directions",
    execute: async (addon, args) => {
      const attached = addon.data.hermes?.items.getAttachedItems() || [];
      if (attached.length === 0) {
        return "No items attached to context. Attach items with `/context` or `/collection` first.";
      }
      const focus = args.trim();
      const focusPrompt = focus ? `with special focus on: "${focus}"` : "";

      const prompt = `Based strictly on the attached research literature (${attached.length} items) ${focusPrompt}, conduct a critical literature gap analysis:

1. **Unaddressed Research Questions**: What important questions, mechanisms, or hypotheses are left unanswered or unexplored across these papers?
2. **Methodological & Data Gaps**: What common weaknesses, boundary conditions, sampling limitations, or missing perspectives exist in the existing studies?
3. **Emerging Contradictions**: What unresolved tensions or inconsistent findings between the works warrant further investigation?
4. **Concrete Future Research Agenda**: Propose 3-5 specific, testable research projects or empirical designs that would bridge these identified gaps.

Cite the relevant papers using (\`@citekey\`) to substantiate each identified gap.`;

      return {
        sendPrompt: prompt,
        systemMessage: `Analyzing literature gaps across **${attached.length} attached papers**...`,
      };
    },
    name: "gaps",
  },
  {
    description:
      "Draft a publication-ready literature review section integrating attached items with @citekey citations",
    execute: async (addon, args) => {
      const attached = addon.data.hermes?.items.getAttachedItems() || [];
      if (attached.length === 0) {
        return "No items attached to context. Attach items with `/context` or `/collection` first.";
      }
      const topic =
        args.trim() || "the thematic consensus of the attached literature";

      const prompt = `Draft a publication-ready academic Literature Review section on the topic: "${topic}".

Requirements:
1. Synthesize the ${attached.length} attached research papers into coherent thematic paragraphs (not just a paper-by-paper summary).
2. Integrate in-text academic citations using \`@citekey\` syntax (e.g. "As argued by @Smith2023..." or "...in recent empirical evaluations [@Doe2022; @Lee2024]").
3. Maintain scholarly tone, clear conceptual transitions, and active synthesis.
4. Conclude with a brief synthesis paragraph linking the surveyed body of work to unresolved questions.`;

      return {
        sendPrompt: prompt,
        systemMessage: `Drafting literature review on **"${topic}"** using ${attached.length} attached sources...`,
      };
    },
    name: "draft-litreview",
  },
  {
    description:
      "Search notes and library items (title, authors, tags, abstract) and add them to context",
    execute: async (addon, args) => {
      const query = args.trim();
      if (!query) {
        return "Please specify a search query. Usage: `/search [query]`";
      }

      try {
        const noteResults = await addon.data.hermes!.notes.searchNotes(query);

        const s = new Zotero.Search();
        s.addCondition("quicksearch-titleCreatorYear", "contains", query);
        s.addCondition("itemType", "isNot", "attachment");
        s.addCondition("itemType", "isNot", "note");
        const itemIDs = await s.search();
        const items = itemIDs ? await Zotero.Items.getAsync(itemIDs) : [];

        if (noteResults.length === 0 && items.length === 0) {
          return `No notes or items found matching: **${query}**`;
        }

        const noteList = noteResults
          .slice(0, 5)
          .map((note) => {
            const rawNote = note.getNote() || "";
            const cleanText = rawNote
              .replace(/<[^>]*>/g, " ")
              .replace(/\s+/g, " ")
              .trim();
            const preview =
              cleanText.length > 80
                ? cleanText.substring(0, 80) + "..."
                : cleanText;
            const title = (note as any).getNoteTitle?.() || "Untitled Note";
            return `- **Note: ${title}**: "${preview}" [Add to Context](add-context:${note.id})`;
          })
          .join("\n");

        const itemList = items
          .slice(0, 5)
          .map((item) => {
            const creators = item
              .getCreators()
              .map((c: any) => c.lastName || c.firstName)
              .join(", ");
            const creatorStr = creators ? ` by ${creators}` : "";
            const yearStr = item.getField("date")
              ? ` (${item.getField("date")})`
              : "";
            return `- **Item: ${item.getDisplayTitle()}**${creatorStr}${yearStr} [Add to Context](add-context:${item.id})`;
          })
          .join("\n");

        let output = `Search results for **${query}**:\n\n`;
        if (noteList) {
          output += `### Notes\n${noteList}\n\n`;
        }
        if (itemList) {
          output += `### Library Items\n${itemList}\n`;
        }

        return output;
      } catch (err) {
        return `Search failed: ${(err as Error).message}`;
      }
    },
    name: "search",
  },
  {
    description: "List all PDF annotations for the attached Zotero item",
    execute: async (addon, _args) => {
      // M4: respect the enableAnnotations pref
      if (!addon.data.hermes!.preferences.get("enableAnnotations", true)) {
        return "Annotation reading is disabled. Enable it in Zotero → Settings → Hermes → Automatic Context.";
      }
      const attachedItems = addon.data.hermes!.items.getAttachedItems();
      if (attachedItems.length === 0) {
        return "No item attached to the conversation. Attach an item first.";
      }
      const parentItem = attachedItems[0];
      try {
        const annotations = await addon.data.hermes!.annotations.getAnnotations(
          parentItem.id,
        );
        if (annotations.length === 0) {
          return `No PDF annotations found for **${parentItem.title}**.`;
        }

        const list = annotations
          .map((ann) => {
            const commentStr = ann.comment
              ? ` *(Comment: ${ann.comment})*`
              : "";
            return `- **Page ${ann.page}** (${ann.type}): "${ann.text}"${commentStr}`;
          })
          .join("\n");

        return `PDF Annotations for **${parentItem.title}**:\n\n${list}`;
      } catch (err) {
        return `Failed to load annotations: ${(err as Error).message}`;
      }
    },
    name: "annotations",
  },
  {
    description:
      "Generate in-text citation and bibliography for the attached item",
    execute: async (addon, args) => {
      // M4: respect the enableCitations pref
      if (!addon.data.hermes!.preferences.get("enableCitations", true)) {
        return "Citation generation is disabled. Enable it in Zotero → Settings → Hermes → Automatic Context.";
      }
      const attachedItems = addon.data.hermes!.items.getAttachedItems();
      if (attachedItems.length === 0) {
        return "No item attached to the conversation. Attach an item first.";
      }
      const parentItem = attachedItems[0];
      const styleName = args.trim();

      let styleID = addon.data.hermes!.citations.getCurrentStyle();
      let styleTitle = addon.data.hermes!.citations.getCurrentStyleName();

      if (styleName) {
        const resolvedStyleID =
          addon.data.hermes!.citations.getStyleByIDOrName(styleName);
        if (resolvedStyleID) {
          styleID = resolvedStyleID;
          const style = Zotero.Styles.get(styleID);
          styleTitle = style?.title || styleID;
        } else {
          return `Could not find citation style matching: **${styleName}**. Try another style name.`;
        }
      }

      try {
        const item = await Zotero.Items.getAsync(parentItem.id);
        if (!item) return "Attached item not found.";

        const citation = addon.data.hermes!.citations.generateCitationWithStyle(
          item.id,
          styleID,
        );
        const bibliography =
          addon.data.hermes!.citations.generateBibliographyWithStyle(
            [item],
            styleID,
          );
        const cleanBib = bibliography
          ? bibliography.replace(/<[^>]*>/g, "").trim()
          : "None";

        const snippets = addon.data.hermes!.citations.getCitationSnippets(item);

        return `### Citation (${styleTitle}) for **${parentItem.title}**

**CSL In-text Citation:**
${citation || "None"}

**CSL Bibliography:**
${cleanBib}

---

### Drafting Keys & Snippets
- **Citation Key**: \`@${snippets.citekey}\`
- **Markdown / Pandoc / Quarto**: \`${snippets.pandoc}\`
- **LaTeX / BibTeX**: \`${snippets.latex}\`
- **Typst**: \`${snippets.typst}\``;
      } catch (err) {
        return `Failed to generate citation: ${(err as Error).message}`;
      }
    },
    name: "cite",
  },
  {
    description:
      "Suggest or apply tags for the attached Zotero item. Usage: `/tag` (to suggest) or `/tag tag1, tag2` (to apply)",
    execute: async (addon, args) => {
      // M4: respect the enableTags pref
      if (!addon.data.hermes!.preferences.get("enableTags", true)) {
        return "Tag management is disabled. Enable it in Zotero → Settings → Hermes → Automatic Context.";
      }
      const attachedItems = addon.data.hermes!.items.getAttachedItems();
      if (attachedItems.length === 0) {
        return "No item attached to the conversation. Attach an item first.";
      }
      const parentItem = attachedItems[0];
      const tagsString = args.trim();

      if (tagsString) {
        const tags = tagsString
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        if (tags.length === 0) return "No valid tags specified.";
        try {
          await addon.data.hermes!.tags.addTags(parentItem.id, tags);
          return `Successfully applied **${tags.length}** tags to **${parentItem.title}**: ${tags.join(", ")}`;
        } catch (err) {
          return `Failed to apply tags: ${(err as Error).message}`;
        }
      }

      try {
        const suggestions = await addon.data.hermes!.tags.suggestTags(
          parentItem.id,
        );
        if (suggestions.length === 0) {
          return `No tag suggestions found for **${parentItem.title}** (ensure you have existing tags in your library).`;
        }

        const list = suggestions
          .slice(0, 10)
          .map(
            (s) =>
              `- **${s.tag}** (Confidence: ${s.confidence}) [Apply](apply-tag:${s.tag})`,
          )
          .join("\n");

        return `Tag suggestions for **${parentItem.title}**:\n\n${list}\n\n*Or type \`/tag tag1, tag2\` to apply specific tags.*`;
      } catch (err) {
        return `Failed to generate tag suggestions: ${(err as Error).message}`;
      }
    },
    name: "tag",
  },
  {
    description:
      "Switch agent persona (e.g. `/persona researcher`, `/persona citation`, `/persona analyst`)",
    execute: async (addon, args) => {
      const input = args.trim().toLowerCase();
      if (!input) {
        const current = addon.data.hermes!.preferences.get(
          "currentPersona",
          "default",
        );
        return `Current persona is: **${current}**. Available personas: \`researcher\`, \`citation\`, \`analyst\`.`;
      }
      let persona: string;
      let title: string;
      if (input === "citation" || input === "cite") {
        persona = "citation";
        title = "Citation Expert";
      } else if (input === "analyst" || input === "analysis") {
        persona = "analyst";
        title = "Literature Analyst";
      } else if (input === "researcher" || input === "default") {
        persona = "default";
        title = "Research Assistant";
      } else {
        return `Unknown persona **${input}**. Available: \`researcher\`, \`citation\`, \`analyst\`.`;
      }

      try {
        addon.data.hermes!.preferences.set("currentPersona", persona);
        return `Switched agent persona to: **${title}**. All subsequent prompts will use this system persona.`;
      } catch (err) {
        return `Failed to set persona: ${(err as Error).message}`;
      }
    },
    name: "persona",
  },
  {
    description:
      "View or update metadata for attached item. Usage: `/metadata` or `/metadata title=My Title, date=2024`",
    execute: async (addon, args) => {
      const attachedItems = addon.data.hermes!.items.getAttachedItems();
      if (attachedItems.length === 0) {
        return "No item attached to the conversation. Attach an item first.";
      }
      const parentItem = attachedItems[0];
      const trimmed = args.trim();

      if (!trimmed) {
        // Display current metadata
        const lines = [
          `### Metadata for **${parentItem.title}**`,
          `- **Item Type**: ${parentItem.itemType}`,
          `- **Creators**: ${parentItem.creators.join(", ") || "(none)"}`,
          `- **Date**: ${parentItem.date || "(none)"}`,
          `- **DOI**: ${parentItem.doi || "(none)"}`,
          `- **URL**: ${parentItem.url || "(none)"}`,
          `- **Abstract**: ${parentItem.abstract ? parentItem.abstract.slice(0, 150) + "..." : "(none)"}`,
          `- **Tags**: ${parentItem.tags.join(", ") || "(none)"}`,
          "",
          "*To update metadata, use `/metadata field=value, ...` (e.g. `/metadata title=New Title, date=2024`)*",
        ];
        return lines.join("\n");
      }

      // Parse field=value pairs
      const updates: Record<string, any> = {};
      const pairs = trimmed.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
      for (const pair of pairs) {
        const eqIdx = pair.indexOf("=");
        const colonIdx = pair.indexOf(":");
        const sepIdx =
          eqIdx !== -1 && (colonIdx === -1 || eqIdx < colonIdx)
            ? eqIdx
            : colonIdx;

        if (sepIdx !== -1) {
          const key = pair.slice(0, sepIdx).trim();
          let val = pair.slice(sepIdx + 1).trim();
          if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
          ) {
            val = val.slice(1, -1);
          }
          if (
            key.toLowerCase() === "creators" ||
            key.toLowerCase() === "authors"
          ) {
            updates.creators = val
              .split(";")
              .map((c) => c.trim())
              .filter(Boolean);
          } else {
            updates[key] = val;
          }
        }
      }

      if (Object.keys(updates).length === 0) {
        return "Could not parse any field updates. Usage: `/metadata field=value, ...`";
      }

      try {
        const success = await addon.data.hermes!.items.updateItemMetadata(
          parentItem.id,
          updates,
        );
        if (success) {
          const fieldNames = Object.keys(updates).join(", ");
          return `Successfully updated metadata (**${fieldNames}**) for **${parentItem.title}**.`;
        } else {
          return "No valid or modifiable fields were provided.";
        }
      } catch (err) {
        return `Failed to update metadata: ${(err as Error).message}`;
      }
    },
    name: "metadata",
  },
  {
    description:
      "Export conversation and attached papers to an Obsidian Canvas (.canvas) graph. Usage: `/canvas [filename]`",
    execute: async (addon, args) => {
      const currentConv =
        addon.data.hermes?.conversations.getCurrentConversation();
      if (!currentConv) {
        return "No active conversation to export as Canvas.";
      }
      const attachedItems = addon.data.hermes?.items.getAttachedItems() || [];
      const customFilename = args.trim() || undefined;

      const result = await addon.data.hermes!.exports.exportCanvasToObsidian(
        currentConv,
        attachedItems,
        customFilename,
      );

      if (result.success) {
        return {
          sendPrompt:
            attachedItems.length > 0
              ? `I have exported our literature knowledge graph to Obsidian Canvas (${result.path || "configured destination"}). Please provide a high-level topological analysis of this network: Identify central theoretical hubs, methodological bridges, and conceptual gaps between these papers.`
              : "",
          systemMessage: `Obsidian Canvas Export: ${result.message}`,
        };
      } else {
        return result.message;
      }
    },
    name: "canvas",
  },
  {
    description:
      "Analyze library/item tags, detect duplicates/variants, and propose a clean taxonomy. Usage: `/organize-tags` or `/organize-tags merge OldTag -> NewTag`",
    execute: async (addon, args) => {
      if (!addon.data.hermes!.preferences.get("enableTags", true)) {
        return "Tag management is disabled. Enable it in Zotero → Settings → Hermes → Automatic Context.";
      }

      const trimmedArgs = args.trim();

      // Check if user wants to execute a merge: /organize-tags merge OldTag -> NewTag
      if (trimmedArgs.toLowerCase().startsWith("merge ")) {
        const mergeSpec = trimmedArgs.slice(6).trim();
        const arrowMatch = mergeSpec.match(/^(.+?)\s*(?:->|=>|to)\s*(.+)$/i);
        if (!arrowMatch) {
          return "Invalid merge syntax. Usage: `/organize-tags merge OldTag -> NewTag`";
        }
        const oldTag = arrowMatch[1].trim();
        const newTag = arrowMatch[2].trim();

        const attachedItems = addon.data.hermes!.items.getAttachedItems();
        const itemIDs =
          attachedItems.length > 0 ? attachedItems.map((i) => i.id) : undefined;

        try {
          const count = await addon.data.hermes!.tags.renameTag(
            oldTag,
            newTag,
            itemIDs,
          );
          return `Successfully merged tag **"${oldTag}"** → **"${newTag}"** across ${count} item(s).`;
        } catch (err) {
          return `Failed to merge tags: ${(err as Error).message}`;
        }
      }

      // Otherwise, scan tags from attached items or all library tags
      const attachedItems = addon.data.hermes!.items.getAttachedItems();
      let tagList: string[] = [];

      if (attachedItems.length > 0) {
        for (const item of attachedItems) {
          tagList.push(...addon.data.hermes!.tags.getItemTags(item.id));
        }
      } else {
        const allTags = await addon.data.hermes!.tags.getAllTags();
        tagList = allTags.map((t) => t.tag);
      }

      const uniqueTags = Array.from(new Set(tagList));
      if (uniqueTags.length === 0) {
        return "No tags found to organize. Attach items or add tags to your library first.";
      }

      const clusters =
        addon.data.hermes!.tags.detectTaxonomyClusters(uniqueTags);
      let duplicateSummary = "";
      if (clusters.duplicates.length > 0) {
        duplicateSummary = `\n**Detected Duplicates & Variants:**\n${clusters.duplicates
          .map(
            (d) =>
              `- Canonical \`${d.canonical}\`: variants [${d.variants.map((v) => `"${v}"`).join(", ")}]`,
          )
          .join("\n")}`;
      }

      const prompt = `I am reviewing the tag taxonomy for my research library (${uniqueTags.length} unique tags analyzed: ${uniqueTags.slice(0, 50).join(", ")}).${duplicateSummary}\n\nPlease recommend a clean, standardized hierarchical ontology (e.g. \`domain/...\`, \`method/...\`, \`dataset/...\`, \`status/...\`). Highlight redundant tags, propose specific merge operations (using \`/organize-tags merge OldTag -> NewTag\`), and explain how this will improve discoverability.`;

      return {
        sendPrompt: prompt,
        systemMessage: `Tag Taxonomy Analysis: ${uniqueTags.length} tags scanned.${clusters.duplicates.length > 0 ? ` Found ${clusters.duplicates.length} duplicate cluster(s).` : ""}`,
      };
    },
    name: "organize-tags",
  },
  {
    description:
      "Generate a chronological literature evolution map and paradigm shift timeline across attached papers",
    execute: async (addon) => {
      const attachedItems = addon.data.hermes!.items.getAttachedItems();
      if (attachedItems.length === 0) {
        return "No items attached to conversation. Attach a collection or multiple papers first (use `/collection` or select items and use `/context`).";
      }

      const sorted = [...attachedItems].sort((a, b) => {
        const yearA = parseInt(a.date || "0", 10) || 0;
        const yearB = parseInt(b.date || "0", 10) || 0;
        return yearA - yearB;
      });

      const itemsSummary = sorted
        .map((i) => {
          const cite = i.citekey ? `@${i.citekey}` : i.title;
          const year = i.date || "Unknown date";
          return `- **${cite}** (${year}): "${i.title}"`;
        })
        .join("\n");

      const prompt = `Synthesize a chronological literature evolution timeline across the attached ${sorted.length} paper(s):\n\n${itemsSummary}\n\nPlease analyze:\n1. **Chronological Arc & Milestones**: Trace the historical trajectory from earliest to latest. For each paper (citing @citekey), identify the breakthrough, theoretical pivot, or new capability introduced.\n2. **Methodological Transitions**: How did methodologies, benchmarks, and architectures evolve across this timeline? What earlier assumptions were overturned?\n3. **Paradigm Shifts & Disagreements**: Where did divergent schools of thought emerge?\n4. **Current Frontier**: Where does this timeline terminate today, and what are the immediate forward trajectories?`;

      return {
        sendPrompt: prompt,
        systemMessage: `Chronological Timeline Analysis: Synthesizing ${sorted.length} papers across time.`,
      };
    },
    name: "timeline",
  },
  {
    description:
      "Conduct a rigorous peer-review methodological critique and stress-test of attached paper(s)",
    execute: async (addon, args) => {
      const attachedItems = addon.data.hermes!.items.getAttachedItems();
      if (attachedItems.length === 0) {
        return "No items attached to conversation. Attach a paper first (use `/context`).";
      }

      const focusAspect = args.trim()
        ? ` Focus specifically on: "${args.trim()}".`
        : "";
      const itemsList = attachedItems
        .map((i) => `${i.citekey ? `@${i.citekey}` : `"${i.title}"`}`)
        .join(", ");

      const prompt = `Conduct an exhaustive academic peer-review critique of the attached paper(s) (${itemsList}).${focusAspect}\n\nExamine:\n1. **Core Thesis & Hidden Assumptions**: What unproven or delicate premises must hold for the primary claims to stand?\n2. **Methodological Rigor & Internal Validity**: Are controls, sample sizes, baselines, and ablation studies adequate? Are there confounding variables or subtle data leaks?\n3. **Threats to External Validity**: Under what real-world conditions or dataset distributions will the proposed method or findings fail?\n4. **Adversarial Counter-arguments**: What is the most devastating criticism a skeptical reviewer could raise?\n5. **Constructive Rebuttal**: What specific follow-up experiment or proof would resolve these concerns?`;

      return {
        sendPrompt: prompt,
        systemMessage: `Peer-Review Critique: Stress-testing methodology and assumptions for ${itemsList}.`,
      };
    },
    name: "critique",
  },
  {
    description:
      "Generate hard seminar discussion questions, exam traps, and defense preparation for attached papers",
    execute: async (addon) => {
      const attachedItems = addon.data.hermes!.items.getAttachedItems();
      if (attachedItems.length === 0) {
        return "No items attached to conversation. Attach a paper first (use `/context`).";
      }

      const itemsList = attachedItems
        .map((i) => `${i.citekey ? `@${i.citekey}` : `"${i.title}"`}`)
        .join(", ");

      const prompt = `Generate a seminar discussion and defense prep kit for the attached paper(s) (${itemsList}):\n\n1. **3 Provocative Seminar Discussion Questions**: Formulate questions that provoke debate between competing paradigms rather than simple factual recitation.\n2. **2 Methodological "Trap" Questions**: Hard technical questions probing subtle implementation choices or dataset compromises.\n3. **Conceptual Stress Test Scenario**: A hypothetical edge-case scenario where the paper's framework is applied to a challenging problem.\n4. **Executive Q&A Defense Cheat Sheet**: 3 concise bullet points to anchor the presenter during a difficult Q&A session.`;

      return {
        sendPrompt: prompt,
        systemMessage: `Seminar & Defense Prep Kit: Formulating discussion questions and technical traps for ${itemsList}.`,
      };
    },
    name: "quiz",
  },
  {
    description:
      "Look up a DOI via CrossRef/DataCite, or find one from the attached item's title. Usage: `/doi [doi]`",
    execute: async (addon, args) => {
      const lookups = addon.data.hermes?.lookups;
      if (!lookups) return "Lookup services are not initialised.";

      const arg = args.trim();
      // A bare DOI is looked up directly; otherwise fall back to the attached
      // item's title (and author/year) via CrossRef's bibliographic query.
      const doi = arg;

      if (!doi || !isDoiLike(normaliseDoi(doi))) {
        const attached = addon.data.hermes?.items.getAttachedItems() || [];
        if (attached.length === 0) {
          return arg
            ? `\`${arg}\` does not look like a DOI, and no item is attached to search by title. Attach an item with \`/context\` first.`
            : "Usage: `/doi 10.1234/example` — or attach an item and run `/doi` to search by its title.";
        }
        const parent = attached[0];
        const titleQuery = parent.title;
        const record = await lookups.findDoiByTitle(titleQuery, {
          author: parent.creators?.[0],
          year: parent.date,
        });
        if (!record) {
          return `No DOI found for **${titleQuery}**. CrossRef's bibliographic match is approximate — verify any candidate before applying.`;
        }
        return `### DOI candidate for **${titleQuery}**

- **DOI**: \`${record.doi}\`
- **Matched title**: ${record.title}
- **Source**: ${record.source}

*Apply with \`/metadata doi=${record.doi}\`. The match is approximate — check it against the item first.*`;
      }

      const record = await lookups.lookupDoi(doi);
      if (!record) {
        return `No record found for DOI \`${normaliseDoi(doi)}\` in CrossRef or DataCite. Check the DOI for typos.`;
      }

      const creators =
        record.creators
          .map((c) => `${c.firstName || ""} ${c.lastName}`.trim())
          .join("; ") || "(none listed)";

      return `### DOI record — \`${record.doi}\`

- **Title**: ${record.title}
- **Type**: ${record.itemType}
- **Creators**: ${creators}
- **Date**: ${record.date || "(none)"}${record.year ? ` (${record.year})` : ""}
- **Publication**: ${record.publicationTitle || "(none)"}
- **Volume/Issue/Pages**: ${record.volume || "—"}/${record.issue || "—"}/${record.pages || "—"}
- **Publisher**: ${record.publisher || "(none)"}
- **Source**: ${record.source}

*Apply the DOI to the attached item with \`/metadata doi=${record.doi}\`.*`;
    },
    name: "doi",
  },
  {
    description:
      "Reverse-citation lookup: which works cite the attached item's DOI. Usage: `/cites`",
    execute: async (addon) => {
      const lookups = addon.data.hermes?.lookups;
      if (!lookups) return "Lookup services are not initialised.";

      const attached = addon.data.hermes?.items.getAttachedItems() || [];
      if (attached.length === 0) {
        return "No item attached. Attach a paper with `/context`, then run `/cites` to see what cites it.";
      }
      const parent = attached[0];
      if (!parent.doi) {
        return `**${parent.title}** has no DOI. Run \`/doi\` to find one first.`;
      }

      // Build the DOI→itemID map once so the synchronous matcher stays
      // synchronous.
      const libraryByDoi = await buildLibraryDoiIndex();

      const works = await lookups.findCitingWorks(parent.doi, {
        limit: 25,
        isInLibrary: (citingDoi) => {
          const id = libraryByDoi.get(normaliseDoi(citingDoi));
          return id ? { id } : null;
        },
      });

      if (works.length === 0) {
        return `Semantic Scholar returned no citing works for **${parent.title}** (\`${parent.doi}\`). The paper may be too recent to have citations indexed.`;
      }

      const list = works
        .map((w) => {
          const venue = w.venue ? ` — *${w.venue}*` : "";
          const year = w.year ? ` (${w.year})` : "";
          const doi = w.doi ? ` \`${w.doi}\`` : "";
          const badge = w.inLibrary ? "  **[in your library]**" : "";
          return `- ${w.title}${year}${venue}${doi}${badge}`;
        })
        .join("\n");

      const inLibrary = works.filter((w) => w.inLibrary).length;
      return `### Works citing **${parent.title}** (${works.length} of up to 25)

${list}

*${inLibrary} of these are already in your library.*`;
    },
    name: "cites",
  },
  {
    description:
      "Edit metadata across every item in the selected collection. Usage: `/bulk-metadata field=value, ...`",
    execute: async (addon, args) => {
      const col = addon.data.hermes?.items.getSelectedCollection();
      if (!col) {
        return "No collection selected in the Zotero collections tree. Click a collection, then run `/bulk-metadata` again.";
      }
      const trimmed = args.trim();
      if (!trimmed) {
        return "Usage: `/bulk-metadata field=value, ...` — e.g. `/bulk-metadata language=en, publisher=My Press`";
      }

      const attached = await addon.data.hermes!.items.attachCollection(
        col,
        500,
      );
      if (attached.length === 0) {
        return `No research items found in collection **"${col.name}"**.`;
      }

      const updates = parseFieldUpdates(trimmed);
      if (Object.keys(updates).length === 0) {
        return "Could not parse any field updates. Usage: `/bulk-metadata field=value, ...`";
      }

      const outcome = await addon.data.hermes!.items.bulkUpdateMetadata(
        attached.map((i) => i.id),
        updates,
      );

      if (outcome.status === "rejected") {
        return "Bulk metadata update cancelled at the approval dialog.";
      }
      if (outcome.status === "failed") {
        return `Bulk metadata update failed: ${outcome.error || "unknown error"}`;
      }
      const fields = Object.keys(updates).join(", ");
      return `Bulk metadata update (**${fields}**) applied to **${outcome.updated}** item(s) in **"${col.name}"**${outcome.failed ? `, ${outcome.failed} failed` : ""}.`;
    },
    name: "bulk-metadata",
  },
  {
    description:
      "Edit metadata across every item attached to the conversation. Usage: `/bulk-field field=value, ...`",
    execute: async (addon, args) => {
      const attached = addon.data.hermes?.items.getAttachedItems() || [];
      if (attached.length === 0) {
        return "No items attached to the conversation. Attach items with `/context` or `/collection` first.";
      }
      const trimmed = args.trim();
      if (!trimmed) {
        return "Usage: `/bulk-field field=value, ...` — e.g. `/bulk-field language=en`";
      }

      const updates = parseFieldUpdates(trimmed);
      if (Object.keys(updates).length === 0) {
        return "Could not parse any field updates. Usage: `/bulk-field field=value, ...`";
      }

      const outcome = await addon.data.hermes!.items.bulkUpdateMetadata(
        attached.map((i) => i.id),
        updates,
      );

      if (outcome.status === "rejected") {
        return "Bulk metadata update cancelled at the approval dialog.";
      }
      if (outcome.status === "failed") {
        return `Bulk metadata update failed: ${outcome.error || "unknown error"}`;
      }
      const fields = Object.keys(updates).join(", ");
      return `Bulk metadata update (**${fields}**) applied to **${outcome.updated}** attached item(s)${outcome.failed ? `, ${outcome.failed} failed` : ""}.`;
    },
    name: "bulk-field",
  },
  {
    description:
      "Edit annotations in place. Usage: `/anno-edit <key> text=..., comment=..., color=#ffd400, page=...`",
    execute: async (addon, args) => {
      const trimmed = args.trim();
      if (!trimmed) {
        return "Usage: `/anno-edit <annotationKey> comment=Fixed, color=#a28ae5` — get a key from `/annotations` or `/anno-search`.";
      }
      const spaceIdx = trimmed.indexOf(" ");
      if (spaceIdx === -1) {
        return "Missing patch. Usage: `/anno-edit <annotationKey> comment=...`";
      }
      const ref = trimmed.slice(0, spaceIdx).trim();
      const patchRaw = trimmed.slice(spaceIdx + 1).trim();
      if (!patchRaw) {
        return "Missing patch. Usage: `/anno-edit <annotationKey> comment=...`";
      }

      const parsed = parseFieldUpdates(patchRaw);
      const patch: {
        text?: string;
        comment?: string;
        color?: string;
        pageLabel?: string;
      } = {};
      if (parsed.text !== undefined) patch.text = String(parsed.text);
      if (parsed.comment !== undefined) patch.comment = String(parsed.comment);
      // Accept both `color` and `colour`; the manager field is `color`.
      if (parsed.color !== undefined) patch.color = String(parsed.color);
      else if (parsed.colour !== undefined) patch.color = String(parsed.colour);
      // `page` maps to Zotero's page *label* for an annotation.
      if (parsed.page !== undefined) patch.pageLabel = String(parsed.page);

      if (Object.keys(patch).length === 0) {
        return "No recognised annotation fields. Use `text`, `comment`, `color` or `page`.";
      }

      const result = await addon.data.hermes!.annotations.updateAnnotationById(
        ref,
        patch,
      );
      if (result.status === "rejected") {
        return "Annotation edit cancelled at the approval dialog.";
      }
      if (result.status === "failed") {
        return `Annotation edit failed: ${result.error || "unknown error"}`;
      }
      return `Annotation \`${ref}\` updated: ${Object.keys(patch).join(", ")}.`;
    },
    name: "anno-edit",
  },
  {
    description:
      "Search annotations across the whole library and cite them. Usage: `/anno-search <text>`",
    execute: async (addon, args) => {
      const query = args.trim();
      if (!query) {
        return "Usage: `/anno-search <text>` — searches annotation text and comments library-wide.";
      }

      const annotationQuery: AnnotationQuery = { text: query, limit: 200 };
      const results =
        await addon.data.hermes!.annotations.searchAnnotations(annotationQuery);

      if (results.length === 0) {
        return `No annotations match **"${query}"**.`;
      }

      const list = results
        .slice(0, 15)
        .map((a) => {
          const page = a.page ? `p.${a.page}` : "—";
          const body = (a.text || a.comment || "").slice(0, 120);
          const key = a.id ? ` \`${a.id}\`` : "";
          return `- **${page}** (${a.type}): "${body}"${key}`;
        })
        .join("\n");

      return `### ${results.length} annotation(s) matching **"${query}"**

${list}${results.length > 15 ? `\n\n*…and ${results.length - 15} more.*` : ""}

*Edit one with \`/anno-edit <key> comment=...\`.*`;
    },
    name: "anno-search",
  },
];

/**
 * Parse `field=value, field=value` into a plain map.
 *
 * Mirrors the `/metadata` parser: comma-separated pairs, `=` or `:`, with
 * surrounding quotes stripped. `creators`/`authors` become an array split on
 * `;`. Extracted so every metadata-editing command parses arguments the same
 * way rather than each inventing its own.
 */
function parseFieldUpdates(input: string): Record<string, any> {
  const updates: Record<string, any> = {};
  const pairs = input.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    const colonIdx = pair.indexOf(":");
    const sepIdx =
      eqIdx !== -1 && (colonIdx === -1 || eqIdx < colonIdx) ? eqIdx : colonIdx;
    if (sepIdx === -1) continue;

    const key = pair.slice(0, sepIdx).trim();
    let val = pair.slice(sepIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!key) continue;

    if (key.toLowerCase() === "creators" || key.toLowerCase() === "authors") {
      updates.creators = val
        .split(";")
        .map((c) => c.trim())
        .filter(Boolean);
    } else {
      updates[key] = val;
    }
  }
  return updates;
}

/**
 * Build a `DOI → itemID` index of the user's library.
 *
 * `/cites` needs a *synchronous* `isInLibrary` matcher (see
 * `LookupManager.findCitingWorks`), so the library is read once up front
 * rather than per citing work. Dois are normalised on both sides so case and
 * `https://doi.org/` prefixes do not defeat the match.
 */
async function buildLibraryDoiIndex(): Promise<Map<string, number>> {
  const index = new Map<string, number>();
  try {
    const ids = await Zotero.Items.getAll(
      Zotero.Libraries.userLibraryID,
      false,
      false,
      true,
    );
    const items = (await Zotero.Items.getAsync(ids)) as any[];
    for (const item of items) {
      const raw = item?.getField?.("DOI");
      if (raw) index.set(normaliseDoi(String(raw)), item.id);
    }
  } catch {
    // A failed index degrades to "nothing marked as in-library" — never lets
    // a citation listing fail outright.
  }
  return index;
}

/**
 * Get all registered slash commands.
 */
export function getSlashCommands(): SlashCommand[] {
  return BUILT_IN_COMMANDS;
}

/**
 * Parse a slash command from user input.
 * Returns null if input doesn't start with '/'.
 */
export function parseSlashCommand(
  input: string,
): { args: string; command: SlashCommand } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const spaceIndex = trimmed.indexOf(" ");
  const commandName = trimmed
    .slice(1, spaceIndex === -1 ? undefined : spaceIndex)
    .toLowerCase();
  const args = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1);

  const command = BUILT_IN_COMMANDS.find(
    (cmd) => cmd.name.toLowerCase() === commandName,
  );

  if (!command) {
    // Return as a synthetic command to forward to Hermes
    return {
      args,
      command: {
        description: "Send command to Hermes",
        execute: async () => null,
        name: commandName,
      },
    };
  }

  return { args, command };
}
