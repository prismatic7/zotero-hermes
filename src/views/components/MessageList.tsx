import React, { useEffect, useState } from "react";
import { ChatMessage } from "../types";
import type Addon from "../../addon";
import { ChatMessageItem } from "./ChatMessageItem";
import { AlertIcon, CloseIcon } from "./Icons";

interface MessageListProps {
  messages: ChatMessage[];
  addon: Addon;
  isTyping: boolean;
  agentName: string;
  error: string | null;
  messagesContainerRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  messageRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
  onEditMessage: (idx: number, newText: string) => void;
  onAbortTerminal?: () => void;
  onSwitchBranch?: (messageId: string, branchIndex: number) => void;
  onDismissError: () => void;
}

const BRAILLE_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function TypingIndicator({
  agentName,
}: {
  agentName: string;
}): React.ReactElement {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((prev) => (prev + 1) % BRAILLE_SPINNER.length);
    }, 80);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="hermes-message hermes-message-assistant hermes-typing-indicator">
      <div className="hermes-typing-header">
        <span className="hermes-message-role">{agentName}</span>
        <span className="hermes-typing-status">
          <span className="hermes-typing-spinner">
            {BRAILLE_SPINNER[frame]}
          </span>
          {" Typing"}
        </span>
      </div>
    </div>
  );
}

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  addon,
  isTyping,
  agentName,
  error,
  messagesContainerRef,
  messagesEndRef,
  messageRefs,
  onEditMessage,
  onAbortTerminal,
  onSwitchBranch,
  onDismissError,
}) => {
  const WINDOW_SIZE = 40;
  const [visibleCount, setVisibleCount] = useState(WINDOW_SIZE);

  const hiddenCount = Math.max(0, messages.length - visibleCount);
  const visibleMessages =
    hiddenCount > 0 ? messages.slice(hiddenCount) : messages;

  return (
    <div
      ref={messagesContainerRef}
      className="hermes-messages"
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "16px 14px 20px",
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        minWidth: 0,
      }}
    >
      {hiddenCount > 0 && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "4px 0",
          }}
        >
          <button
            onClick={() => setVisibleCount((prev) => prev + WINDOW_SIZE)}
            className="hermes-small-btn"
            style={{
              padding: "4px 12px",
              borderRadius: "12px",
              backgroundColor: "var(--hermes-bg-secondary, #f0f0f0)",
              border: "1px solid var(--hermes-border, #e0e0e0)",
              color: "var(--hermes-text, #333)",
              cursor: "pointer",
              fontSize: "0.85em",
            }}
          >
            Show earlier messages ({hiddenCount} hidden)
          </button>
        </div>
      )}
      {visibleMessages.map((msg, visibleIdx) => {
        const idx = hiddenCount + visibleIdx;
        if (isTyping && msg.role === "assistant" && !msg.content) return null;
        return (
          <div
            key={msg.id}
            ref={(el) => {
              if (el) messageRefs.current.set(msg.id, el);
              else messageRefs.current.delete(msg.id);
            }}
            // The wrapper must be a flex column so the inner .hermes-message
            // can align itself (align-self needs a flex parent). Without this,
            // .hermes-message-user/.hermes-message-assistant alignment is
            // ignored and every bubble stretches full width.
            style={{ display: "flex", flexDirection: "column" }}
          >
            <ChatMessageItem
              message={msg}
              addon={addon}
              onAbortTerminal={onAbortTerminal}
              onSwitchBranch={onSwitchBranch}
              onEditMessage={
                msg.role === "user"
                  ? (newText) => onEditMessage(idx, newText)
                  : undefined
              }
            />
          </div>
        );
      })}
      {isTyping && <TypingIndicator agentName={agentName} />}
      {error && (
        <div className="hermes-error-bar">
          <AlertIcon />
          <span style={{ flex: 1 }}>{error}</span>
          <button onClick={onDismissError} className="hermes-error-bar-close">
            <CloseIcon />
          </button>
        </div>
      )}
      <div ref={messagesEndRef} />
    </div>
  );
};
