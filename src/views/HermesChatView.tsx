import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  ChatSessionUpdate,
  PromptContextItem,
} from "../modules/hermes/types";
import type Addon from "../addon";
import { useStreamBuffer } from "./useStreamBuffer";
import { generateMessageId } from "../utils/uuid";
import { stripAnsi } from "../utils/stripAnsi";
import { ChatHeader } from "./components/ChatHeader";
import { ContextBar } from "./components/ContextBar";
import { InputArea } from "./components/InputArea";
import { MessageList } from "./components/MessageList";
import { SidePanels, ConversationSummary } from "./components/SidePanels";
import { ChatMessage, ContextItem } from "./types";
import {
  parseSlashCommand,
  getSlashCommands,
} from "../modules/hermes/SlashCommands";
import type { SlashCommand } from "../modules/hermes/SlashCommands";

interface HermesChatViewProps {
  addon: Addon;
}

/**
 * Determine if a CSS color value represents a dark color.
 * Supports rgb()/rgba(), #rgb/#rrggbb/#rrggbbaa hex, and transparency.
 */
function isDarkColor(color: string): boolean {
  const rgbMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1], 10);
    const g = parseInt(rgbMatch[2], 10);
    const b = parseInt(rgbMatch[3], 10);
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    return brightness < 128;
  }
  // Hex colours (3, 6, or 8 digits) — computed styles often return hex.
  const hexMatch = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) {
      hex = hex
        .split("")
        .map((c) => c + c)
        .join("");
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    return brightness < 128;
  }
  if (color === "transparent" || color === "rgba(0, 0, 0, 0)") {
    return false;
  }
  return false;
}

export function HermesChatViewComponent({ addon }: HermesChatViewProps) {
  // No render log here — this component re-renders on every stream chunk;
  // logging on each render floods the console (min1: render log noise).
  // Lifecycle logs live in mountHermesChat / the stream subscription.

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextItems, setContextItems] = useState<ContextItem[]>([]);
  const [allowedTools, setAllowedTools] = useState<string[] | null>(null);
  const [isConversationListOpen, setIsConversationListOpen] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatches, setSearchMatches] = useState<number[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);

  // Session settings state
  const [isSessionSettingsOpen, setIsSessionSettingsOpen] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<{
    input: number;
    output: number;
    total: number;
  } | null>(null);

  // Onboarding state — initialised as true, corrected after settings is available
  const [showOnboarding, setShowOnboarding] = useState(true);

  // Slash command autocomplete state
  const [slashSuggestions, setSlashSuggestions] = useState<SlashCommand[]>([]);
  const [isSlashOpen, setIsSlashOpen] = useState(false);
  const [slashSelectionIndex, setSlashSelectionIndex] = useState(0);
  const slashDropdownRef = useRef<HTMLDivElement>(null);

  const lastSendTimeRef = useRef<number>(0);
  const RATE_LIMIT_MS = 2000;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sendBtnRef = useRef<HTMLButtonElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep a ref to latest state for native event callbacks
  const stateRef = useRef({
    input: "",
    messages,
    contextItems,
    allowedTools,
    isTyping,
    isConversationListOpen,
    isSearchOpen,
    searchQuery,
    searchMatches,
    currentMatchIndex,
    conversations,
    error,
  });
  useEffect(() => {
    stateRef.current = {
      input,
      messages,
      contextItems,
      allowedTools,
      isTyping,
      isConversationListOpen,
      isSearchOpen,
      searchQuery,
      searchMatches,
      currentMatchIndex,
      conversations,
      error,
    };
  }, [
    input,
    messages,
    contextItems,
    allowedTools,
    isTyping,
    isConversationListOpen,
    isSearchOpen,
    searchQuery,
    searchMatches,
    currentMatchIndex,
    conversations,
    error,
  ]);

  // Guard: Hermes modules not initialized yet
  const hermes = addon.data.hermes;
  if (!hermes) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          backgroundColor: "var(--hermes-bg, #fff)",
          color: "var(--hermes-text, #333)",
          fontFamily: "system-ui, -apple-system, sans-serif",
          fontSize: "14px",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "8px 12px",
            borderBottom: "1px solid var(--hermes-border, #e0e0e0)",
            backgroundColor: "var(--hermes-bg-secondary, #fafafa)",
            minHeight: "40px",
          }}
        >
          Hermes Agent
        </div>
        <div style={{ padding: "16px", opacity: 0.7 }}>
          Initializing Hermes modules...
        </div>
      </div>
    );
  }

  const settings = hermes.preferences;

  // Correct onboarding state now that settings is available
  useEffect(() => {
    setShowOnboarding(!settings.get("hasSeenOnboarding", false));
  }, [settings]);

  const {
    appendContent,
    appendReasoning,
    clearBuffer,
    flushNow,
    reasoningMessageIdRef,
    streamingMessageIdRef,
  } = useStreamBuffer(
    setMessages,
    settings.get("showReasoning", true),
    settings.get("enableTypingSound", false),
    settings.get("enableHapticFeedback", false),
  );

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  // Keep ChatManager in sync with the view state so slash commands
  // (/savechat) and the persistence layer see the current
  // conversation. setMessages schedules a debounced save (500ms), which
  // is exactly the intended write path during streaming (min1: the
  // old code never pushed view messages into ChatManager, so /savechat
  // saved an empty conversation).
  useEffect(() => {
    hermes.chat.setMessages(messages);
  }, [messages, hermes.chat]);

  // ─── Send Logic ───
  /**
   * Shared send pipeline used by both sendToHermes and resendFromIndex (M7).
   * - builds the prompt context from the current contextItems state
   * - appends the user message + an empty assistant message (truncating
   *   first when resending from an index)
   * - connects the client if needed, then streams via client.sendPrompt
   */
  const performSend = useCallback(
    async (text: string, truncateToIndex?: number, items?: ContextItem[]) => {
      const st = stateRef.current;
      const streamingMessageId = generateMessageId();
      streamingMessageIdRef.current = streamingMessageId;
      reasoningMessageIdRef.current = null;

      if (items && items.length > 0) {
        // Merge context (e.g. from the item context menu) into the bar,
        // deduping by id, and send from the merged set rather than the
        // possibly-stale state snapshot.
        const merged = [
          ...st.contextItems,
          ...items.filter((n) => !st.contextItems.some((p) => p.id === n.id)),
        ];
        setContextItems(merged);
        st.contextItems = merged;
      }

      const userMessage: ChatMessage = {
        id: generateMessageId(),
        content: text,
        role: "user",
        timestamp: Date.now(),
      };
      const assistantMessage: ChatMessage = {
        content: "",
        id: streamingMessageId,
        role: "assistant",
        timestamp: Date.now(),
      };

      if (truncateToIndex !== undefined) {
        const targetMsg = st.messages[truncateToIndex];
        const previousTail = st.messages.slice(truncateToIndex);
        const existingHistory = targetMsg?.branchHistory
          ? [...targetMsg.branchHistory]
          : [previousTail];

        const targetBranchIndex = targetMsg?.branchIndex ?? 0;
        if (targetBranchIndex < existingHistory.length) {
          existingHistory[targetBranchIndex] = previousTail;
        }

        const newBranchHistory = [
          ...existingHistory,
          [userMessage, assistantMessage],
        ];
        userMessage.branchHistory = newBranchHistory;
        userMessage.branchIndex = newBranchHistory.length - 1;

        setMessages([
          ...st.messages.slice(0, truncateToIndex),
          userMessage,
          assistantMessage,
        ]);
      } else {
        setMessages((prev) => [...prev, userMessage, assistantMessage]);
      }
      setInput("");
      setIsTyping(true);

      if (
        settings.get("enableHapticFeedback", false) &&
        typeof navigator !== "undefined" &&
        navigator.vibrate
      ) {
        navigator.vibrate(50);
      }

      // Safety timeout: clear typing indicator after 60s if no stop/session_info arrives
      typingTimeoutRef.current = setTimeout(() => {
        addon.log("[ChatView] Typing timeout reached, clearing indicator");
        setIsTyping(false);
        streamingMessageIdRef.current = null;
        reasoningMessageIdRef.current = null;
      }, 60000);

      const client = hermes.client;
      if (!client.getIsConnected()) {
        try {
          await client.connect();
        } catch (err) {
          setError(`Connection failed: ${(err as Error).message}`);
          setIsTyping(false);
          streamingMessageIdRef.current = null;
          if (typingTimeoutRef.current) {
            clearTimeout(typingTimeoutRef.current);
            typingTimeoutRef.current = null;
          }
          return;
        }
      }

      const promptContextItems: PromptContextItem[] = st.contextItems.map(
        (item) => ({
          id: item.id,
          type: item.type,
          text: item.text,
          data: item.data ? JSON.stringify(item.data.toJSON()) : undefined,
          extracted: item.extracted
            ? (item.extracted as unknown as Record<string, unknown>)
            : undefined,
        }),
      );

      try {
        await client.sendPrompt(text, promptContextItems, {
          allowedTools: st.allowedTools,
        });
      } catch (err) {
        setError(`Send failed: ${(err as Error).message}`);
        setIsTyping(false);
        streamingMessageIdRef.current = null;
        if (typingTimeoutRef.current) {
          clearTimeout(typingTimeoutRef.current);
          typingTimeoutRef.current = null;
        }
      }

      // M8: persist the tool restriction state into the current
      // conversation so it survives restarts and can be restored.
      const conv = hermes.conversations.getCurrentConversation();
      if (conv) {
        conv.allowedTools = st.allowedTools;
        hermes.conversations.saveConversation(conv);
      }
    },
    [hermes.client, addon, settings],
  );

  const sendToHermes = useCallback(
    async (text: string, items?: ContextItem[]) => {
      addon.log("[ChatView] sendToHermes called with text:", text.slice(0, 60));
      await performSend(text, undefined, items);
    },
    [performSend, addon],
  );

  const resendFromIndex = useCallback(
    async (index: number, newText: string) => {
      addon.log("[ChatView] resendFromIndex called at index:", index);
      await performSend(newText, index);
    },
    [performSend, addon],
  );

  const handleSwitchBranch = useCallback(
    (messageId: string, targetBranchIndex: number) => {
      const st = stateRef.current;
      const msgIndex = st.messages.findIndex((m) => m.id === messageId);
      if (msgIndex === -1) return;

      const msg = st.messages[msgIndex];
      if (!msg.branchHistory || !msg.branchHistory[targetBranchIndex]) return;

      // Save current active tail back into history
      const currentTail = st.messages.slice(msgIndex);
      const updatedHistory = [...msg.branchHistory];
      const currentIndex = msg.branchIndex ?? 0;
      updatedHistory[currentIndex] = currentTail;

      // Retrieve target branch tail
      const targetTail = updatedHistory[targetBranchIndex];
      if (!targetTail || targetTail.length === 0) return;

      const updatedUserMsg: ChatMessage = {
        ...targetTail[0],
        branchHistory: updatedHistory,
        branchIndex: targetBranchIndex,
      };

      setMessages([
        ...st.messages.slice(0, msgIndex),
        updatedUserMsg,
        ...targetTail.slice(1),
      ]);
    },
    [],
  );

  const handleAbortTerminal = useCallback(() => {
    addon.log("[ChatView] Abort requested on terminal execution");
    void hermes.client.cancel();
    setIsTyping(false);
    streamingMessageIdRef.current = null;
    reasoningMessageIdRef.current = null;
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
  }, [hermes.client, addon]);

  const sendMessage = useCallback(async () => {
    const st = stateRef.current;
    const text = st.input.trim();
    if (!text || st.isTyping) return;

    const now = Date.now();
    if (now - lastSendTimeRef.current < RATE_LIMIT_MS) {
      setError("Please wait a moment before sending another message.");
      return;
    }
    lastSendTimeRef.current = now;
    setError(null);

    // Check for slash commands
    const slashCmd = parseSlashCommand(text);
    if (slashCmd) {
      setInput("");

      if (slashCmd.command.name === "clear") {
        setMessages([]);
        setContextItems([]);
        setAllowedTools(null);
        hermes.chat.clearMessages();
        hermes.conversations.createConversation();
        return;
      }

      try {
        const result = await slashCmd.command.execute(addon, slashCmd.args);
        if (result && typeof result === "object" && "sendPrompt" in result) {
          if (result.systemMessage) {
            setMessages((prev) => [
              ...prev,
              {
                id: generateMessageId(),
                content: result.systemMessage!,
                role: "system",
                timestamp: Date.now(),
              },
            ]);
          }
          await sendToHermes(result.sendPrompt);
        } else if (typeof result === "string") {
          setMessages((prev) => [
            ...prev,
            {
              id: generateMessageId(),
              content: result,
              role: "system",
              timestamp: Date.now(),
            },
          ]);
        } else {
          await sendToHermes(text);
        }
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: generateMessageId(),
            content: `Error executing /${slashCmd.command.name}: ${(err as Error).message}`,
            role: "system",
            timestamp: Date.now(),
          },
        ]);
      }
      return;
    }

    await sendToHermes(text);
  }, [addon, hermes.chat, hermes.conversations, sendToHermes]);

  // ─── Native DOM event wiring ───
  // Zotero's sandboxed Firefox does not reliably fire React synthetic events
  // (onChange, onClick, onKeyDown). All user interaction goes through native
  // addEventListener via refs.

  // 1. Textarea input → sync to state + slash command detection
  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    const handler = (e: Event) => {
      const value = (e.target as HTMLTextAreaElement).value;
      setInput(value);

      // Slash command autocomplete
      if (value.startsWith("/") && !value.includes(" ")) {
        const query = value.slice(1).toLowerCase();
        const commands = getSlashCommands();
        const filtered = commands.filter((cmd) =>
          cmd.name.toLowerCase().includes(query),
        );
        setSlashSuggestions(filtered);
        setIsSlashOpen(filtered.length > 0);
        setSlashSelectionIndex(0);
      } else {
        setIsSlashOpen(false);
        setSlashSuggestions([]);
      }
    };
    textarea.addEventListener("input", handler);
    return () => textarea.removeEventListener("input", handler);
  }, []);

  // 2. Sync React state → textarea.value (for clearing on send)
  useEffect(() => {
    const textarea = inputRef.current;
    if (textarea && textarea.value !== input) {
      textarea.value = input;
    }
  }, [input]);

  // 3. Send button click → native
  // The send button doubles as a stop button (AGENTS.md: Stop Button Wiring).
  // Reads stateRef.current.isTyping (not React state) to decide: typing →
  // client.cancel() to abort the in-flight stream; idle → sendMessage().
  useEffect(() => {
    const btn = sendBtnRef.current;
    if (!btn) return;
    const handler = () => {
      const st = stateRef.current;
      if (st.isTyping) {
        addon.log("[ChatView] Stop requested — cancelling in-flight stream");
        void hermes.client.cancel();
        // Clear the typing state immediately — the ACP cancel is
        // asynchronous and no terminal event is guaranteed to follow.
        setIsTyping(false);
        streamingMessageIdRef.current = null;
        reasoningMessageIdRef.current = null;
        if (typingTimeoutRef.current) {
          clearTimeout(typingTimeoutRef.current);
          typingTimeoutRef.current = null;
        }
        return;
      }
      void sendMessage();
    };
    btn.addEventListener("click", handler);
    return () => btn.removeEventListener("click", handler);
  }, [sendMessage, hermes.client, addon]);

  // 4. Textarea Enter key → native + slash command navigation
  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        if (isSlashOpen && slashSuggestions.length > 0) {
          e.preventDefault();
          const selected = slashSuggestions[slashSelectionIndex];
          if (selected) {
            setInput(`/${selected.name} `);
            setIsSlashOpen(false);
          }
          return;
        }
        e.preventDefault();
        void sendMessage();
      } else if (e.key === "ArrowDown" && isSlashOpen) {
        e.preventDefault();
        setSlashSelectionIndex((prev) =>
          Math.min(prev + 1, slashSuggestions.length - 1),
        );
      } else if (e.key === "ArrowUp" && isSlashOpen) {
        e.preventDefault();
        setSlashSelectionIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Escape" && isSlashOpen) {
        setIsSlashOpen(false);
      }
    };
    textarea.addEventListener("keydown", handler);
    return () => textarea.removeEventListener("keydown", handler);
  }, [sendMessage, isSlashOpen, slashSuggestions, slashSelectionIndex]);

  // 5. Stream subscription — consume agent responses, reasoning, tools, etc.
  // NOTE: This effect intentionally has minimal deps. The callbacks use refs for
  // mutable state (streamingMessageIdRef, reasoningMessageIdRef) and the
  // client is accessed via hermes.client which is stable after init.
  useEffect(() => {
    const client = hermes.client;
    addon.log("[ChatView] Subscribing to client updates");

    const handleUpdate = (update: ChatSessionUpdate) => {
      // Reset typing timeout on any activity, then restart it for non-terminal events
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
      const isTerminal =
        update.type === "stop" ||
        update.type === "usage" ||
        update.type === "session_info" ||
        update.type === "error";
      if (!isTerminal) {
        typingTimeoutRef.current = setTimeout(() => {
          addon.log(
            "[ChatView] Typing timeout reached (no terminal event), clearing indicator",
          );
          setIsTyping(false);
          streamingMessageIdRef.current = null;
          reasoningMessageIdRef.current = null;
        }, 60000);
      }

      if (update.type === "message" && update.content) {
        // NOTE: do NOT setIsTyping(true) here — performSend already arms the
        // indicator before the stream starts, and hermes sends the final
        // agent_message_chunk AFTER usage/session_info (verified on the wire
        // 2026-09-10). Re-arming on the last chunk would leave the indicator
        // stuck when no terminal event follows it.
        appendContent(update.content);
      } else if (update.type === "stop") {
        flushNow();
        setIsTyping(false);
        streamingMessageIdRef.current = null;
        reasoningMessageIdRef.current = null;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.role === "tool" && m.isRunning) {
              return {
                ...m,
                isRunning: false,
                toolStatus: "complete" as const,
              };
            }
            return m;
          }),
        );
      } else if (update.type === "reasoning" && update.reasoning) {
        if (settings.get("showReasoning", true)) {
          appendReasoning(update.reasoning);
        }
      } else if (
        update.type === "tool_start" ||
        update.type === "tool_progress" ||
        update.type === "tool_complete"
      ) {
        flushNow();
        // M4: respect the showToolUse pref — tool messages are purely
        // informational and can be hidden entirely.
        if (!settings.get("showToolUse", true)) {
          return;
        }
        if (update.toolCall) {
          const isRunning =
            update.type !== "tool_complete" &&
            update.toolCall.status === "running";
          const callId = update.toolCall.callId;
          const status =
            update.toolCall.status === "error"
              ? "error"
              : isRunning
                ? "running"
                : "complete";
          setMessages((prev) => {
            const toolIndex = prev.findIndex(
              (m) => m.role === "tool" && m.toolCallId === callId,
            );
            let toolName = update.toolCall!.name;
            if (
              toolIndex >= 0 &&
              (toolName === "other" || toolName === "unknown-tool")
            ) {
              toolName = prev[toolIndex]?.toolName || toolName;
            }
            const resultContent = update.toolCall!.result
              ? `**Result:**\n\`\`\`text\n${update.toolCall!.result}\n\`\`\``
              : "";
            if (toolIndex >= 0) {
              const updated = [...prev];
              updated[toolIndex] = {
                ...updated[toolIndex]!,
                content: resultContent,
                isRunning,
                toolName,
                toolStatus: status,
              };
              return updated;
            }
            const newToolMsg: ChatMessage = {
              content: resultContent,
              id: generateMessageId(),
              isRunning,
              isCollapsed: true,
              role: "tool",
              timestamp: Date.now(),
              toolCallId: callId,
              toolName,
              toolStatus: status,
            };
            const assistantIndex = prev.findIndex(
              (m) => m.id === streamingMessageIdRef.current,
            );
            if (assistantIndex >= 0) {
              const updated = [...prev];
              updated.splice(assistantIndex, 0, newToolMsg);
              return updated;
            }
            return [...prev, newToolMsg];
          });
        }
      } else if (update.type === "terminal_output" && update.terminal) {
        flushNow();
        setMessages((prev) => {
          const index = prev.findIndex(
            (m) =>
              m.role === "terminal" && m.terminalId === update.terminal!.id,
          );
          if (index >= 0) {
            const updated = [...prev];
            updated[index] = {
              ...updated[index]!,
              content: updated[index]!.content + update.terminal!.output,
              isExited:
                (updated[index]!.isExited ?? false) ||
                (update.terminal!.isExited ?? false),
            };
            return updated;
          }
          return [
            {
              content: update.terminal!.output,
              id: generateMessageId(),
              isExited: update.terminal!.isExited ?? false,
              role: "terminal",
              terminalId: update.terminal!.id,
              timestamp: Date.now(),
            },
            ...prev,
          ];
        });
      } else if (update.type === "usage" && update.usage) {
        flushNow();
        // C4: single display — the token dashboard (gated on the
        // showTokenCount pref). Previously this ALSO appended a system
        // message, showing the same numbers twice.
        if (settings.get("showTokenCount", false)) {
          setTokenUsage({
            input: update.usage.inputTokens,
            output: update.usage.outputTokens,
            total: update.usage.totalTokens,
          });
        }
        // usage_update often signals the end of a turn when no stop is sent
        setIsTyping(false);
      } else if (update.type === "session_info") {
        // session_info_update is NOT a reliable end-of-turn signal — hermes
        // sends it BEFORE the final agent_message_chunk (verified on the wire
        // 2026-09-10). Nulling the refs here would make the flush drop the
        // final answer silently. Only stop/error end the turn; performSend
        // resets both refs on the next send.
        flushNow();
        setIsTyping(false);
      } else if (update.type === "error") {
        flushNow();
        const cleaned = stripAnsi(update.content || "").trim();
        if (!cleaned) return;
        setError(cleaned);
        setIsTyping(false);
        streamingMessageIdRef.current = null;
        reasoningMessageIdRef.current = null;
      }
    };

    const handleError = (err: Error) => {
      addon.log("[ChatView] handleError fired:", err.message);
      const cleaned = stripAnsi(err.message).trim();
      if (!cleaned) return;
      setError(cleaned);
      setIsTyping(false);
    };

    const unsubUpdate = client.onUpdate(handleUpdate);
    const unsubError = client.onError(handleError);
    addon.log("[ChatView] Subscribed successfully");

    return () => {
      addon.log("[ChatView] Unsubscribing from client updates");
      unsubUpdate();
      unsubError();
    };
  }, [hermes.client]);

  // 6. Click handler on messages list to intercept add-context: links
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handler = async (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const link = target.closest("a");
      if (!link) return;

      const href = link.getAttribute("href");
      if (!href) return;

      // Defense-in-depth: unconditionally block navigation on any unrecognized scheme
      // to prevent chrome privilege escalation via javascript:, chrome:, file:, etc.
      if (
        !href.startsWith("http://") &&
        !href.startsWith("https://") &&
        !href.startsWith("add-context:") &&
        !href.startsWith("apply-tag:") &&
        !href.startsWith("action:")
      ) {
        e.preventDefault();
        return;
      }

      // http(s) links: open in the system browser via Zotero.launchURL.
      // The sandbox blocks default navigation (target=_blank does nothing),
      // so we must intercept and hand the URL to Zotero.
      if (href.startsWith("http://") || href.startsWith("https://")) {
        e.preventDefault();
        Zotero.launchURL(href);
        return;
      }
      if (href.startsWith("add-context:")) {
        e.preventDefault();
        const itemIdStr = href.substring("add-context:".length);
        const itemId = parseInt(itemIdStr, 10);
        if (isNaN(itemId)) return;

        try {
          const item = await Zotero.Items.getAsync(itemId);
          if (item) {
            if (item.itemType === "note") {
              const noteText = item.getNote() || "";
              const title = (item as any).getNoteTitle?.() || "Untitled Note";
              setContextItems((prev) => {
                if (prev.some((p) => p.id === `note-${itemId}`)) return prev;
                return [
                  ...prev,
                  {
                    id: `note-${itemId}`,
                    type: "note" as const,
                    text: title,
                    data: item,
                    extracted: {
                      id: item.id,
                      key: item.key,
                      title: title,
                      itemType: "note",
                      creators: [],
                      date: "",
                      abstract: noteText,
                      tags: item.getTags().map((t: any) => t.tag),
                    },
                  },
                ];
              });
            } else {
              // C1: also record in ItemManager.attachedItems so slash
              // commands can resolve items added via add-context: links.
              const extracted = await hermes.items.attachItem(item);
              setContextItems((prev) => {
                if (prev.some((p) => p.id === `item-${itemId}`)) return prev;
                return [
                  ...prev,
                  {
                    id: `item-${itemId}`,
                    type: "item" as const,
                    text: item.getDisplayTitle(),
                    data: item,
                    extracted,
                  },
                ];
              });
            }
          }
        } catch (err) {
          setError(`Failed to add item to context: ${(err as Error).message}`);
        }
      } else if (href && href.startsWith("apply-tag:")) {
        e.preventDefault();
        // M4: respect the enableTags pref
        if (!settings.get("enableTags", true)) {
          setError(
            "Tag management is disabled. Enable it in Zotero → Settings → Hermes.",
          );
          return;
        }
        const tag = href.substring("apply-tag:".length);
        const attachedItems = hermes.items.getAttachedItems();
        if (attachedItems.length === 0) {
          setError("No item attached to apply tag to.");
          return;
        }
        const parentItem = attachedItems[0];
        try {
          await hermes.tags.addTags(parentItem.id, [tag]);
          setMessages((prev) => [
            ...prev,
            {
              id: generateMessageId(),
              content: `Applied tag **${tag}** to item **${parentItem.title}**!`,
              role: "system",
              timestamp: Date.now(),
            },
          ]);
        } catch (err) {
          setError(`Failed to apply tag: ${(err as Error).message}`);
        }
      } else if (href && href.startsWith("action:")) {
        e.preventDefault();
        const actionPayload = href.substring("action:".length);
        const attachedItems = hermes.items.getAttachedItems();
        if (actionPayload === "save-note") {
          const conv = hermes.conversations.getCurrentConversation();
          if (conv) {
            hermes.exports
              .exportToZoteroNote(conv, hermes.items.getAttachedItems())
              .then((res) => {
                setMessages((prev) => [
                  ...prev,
                  {
                    id: generateMessageId(),
                    content: res.message,
                    role: "system",
                    timestamp: Date.now(),
                  },
                ]);
              })
              .catch((err) => {
                setError(`Failed to save note: ${(err as Error).message}`);
              });
          }
        } else if (actionPayload.startsWith("metadata?")) {
          const parentItem = attachedItems[0];
          if (!parentItem) {
            setError("No item attached to update metadata for.");
            return;
          }
          const queryString = actionPayload.substring("metadata?".length);
          const params = new URLSearchParams(queryString);
          const updates: Record<string, string> = {};
          params.forEach((val, key) => {
            updates[key] = val;
          });
          try {
            await hermes.items.updateItemMetadata(parentItem.id, updates);
            setMessages((prev) => [
              ...prev,
              {
                id: generateMessageId(),
                content: `Successfully updated metadata for **${parentItem.title}**!`,
                role: "system",
                timestamp: Date.now(),
              },
            ]);
          } catch (err) {
            setError(
              `Metadata update cancelled or failed: ${(err as Error).message}`,
            );
          }
        }
      }
    };

    container.addEventListener("click", handler);
    return () => container.removeEventListener("click", handler);
  }, [hermes.notes, hermes.tags]);

  // Subscribe to external prompts dispatched from Reader / Context Menu
  useEffect(() => {
    addon.log("[ChatView] subscribing to external prompts");
    const unsub = hermes.chat.onExternalPrompt((promptText, contextItems) => {
      void sendToHermes(promptText, contextItems);
    });
    return unsub;
  }, [hermes.chat, sendToHermes, addon]);

  useEffect(() => {
    const win = Zotero.getMainWindow();
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setIsSearchOpen(true);
        win.setTimeout(() => {
          searchInputRef.current?.focus();
        }, 50);
      }
    };
    win.addEventListener("keydown", handleKeyDown);
    return () => win.removeEventListener("keydown", handleKeyDown);
  }, []);

  const attachSelectedItems = useCallback(() => {
    // Check if there is an active selection in the PDF reader
    const readerSel = hermes.items.getActiveReaderSelection?.();
    if (readerSel) {
      const selId = `sel-${Date.now()}`;
      const displayText = readerSel.page
        ? `[Page ${readerSel.page}]: "${readerSel.text}"`
        : `"${readerSel.text}"`;
      setContextItems((prev) => [
        ...prev,
        {
          id: selId,
          type: "selection" as const,
          text: displayText,
        },
      ]);
    }

    const items = hermes.items.getSelectedItems();
    if (items.length === 0 && !readerSel) {
      setError("No items or text selected in Zotero library or reader.");
      return;
    }
    void (async () => {
      const extractedItems = await Promise.all(
        items.map(async (item) => {
          // C1: populate ItemManager.attachedItems so slash commands
          // (/annotations, /cite, /tag, /savechat) can resolve the item.
          const extracted = await hermes.items.attachItem(item);
          return {
            id: `item-${item.id}`,
            type: "item" as const,
            text: item.getDisplayTitle(),
            data: item,
            extracted,
          };
        }),
      );
      setContextItems((prev) => {
        const newItems = extractedItems.filter(
          (item) => !prev.some((p) => p.id === item.id),
        );
        return [...prev, ...newItems];
      });
    })();
  }, [hermes.items]);

  const clearContext = useCallback(() => {
    setContextItems([]);
    hermes.items.clearAttachedItems();
  }, [hermes.items]);

  const loadConversationList = useCallback(() => {
    const allConvs = hermes.conversations.loadAllConversations();
    setConversations(
      allConvs.map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
      })),
    );
  }, [hermes.conversations]);

  const abortActiveStream = useCallback(() => {
    if (stateRef.current.isTyping) {
      hermes.client.cancel().catch(() => {});
      setIsTyping(false);
    }
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    streamingMessageIdRef.current = null;
    reasoningMessageIdRef.current = null;
    clearBuffer();
  }, [hermes.client, clearBuffer]);

  const handleLoadConversation = useCallback(
    (id: string) => {
      abortActiveStream();
      const conv = hermes.conversations.loadConversation(id);
      if (conv) {
        setMessages(conv.messages || []);
        setContextItems([]);
        setError(null);
        // M8: restore the conversation's tool restriction state (null =
        // unrestricted, array = restricted list, [] = block all).
        setAllowedTools(conv.allowedTools ?? null);
        hermes.chat.loadFromConversation(conv);
        setIsConversationListOpen(false);
      }
    },
    [hermes.conversations, hermes.chat, abortActiveStream],
  );

  const handleDeleteConversation = useCallback(
    (id: string) => {
      // M2: deleting a history item must not wipe the active chat view.
      // Only reset the view when the deleted conversation IS the current
      // one (ConversationManager already nulls currentConversation then).
      const wasCurrent =
        hermes.conversations.getCurrentConversation()?.id === id;
      if (wasCurrent) {
        abortActiveStream();
      }
      hermes.conversations.deleteConversation(id);
      loadConversationList();
      if (wasCurrent) {
        setMessages([]);
        setContextItems([]);
        hermes.conversations.createConversation();
      }
    },
    [hermes.conversations, loadConversationList, abortActiveStream],
  );

  const handleExportCurrentChat = useCallback(async () => {
    const conv = hermes.conversations.getCurrentConversation();
    if (!conv || !conv.messages || conv.messages.length === 0) {
      setError("No conversation messages to export.");
      return;
    }
    const attached = hermes.items.getAttachedItems();
    const vaultPath = settings.get<string>("obsidianVaultPath", "");
    if (vaultPath && vaultPath.trim()) {
      const res = await hermes.exports.exportToObsidianVault(conv, attached);
      if (res.success) {
        setMessages((prev) => [
          ...prev,
          {
            id: generateMessageId(),
            content: `${res.message} (Obsidian Vault)`,
            role: "system",
            timestamp: Date.now(),
          },
        ]);
        return;
      }
    }
    const res = await hermes.exports.exportWithFilePicker(conv, attached);
    if (res.success) {
      setMessages((prev) => [
        ...prev,
        {
          id: generateMessageId(),
          content: `${res.message}`,
          role: "system",
          timestamp: Date.now(),
        },
      ]);
    } else if (res.message && res.message !== "Export cancelled by user.") {
      setError(res.message);
    }
  }, [hermes.conversations, hermes.items, hermes.exports, settings]);

  const handleExportCanvas = useCallback(async () => {
    const conv = hermes.conversations.getCurrentConversation();
    if (!conv) {
      setError("No active conversation to export as Canvas.");
      return;
    }
    const attached = hermes.items.getAttachedItems();
    const res = await hermes.exports.exportCanvasToObsidian(conv, attached);
    if (res.success) {
      setMessages((prev) => [
        ...prev,
        {
          id: generateMessageId(),
          content: `${res.message}`,
          role: "system",
          timestamp: Date.now(),
        },
      ]);
    } else if (res.message && res.message !== "Canvas export cancelled.") {
      setError(res.message);
    }
  }, [hermes.conversations, hermes.items, hermes.exports]);

  const handleExportConversation = useCallback(
    async (id: string) => {
      const allConvs = hermes.conversations.loadAllConversations();
      const targetConv = allConvs.find((c) => c.id === id);
      if (
        !targetConv ||
        !targetConv.messages ||
        targetConv.messages.length === 0
      ) {
        setError("Conversation has no messages to export.");
        return;
      }
      const vaultPath = settings.get<string>("obsidianVaultPath", "");
      if (vaultPath && vaultPath.trim()) {
        const res = await hermes.exports.exportToObsidianVault(targetConv, []);
        if (res.success) {
          setMessages((prev) => [
            ...prev,
            {
              id: generateMessageId(),
              content: `${res.message} (Obsidian Vault)`,
              role: "system",
              timestamp: Date.now(),
            },
          ]);
          return;
        }
      }
      const res = await hermes.exports.exportWithFilePicker(targetConv, []);
      if (res.success) {
        setMessages((prev) => [
          ...prev,
          {
            id: generateMessageId(),
            content: `${res.message}`,
            role: "system",
            timestamp: Date.now(),
          },
        ]);
      } else if (res.message && res.message !== "Export cancelled by user.") {
        setError(res.message);
      }
    },
    [hermes.conversations, hermes.exports, settings],
  );

  const performSearch = useCallback(
    (query: string): void => {
      if (!query.trim()) {
        setSearchMatches([]);
        setCurrentMatchIndex(0);
        return;
      }
      const lower = query.toLowerCase();
      const indices: number[] = [];
      messages.forEach((msg, idx) => {
        if (msg.content.toLowerCase().includes(lower)) {
          indices.push(idx);
        }
      });
      setSearchMatches(indices);
      setCurrentMatchIndex(indices.length > 0 ? 0 : 0);
    },
    [messages],
  );

  const jumpToMatch = useCallback(
    (direction: "next" | "prev"): void => {
      if (searchMatches.length === 0) return;
      const newIndex =
        direction === "next"
          ? (currentMatchIndex + 1) % searchMatches.length
          : (currentMatchIndex - 1 + searchMatches.length) %
            searchMatches.length;
      setCurrentMatchIndex(newIndex);
      const msgIndex = searchMatches[newIndex];
      if (msgIndex !== undefined) {
        const msgId = messages[msgIndex]?.id;
        const el = msgId ? messageRefs.current.get(msgId) : undefined;
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("hermes-search-highlight");
          const win = Zotero.getMainWindow();
          win.setTimeout(() => {
            el.classList.remove("hermes-search-highlight");
          }, 2000);
        }
      }
    },
    [searchMatches, currentMatchIndex, messages],
  );

  const newChat = useCallback(() => {
    abortActiveStream();
    setMessages([]);
    setContextItems([]);
    setError(null);
    setAllowedTools(null);
    hermes.chat.clearMessages();
    hermes.conversations.createConversation();
  }, [hermes.chat, hermes.conversations, abortActiveStream]);

  return (
    <div
      className="hermes-chat-view"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        backgroundColor: "var(--hermes-bg, #fff)",
        color: "var(--hermes-text, #333)",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: "14px",
      }}
    >
      <ChatHeader
        addon={addon}
        onSearchToggle={() => {
          setIsSearchOpen((prev) => !prev);
          if (!isSearchOpen)
            setTimeout(() => searchInputRef.current?.focus(), 0);
        }}
        onConversationListToggle={() => {
          loadConversationList();
          setIsConversationListOpen((prev) => !prev);
        }}
        onAttachItems={attachSelectedItems}
        onNewChat={newChat}
        onSettingsToggle={() => setIsSessionSettingsOpen((prev) => !prev)}
        onExport={handleExportCurrentChat}
        onExportCanvas={handleExportCanvas}
      />

      <SidePanels
        isConversationListOpen={isConversationListOpen}
        isSearchOpen={isSearchOpen}
        isSessionSettingsOpen={isSessionSettingsOpen}
        showOnboarding={showOnboarding && messages.length === 0}
        conversations={conversations}
        searchQuery={searchQuery}
        searchMatches={searchMatches}
        currentMatchIndex={currentMatchIndex}
        allowedTools={allowedTools}
        searchInputRef={searchInputRef}
        onLoadConversation={handleLoadConversation}
        onDeleteConversation={handleDeleteConversation}
        onExportConversation={handleExportConversation}
        onCloseConversationList={() => setIsConversationListOpen(false)}
        onSearchChange={(query) => {
          setSearchQuery(query);
          performSearch(query);
        }}
        onSearchKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            jumpToMatch("next");
          } else if (e.key === "Escape") {
            setIsSearchOpen(false);
            setSearchQuery("");
            setSearchMatches([]);
          }
        }}
        onSearchPrev={() => jumpToMatch("prev")}
        onSearchNext={() => jumpToMatch("next")}
        onCloseSearch={() => {
          setIsSearchOpen(false);
          setSearchQuery("");
          setSearchMatches([]);
        }}
        onAllowAllTools={() => setAllowedTools(null)}
        onBlockAllTools={() => setAllowedTools([])}
        onToggleTool={(tool, checked) => {
          const current = allowedTools ?? [
            "read_file",
            "write_file",
            "terminal",
          ];
          if (checked) {
            setAllowedTools([...current, tool]);
          } else {
            setAllowedTools(current.filter((t) => t !== tool));
          }
        }}
        onCloseSessionSettings={() => setIsSessionSettingsOpen(false)}
        onDismissOnboarding={() => {
          setShowOnboarding(false);
          settings.set("hasSeenOnboarding", true);
        }}
      />

      <MessageList
        messages={messages}
        addon={addon}
        isTyping={isTyping}
        agentName={settings.get("chatAgentName", "Hermes") || "Hermes"}
        error={error}
        messagesContainerRef={messagesContainerRef}
        messagesEndRef={messagesEndRef}
        messageRefs={messageRefs}
        onEditMessage={resendFromIndex}
        onSwitchBranch={handleSwitchBranch}
        onAbortTerminal={handleAbortTerminal}
        onDismissError={() => setError(null)}
      />

      <ContextBar
        items={contextItems}
        onRemoveItem={(id) => {
          setContextItems((prev) => {
            const removed = prev.find((c) => c.id === id);
            if (removed?.extracted?.id) {
              hermes.items.removeAttachedItem(removed.extracted.id as number);
            } else if (removed?.data?.id) {
              hermes.items.removeAttachedItem(removed.data.id);
            }
            return prev.filter((c) => c.id !== id);
          });
        }}
        onClear={clearContext}
      />

      {/* Token Dashboard */}
      {tokenUsage && (
        <div
          className="hermes-token-dashboard"
          style={{
            fontSize: "0.75em",
            color: "var(--hermes-text-muted, #666)",
            padding: "6px 12px",
            borderTop: "1px solid var(--hermes-border, #e0e0e0)",
            backgroundColor: "var(--hermes-bg-secondary, #fafafa)",
            textAlign: "right",
          }}
        >
          Tokens: <strong>{tokenUsage.input}</strong> in,{" "}
          <strong>{tokenUsage.output}</strong> out (Total: {tokenUsage.total})
        </div>
      )}

      <InputArea
        inputRef={inputRef}
        sendBtnRef={sendBtnRef}
        isTyping={isTyping}
        input={input}
        isSlashOpen={isSlashOpen}
        slashSuggestions={slashSuggestions}
        slashSelectionIndex={slashSelectionIndex}
        slashDropdownRef={slashDropdownRef}
        onSelectSuggestion={(cmd) => {
          setInput(`/${cmd.name} `);
          setIsSlashOpen(false);
        }}
      />
    </div>
  );
}

/**
 * Mount the Hermes Chat React app into a DOM container.
 * Call this from the Zotero sidebar onReady callback.
 */
export function mountHermesChat(
  container: HTMLElement,
  addonInstance: Addon,
): () => void {
  // Ensure browser globals are available for React in Zotero sandbox
  const win = container.ownerDocument?.defaultView;
  if (win) {
    if (typeof (globalThis as any).window === "undefined") {
      (globalThis as any).window = win;
    }
    if (typeof (globalThis as any).document === "undefined") {
      (globalThis as any).document = win.document;
    }
    if (typeof (globalThis as any).navigator === "undefined") {
      (globalThis as any).navigator = win.navigator;
    }
  }

  // Detect dark mode from OS + Zotero
  let isDark = false;
  const doc = container.ownerDocument;
  try {
    // Method 1: OS dark mode via matchMedia
    const mq = win?.matchMedia?.("(prefers-color-scheme: dark)");
    if (mq && mq.matches) {
      isDark = true;
      addonInstance.log("Hermes theme: detected dark via matchMedia");
    }

    // Method 2: Check Zotero main window background color
    if (!isDark) {
      const mainWindow = doc?.getElementById("main-window");
      if (mainWindow && win) {
        const style = win.getComputedStyle(mainWindow);
        const bg = style?.backgroundColor || "";
        if (isDarkColor(bg)) {
          isDark = true;
          addonInstance.log("Hermes theme: detected dark via main-window bg");
        }
      }
    }

    // Method 3: Check document element classes/attributes
    if (!isDark && doc?.documentElement) {
      const htmlClass = doc.documentElement.className || "";
      const htmlAttr = doc.documentElement.getAttribute("data-theme") || "";
      if (
        htmlClass.includes("dark") ||
        htmlClass.includes("theme-dark") ||
        htmlAttr.includes("dark")
      ) {
        isDark = true;
        addonInstance.log(
          "Hermes theme: detected dark via document class/attr",
        );
      }
    }
  } catch (e) {
    addonInstance.log(`Hermes theme detection error: ${(e as Error).message}`);
  }

  addonInstance.log(`Hermes theme: isDark=${isDark}`);

  // Apply theme directly to container element — most reliable in XUL sandbox.
  const theme = {
    bg: isDark ? "#111413" : "#f1f2ef",
    text: isDark ? "#ecefea" : "#191c1a",
    textMuted: isDark ? "#8c938c" : "#5e655e",
    border: isDark ? "#2b322e" : "#dee1db",
    bgSecondary: isDark ? "#202623" : "#f7f8f5",
    bgTertiary: isDark ? "#262d2a" : "#ecedea",
    inputBg: isDark ? "#191d1b" : "#ffffff",
    accent: isDark ? "#45be97" : "#0b6b54",
    accentText: isDark ? "#06231a" : "#ffffff",
    highlight: isDark ? "#e0b054" : "#9a6608",
    danger: isDark ? "#f2b8b5" : "#b3261e",
    success: isDark ? "#3fbf83" : "#1c6b44",
  };

  container.style.setProperty("--hermes-bg", theme.bg);
  container.style.setProperty("--hermes-text", theme.text);
  container.style.setProperty("--hermes-text-muted", theme.textMuted);
  container.style.setProperty("--hermes-border", theme.border);
  container.style.setProperty("--hermes-bg-secondary", theme.bgSecondary);
  container.style.setProperty("--hermes-bg-tertiary", theme.bgTertiary);
  container.style.setProperty("--hermes-input-bg", theme.inputBg);
  container.style.setProperty("--hermes-accent", theme.accent);
  container.style.setProperty("--hermes-accent-text", theme.accentText);
  container.style.setProperty("--hermes-highlight", theme.highlight);
  container.style.setProperty("--hermes-danger", theme.danger);
  container.style.setProperty("--hermes-success", theme.success);

  // Explicitly set container background/color so something shows even if
  // CSS variable inheritance fails inside the React tree.
  container.style.backgroundColor = theme.bg;
  container.style.color = theme.text;
  container.style.colorScheme = isDark ? "dark" : "light";

  // Inject CSS via CSSOM insertRule — the only reliable method in XUL documents
  // where textContent/innerHTML on <style> elements don't persist.
  if (doc) {
    const existing = doc.getElementById("hermes-theme-style");
    if (existing) existing.remove();
    const styleEl = doc.createElement("style");
    styleEl.setAttribute("id", "hermes-theme-style");
    styleEl.setAttribute("type", "text/css");
    const parent = doc.documentElement || doc.head || doc.body;
    if (parent) {
      parent.appendChild(styleEl);
      const sheet = (styleEl as any).sheet;
      if (sheet && sheet.insertRule) {
        const rule = `
          #hermes-react-root {
            --hermes-bg: ${theme.bg};
            --hermes-text: ${theme.text};
            --hermes-text-muted: ${theme.textMuted};
            --hermes-border: ${theme.border};
            --hermes-bg-secondary: ${theme.bgSecondary};
            --hermes-bg-tertiary: ${theme.bgTertiary};
            --hermes-input-bg: ${theme.inputBg};
            --hermes-accent: ${theme.accent};
            --hermes-accent-text: ${theme.accentText};
            --hermes-highlight: ${theme.highlight};
            --hermes-danger: ${theme.danger};
            --hermes-success: ${theme.success};
            background-color: ${theme.bg} !important;
            color: ${theme.text} !important;
            color-scheme: ${isDark ? "dark" : "light"};
          }
        `;
        sheet.insertRule(rule, 0);
      }
    }
  }

  // Load external CSS file (hermes-chat.css) via chrome URL and inject
  try {
    const cssUrl = `chrome://hermes/content/hermes-chat.css`;
    const xhr = new XMLHttpRequest();
    xhr.open("GET", cssUrl, true);
    xhr.onreadystatechange = () => {
      if (xhr.readyState === 4 && xhr.status === 200) {
        const cssText = xhr.responseText;
        if (doc && cssText) {
          const existingCss = doc.getElementById("hermes-chat-css");
          if (existingCss) existingCss.remove();
          const cssStyleEl = doc.createElement("style");
          cssStyleEl.setAttribute("id", "hermes-chat-css");
          cssStyleEl.setAttribute("type", "text/css");
          const cssParent = doc.documentElement || doc.head || doc.body;
          if (cssParent) {
            cssParent.appendChild(cssStyleEl);
            cssStyleEl.textContent = cssText;
          }
        }
      }
    };
    xhr.send();
  } catch (e) {
    addonInstance.log(`Hermes theme: CSS load error: ${(e as Error).message}`);
  }

  // Listen for OS theme changes and update dynamically
  // M6: keep a reference so the listener can be removed on unmount.
  let mq: MediaQueryList | null = null;
  let onThemeChange: ((e: MediaQueryListEvent) => void) | null = null;
  try {
    mq = win?.matchMedia?.(
      "(prefers-color-scheme: dark)",
    ) as MediaQueryList | null;
    if (mq) {
      onThemeChange = (e: MediaQueryListEvent) => {
        const newIsDark = e.matches;
        const newTheme = {
          bg: newIsDark ? "#111413" : "#f1f2ef",
          text: newIsDark ? "#ecefea" : "#191c1a",
          textMuted: newIsDark ? "#8c938c" : "#5e655e",
          border: newIsDark ? "#2b322e" : "#dee1db",
          bgSecondary: newIsDark ? "#202623" : "#f7f8f5",
          bgTertiary: newIsDark ? "#262d2a" : "#ecedea",
          inputBg: newIsDark ? "#191d1b" : "#ffffff",
          accent: newIsDark ? "#45be97" : "#0b6b54",
          accentText: newIsDark ? "#06231a" : "#ffffff",
          highlight: newIsDark ? "#e0b054" : "#9a6608",
          danger: newIsDark ? "#f2b8b5" : "#b3261e",
          success: newIsDark ? "#3fbf83" : "#1c6b44",
        };
        container.style.setProperty("--hermes-bg", newTheme.bg);
        container.style.setProperty("--hermes-text", newTheme.text);
        container.style.setProperty("--hermes-text-muted", newTheme.textMuted);
        container.style.setProperty("--hermes-border", newTheme.border);
        container.style.setProperty(
          "--hermes-bg-secondary",
          newTheme.bgSecondary,
        );
        container.style.setProperty(
          "--hermes-bg-tertiary",
          newTheme.bgTertiary,
        );
        container.style.setProperty("--hermes-input-bg", newTheme.inputBg);
        container.style.setProperty("--hermes-accent", newTheme.accent);
        container.style.setProperty(
          "--hermes-accent-text",
          newTheme.accentText,
        );
        container.style.setProperty("--hermes-highlight", newTheme.highlight);
        container.style.setProperty("--hermes-danger", newTheme.danger);
        container.style.setProperty("--hermes-success", newTheme.success);
        container.style.backgroundColor = newTheme.bg;
        container.style.color = newTheme.text;
        container.style.colorScheme = newIsDark ? "dark" : "light";
      };
      mq.addEventListener("change", onThemeChange);
    }
  } catch {
    // ignore
  }

  let root: ReturnType<typeof createRoot> | null = null;
  try {
    root = createRoot(container);
  } catch (err) {
    addonInstance.log(
      `Hermes theme: createRoot FAILED: ${(err as Error).message}`,
    );
    return () => {};
  }

  try {
    root.render(<HermesChatViewComponent addon={addonInstance} />);
  } catch (err) {
    addonInstance.log(
      `Hermes theme: root.render() FAILED: ${(err as Error).message}`,
    );
  }

  return () => {
    // M6: remove the matchMedia listener to avoid leaks on unmount/toggle.
    if (mq && onThemeChange) {
      try {
        mq.removeEventListener("change", onThemeChange);
      } catch {
        // ignore
      }
    }
    root?.unmount();
  };
}
