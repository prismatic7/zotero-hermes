# ARCHITECTURE — Hermes Agent for Zotero

**Current code reality.** This document describes how the code is actually
structured today. When it disagrees with DESIGN.md, flag the conflict.

## Runtime Environment

- **Host:** Zotero 7–10 (Mozilla 140 ESR / Firefox ESR sandbox)
- **Language:** TypeScript (strict), bundled by esbuild via
  zotero-plugin-scaffold
- **UI:** React 18 (chat), XUL/XHTML (native panels)
- **Toolkit:** zotero-plugin-toolkit

## Module Map

```
src/
├── index.ts                    # Entry: sets browser globals, instantiates Addon
├── addon.ts                    # Addon class — typed module registry (addon.data.hermes)
├── hooks.ts                    # Zotero lifecycle: startup, shutdown, window load/unload
├── modules/
│   ├── hermes/
│   │   ├── HermesClient.ts     # ACP/stdio client (JSON-RPC over NDJSON)
│   │   ├── HermesApiClient.ts  # REST/SSE client (OpenAI-compatible)
│   │   ├── ChatManager.ts      # Conversation state (debounced persistence)
│   │   ├── ConversationManager.ts # JSON file persistence in profile dir
│   │   ├── ItemManager.ts      # Zotero item metadata extraction & updates (approval-gated)
│   │   ├── NoteManager.ts      # Note read/write (approval-gated)
│   │   ├── AnnotationManager.ts # PDF annotation read/write (approval-gated)
│   │   ├── CitationManager.ts  # CSL citation/bibliography generation
│   │   ├── TagManager.ts       # Tag operations + suggestions (approval-gated)
│   │   ├── SlashCommands.ts    # Built-in slash command registry (/metadata, /tag, etc.)
│   │   ├── ApprovalDialog.ts   # Serialised approval modal
│   │   ├── PreferencesManager.ts # Pref defaults + access
│   │   ├── HermesBinaryFinder.ts # Binary discovery across $PATH
│   │   └── systemPrompt.ts     # System prompt + item context builders
│   └── preferenceScript.ts     # Preferences pane UI logic
├── utils/
│   ├── MarkdownRenderer.tsx    # Sandbox-safe markdown → React
│   ├── AuditLog.ts             # Persistent action log (batched)
│   ├── DebugLogger.ts          # Debug-gated logging
│   ├── stripAnsi.ts            # ANSI code stripping
│   ├── uuid.ts                 # Message ID generation
│   ├── locale.ts               # FTL localization
│   └── ztoolkit.ts             # Toolkit helper
└── views/
    ├── HermesChatView.tsx      # Chat orchestration + mount (theme detection)
    ├── useStreamBuffer.ts      # Buffered streaming hook
    ├── types.ts                # ChatMessage, ContextItem
    └── components/
        ├── ChatHeader.tsx      # Toolbar
        ├── SidePanels.tsx      # Conversations/search/settings/onboarding
        ├── MessageList.tsx     # Message list + typing + error
        ├── ChatMessageItem.tsx # Per-message rendering + actions
        ├── ContextBar.tsx      # Attached item chips
        ├── InputArea.tsx       # Textarea + send/stop + slash dropdown
        └── Icons.tsx           # SVG icon set
```

## Data Flow

### Chat send (ACP mode)

```
User types → native input listener → setInput
  → sendMessage (rate-limited 2s)
    → parseSlashCommand? → execute | sendToHermes
    → sendToHermes:
        setMessages (user + empty assistant)
        client.connect() if needed
        client.sendPrompt(text, contextItems, allowedTools)
          → HermesClient: buildSystemPrompt + buildItemContext
          → JSON-RPC session/prompt over stdin
```

### Stream receive

```
HermesClient stdout → NDJSON parse → handleNotification
  → session/update → emitUpdate
    → HermesChatView handleUpdate:
        message → appendContent (useStreamBuffer)
        reasoning → appendReasoning
        tool_* → tool message splice
        terminal_output → terminal message (gated by allowTerminal)
        usage → token dashboard
        stop/session_info/error → flush, clear typing
```

### Persistence

```
ChatManager.addMessage → scheduleSave (500ms debounce)
  → ConversationManager.saveConversation
    → JSON file in <profile>/zotero-hermes/<folder>/<id>.json
```

## Key Patterns

### Native event wiring & sandbox event boundaries

In Zotero's Firefox ESR sandbox, React synthetic events on text inputs
(`onChange`, `onKeyDown`) fail to dispatch reliably due to Mozilla privileged
chrome event handling. The input area, Enter-to-send, and window-level
shortcuts (`Cmd+F`) strictly use native `addEventListener` via refs, reading
mutable state from `stateRef.current`. Standard button click handlers inside
React subcomponents dispatch normally and use declarative `onClick`.

### Stream subscription (minimal deps)

The stream-subscription effect has `[hermes.client]` as its only dependency.
Callbacks use refs (`streamingMessageIdRef`, `reasoningMessageIdRef`) for
mutable state, avoiding re-subscription loops.

### Buffered streaming

`useStreamBuffer` collects chunks in refs and flushes via
`setTimeout(flushBuffer, 50)` — `requestAnimationFrame` is unreliable in the
sandbox. Reasoning messages are inserted BEFORE the assistant message via
`splice(assistantIndex, 0, reasoningMsg)`.

### Approval serialisation

`ApprovalDialog` serialises dialogs through a queue — at most one modal open
at a time. Each call creates a fresh `<dialog>` element (never reuses a stale
one), preventing Promise leaks on concurrent calls.

## Security Architecture

- **Subprocess spawn:** `HermesClient` invokes the binary directly with an
  argument array (`command: hermesPath, arguments: ["acp"]`) — no shell, no
  command injection surface. PATH is extended via the environment object.
- **Approval gate & Audit logging:** `NoteManager.writeNote`,
  `AnnotationManager.writeAnnotation`, `TagManager.addTags/removeTags`, and
  `ItemManager.updateItemMetadata` route through `ApprovalDialog` before any
  Zotero write, and record persistent entries to `AuditLog`.
- **Terminal gating:** `terminal_output` updates are dropped unless
  `allowTerminal` is enabled.
- **Secrets:** credentials (e.g. a Semantic Scholar API key) live in the vault,
  never in Zotero prefs and never logged. _(Corrected 2026-10-04 — this
  previously stored the key in Zotero prefs, contradicting the vault decision.)_
- **No hardcoded paths:** Zotero data/profile dirs resolved at runtime.

## Testing

- **Unit tests:** `test/` — markdown renderer, slash commands, stripAnsi,
  tag manager, startup, systemPrompt, ItemManager, ChatManager,
  ConversationManager, HermesClient NDJSON handling. Run with
  `NODE_ENV=test npm test`.
- **Build:** `NODE_ENV=test npm run build` (zotero-plugin build + `tsc --noEmit`).
- **CI:** GitHub Actions — lint, build, test on push/PR to main.

## Known Technical Debt

1. **`any` types** in sandbox-facing code (Subprocess, Components, Zotero
   internals) — necessary where the sandbox API is untyped, but should be
   narrowed where possible.
2. **`/* eslint-disable */`** was removed from the views during the 2026-08-11
   restoration; remaining disables should be justified.
3. **Test coverage** is still thin on the transport layer — HermesApiClient
   (HTTP/SSE) has no unit tests; the ACP client tests cover NDJSON parsing
   but not the full connect/disconnect lifecycle.
4. **`UIExampleFactory`** is a misleading name — it is live code that
   registers the plugin's own `zoteroPane.css` stylesheet on window load.
   Renaming it (e.g. `registerPaneStylesheet`) would clarify intent.
