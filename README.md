# Hermes Agent for Zotero

[![zotero target version](https://img.shields.io/badge/Zotero-7.0+-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Version](https://img.shields.io/badge/version-0.3.1-blue?style=flat-square)](./package.json)

A Zotero plugin that integrates the [Hermes Agent](https://github.com/nousresearch/hermes) directly into your research workflow. Chat with an AI assistant that has full context of your Zotero library — no copy-pasting, no context switching.

## Features

- **AI Chat in Zotero** — Chat with Hermes Agent in a dedicated sidebar tab
- **Zotero-First Context** — Attach selected Zotero items to conversations; the agent receives full metadata (title, authors, abstract, tags, date, DOI, URL)
- **Dual Connection Modes**
  - **ACP (stdio)** — Spawns `hermes acp` as a subprocess, communicates via JSON-RPC over stdio/NDJSON
  - **API (HTTP)** — Connects to `hermes gateway` via OpenAI-compatible `/v1/chat/completions` with SSE streaming
- **Note Operations** — Save specific assistant responses as child notes via a `📝` bubble button, or use `/savechat` to save the whole conversation history to a child note
- **PDF Annotation Integration** — Read PDF highlights/comments with the `/annotations` command, and write back annotations to Zotero with `ApprovalDialog` safety prompts
- **Citation Helpers** — Compile in-text citations and standard bibliographies in any matched CSL style with `/cite [style]` (e.g. `/cite mla` or `/cite chicago`)
- **Auto-Tagging System** — Generate tag recommendations with confidence scores for attached items based on local text analysis, and click-to-apply them to Zotero references
- **Conversation Branching** — Edit previous user messages via a pencil icon to spawn a new conversation branch, automatically truncating subsequent message history
- **Keyboard Search (Cmd+F)** — Intercepts `Cmd+F` / `Ctrl+F` to toggle and focus the chat messages search panel, supporting navigation and match counters
- **Token Dashboard** — Displays real-time input and output token counts for the last turn at the bottom of the chat view
- **Persona Switcher** — Switch system prompt orientations (Research Assistant, Citation Expert, Literature Analyst) dynamically using the `/persona [name]` command
- **Streaming Responses** — Real-time message streaming with typing indicator
- **Reasoning Display** — Collapsible reasoning/thought process bubbles
- **Tool Call Visualization** — Expandable tool call panels with status indicators
- **Copy to Clipboard** — 📋 buttons on all message bubbles for easy text extraction
- **Markdown Rendering** — Custom sandbox-safe markdown renderer supporting headers, bold, italic, code, links, lists, blockquotes, tables, and horizontal rules
- **Dark/Light Theme** — Automatic theme detection and CSS variable-based styling
- **Slash Commands** — Built-in commands: `/clear`, `/search`, `/annotations`, `/cite`, `/tag`, `/persona`, `/savechat`, and extensible command registry
- **Preferences Panel** — Connection settings, chat toggles, and feature flags

## Architecture

```
┌─────────────────────────────────────────┐
│  Zotero Main Window                     │
│  ┌─────────────────────────────────────┐  │
│  │  Hermes Chat Tab (React 18)       │  │
│  │  ┌─────────────────────────────┐  │  │
│  │  │  Messages (MarkdownRenderer)│  │  │
│  │  │  Input + Send Button        │  │  │
│  │  │  Context Items Bar          │  │  │
│  │  └─────────────────────────────┘  │  │
│  └─────────────────────────────────────┘  │
└─────────────────────────────────────────┘
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
┌───────────────┐      ┌───────────────┐
│ HermesClient  │      │ HermesApiClient│
│ (ACP / stdio) │      │ (REST / SSE)   │
└───────────────┘      └───────────────┘
        │                       │
        └───────────┬───────────┘
                    ▼
            ┌───────────────┐
            │ hermes CLI   │
            │ (local AI)   │
            └───────────────┘
```

### Key Files

| File                                    | Purpose                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `src/views/HermesChatView.tsx`          | Main React chat UI — messages, input, context items, stream subscription |
| `src/modules/hermes/HermesClient.ts`    | ACP client — JSON-RPC over stdio, auto-discovery, notification handling  |
| `src/modules/hermes/HermesApiClient.ts` | API client — REST + SSE streaming, OpenAI-compatible                     |
| `src/modules/hermes/ChatManager.ts`     | Conversation state persistence                                           |
| `src/modules/hermes/ItemManager.ts`     | Zotero item metadata extraction and attachment resolution                |
| `src/modules/hermes/NoteManager.ts`     | Note read/write operations                                               |
| `src/modules/hermes/SlashCommands.ts`   | Built-in slash command registry                                          |
| `src/utils/MarkdownRenderer.tsx`        | Sandbox-safe markdown-to-React renderer (no `dangerouslySetInnerHTML`)   |
| `src/views/useStreamBuffer.ts`          | Buffered streaming hook with `setTimeout` flush                          |
| `addon/content/preferences.xhtml`       | Settings panel UI                                                        |

## Zotero Sandbox Constraints

Zotero plugins run in a **Firefox 140 ESR sandbox** (Zotero 10; was 115 ESR
under Zotero 9) with significant React limitations:

- **Synthetic events fail** — `onChange`, `onClick`, `onKeyDown` on React elements don't work
- **Solution** — All user interaction uses native `addEventListener` via refs
- **State ref pattern** — `stateRef` mirrors all React state for native callback access
- **No `dangerouslySetInnerHTML`** — Crashes the sandbox; use `MarkdownRenderer` instead
- **No `DOMParser`** — Also crashes; pure React element creation only

## Installation

### Prerequisites

1. Zotero 7.0 or later. The manifest pins `strict_min_version` to 7.0 —
   Zotero's internal compatibility check requires this even on 9.x/10.x builds.
   `strict_max_version` is `10.*` (Zotero 10 runs on Mozilla 140 ESR).
2. [Hermes CLI](https://github.com/nousresearch/hermes) installed and available in `$PATH`
3. Node.js 18+ and npm

### Build from Source

```bash
git clone https://github.com/techne-tools/zotero-hermes.git
cd zotero-hermes
npm install
npm run build
```

The built `.xpi` will be in `.scaffold/build/hermes-agent-for-zotero.xpi`.

### Install in Zotero

1. Open Zotero → Tools → Add-ons
2. Click the gear icon → Install Add-on From File
3. Select `.scaffold/build/hermes-agent-for-zotero.xpi`
4. Restart Zotero

### Development

```bash
npm start
```

Starts Zotero with the plugin loaded and enables **auto hot reload** — changes to `src/` or `addon/` are automatically compiled and reloaded.

## Configuration

Open **Zotero → Edit → Settings → Hermes Agent** to configure:

- **🤖 Agent Personality** — Customise the assistant's display name
- **💬 Chat Display** — Toggle reasoning steps, tool use notices, token counter, and auto-save
- **🔌 Connection** — Choose Local (ACP/stdio) or Remote (API/SSE) mode, with test-connection buttons
- **📎 Automatic Context** — Enable citation generation, annotation reading, and tag management
- **🗂️ Saving Conversations** — Set save folder and organisation mode (flat / by-date)
- **🔊 Sound & Feel** — Typing sounds and haptic feedback toggles
- **🛡️ Security** — Terminal command approval toggle
- **🐛 Troubleshooting** — Debug mode and onboarding reset

## Usage

1. Select items in your Zotero library
2. Click the 📎 paperclip icon in the chat to attach them as context
3. Type your question and press Send
4. The agent answers using the attached items' metadata

### Example Queries

- "Summarize this paper" (with item attached)
- "What are the key findings?" (with item attached)
- "Compare these two articles" (with multiple items attached)
- "/clear" — Clear the conversation

### Slash Commands

Library operations run through the chat input. Every Zotero write (metadata,
tags, annotations) opens an approval dialog first and is recorded in the audit
log.

| Command                         | What it does                                                           |
| ------------------------------- | ---------------------------------------------------------------------- |
| `/clear`                        | Clear the current conversation                                         |
| `/context`                      | Attach selected library items as context                               |
| `/collection [n]`               | Attach up to `n` items from the selected collection                    |
| `/search <query>`               | Search notes and items; add results to context                         |
| `/metadata [field=value, …]`    | View or update metadata for the attached item                          |
| `/doi [doi]`                    | Resolve a DOI via CrossRef/DataCite, or find one from the item's title |
| `/cites`                        | Reverse-citation lookup: which works cite the attached item            |
| `/bulk-metadata field=value, …` | Edit metadata across a whole collection                                |
| `/bulk-field field=value, …`    | Edit metadata across all attached items                                |
| `/tag [tag1, tag2]`             | Suggest or apply tags                                                  |
| `/organize-tags [merge A -> B]` | Analyse the tag taxonomy; merge duplicates                             |
| `/annotations`                  | List PDF annotations for the attached item                             |
| `/anno-search <text>`           | Search annotations across the whole library                            |
| `/anno-edit <key> field=…`      | Edit an annotation (comment, colour, text, page)                       |
| `/cite [style]`                 | In-text citation and bibliography for the attached item                |
| `/savechat`                     | Save the conversation as a Zotero note                                 |
| `/export [name\|note]`          | Export the conversation (Obsidian Markdown, or a note)                 |
| `/canvas [name]`                | Export a conversation + papers knowledge graph as an Obsidian Canvas   |
| `/compare`                      | Comparative synthesis across attached papers                           |
| `/gaps`                         | Literature gap analysis across attached papers                         |
| `/timeline`                     | Chronological evolution map across attached papers                     |
| `/draft-litreview <topic>`      | Draft a literature review section with `@citekey` citations            |
| `/critique [focus]`             | Peer-review methodological critique                                    |
| `/quiz`                         | Seminar questions and defence prep                                     |
| `/persona <name>`               | Switch agent persona (`researcher`, `citation`, `analyst`)             |
| `/help`                         | List all commands                                                      |

## Recent Changes (11 August 2026)

### Fixed

- **Chat UI restored** — the chat view was a non-functional stub (empty
  callbacks, placeholder components) since the 2026-08-02 component split.
  The full implementation was ported from git history into the proper
  component structure: `HermesChatView` (state + orchestration),
  `ChatMessageItem` (copy/save-note/edit/collapsible), `InputArea` (native
  listeners + slash dropdown), `MessageList` (typing + error),
  `SidePanels` (export/conversations/search/settings/onboarding),
  `ContextBar` (chips), `ChatHeader` (toolbar).
- **Hardcoded path removed** — `HermesClient` no longer falls back to
  a hardcoded Zotero data dir; it is resolved at runtime.
- **Command injection surface closed** — the `hermes` binary is now spawned
  directly with an argument array (no `zsh -c` shell string), so a
  configured path with metacharacters cannot inject commands.
- **HTML injection in note titles** — `NoteManager.writeNote` escapes the
  title before interpolating into `<h1>`.
- **`/tmp` data-loss fallback removed** — `ConversationManager` no longer
  writes conversations to `/tmp`; it falls back to the Zotero data directory.
- **Timer leak** — `HermesClient.waitForResponse` clears its 90s timeout
  when the response arrives.
- **Log bug** — `processStdoutBuffer` debug log now interpolates the line
  count (was printing the literal template string).

### Changed

- **Governance docs added** — `DESIGN.md` (design north star), `PRODUCT.md`
  (product intent), `ARCHITECTURE.md` (code reality), and
  `.agent/rules/agent-standards.md` (agent contract), wired into AGENTS.md
  with explicit precedence and a conflict rule.
- **`archive/` removed** — 1.5MB of drifting duplicate source; the live
  source is the single source of truth.
- **Tracked `.DS_Store` files removed** from git.

## Recent Changes (17 July 2026)

### Added

- **Note Creation and Saving** — Expose a save-to-note `📝` icon on messages to save them as child notes. Added `/savechat` command to output conversation as child note.
- **Note Relevance Search** — Added relevance-scoring and text-cleaning for local note search via `/search [query]`, with click-to-add context chips in chat sidebar.
- **PDF Annotation Integration** — Added `/annotations` to extract highlights and notes on attached references, and implemented programmatic annotation creation safely routed through `ApprovalDialog`.
- **CSL Citation Helper** — Added `/cite [style]` command to format in-text citations and bibliographies in APA, MLA, Chicago, and other styles.
- **Local Tag Suggester** — Added `/tag` to recommend library tags using term frequency matching and user pattern count weights.
- **Conversation Branching** — Edit previous user messages via pencil button to spawn edited dialog paths.
- **Cmd+F Search Shortcut** — Window keydown interceptor opens and focuses message search panel.
- **Token Dashboard** — Displays real-time API turn tokens dynamically.
- **Persona Switcher** — Added `/persona` command to switch between system prompts (Research Assistant, Citation Expert, Literature Analyst).

## Recent Changes (5 June 2026)

### Fixed

- **Preferences pane not appearing** — Added `Zotero.PreferencePanes.register()` call during startup so the Hermes Agent settings pane appears in Zotero Settings
- **Metadata context** — Full item metadata (title, authors, abstract, tags, date, DOI, URL) now passed to agent, preventing hallucinations
- **Storage folder resolution** — Attachment item key (not parent key) used for correct storage path
- **Stuck typing indicator** — Safety timeout restarts on activity, clears after 60s of no terminal event
- **Markdown tables** — Custom table rendering in sandbox-safe markdown renderer
- **Build errors** — Duplicate variable declarations in `HermesClient.ts`

### Added

- **Proper preferences pane** — Full 8-section settings UI aligned with obsidian-hermes: Agent Personality, Chat Display, Connection (local/remote with test buttons), Automatic Context, Saving Conversations, Sound & Feel, Security, Troubleshooting
- **Conversation organisation** — Flat or by-date monthly subfolders for saved conversations
- **Typing sounds** — Soft click sound via Web Audio API while agent writes (toggleable)
- **Haptic feedback** — Vibrate on agent response start (toggleable)
- **MCP server support** — Enable/disable external tool servers with path configuration
- **Reset onboarding** — Button to show welcome message again
- **Copy to clipboard** — 📋 buttons on assistant messages and reasoning bubbles
- **Stronger system prompt** — Explicitly instructs agent to answer from provided metadata
- **MCP removal** — Removed flaky MCP dependency; uses direct fs-based access

### Changed

- **System instruction** — Clarified that SQLite is locked and MCP is unavailable

## Known Issues

- SQLite database cannot be read while Zotero is running (locked)
- PDF content extraction requires the PDF to be in Zotero storage
- Large conversations may benefit from virtualized scrolling (not yet implemented)

## Roadmap

See [TODO.md](./TODO.md) for detailed implementation plan and feature backlog.

## License

[MIT](./LICENSE)

## Acknowledgments

- Built with [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) by windingwind
- Uses [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit) for Zotero API integration
- Hermes Agent by [Nous Research](https://nousresearch.com)
