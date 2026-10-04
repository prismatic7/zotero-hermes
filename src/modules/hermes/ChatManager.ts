import type Addon from "../../addon";
import type { Conversation } from "./ConversationManager";
import { ChatMessage, ContextItem } from "../../views/types";

/**
 * Manages chat conversations and state for Hermes Agent.
 * Integrates with ConversationManager for persistence.
 *
 * Saves are debounced (500ms) to avoid excessive I/O during streaming.
 */
export class ChatManager {
  private messages: ChatMessage[] = [];
  private readonly addon: Addon;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly SAVE_DEBOUNCE_MS = 500;

  constructor(addon: Addon) {
    this.addon = addon;
  }

  /**
   * Schedule a debounced save to disk. Only the last call within the
   * debounce window actually writes. Respects the autoSave pref (M4).
   * Verifies conversation ID matching to prevent cross-conversation overwrite.
   */
  private scheduleSave(): void {
    const autoSave = this.addon.data.hermes?.preferences?.get<boolean>(
      "autoSave",
      true,
    );
    if (autoSave === false) return;

    const currentConv =
      this.addon.data.hermes?.conversations.getCurrentConversation();
    if (!currentConv) return;
    const targetConvId = currentConv.id;

    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const conv =
        this.addon.data.hermes?.conversations.getCurrentConversation();
      // Verify active conversation has not switched during the debounce delay
      if (conv && conv.id === targetConvId) {
        conv.messages = [...this.messages];
        this.addon.data.hermes?.conversations.saveConversation(conv);
      }
    }, this.SAVE_DEBOUNCE_MS);
  }

  public addMessage(message: ChatMessage): void {
    this.messages.push(message);
    this.scheduleSave();
  }

  public getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  public setMessages(newMessages: ChatMessage[]): void {
    this.messages = newMessages;
    this.scheduleSave();
  }

  public clearMessages(): void {
    this.messages = [];
    // Flush immediately on clear
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.addon.data.hermes?.conversations.clearMessages();
  }

  public loadFromConversation(conv: Conversation): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.messages = conv.messages || [];
  }

  /**
   * Force an immediate flush of any pending save.
   */
  public flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const conv = this.addon.data.hermes?.conversations.getCurrentConversation();
    if (conv) {
      conv.messages = [...this.messages];
      this.addon.data.hermes?.conversations.saveConversation(conv);
    }
  }

  private externalPromptListeners: Array<
    (prompt: string, contextItems?: ContextItem[]) => void
  > = [];

  /**
   * Prompts dispatched before the React view has subscribed. React 18's
   * `createRoot().render()` is asynchronous, so a menu/reader action that
   * fires a prompt during (or shortly after) the sidebar toggle can beat
   * the subscription effect in HermesChatView. Without a buffer the
   * prompt was silently dropped — the sidebar opened with nothing in it.
   * Capped so an unattended dispatch cannot grow unbounded.
   */
  private pendingExternalPrompts: Array<{
    prompt: string;
    contextItems?: ContextItem[];
  }> = [];
  private readonly MAX_PENDING_PROMPTS = 20;

  public onExternalPrompt(
    callback: (prompt: string, contextItems?: ContextItem[]) => void,
  ): () => void {
    this.externalPromptListeners.push(callback);
    // Replay anything dispatched before this subscriber existed.
    if (this.pendingExternalPrompts.length > 0) {
      const pending = this.pendingExternalPrompts;
      this.pendingExternalPrompts = [];
      for (const p of pending) {
        try {
          callback(p.prompt, p.contextItems);
        } catch (err) {
          this.addon.log(
            `Error replaying external prompt: ${(err as Error).message}`,
          );
        }
      }
    }
    return () => {
      this.externalPromptListeners = this.externalPromptListeners.filter(
        (cb) => cb !== callback,
      );
    };
  }

  /**
   * Dispatch a prompt from outside the React tree (item context menu,
   * reader actions). Optionally carries pre-built context items so the
   * prompt stays grounded in the item's metadata.
   *
   * @returns the number of subscribers the prompt reached synchronously;
   *   0 means no ChatView subscriber existed yet and it was buffered for
   *   the next one (see `pendingExternalPrompts`).
   */
  public dispatchExternalPrompt(
    prompt: string,
    contextItems?: ContextItem[],
  ): number {
    if (this.externalPromptListeners.length === 0) {
      this.pendingExternalPrompts.push({ prompt, contextItems });
      if (this.pendingExternalPrompts.length > this.MAX_PENDING_PROMPTS) {
        this.pendingExternalPrompts.shift();
      }
      this.addon.log("External prompt buffered — no ChatView subscriber yet");
      return 0;
    }
    for (const listener of this.externalPromptListeners) {
      try {
        listener(prompt, contextItems);
      } catch (err) {
        this.addon.log(
          `Error in externalPrompt listener: ${(err as Error).message}`,
        );
      }
    }
    return this.externalPromptListeners.length;
  }
}
