import type Addon from "../../addon";
import type { ChatMessage } from "../../views/types";
import {
  ensureHermesDir,
  getDataDir,
  getProfileDir,
} from "../../utils/zoteroPaths";

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  allowedTools: string[] | null;
}

/**
 * Manages conversation persistence and history for Hermes Agent.
 * Conversations are stored in Zotero's data directory as JSON files.
 */
export class ConversationManager {
  private readonly addon: Addon;
  private currentConversation: Conversation | null = null;
  private conversations = new Map<string, Conversation>();

  // Cached resolved directory path. Invalidated when org/folder prefs change.
  private _cachedDir: string | null = null;
  private _cachedDirOrg: string | null = null;
  private _cachedDirFolder: string | null = null;

  constructor(addon: Addon) {
    this.addon = addon;
  }

  /**
   * Get the base conversations directory path.
   * Prefers the Zotero profile directory; falls back to the Zotero data
   * directory. Never writes to /tmp — conversations are user data and must
   * survive restarts.
   */
  private getBaseDir(): string {
    const baseDir = getProfileDir() || getDataDir();
    if (!baseDir) {
      this.addon.log(
        "[ConversationManager] No profile or data directory available — conversations will not be persisted",
      );
      return "";
    }
    const folderName =
      this.addon.data.hermes?.preferences?.get("chatSaveFolder", "hermes") ||
      "hermes";
    return ensureHermesDir(baseDir, folderName, this.addon);
  }

  /**
   * Get the conversations directory path, respecting organisation preference.
   * Result is cached and only recomputed when the org or folder prefs change.
   */
  private getConversationsDir(): string {
    const organization =
      this.addon.data.hermes?.preferences?.get<string>(
        "conversationOrganization",
        "flat",
      ) || "flat";
    const folderName =
      this.addon.data.hermes?.preferences?.get("chatSaveFolder", "hermes") ||
      "hermes";

    // Invalidate cache if relevant prefs have changed since last call.
    if (
      this._cachedDir !== null &&
      this._cachedDirOrg === organization &&
      this._cachedDirFolder === folderName
    ) {
      return this._cachedDir;
    }

    const baseDir = this.getBaseDir();
    if (!baseDir) {
      this._cachedDir = "";
      this._cachedDirOrg = organization;
      this._cachedDirFolder = folderName;
      return "";
    }
    let resolvedDir: string;

    if (organization === "by-date") {
      const now = new Date();
      const monthDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const dir = Zotero.File.pathToFile(baseDir);
      const subDir = dir.clone() as nsIFile;
      subDir.append(monthDir);
      if (!subDir.exists()) {
        subDir.create(
          Components.interfaces.nsIFile.DIRECTORY_TYPE as number,
          0o755,
        );
      }
      resolvedDir = subDir.path;
    } else {
      // flat (default) or by-project (not yet implemented)
      resolvedDir = baseDir;
    }

    this._cachedDir = resolvedDir;
    this._cachedDirOrg = organization;
    this._cachedDirFolder = folderName;

    return resolvedDir;
  }

  /**
   * Validate that a conversation ID is alphanumeric with hyphens/underscores only.
   * Rejects path traversal attempts (../, / , \).
   */
  public isValidId(id: string): boolean {
    return Boolean(id && /^[a-zA-Z0-9_-]+$/.test(id));
  }

  /**
   * Get the file path for a conversation.
   */
  private getConversationFile(id: string): string {
    if (!this.isValidId(id)) {
      this.addon.log(
        `[ConversationManager] Invalid conversation ID rejected: ${id}`,
      );
      return "";
    }
    const dir = this.getConversationsDir();
    if (!dir) return "";
    return `${dir}/${id}.json`;
  }

  /**
   * Create a new conversation.
   */
  public createConversation(title?: string): Conversation {
    const conversation: Conversation = {
      id: this.generateId(),
      title: title || `Conversation ${new Date().toLocaleString()}`,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      allowedTools: null,
    };
    this.currentConversation = conversation;
    this.conversations.set(conversation.id, conversation);
    this.saveConversation(conversation);
    return conversation;
  }

  /**
   * Save a conversation to disk.
   */
  public saveConversation(conversation: Conversation): void {
    conversation.updatedAt = Date.now();
    this.conversations.set(conversation.id, conversation);

    const filePath = this.getConversationFile(conversation.id);
    if (!filePath) return;
    const json = JSON.stringify(conversation, null, 2);

    try {
      const file = Zotero.File.pathToFile(filePath);
      Zotero.File.putContents(file, json);
    } catch (err) {
      this.addon.log(`Failed to save conversation: ${(err as Error).message}`);
    }
  }

  /**
   * Load a conversation from disk WITHOUT making it the current one.
   */
  private loadConversationFromFile(id: string): Conversation | null {
    const filePath = this.getConversationFile(id);
    if (!filePath) return null;

    try {
      const file = Zotero.File.pathToFile(filePath);
      if (!file.exists()) {
        return null;
      }

      const json = Zotero.File.getContents(file) as string;
      return JSON.parse(json) as Conversation;
    } catch (err) {
      this.addon.log(`Failed to load conversation: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Load a conversation from disk and make it the current one.
   */
  public loadConversation(id: string): Conversation | null {
    const conversation = this.loadConversationFromFile(id);
    if (conversation) {
      this.conversations.set(id, conversation);
      this.currentConversation = conversation;
    }
    return conversation;
  }

  /**
   * Load all conversations from disk.
   * Does NOT mutate the current conversation — listing history must not
   * clobber the active chat's state (M1).
   */
  public loadAllConversations(): Conversation[] {
    const dir = this.getConversationsDir();
    const dirFile = Zotero.File.pathToFile(dir);

    // nsIFile.isDirectory is a boolean PROPERTY, not a method (min1 fix).
    if (!dirFile.exists() || !dirFile.isDirectory) {
      return [];
    }

    const entries = dirFile.directoryEntries;
    const conversations: Conversation[] = [];

    while (entries.hasMoreElements()) {
      const entry = entries.getNext() as nsIFile;
      if (entry.leafName.endsWith(".json")) {
        const conv = this.loadConversationFromFile(
          entry.leafName.replace(".json", ""),
        );
        if (conv) {
          conversations.push(conv);
        }
      }
    }

    return conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Delete a conversation.
   */
  public deleteConversation(id: string): boolean {
    const filePath = this.getConversationFile(id);
    if (!filePath) return false;

    try {
      const file = Zotero.File.pathToFile(filePath);
      if (file.exists()) {
        file.remove(false);
      }
      this.conversations.delete(id);
      if (this.currentConversation?.id === id) {
        this.currentConversation = null;
      }
      return true;
    } catch (err) {
      this.addon.log(
        `Failed to delete conversation: ${(err as Error).message}`,
      );
      return false;
    }
  }

  public getCurrentConversation(): Conversation | null {
    return this.currentConversation;
  }

  public setCurrentConversation(id: string): void {
    const conversation =
      this.conversations.get(id) || this.loadConversation(id);
    if (conversation) {
      this.currentConversation = conversation;
    }
  }

  public getAllConversations(): Conversation[] {
    return Array.from(this.conversations.values()).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }

  public clearMessages(): void {
    if (this.currentConversation) {
      this.currentConversation.messages = [];
      this.saveConversation(this.currentConversation);
    }
  }

  private generateId(): string {
    return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}
