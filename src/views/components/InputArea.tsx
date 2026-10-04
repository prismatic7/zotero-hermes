import React, { useEffect } from "react";
import type { SlashCommand } from "../../modules/hermes/SlashCommands";
import { StopIcon } from "./Icons";

interface InputAreaProps {
  inputRef: React.RefObject<HTMLTextAreaElement>;
  sendBtnRef: React.RefObject<HTMLButtonElement>;
  isTyping: boolean;
  input: string;
  isSlashOpen: boolean;
  slashSuggestions: SlashCommand[];
  slashSelectionIndex: number;
  slashDropdownRef: React.RefObject<HTMLDivElement>;
  onSelectSuggestion: (cmd: SlashCommand) => void;
}

export const InputArea: React.FC<InputAreaProps> = ({
  inputRef,
  sendBtnRef,
  isTyping,
  input,
  isSlashOpen,
  slashSuggestions,
  slashSelectionIndex,
  slashDropdownRef,
  onSelectSuggestion,
}) => {
  // Auto-grow the textarea up to 6 lines, then scroll. Runs on every input
  // change (typing, clearing after send, slash-command insertion) so the box
  // always fits its content. The send button stays centred via the row's
  // align-items: center — it never grows with the textarea.
  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const maxHeight = 6 * 13 * 1.5 + 8; // 6 lines × font-size × line-height + padding
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  }, [input, inputRef]);

  return (
    <div
      className="hermes-input-area"
      style={{
        position: "relative",
        padding: "12px 14px",
        borderTop: "1px solid var(--hermes-border, #dee1db)",
        backgroundColor: "var(--hermes-bg-secondary, #f7f8f5)",
      }}
    >
      {/* Slash command dropdown */}
      {isSlashOpen && slashSuggestions.length > 0 && (
        <div className="hermes-slash-dropdown" ref={slashDropdownRef}>
          {slashSuggestions.map((cmd, idx) => (
            <button
              key={cmd.name}
              className={`hermes-slash-item${idx === slashSelectionIndex ? " hermes-slash-item-selected" : ""}`}
              onClick={() => onSelectSuggestion(cmd)}
            >
              <span className="hermes-slash-item-name">/{cmd.name}</span>
              <span className="hermes-slash-item-desc">{cmd.description}</span>
            </button>
          ))}
        </div>
      )}
      <div
        className="hermes-input-row"
        style={{
          display: "flex",
          gap: "8px",
          alignItems: "center",
          padding: "8px",
          backgroundColor: "var(--hermes-input-bg, #ffffff)",
          border: "1px solid var(--hermes-border, #dee1db)",
          borderRadius: "10px",
        }}
      >
        <textarea
          ref={inputRef}
          defaultValue={input}
          placeholder="Message Hermes..."
          rows={1}
          className="hermes-textarea"
          style={{
            flex: 1,
            minHeight: "28px",
            border: "none",
            outline: "none",
            resize: "none",
            padding: "4px 6px",
            backgroundColor: "transparent",
            color: "inherit",
            fontFamily: "inherit",
            fontSize: "13px",
            lineHeight: 1.5,
          }}
        />
        <button
          ref={sendBtnRef}
          disabled={!input.trim()}
          className="hermes-send-btn"
          style={{
            height: "28px",
            padding: "0 16px",
            lineHeight: 1.5,
            border: "none",
            borderRadius: "6px",
            backgroundColor: "var(--hermes-accent, #0b6b54)",
            color: "var(--hermes-accent-text, #ffffff)",
            cursor: "pointer",
            fontWeight: 600,
            fontSize: "13px",
            whiteSpace: "nowrap",
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            opacity: !input.trim() ? 0.4 : 1,
          }}
        >
          {isTyping ? <StopIcon /> : "Send"}
        </button>
      </div>
    </div>
  );
};
