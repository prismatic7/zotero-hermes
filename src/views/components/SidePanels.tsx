import React from "react";
import {
  CloseIcon,
  TrashIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  LockIcon,
  ExportIcon,
} from "./Icons";

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
}

interface SidePanelsProps {
  isConversationListOpen: boolean;
  isSearchOpen: boolean;
  isSessionSettingsOpen: boolean;
  showOnboarding: boolean;
  conversations: ConversationSummary[];
  searchQuery: string;
  searchMatches: number[];
  currentMatchIndex: number;
  allowedTools: string[] | null;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onLoadConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onExportConversation?: (id: string) => void;
  onCloseConversationList: () => void;
  onSearchChange: (query: string) => void;
  onSearchKeyDown: (e: React.KeyboardEvent) => void;
  onSearchPrev: () => void;
  onSearchNext: () => void;
  onCloseSearch: () => void;
  onAllowAllTools: () => void;
  onBlockAllTools: () => void;
  onToggleTool: (tool: string, checked: boolean) => void;
  onCloseSessionSettings: () => void;
  onDismissOnboarding: () => void;
}

export const SidePanels: React.FC<SidePanelsProps> = ({
  isConversationListOpen,
  isSearchOpen,
  isSessionSettingsOpen,
  showOnboarding,
  conversations,
  searchQuery,
  searchMatches,
  currentMatchIndex,
  allowedTools,
  searchInputRef,
  onLoadConversation,
  onDeleteConversation,
  onExportConversation,
  onCloseConversationList,
  onSearchChange,
  onSearchKeyDown,
  onSearchPrev,
  onSearchNext,
  onCloseSearch,
  onAllowAllTools,
  onBlockAllTools,
  onToggleTool,
  onCloseSessionSettings,
  onDismissOnboarding,
}) => {
  return (
    <>
      {/* Conversation List */}
      {isConversationListOpen && (
        <div className="hermes-conversation-list">
          <div className="hermes-conversation-list-header">
            <span className="hermes-conversation-list-title">
              Previous Conversations
            </span>
            <button
              onClick={onCloseConversationList}
              className="hermes-small-btn"
            >
              <CloseIcon />
            </button>
          </div>
          {conversations.length === 0 ? (
            <div className="hermes-conversation-empty">
              No saved conversations
            </div>
          ) : (
            <ul style={{ margin: 0, padding: "0 0 0 1em" }}>
              {/* No hard cap — the CSS max-height + overflow-y scrolls. */}
              {conversations.map((conv) => (
                <li key={conv.id} className="hermes-conversation-item">
                  <button
                    onClick={() => onLoadConversation(conv.id)}
                    className="hermes-conversation-item-btn"
                  >
                    {conv.title}
                  </button>
                  {onExportConversation && (
                    <button
                      onClick={() => onExportConversation(conv.id)}
                      className="hermes-small-btn"
                      style={{
                        padding: "0 4px",
                        marginRight: "4px",
                      }}
                      title="Export to Markdown / Obsidian"
                      aria-label="Export conversation"
                    >
                      <ExportIcon />
                    </button>
                  )}
                  <button
                    onClick={() => onDeleteConversation(conv.id)}
                    className="hermes-small-btn"
                    style={{
                      color: "var(--hermes-danger, #b3261e)",
                      padding: "0 4px",
                    }}
                    title="Delete"
                    aria-label="Delete conversation"
                  >
                    <TrashIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Search Bar */}
      {isSearchOpen && (
        <div className="hermes-search-bar">
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="Search messages..."
            className="hermes-search-input"
          />
          {searchMatches.length > 0 && (
            <span className="hermes-search-count">
              {currentMatchIndex + 1} / {searchMatches.length}
            </span>
          )}
          <button
            onClick={onSearchPrev}
            className="hermes-small-btn"
            title="Previous"
          >
            <ChevronUpIcon />
          </button>
          <button
            onClick={onSearchNext}
            className="hermes-small-btn"
            title="Next"
          >
            <ChevronDownIcon />
          </button>
          <button
            onClick={onCloseSearch}
            className="hermes-small-btn"
            title="Close"
          >
            <CloseIcon />
          </button>
        </div>
      )}

      {/* Session Settings */}
      {isSessionSettingsOpen && (
        <div className="hermes-session-settings">
          <div className="hermes-session-settings-header">
            <span className="hermes-session-settings-title">
              Session Settings
            </span>
            <button
              onClick={onCloseSessionSettings}
              className="hermes-small-btn"
            >
              <CloseIcon />
            </button>
          </div>
          <p className="hermes-session-settings-desc">
            Configure tool permissions for this conversation. Disabled tools
            will not be available to the agent.
          </p>
          <div className="hermes-session-settings-actions">
            <button
              onClick={onAllowAllTools}
              className="hermes-session-btn-secondary"
            >
              Allow All
            </button>
            <button
              onClick={onBlockAllTools}
              className="hermes-session-btn-secondary"
            >
              Block All
            </button>
          </div>
          <div>
            {["read_file", "write_file", "terminal"].map((tool) => (
              <label key={tool} className="hermes-session-tool-toggle">
                <input
                  type="checkbox"
                  checked={allowedTools === null || allowedTools.includes(tool)}
                  onChange={(e) => onToggleTool(tool, e.target.checked)}
                />
                {tool === "read_file" && "Read Files"}
                {tool === "write_file" && "Write Files"}
                {tool === "terminal" && "Terminal Commands"}
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Onboarding Panel */}
      {showOnboarding && (
        <div className="hermes-onboarding">
          <div className="hermes-onboarding-header">
            <span>Welcome to Hermes</span>
            <button onClick={onDismissOnboarding} className="hermes-small-btn">
              <CloseIcon />
            </button>
          </div>
          <div className="hermes-onboarding-content">
            <p>
              Hermes is an AI assistant that helps you work with your Zotero
              library.
            </p>
            <ul>
              <li>
                <strong>Attach items</strong> — Select Zotero items and click
                the paperclip icon to provide context
              </li>
              <li>
                <strong>Ask questions</strong> — Chat with Hermes about your
                research, annotations, and metadata
              </li>
              <li>
                <strong>Slash commands</strong> — Type <code>/help</code> to see
                available commands
              </li>
              <li>
                <strong>Session settings</strong> — Control which tools the
                agent can use
              </li>
            </ul>
            <p>Your conversations are saved locally and can be searched.</p>
          </div>
          <div className="hermes-onboarding-security">
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <LockIcon />
              Hermes runs locally. Your data stays on your machine.
            </span>
          </div>
        </div>
      )}
    </>
  );
};
