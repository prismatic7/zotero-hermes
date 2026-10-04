import type Addon from "../../addon";
import type { Conversation } from "./ConversationManager";
import type { AttachedItem } from "./ItemManager";
import { stripAnsi } from "../../utils/stripAnsi";
import { getDataDir, getProfileDir } from "../../utils/zoteroPaths";

export interface ExportResult {
  message: string;
  path?: string;
  success: boolean;
}

export interface CanvasNode {
  color?: string;
  height: number;
  id: string;
  text: string;
  type: "text";
  width: number;
  x: number;
  y: number;
}

export interface CanvasEdge {
  color?: string;
  fromNode: string;
  fromSide: "bottom" | "left" | "right" | "top";
  id: string;
  label?: string;
  toNode: string;
  toSide: "bottom" | "left" | "right" | "top";
}

export interface CanvasData {
  edges: CanvasEdge[];
  nodes: CanvasNode[];
}

/**
 * Manages exporting Hermes conversations into clean Markdown (with YAML frontmatter,
 * wikilinks, and zotero:// deep links) for Obsidian, notes, and local files.
 */
export class ExportManager {
  private readonly addon: Addon;

  constructor(addon: Addon) {
    this.addon = addon;
  }

  /**
   * Formats a conversation and its attached item context into a structured Markdown document
   * complete with Obsidian-compatible YAML frontmatter.
   */
  public exportToMarkdown(
    conversation: Conversation,
    attachedItems: AttachedItem[] = [],
  ): string {
    const title = conversation.title || "Hermes Conversation";
    const dateStr = new Date(conversation.createdAt).toISOString();
    const persona =
      this.addon.data.hermes?.preferences?.get("currentPersona", "default") ||
      "default";

    // Escape quotes in frontmatter title
    const escapedTitle = title.replace(/"/g, '\\"');

    // Build YAML frontmatter
    let frontmatter = "---\n";
    frontmatter += `title: "${escapedTitle}"\n`;
    frontmatter += `date: ${dateStr}\n`;
    frontmatter += `persona: ${persona}\n`;
    frontmatter += `tags:\n  - hermes\n  - zotero-chat\n`;

    if (attachedItems.length > 0) {
      frontmatter += `sources:\n`;
      for (const item of attachedItems) {
        const itemEscapedTitle = item.title.replace(/"/g, '\\"');
        const citekeyStr = item.citekey ? `"${item.citekey}"` : "null";
        frontmatter += `  - title: "${itemEscapedTitle}"\n`;
        frontmatter += `    key: "${item.key}"\n`;
        frontmatter += `    citekey: ${citekeyStr}\n`;
        frontmatter += `    zotero_select_uri: "zotero://select/items/${item.key}"\n`;
        if (item.attachmentKey) {
          frontmatter += `    zotero_pdf_uri: "zotero://open-pdf/library/items/${item.attachmentKey}"\n`;
        }
      }
    }
    frontmatter += "---\n\n";

    // Build Document Body
    let body = `# ${title}\n\n`;

    // Attached Sources section
    if (attachedItems.length > 0) {
      body += `## Attached Sources\n\n`;
      for (const item of attachedItems) {
        const citekeyDisplay = item.citekey ? ` (\`@${item.citekey}\`)` : "";
        body += `- **[[${item.title}]]**${citekeyDisplay}\n`;
        body += `  - **Zotero Link**: [Open in Zotero](zotero://select/items/${item.key})\n`;
        if (item.attachmentKey) {
          body += `  - **PDF Reader**: [Open PDF](zotero://open-pdf/library/items/${item.attachmentKey})\n`;
        }
        if (item.creators && item.creators.length > 0) {
          body += `  - **Authors**: ${item.creators.join(", ")}\n`;
        }
        if (item.date) {
          body += `  - **Date**: ${item.date}\n`;
        }
        if (item.doi) {
          body += `  - **DOI**: [${item.doi}](https://doi.org/${item.doi})\n`;
        }
        body += `\n`;
      }
      body += `---\n\n`;
    }

    // Transcript section
    body += `## Discussion\n\n`;

    const messages = conversation.messages || [];
    for (const msg of messages) {
      const rawContent = msg.content || "";
      const cleanContent = stripAnsi(rawContent).trim();

      if (msg.role === "user") {
        body += `### 🧑 User\n\n${cleanContent}\n\n`;
      } else if (msg.role === "assistant") {
        body += `### 🤖 Hermes\n\n${cleanContent}\n\n`;
      } else if (msg.role === "reasoning") {
        body += `<details>\n<summary>💭 Thought Process</summary>\n\n${cleanContent}\n\n</details>\n\n`;
      } else if (msg.role === "tool") {
        const toolName =
          (msg as any).toolCall?.name || msg.toolCallId || "Action";
        body += `> 🛠️ **${toolName}**\n> \n> \`\`\`\n> ${cleanContent.replace(/\n/g, "\n> ")}\n> \`\`\`\n\n`;
      }
    }

    return frontmatter + body;
  }

  /**
   * Export conversation directly into the user's configured Obsidian vault.
   * Creates a 'Hermes' folder inside the vault root if it does not already exist.
   */
  public async exportToObsidianVault(
    conversation: Conversation,
    attachedItems: AttachedItem[] = [],
    customFilename?: string,
  ): Promise<ExportResult> {
    const vaultPath =
      this.addon.data.hermes?.preferences?.get<string>(
        "obsidianVaultPath",
        "",
      ) || "";
    if (!vaultPath || !vaultPath.trim()) {
      return {
        success: false,
        message:
          "No Obsidian vault folder configured. Please set your vault path in Zotero Settings → Hermes → Saving Conversations.",
      };
    }

    try {
      const vaultDir = Zotero.File.pathToFile(vaultPath.trim());
      if (!vaultDir.exists() || !vaultDir.isDirectory) {
        return {
          success: false,
          message: `Obsidian vault directory not found: "${vaultPath}"`,
        };
      }

      // Create or locate 'Hermes' folder in the vault
      const hermesFolder = vaultDir.clone() as nsIFile;
      hermesFolder.append("Hermes");
      if (!hermesFolder.exists()) {
        hermesFolder.create(
          Components.interfaces.nsIFile.DIRECTORY_TYPE as number,
          0o755,
        );
      }

      // Format safe filename
      const title = conversation.title || "Hermes-Chat";
      const sanitizedTitle = (customFilename || title)
        .replace(/[/\\?%*:|"<>]/g, "-")
        .replace(/\s+/g, " ")
        .trim();
      const filename = sanitizedTitle.endsWith(".md")
        ? sanitizedTitle
        : `${sanitizedTitle}.md`;

      const targetFile = hermesFolder.clone() as nsIFile;
      targetFile.append(filename);

      const markdown = this.exportToMarkdown(conversation, attachedItems);
      Zotero.File.putContents(targetFile, markdown);

      this.addon.data.hermes?.auditLog?.record(
        "file_change",
        `Obsidian Export: ${targetFile.path}`,
        "success",
        { conversationId: conversation.id, path: targetFile.path },
      );

      return {
        success: true,
        path: targetFile.path,
        message: `Successfully exported to Obsidian: **${filename}**`,
      };
    } catch (err) {
      const errorMsg = (err as Error).message;
      this.addon.log(`ExportManager: Obsidian export failed: ${errorMsg}`);
      return {
        success: false,
        message: `Failed to export to Obsidian: ${errorMsg}`,
      };
    }
  }

  /**
   * Save markdown to a user-chosen file location using nsIFilePicker.
   */
  public async exportWithFilePicker(
    conversation: Conversation,
    attachedItems: AttachedItem[] = [],
  ): Promise<ExportResult> {
    try {
      const title = conversation.title || "Hermes-Chat";
      const sanitizedTitle = title
        .replace(/[/\\?%*:|"<>]/g, "-")
        .replace(/\s+/g, " ")
        .trim();
      const defaultFilename = `${sanitizedTitle}.md`;

      const win = Zotero.getMainWindow();
      if (!win) {
        // Fallback: save to conversation directory
        return this.exportToLocalDataDir(conversation, attachedItems);
      }

      const fp = (Components as any).classes[
        "@mozilla.org/filepicker;1"
      ].createInstance(Components.interfaces.nsIFilePicker);

      fp.init(
        win,
        "Save Hermes Conversation as Markdown",
        Components.interfaces.nsIFilePicker.modeSave,
      );
      fp.appendFilter("Markdown (*.md)", "*.md");
      fp.defaultString = defaultFilename;
      fp.defaultExtension = "md";

      return new Promise<ExportResult>((resolve) => {
        fp.open((result: number) => {
          if (
            result === Components.interfaces.nsIFilePicker.returnOK ||
            result === Components.interfaces.nsIFilePicker.returnReplace
          ) {
            try {
              const file = fp.file;
              const markdown = this.exportToMarkdown(
                conversation,
                attachedItems,
              );
              Zotero.File.putContents(file, markdown);

              this.addon.data.hermes?.auditLog?.record(
                "file_change",
                `Markdown Export: ${file.path}`,
                "success",
                { conversationId: conversation.id, path: file.path },
              );

              resolve({
                success: true,
                path: file.path,
                message: `Exported to: **${file.leafName}**`,
              });
            } catch (err) {
              resolve({
                success: false,
                message: `Failed to write file: ${(err as Error).message}`,
              });
            }
          } else {
            resolve({
              success: false,
              message: "Export cancelled by user.",
            });
          }
        });
      });
    } catch (err) {
      return {
        success: false,
        message: `File picker error: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Fallback export to Hermes exports folder in Zotero data dir.
   */
  public exportToLocalDataDir(
    conversation: Conversation,
    attachedItems: AttachedItem[] = [],
  ): ExportResult {
    try {
      const baseDir: nsIFile | null = getProfileDir() || getDataDir();
      if (!baseDir) {
        return {
          success: false,
          message: "Could not locate Zotero data directory.",
        };
      }

      baseDir.append("zotero-hermes");
      baseDir.append("exports");
      if (!baseDir.exists()) {
        baseDir.create(
          Components.interfaces.nsIFile.DIRECTORY_TYPE as number,
          0o755,
        );
      }

      const title = conversation.title || "Hermes-Chat";
      const filename = `${title.replace(/[/\\?%*:|"<>]/g, "-")}.md`;
      baseDir.append(filename);

      const markdown = this.exportToMarkdown(conversation, attachedItems);
      Zotero.File.putContents(baseDir, markdown);

      return {
        success: true,
        path: baseDir.path,
        message: `Saved to: **${baseDir.path}**`,
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to save export: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Export conversation as a Zotero rich child or standalone note.
   */
  public async exportToZoteroNote(
    conversation: Conversation,
    attachedItems: AttachedItem[] = [],
  ): Promise<ExportResult> {
    try {
      const title = conversation.title || "Hermes Discussion";
      const parentItemID =
        attachedItems.length > 0 ? attachedItems[0].id : undefined;

      const messages = conversation.messages || [];
      const htmlBody = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => {
          const roleLabel = m.role === "user" ? "You" : "Hermes";
          const formatted = (m.content || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\n/g, "<br/>")
            .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
          return `<p><strong>${roleLabel}:</strong> ${formatted}</p>`;
        })
        .join("\n");

      const noteID = await this.addon.data.hermes!.notes.writeNote(
        null,
        htmlBody,
        title,
        parentItemID,
      );

      return {
        success: true,
        message: `Saved as Zotero Note (ID: ${noteID}).`,
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to create Zotero note: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Converts conversation and attached items into an Obsidian Canvas (.canvas) JSON document.
   */
  public exportToCanvas(
    conversation: Conversation,
    attachedItems: AttachedItem[] = [],
  ): string {
    const nodes: CanvasNode[] = [];
    const edges: CanvasEdge[] = [];

    const title = conversation.title || "Hermes Research Graph";
    const dateStr = new Date(conversation.createdAt).toLocaleDateString();

    // 1. Root Header Card
    nodes.push({
      id: "root-header",
      type: "text",
      text: `# 🧠 ${title}\n\n**Synthesized:** ${dateStr} • **Sources:** ${attachedItems.length} papers\n\n*Generated by Hermes Agent for Zotero*`,
      x: -240,
      y: -180,
      width: 480,
      height: 140,
      color: "6", // Purple
    });

    if (attachedItems.length === 0) {
      nodes.push({
        id: "no-items-card",
        type: "text",
        text: `### ℹ️ No Items Attached\n\nAttach Zotero library items to generate a multi-paper knowledge graph.`,
        x: -180,
        y: 40,
        width: 360,
        height: 120,
        color: "1",
      });
      return JSON.stringify({ nodes, edges } as CanvasData, null, 2);
    }

    // 2. Paper Cards (Structured grid layout)
    const cardWidth = 380;
    const cardHeight = 260;
    const gapX = 40;
    const gapY = 50;
    const colCount = Math.min(3, Math.max(1, attachedItems.length));
    const totalWidth = colCount * cardWidth + (colCount - 1) * gapX;
    const startX = -Math.floor(totalWidth / 2);

    attachedItems.forEach((item, idx) => {
      const row = Math.floor(idx / colCount);
      const col = idx % colCount;
      const x = startX + col * (cardWidth + gapX);
      const y = 80 + row * (cardHeight + gapY);

      const nodeId = `paper-${item.key}`;
      const citekeyStr = item.citekey ? `\`@${item.citekey}\` • ` : "";
      const authorsStr =
        item.creators && item.creators.length > 0
          ? `${item.creators.slice(0, 3).join(", ")}${item.creators.length > 3 ? " et al." : ""}`
          : "Unknown authors";
      const yearStr = item.date ? ` (${item.date})` : "";
      const abstractExcerpt = item.abstract
        ? `> ${item.abstract.slice(0, 160).trim()}...\n\n`
        : "";

      const cardText = `### 📄 [[${item.title}]]\n\n**${citekeyStr}${authorsStr}${yearStr}**\n\n${abstractExcerpt}[🔗 Open in Zotero](zotero://select/items/${item.key})${
        item.attachmentKey
          ? ` • [📖 Open PDF](zotero://open-pdf/library/items/${item.attachmentKey})`
          : ""
      }`;

      nodes.push({
        id: nodeId,
        type: "text",
        text: cardText,
        x,
        y,
        width: cardWidth,
        height: cardHeight,
        color: "4", // Green
      });

      // Edge from header to each paper
      edges.push({
        id: `edge-header-${item.key}`,
        fromNode: "root-header",
        fromSide: "bottom",
        toNode: nodeId,
        toSide: "top",
      });
    });

    // 3. Chronological links between papers with dates
    const datedItems = [...attachedItems]
      .filter((i) => i.date && !isNaN(parseInt(i.date, 10)))
      .sort((a, b) => parseInt(a.date!, 10) - parseInt(b.date!, 10));

    for (let k = 0; k < datedItems.length - 1; k++) {
      const curr = datedItems[k];
      const next = datedItems[k + 1];
      if (curr.key !== next.key) {
        edges.push({
          id: `edge-chrono-${curr.key}-${next.key}`,
          fromNode: `paper-${curr.key}`,
          fromSide: "right",
          toNode: `paper-${next.key}`,
          toSide: "left",
          label: "precedes",
          color: "5", // Cyan
        });
      }
    }

    return JSON.stringify({ nodes, edges } as CanvasData, null, 2);
  }

  /**
   * Export conversation knowledge graph directly to Obsidian Canvas folder.
   */
  public async exportCanvasToObsidian(
    conversation: Conversation,
    attachedItems: AttachedItem[] = [],
    customFilename?: string,
  ): Promise<ExportResult> {
    try {
      const vaultPath =
        this.addon.data.hermes?.preferences?.get<string>(
          "obsidianVaultPath",
          "",
        ) || "";
      if (!vaultPath) {
        return this.exportCanvasWithFilePicker(conversation, attachedItems);
      }

      const vaultDir = Zotero.File.pathToFile(vaultPath);
      if (!vaultDir.exists() || !vaultDir.isDirectory) {
        return this.exportCanvasWithFilePicker(conversation, attachedItems);
      }

      // Ensure Hermes/Canvas directory in vault
      const hermesFolder = vaultDir.clone() as nsIFile;
      hermesFolder.append("Hermes");
      if (!hermesFolder.exists()) {
        hermesFolder.create(
          Components.interfaces.nsIFile.DIRECTORY_TYPE as number,
          0o755,
        );
      }
      const canvasFolder = hermesFolder.clone() as nsIFile;
      canvasFolder.append("Canvas");
      if (!canvasFolder.exists()) {
        canvasFolder.create(
          Components.interfaces.nsIFile.DIRECTORY_TYPE as number,
          0o755,
        );
      }

      const title = conversation.title || "Hermes-Graph";
      const sanitizedTitle = (customFilename || title)
        .replace(/[/\\?%*:|"<>]/g, "-")
        .replace(/\s+/g, " ")
        .trim();
      const filename = sanitizedTitle.endsWith(".canvas")
        ? sanitizedTitle
        : `${sanitizedTitle}.canvas`;

      const targetFile = canvasFolder.clone() as nsIFile;
      targetFile.append(filename);

      const canvasJson = this.exportToCanvas(conversation, attachedItems);
      Zotero.File.putContents(targetFile, canvasJson);

      this.addon.data.hermes?.auditLog?.record(
        "file_change",
        `Obsidian Canvas Export: ${targetFile.path}`,
        "success",
        { conversationId: conversation.id, path: targetFile.path },
      );

      return {
        success: true,
        path: targetFile.path,
        message: `Successfully exported Obsidian Canvas: **${filename}**`,
      };
    } catch (err) {
      const errorMsg = (err as Error).message;
      this.addon.log(`ExportManager: Canvas export failed: ${errorMsg}`);
      return {
        success: false,
        message: `Failed to export Canvas: ${errorMsg}`,
      };
    }
  }

  /**
   * Save Obsidian Canvas file using nsIFilePicker.
   */
  public async exportCanvasWithFilePicker(
    conversation: Conversation,
    attachedItems: AttachedItem[] = [],
  ): Promise<ExportResult> {
    try {
      const title = conversation.title || "Hermes-Graph";
      const sanitizedTitle = title
        .replace(/[/\\?%*:|"<>]/g, "-")
        .replace(/\s+/g, " ")
        .trim();
      const defaultFilename = `${sanitizedTitle}.canvas`;

      const win = Zotero.getMainWindow();
      if (!win) {
        return {
          success: false,
          message: "No Zotero window available for file picker.",
        };
      }

      const fp = (Components as any).classes[
        "@mozilla.org/filepicker;1"
      ].createInstance(Components.interfaces.nsIFilePicker);

      fp.init(
        win,
        "Save Obsidian Canvas",
        Components.interfaces.nsIFilePicker.modeSave,
      );
      fp.appendFilter("Obsidian Canvas (*.canvas)", "*.canvas");
      fp.defaultString = defaultFilename;
      fp.defaultExtension = "canvas";

      return new Promise<ExportResult>((resolve) => {
        fp.open((result: number) => {
          if (
            result === Components.interfaces.nsIFilePicker.returnOK ||
            result === Components.interfaces.nsIFilePicker.returnReplace
          ) {
            try {
              const file = fp.file;
              const canvasJson = this.exportToCanvas(
                conversation,
                attachedItems,
              );
              Zotero.File.putContents(file, canvasJson);

              this.addon.data.hermes?.auditLog?.record(
                "file_change",
                `Canvas File Export: ${file.path}`,
                "success",
                { conversationId: conversation.id, path: file.path },
              );

              resolve({
                success: true,
                path: file.path,
                message: `Saved Obsidian Canvas to: **${file.path}**`,
              });
            } catch (saveErr) {
              resolve({
                success: false,
                message: `Failed to write file: ${(saveErr as Error).message}`,
              });
            }
          } else {
            resolve({
              success: false,
              message: "Canvas export cancelled.",
            });
          }
        });
      });
    } catch (err) {
      return {
        success: false,
        message: `File picker error: ${(err as Error).message}`,
      };
    }
  }
}
