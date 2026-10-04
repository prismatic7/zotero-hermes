import type Addon from "../../addon";

import { buildPersonaPrompt, buildItemContext } from "./systemPrompt";
import type { ChatClient, ChatSessionUpdate, PromptContextItem } from "./types";
import { getDataDirPath } from "../../utils/zoteroPaths";

/**
 * Client for the Hermes Agent REST API with Server-Sent Events streaming.
 *
 * This is an alternative to the ACP (stdio) client for environments where
 * spawning a subprocess is unreliable or unavailable. It connects to the Hermes
 * API server over HTTP and streams responses via SSE.
 *
 * INTERFACE COMPATIBILITY:
 * - Implements the same public interface as HermesClient (ACP) so the React UI
 *   and other consumers don't need to know which backend is active.
 * - Uses Zotero preferences for API URL and key storage.
 */
export class HermesApiClient implements ChatClient {
  private _isConnected = false;
  private readonly addon: Addon;
  private activeAbortController: AbortController | null = null;
  private messageCallbacks: ((update: ChatSessionUpdate) => void)[] = [];
  private errorCallbacks: ((error: Error) => void)[] = [];
  private commandsCallbacks: ((
    commands: { description: string; name: string }[],
  ) => void)[] = [];
  private toolCallbacks: ((
    toolCallId: string,
    title: string,
    status: string,
    payload?: string,
  ) => void)[] = [];
  private lastAvailableCommands: { description: string; name: string }[] = [];
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private reconnectTimeout: number | null = null;
  private isConnecting = false;
  private isReconnecting = false;

  constructor(addon: Addon) {
    this.addon = addon;
  }

  public isReady(): boolean {
    const url = this.getApiUrl();
    return Boolean(url);
  }

  public getIsConnected(): boolean {
    return this._isConnected;
  }

  public getSessionId(): string | null {
    // API is stateless; no session ID
    return null;
  }

  /**
   * Verify connectivity by hitting the /health endpoint.
   */
  public async connect(): Promise<void> {
    if (this._isConnected || this.isConnecting) {
      return;
    }
    this.isConnecting = true;

    try {
      const url = `${this.getApiUrl()}/health`;
      this.addon.log(`Hermes API: checking health at ${url}`);

      const response = await fetch(url, {
        method: "GET",
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "Unknown error");
        throw new Error(`Health check failed: ${response.status} ${text}`);
      }

      const data = (await response.json()) as { status?: string };
      this.addon.log(`Hermes API: health check OK`, data);

      this._isConnected = true;
      this.reconnectAttempts = 0;

      // Fetch available commands for slash-command support
      await this.fetchAvailableCommands();
    } catch (error) {
      this.addon.log("Hermes API: connection failed", error);
      throw error;
    } finally {
      this.isConnecting = false;
    }
  }

  public disconnect(): void {
    this.cancelReconnect();
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
    this._isConnected = false;
  }

  public async cancel(): Promise<void> {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
  }

  public async sendPrompt(
    text: string,
    contextItems: PromptContextItem[] = [],
    options?: { allowedTools?: string[] | null },
  ): Promise<void> {
    if (!this._isConnected) {
      await this.connect();
    }

    // Abort any in-flight request before starting a new one
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }

    const url = `${this.getApiUrl()}/v1/chat/completions`;
    const messages: Record<string, unknown>[] = [];

    // Inject persona as a system message (single source of truth:
    // buildPersonaPrompt from systemPrompt.ts — same wording as ACP mode)
    const persona = (this.addon.data.hermes?.preferences?.get(
      "currentPersona",
      "default",
    ) || "default") as string;
    messages.push({
      role: "system",
      content: buildPersonaPrompt(persona),
    });

    // M8: inject tool restrictions. null/undefined = unrestricted (skip);
    // an empty array = block ALL tools and must still be transmitted.
    if (options?.allowedTools !== undefined && options?.allowedTools !== null) {
      const restriction =
        options.allowedTools.length > 0
          ? `You are restricted to ONLY using the following tools: ${options.allowedTools.join(", ")}.`
          : "You are not allowed to use ANY tools in this conversation. Answer using only the provided context and your own knowledge.";
      messages.push({
        role: "system",
        content: restriction,
      });
    }

    const zoteroDataDir = getDataDirPath();
    const zoteroStorageDir = zoteroDataDir ? `${zoteroDataDir}/storage` : "";

    // Build user message with context items
    const userContentParts: Record<string, unknown>[] = [];
    for (const item of contextItems) {
      if (item.type === "image" && item.data) {
        userContentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${item.mimeType || "image/jpeg"};base64,${item.data}`,
          },
        });
      } else {
        userContentParts.push({
          type: "text",
          text: buildItemContext(item, zoteroStorageDir),
        });
      }
    }
    userContentParts.push({ type: "text", text });
    messages.push({ role: "user", content: userContentParts });

    this.activeAbortController = new AbortController();

    try {
      this.addon.log(`Hermes API: sending prompt to ${url}`);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          ...this.getAuthHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "hermes-agent",
          messages,
          stream: true,
        }),
        signal: this.activeAbortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(`API error ${response.status}: ${errorText}`);
      }

      if (!response.body) {
        throw new Error("API response has no body");
      }

      // Stream SSE response using the standard ReadableStreamDefaultReader API.
      // The zotero-types lib types read() as requiring a view (Firefox 115 BYOB
      // typing quirk) — cast to any to use the standard no-arg form, which is
      // what the runtime actually supports for a default reader.
      const reader = response.body.getReader() as any;
      const decoder = new TextDecoder();
      let buffer = "";
      let stopEmitted = false;

      const emitStop = () => {
        if (!stopEmitted) {
          stopEmitted = true;
          this.emit({ type: "stop" });
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
          } else if (value) {
            buffer += decoder.decode(value, { stream: true });
          }

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;

            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") {
              emitStop();
              return;
            }

            try {
              const parsed = JSON.parse(data) as {
                choices?: {
                  delta?: { content?: string; reasoning?: string };
                  finish_reason?: string;
                }[];
                usage?: {
                  prompt_tokens?: number;
                  completion_tokens?: number;
                  total_tokens?: number;
                };
              };

              const delta = parsed.choices?.[0]?.delta;
              if (delta?.content) {
                this.emit({ type: "message", content: delta.content });
              }
              if (delta?.reasoning) {
                this.emit({ type: "reasoning", reasoning: delta.reasoning });
              }
              if (parsed.choices?.[0]?.finish_reason) {
                emitStop();
                return;
              }
              if (parsed.usage) {
                this.emit({
                  type: "usage",
                  usage: {
                    inputTokens: parsed.usage.prompt_tokens || 0,
                    outputTokens: parsed.usage.completion_tokens || 0,
                    totalTokens: parsed.usage.total_tokens || 0,
                  },
                });
              }
            } catch {
              // Ignore malformed SSE lines
            }
          }

          if (done) break;
        }
      } finally {
        reader.releaseLock();
        emitStop();
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        this.emit({ type: "stop" });
        return;
      }
      if (
        error instanceof Error &&
        (error.message.includes("fetch") ||
          error.message.includes("network") ||
          error.message.includes("ECONNREFUSED"))
      ) {
        this.scheduleReconnect();
      }
      throw error;
    } finally {
      this.activeAbortController = null;
    }
  }

  public onUpdate(callback: (update: ChatSessionUpdate) => void): () => void {
    this.messageCallbacks.push(callback);
    return () => {
      const idx = this.messageCallbacks.indexOf(callback);
      if (idx >= 0) this.messageCallbacks.splice(idx, 1);
    };
  }

  public onError(callback: (error: Error) => void): () => void {
    this.errorCallbacks.push(callback);
    return () => {
      const idx = this.errorCallbacks.indexOf(callback);
      if (idx >= 0) this.errorCallbacks.splice(idx, 1);
    };
  }

  public onAvailableCommands(
    callback: (commands: { description: string; name: string }[]) => void,
  ): () => void {
    this.commandsCallbacks.push(callback);
    if (this.lastAvailableCommands.length > 0) {
      try {
        callback(this.lastAvailableCommands);
      } catch {
        // ignore
      }
    }
    return () => {
      const idx = this.commandsCallbacks.indexOf(callback);
      if (idx >= 0) this.commandsCallbacks.splice(idx, 1);
    };
  }

  public onToolUpdate(
    callback: (
      toolCallId: string,
      title: string,
      status: string,
      payload?: string,
    ) => void,
  ): () => void {
    this.toolCallbacks.push(callback);
    return () => {
      const idx = this.toolCallbacks.indexOf(callback);
      if (idx >= 0) this.toolCallbacks.splice(idx, 1);
    };
  }

  // --- Private helpers ---

  private getApiUrl(): string {
    // Use PreferencesManager (single source of truth for prefs) instead of
    // reading raw Zotero.Prefs with the hardcoded prefix.
    return (
      this.addon.data.hermes?.preferences?.get<string>("apiUrl", "") || ""
    ).replace(/\/$/, "");
  }

  private getApiKey(): string {
    return this.addon.data.hermes?.preferences?.get<string>("apiKey", "") || "";
  }

  private getAuthHeaders(): Record<string, string> {
    const apiKey = this.getApiKey();
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }

  private emit(update: ChatSessionUpdate): void {
    for (const cb of this.messageCallbacks) {
      try {
        cb(update);
      } catch {
        // ignore
      }
    }
  }

  private async fetchAvailableCommands(): Promise<void> {
    const url = `${this.getApiUrl()}/v1/toolsets`;
    try {
      const response = await fetch(url, {
        headers: {
          ...this.getAuthHeaders(),
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) return;

      const data = (await response.json()) as {
        toolsets?: { tools?: { description?: string; name: string }[] }[];
      };

      const commands: { description: string; name: string }[] = [];
      for (const ts of data.toolsets || []) {
        for (const tool of ts.tools || []) {
          commands.push({
            name: tool.name,
            description: tool.description || "",
          });
        }
      }

      this.lastAvailableCommands = commands;
      for (const cb of this.commandsCallbacks) {
        try {
          cb(commands);
        } catch {
          // ignore
        }
      }
    } catch {
      // Silently ignore — endpoint may not exist
    }
  }

  private scheduleReconnect(): void {
    if (this.isReconnecting) return;
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      this.emit({
        type: "error",
        content: "API connection lost. Max reconnection attempts reached.",
      });
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts - 1),
      30000,
    );
    this.emit({
      type: "message",
      content: `Reconnecting to Hermes API (attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})...`,
    });

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect()
        .then(() => {
          this.reconnectAttempts = 0;
          this.isReconnecting = false;
        })
        .catch(() => {
          this.isReconnecting = false;
          this.scheduleReconnect();
        });
    }, delay) as unknown as number;
  }

  private cancelReconnect(): void {
    if (this.reconnectTimeout !== null) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
  }

  private logDebug(message: string, ...args: unknown[]): void {
    if (this.addon.data?.hermes?.debug) {
      this.addon.data.hermes.debug.debug(message, ...args);
    } else if (
      this.addon.data?.hermes?.preferences?.get("enableDebugMode", false)
    ) {
      this.addon.log(`[DEBUG] ${message}`, ...args);
    }
  }
}
