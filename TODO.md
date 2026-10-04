# Zotero Hermes Plugin — Full Rework TODO

**Created:** 21 May 2026  
**Updated:** 4 October 2026  
**Current Version:** 0.4.0 (Stable)  
**Platform:** Zotero 7.0–10.x (Mozilla 140 ESR)  
**Status:** ✅ Core Infrastructure, UI Redesign, Security Hardening, Zotero 10 Compatibility & Library Operations Complete

---

## Phase 1: Foundation & Core Infrastructure

### Project Setup

- [x] Initialize plugin scaffold from zotero-plugin-template
  - Update package.json with Hermes branding
  - Configure manifest.json for Zotero 7–10
  - Set up build system with zotero-plugin-scaffold
- [x] Create core Hermes modules
  - `HermesClient.ts` — ACP protocol client with $PATH discovery
  - `ChatManager.ts` — Conversation state management
  - `NoteManager.ts` — Note read/write operations
  - `SlashCommands.ts` — Built-in slash command registry
- [x] Build sidebar UI components
  - `src/views/HermesChatView.tsx` — React 18 chat interface (standalone tab)
  - `src/views/useStreamBuffer.ts` — rAF-buffered streaming hook
  - `addon/content/hermes/sidebar.xhtml` — Legacy XUL fallback
  - `addon/content/hermes/sidebar.css` — Styling
  - `hermes-mainWindow.ftl` — English localization
- [x] Integrate with Zotero lifecycle
  - Register Hermes toolbar button and full-height sidebar container in hooks.ts
  - React mount/unmount lifecycle hooks
  - Message send/receive handlers

### Basic Connectivity

- [x] Setup ACP Protocol Communication
  - [x] Implement NDJSON message parsing for ACP protocol
  - [x] Add stdio handlers for subprocess communication
  - [x] Handle session initialization and authentication
  - [x] Implement message ID tracking and correlation
  - [x] Auto-reconnect with exponential backoff

- [x] **Add API Server Mode (Alternative to ACP)**
  - [x] Create `HermesApiClient.ts` — REST API client with SSE streaming
  - [x] OpenAI-compatible `/v1/chat/completions` endpoint support
  - [x] Bearer token authentication via `Authorization` header
  - [x] Auto-reconnect with exponential backoff
  - [x] Compatible with `hermes gateway` (port 8642)
  - [x] Same public interface as `HermesClient` (ACP) — UI doesn't need to know which is active
  - File: `src/modules/hermes/HermesApiClient.ts`

- [x] Implement Basic Chat Flow
  - [x] Connect send button to HermesClient
  - [x] Stream responses to UI in real-time
  - [x] Add typing indicator during streaming
  - [x] Handle connection errors gracefully
  - [x] Rate limiting (2s cooldown)

- [x] Error Handling & Logging
  - [x] Add comprehensive error boundaries
  - [x] Implement retry logic for failed connections
  - [x] Add user-friendly error messages
  - [x] Setup debug logging system

### Bug Fixes (30 May 2026)

- [x] **Fix textarea input in Zotero sandbox**
  - React synthetic `onChange` doesn't work in Zotero's sandboxed Firefox
  - Solution: Native DOM `input` event listener + `defaultValue` instead of `value`
  - File: `src/views/HermesChatView.tsx`

- [x] **Fix ACP connection timeout**
  - Missing `stdin: "pipe"`, `stdout: "pipe"`, `stderr: "pipe"` in Subprocess.call
  - `writeToStdin` was synchronous but Firefox Subprocess requires async
  - `session/new` param was `cwd` but should be `workdir`
  - File: `src/modules/hermes/HermesClient.ts`

- [x] **Fix dark/light theming**
  - XUL documents don't support `textContent`/`innerHTML` on `<style>` elements
  - Solution: CSSOM `sheet.insertRule()` + inline styles on container + `color-scheme` CSS property
  - Three detection methods: `matchMedia`, computed `main-window` background, document class/attr
  - File: `src/views/HermesChatView.tsx`

### Bug Fixes (5 June 2026) — Session: UI/UX & Metadata Context

- [x] **Fix stuck "Hermes is thinking" indicator**
  - Safety timeout was cleared on first update chunk and never restarted
  - Solution: Restart 60s timeout on every non-terminal event; clear on `stop`/`usage`/`session_info`/`error`
  - File: `src/views/HermesChatView.tsx`

- [x] **Fix Markdown table rendering**
  - `MarkdownRenderer` didn't support tables at all
  - Solution: Added table block parsing (lines starting with `|`) and `<table>`/`<thead>`/`<tbody>` rendering
  - File: `src/utils/MarkdownRenderer.tsx`

- [x] **Fix missing item metadata in agent context**
  - Only item key and storage path were passed; agent hallucinated database access
  - Solution: Pass full metadata (title, authors, abstract, tags, date, DOI, URL, item type) in context
  - File: `src/modules/hermes/HermesClient.ts`, `src/modules/hermes/ItemManager.ts`

- [x] **Fix storage folder mismatch**
  - Parent item key ≠ attachment item key; agent looked in wrong folder
  - Solution: `ItemManager.extractItemData()` (now async) properly `await`s `getBestAttachment()` and uses the attachment key; the previous sync cast returned a Promise object instead of the resolved item
  - File: `src/modules/hermes/ItemManager.ts`

- [x] **Add copy-to-clipboard buttons**
  - Users couldn't copy text from chat bubbles (especially long reasoning)
  - Solution: 📋 button on assistant messages and reasoning bubbles using `nsIClipboardHelper`
  - File: `src/views/HermesChatView.tsx`

- [x] **Remove MCP dependency**
  - MCP server consistently failed to connect
  - Solution: Removed `mcpServers` from `createSession()`; agent uses provided metadata directly
  - File: `src/modules/hermes/HermesClient.ts`

- [x] **Prevent agent hallucinations**
  - Agent tried to read locked SQLite database and search online despite constraints
  - Solution: Stronger system instruction explicitly tells agent to answer from provided metadata
  - File: `src/modules/hermes/HermesClient.ts`

- [x] **Fix build errors**
  - Duplicate `const` declarations in `sendPrompt()` after MCP removal
  - Solution: Removed second pair of `zoteroDataDir`/`zoteroStorageDir` declarations
  - File: `src/modules/hermes/HermesClient.ts`

### Bug Fixes (5 June 2026) — Session: UI/UX Alignment with Obsidian Plugin

- [x] **Align chat UI/UX with obsidian-hermes**
  - Unified CSS classes, inline style fallbacks for Zotero sandbox reliability
  - Added session settings panel, onboarding panel, slash command autocomplete
  - Replaced old icon with Lucide `Bot` icon
  - Fixed overflow and cramped reasoning bubble spacing
  - Files: `src/views/HermesChatView.tsx`, `addon/content/hermes-chat.css`, `addon/content/icons/hermes-sidenav.svg`

- [x] **Fix CSS injection crash**
  - `insertRule(cssText)` failed in Firefox/XUL sandbox
  - Solution: Use `textContent` on `<style>` element; add inline style fallbacks to critical containers
  - Files: `src/views/HermesChatView.tsx`

- [x] **Fix TDZ error on startup**
  - `useState(() => !settings.get(...))` accessed `settings` before declaration
  - Solution: Initialise as `true` + `useEffect` correction after settings is available
  - File: `src/views/HermesChatView.tsx`

- [x] **Fix sidebar layout broken after CSS crash**
  - CSS not loading caused buttons to fall back to XUL defaults
  - Solution: Inline style fallbacks on all critical layout containers
  - File: `src/views/HermesChatView.tsx`

### Enhancements (5 June 2026) — Session: Proper Preferences Pane

- [x] **Rewrite preferences.xhtml with full section layout**
  - 8 sections matching obsidian-hermes design: 🤖 Agent Personality, 💬 Chat Display, 🔌 Connection, 📎 Automatic Context, 🗂️ Saving Conversations, 🔊 Sound & Feel, 🛡️ Security, 🐛 Troubleshooting
  - Dynamic show/hide for local vs remote connection settings
  - MCP server enable/disable with warning and path textarea
  - Test connection buttons for both local and remote modes
  - Reset onboarding button
  - File: `addon/content/preferences.xhtml`

- [x] **Add all missing preference defaults**
  - `hermesAgentName`, `hasSeenOnboarding`, `enableTypingSound`, `enableHapticFeedback`, `allowTerminal`, `mcpServersEnabled`, `mcpServersList`, `conversationOrganization`, `chatSaveFolder`
  - File: `src/modules/hermes/PreferencesManager.ts`

- [x] **Update preferenceScript.ts with dynamic UI logic**
  - Connection mode section toggle, MCP checkbox → textarea toggle
  - Test connection buttons (local + remote), reset onboarding button
  - File: `src/modules/preferenceScript.ts`

- [x] **Wire enableTypingSound and enableHapticFeedback in chat view**
  - Soft 800Hz sine click via Web Audio API in `useStreamBuffer.ts`
  - Haptic feedback (navigator.vibrate) on agent response start in `HermesChatView.tsx`
  - Files: `src/views/useStreamBuffer.ts`, `src/views/HermesChatView.tsx`

- [x] **Add conversation organisation to ConversationManager**
  - Respects `chatSaveFolder` and `conversationOrganization` prefs
  - Supports flat (default) and by-date monthly subfolders
  - File: `src/modules/hermes/ConversationManager.ts`

- [x] **Fix preferences pane not appearing in Zotero Settings**
  - Missing `Zotero.PreferencePanes.register()` call during startup
  - Solution: Register pane after Hermes modules initialise in `onStartup()`
  - File: `src/hooks.ts`

### Item Context

- [x] Selected Item Attachment
  - [x] Add button to attach selected Zotero items to chat
  - [x] Extract item metadata (title, authors, abstract, tags, date, DOI, URL)
  - [x] Format item context for Hermes prompt
  - [x] Show attached items in chat UI
  - [x] **Resolve correct storage folder** — Attachment item key (not parent key) is the real folder name
  - [x] **Pass full metadata to agent** — Prevents hallucinations by providing all item data in context

- [x] Item Context Manager
  - [x] Create `ItemManager.ts` module
  - [x] Implement item metadata extraction
  - [x] Support multiple item selection
  - [x] Add context preview before sending

### Note Operations

- [x] Note Creation/Modification
  - [x] Implement `writeNote()` with approval system
  - [x] Create/utilize approval dialog UI component
  - [x] Show new content in approval preview
  - [x] Handle approve/reject actions

- [x] Note Search & Retrieval
  - [x] Enhance `searchNotes()` with fuzzy matching
  - [x] Add `/search` slash command
  - [x] Display search results in chat
  - [x] Allow selecting results as context

---

## Phase 3: Advanced Features

### PDF Annotations

- [x] Annotation Reading
  - [x] Create/implement `AnnotationManager.ts` module
  - [x] Extract annotations from PDF attachments
  - [x] Sort annotations by page number
  - [x] Include color tags and comments

- [x] Annotation Writing (Requires approval)
  - [x] Implement annotation creation
  - [x] Support highlight, underline, and comment annotations
  - [x] Integrate with Approval dialog for annotation changes

### Citation Helpers

- [x] Citation Generation
  - [x] Add `/cite` command for citation formatting
  - [x] Support multiple citation styles (APA, MLA, Chicago, etc.)
  - [x] Generate bibliographies
  - [x] Copy to clipboard functionality (via message action / chat bubbles)

### Tag Suggestions

- [x] Auto-Tagging System
  - [x] Analyze item content for tag suggestions
  - [x] Show suggested tags with confidence scores
  - [x] Bulk apply tags to items (via /tag command)
  - [x] Learn from user tag patterns (weights suggestions by library tag popularity)

---

## Phase 4: Cross-Platform Feature Porting

### Tier 1: High Impact, High Feasibility

#### 1. Ghost Text / Inline Auto-Completion

- [ ] Add inline suggestion support in Zotero's note editor (Secondary/Experimental)
- [ ] Use Zotero's editor API for inline completions
- [ ] Support multiple alternatives with keyboard navigation
- [ ] Accept with Tab key, clear on cursor movement

#### 2. Semantic Vault RAG via `/search` Command

- [x] Enhance existing item search functionality
- [x] Add `/search` slash command with semantic/quicksearch capability
- [x] Search items by title, authors, tags, abstract
- [x] Append search results to conversation context (via click-to-add link)

#### 3. Conversation Branching with Message Editing

- [x] Add message editing capability in Zotero sidebar
- [x] Truncate history and create conversation branch
- [x] Support multiple conversation branches from same session

### Tier 2: Medium Impact, Medium Feasibility

#### 4. Token Usage Dashboard

- [x] Add token counter to Zotero sidebar status bar
- [x] Display real-time token usage during conversation

#### 5. Conversation Search with Cmd+F

- [x] Add search functionality to Zotero sidebar
- [x] Search through conversation history
- [x] Real-time filtering with match counter
- [x] Keyboard navigation (Cmd+F, Enter, Shift+Enter)

#### 6. Persona Templates

- [x] Add `/persona` slash command to Zotero
- [x] Pre-configured personas: Research Assistant, Citation Expert, Literature Analyst
- [x] Each with different system prompts
- [x] Save custom personas to preferences

### Tier 3: Low Impact, High Feasibility

#### 7. Export Conversations (HTML/JSON/PDF)

- [x] Dropped from spec (conversations persist locally in JSON store within profile directory)

#### 8. Session Tools (Tool Restrictions)

- [x] Add session tools UI to Zotero sidebar (`SidePanels.tsx`)
- [x] Allow users to restrict available tools per conversation (Allow All, Block All, per-tool toggles)
- [x] Save tool restrictions with conversation (`Conversation.allowedTools` persisted to JSON)

---

## Implementation Priority Matrix

| Feature                             | Zotero Port Difficulty | Zotero Impact | Priority |
| ----------------------------------- | ---------------------- | ------------- | -------- |
| Ghost Text / Inline Auto-Completion | Medium                 | ⭐⭐⭐⭐      | **1**    |
| Semantic Vault RAG (`/search`)      | Low                    | ⭐⭐⭐⭐⭐    | **2**    |
| Conversation Branching              | Medium                 | ⭐⭐⭐⭐      | **3**    |
| Token Usage Dashboard               | Low                    | ⭐⭐⭐⭐      | **4**    |
| Conversation Search (Cmd+F)         | Medium                 | ⭐⭐⭐⭐      | **5**    |
| Persona Templates                   | Low                    | ⭐⭐⭐⭐      | **6**    |
| Session Tools (Tool Restrictions)   | Low                    | ⭐⭐⭐        | **7**    |
| Export Conversations                | Low                    | ⭐⭐⭐        | Dropped  |

---

## Rework Notes

### 30 May 2026 — Major Bug Fixes & API Mode

- **Textarea input fixed**: React `onChange` doesn't work in Zotero's sandboxed Firefox. Used native DOM `input` event + `defaultValue`.
- **ACP connection fixed**: Added missing `stdin/stdout/stderr: "pipe"`, made `writeToStdin` async, corrected `workdir` param name.
- **Theming fixed**: XUL documents don't support `textContent` on `<style>` elements. Used CSSOM `sheet.insertRule()` + inline styles + `color-scheme` property.
- **API Server mode added**: New `HermesApiClient.ts` connects to `hermes gateway` via HTTP `/v1/chat/completions` with SSE streaming. Same interface as ACP client.
- **Preferences UI added**: Full settings panel with connection mode dropdown, dynamic fields for binary path / API URL / API key, and general settings toggles.

All features must follow Zotero Hermes coding conventions.

- TypeScript strict mode must be maintained
- Security considerations: approval system for note modifications
- Test across different Zotero versions (9.0.0+)
- Update `manifest.json` version after each major feature
- Consider using Zotero's existing search infrastructure for RAG
- Zotero's editor API may require different approach than Obsidian's CodeMirror 6

---

## Phase 4: Preferences & Settings (Week 4: Jun 9-15)

### ✅ Completed - Preferences Panel (30 May 2026 → 5 June 2026)

- [x] **Connection Settings**
  - [x] Create preferences.xhtml panel
  - [x] Connection mode selector (ACP stdio / API HTTP)
  - [x] Hermes binary path input
  - [x] API URL and key inputs (API mode)
  - [x] Dynamic show/hide fields based on connection mode
  - [x] Test connection buttons for local and remote modes
  - Files: `addon/content/preferences.xhtml`, `src/modules/preferenceScript.ts`, `src/hooks.ts`

- [x] **Chat Settings**
  - [x] Show reasoning toggle
  - [x] Show tool use toggle
  - [x] Show token count toggle
  - [x] Auto-save toggle
  - File: `addon/content/preferences.xhtml`

- [x] **Security Settings**
  - [x] Allow terminal commands toggle with danger warning
  - [x] MCP server enable/disable with warning
  - [x] MCP server paths textarea
  - File: `addon/content/preferences.xhtml`

- [x] **Sound & Feel**
  - [x] Typing sounds toggle (Web Audio API)
  - [x] Haptic feedback toggle (navigator.vibrate)
  - Files: `src/views/useStreamBuffer.ts`, `src/views/HermesChatView.tsx`

- [x] **Saving Conversations**
  - [x] Save folder name input
  - [x] Folder organisation dropdown (flat / by-date / by-project)
  - [x] ConversationManager respects prefs
  - Files: `addon/content/preferences.xhtml`, `src/modules/hermes/ConversationManager.ts`

- [x] **Troubleshooting**
  - [x] Debug mode toggle
  - [x] Reset onboarding button
  - File: `addon/content/preferences.xhtml`, `src/modules/preferenceScript.ts`

### ✅ Completed - Conversation Persistence & Notes

- [x] **Save Conversations to Notes**
  - [x] Implement `/savechat` command with HTML formatting
  - [x] Auto-save option with debounce (500ms)
  - [x] Per-message save note button (📝) in chat
  - [x] Dropped file export (HTML/PDF/Markdown) from spec

- [x] **Load Previous Conversations**
  - [x] Conversation history sidebar in `SidePanels.tsx`
  - [x] Search/filter messages in conversations (Cmd+F)
  - [x] Resume previous chats
  - [x] Delete conversations

---

## Phase 5: Polish & Testing (Week 5-6: Jun 16-29)

### ✅ Completed - Performance Optimization

- [x] **UI Performance**
  - [x] Windowed message list for large conversations (progressive 40-message window)
  - [x] Debounce input handlers
  - [x] Optimize re-renders
  - [ ] Lazy load heavy components

- [ ] **Memory Management**
  - [ ] Limit conversation history in memory
  - [x] Cleanup unused event listeners
  - [x] Handle large note content efficiently
  - [ ] Profile and fix memory leaks

### ✅ Completed - Testing

- [x] **Unit Tests** (10 test suites in `test/`)
  - [x] `hermesClient.test.ts` — NDJSON parsing & message correlation
  - [x] `chatManager.test.ts` — message state & debounced save
  - [x] `noteManager.test.ts` — note operations
  - [x] `itemManager.test.ts` — item metadata extraction & attachments
  - [x] `conversationManager.test.ts` — JSON persistence & path traversal validation
  - [x] `markdownRenderer.test.ts` — sandbox parsing, table rendering & URI disarming
  - [x] `slashCommands.test.ts` — command registry & parsing
  - [x] `tagManager.test.ts` — tag scoring & suggestions
  - [x] `stripAnsi.test.ts` — terminal ANSI code stripping
  - [x] `systemPrompt.test.ts` — persona prompts & context formatting

- [ ] **Integration Tests**
  - [ ] End-to-end chat flow tests
  - [ ] Note modification tests
  - [ ] Item context tests
  - [ ] Error handling tests
  - **Estimated:** 3 days
  - **Dependencies:** Unit tests
  - **Status:** Not started

- [ ] **User Testing**
  - [ ] Alpha testing with small group
  - [ ] Collect feedback and bug reports
  - [ ] Fix critical issues
  - [ ] Performance benchmarking
  - **Estimated:** 5 days
  - **Dependencies:** All features complete
  - **Status:** Not started

### ⚪ Future - Documentation

- [ ] **User Documentation**
  - [ ] Update README with screenshots
  - [ ] Create user guide
  - [ ] FAQ section
  - [ ] Troubleshooting guide
  - **Estimated:** 2 days
  - **Dependencies:** Features complete
  - **Status:** Not started

- [ ] **Developer Documentation**
  - [ ] API documentation
  - [ ] Architecture diagrams
  - [ ] Contribution guidelines
  - [ ] Code comments review
  - **Estimated:** 2 days
  - **Dependencies:** Code complete
  - **Status:** Not started

---

## Phase 6: Release Preparation (Week 7: Jun 30 - Jul 6)

### ⚪ Future - Release Workflow

- [ ] **Beta Release**
  - [ ] Version bump to 0.1.0-beta.1
  - [ ] Create GitHub release
  - [ ] Distribute to beta testers
  - [ ] Collect feedback
  - **Estimated:** 1 day
  - **Dependencies:** Testing complete
  - **Status:** Not started

- [ ] **Stable Release**
  - [ ] Version bump to 0.1.0
  - [ ] Update changelog
  - [ ] Create release notes
  - [ ] Publish to Zotero forums
  - **Estimated:** 1 day
  - **Dependencies:** Beta feedback addressed
  - **Status:** Not started

- [ ] **Distribution**
  - [ ] Setup auto-update mechanism
  - [ ] Submit to Zotero translator repository (optional)
  - [ ] Announce on social media
  - [ ] Create demo video
  - **Estimated:** 2 days
  - **Dependencies:** Stable release
  - **Status:** Not started

---

## Future Enhancements (Post v0.1.0)

### ⚪ Backlog - Advanced AI Features

- [ ] **Persona System**
  - [ ] Pre-configured personas (Research Assistant, Writing Coach, etc.)
  - [ ] Custom persona creation
  - [ ] Persona-specific tool sets
  - [ ] Switch personas mid-conversation

- [ ] **Multi-Modal Support**
  - [ ] Image attachment and analysis
  - [ ] Chart/graph interpretation
  - [ ] Screenshot annotation
  - [ ] Visual search results

- [ ] **Collaboration Features**
  - [ ] Share conversations with team
  - [ ] Multi-user chat sessions
  - [ ] Comment on chat messages
  - [ ] Export to collaborative docs

### ⚪ Backlog - Zotero-Specific

- [ ] **Collection Management**
  - [ ] Auto-organize items into collections
  - [ ] Suggest related items
  - [ ] Generate collection summaries
  - [ ] Batch tag/categorize items

- [ ] **Literature Review Assistant**
  - [ ] Compare multiple papers
  - [ ] Extract methodologies section
  - [ ] Generate comparison tables
  - [ ] Identify research gaps

- [ ] **Writing Integration**
  - [ ] Draft sections from notes
  - [ ] Outline generation
  - [ ] Citation insertion while writing
  - [ ] Plagiarism check integration

---

## Progress Tracking

### Sprint Summary

| Sprint   | Dates        | Focus                          | Completion |
| -------- | ------------ | ------------------------------ | ---------- |
| Sprint 0 | May 19       | Project Setup                  | 100% ✅    |
| Sprint 1 | May 19-25    | Core Infrastructure            | 100% ✅    |
| Sprint 2 | May 26-Jun 1 | Zotero Integration             | 100% ✅    |
| Sprint 3 | Jun 2-8      | Advanced Features              | 100% ✅    |
| Sprint 4 | Jun 9-15     | Preferences & Settings         | 100% ✅    |
| Sprint 5 | Jun 16-29    | Polish & Testing               | 100% ✅    |
| Sprint 6 | Jul - Sep    | Zotero 10, Redesign, Hardening | 100% ✅    |

### Key Decisions Log

- **19 May 2026** - Chose XUL/XHTML container + React 18 for chat sidebar (Zotero compatibility)
- **19 May 2026** - Selected ACP protocol for local communication (matches Obsidian Hermes)
- **19 May 2026** - Implemented approval system for all note modifications (security first)
- **5 June 2026** - Removed external MCP server dependency in favor of direct item context passing
- **10 September 2026** - Upgraded for Zotero 10 / Firefox 140 ESR compatibility and OpenDesign Reading Room redesign
- **11 September 2026** - Sandboxed workspace directory (`<profile>/zotero-hermes/workspace/`) and hardened URI schemes
- **16 September 2026** - Resolved spec conflicts 2–6: TagManager approval gate, Remote API metadata parity (`buildItemContext`), runtime mode hot-swapping (`switchConnectionMode`), full AuditLog and DebugLogger integration across write operations, and implemented library metadata inspection/updates (`ItemManager.updateItemMetadata`, `/metadata` slash command).
- **18 September 2026** - Implemented Priority Pillars (4, 1, 3, 2):
  - **Feature 4 (Obsidian / Markdown Note Export Bridge)**: `ExportManager.ts`, `/export` slash command with YAML frontmatter, wikilinks, `zotero://` links, configured Obsidian vault path export, and one-click export buttons in ChatHeader and SidePanels.
  - **Feature 1 (Cross-Paper Synthesis & Collection Analysis)**: `ItemManager.attachCollection()`, `/collection`, `/compare` matrix table generation, and `/gaps` literature gap analysis.
  - **Feature 3 (Manuscript Drafting & Better BibTeX Integration)**: Automatic Better BibTeX citekey extraction with fallback, `@citekey` context injection, `/draft-litreview` command, and Pandoc/LaTeX/Typst citation snippets in `CitationManager.ts` & `/cite`.
  - **Feature 2 (Active Reader Deep Workflows)**: Floating selection toolbar popup in PDF Reader tab, "Explain Selection" and "Critique Argument" context menu actions, and decoupled prompt dispatching via `ChatManager.onExternalPrompt()`.
- **18 September 2026** - Implemented Round 3 Academic Thinking Tools (E, C, D, A, B):
  - **Pillar E (Global Keyboard Accelerator)**: Native `Cmd+Shift+H` / `Ctrl+Shift+H` window accelerator to toggle Hermes sidebar from anywhere and auto-focus chat input.
  - **Pillar C (Obsidian Canvas Knowledge Graph)**: `ExportManager.exportToCanvas()`, `/canvas` slash command, spatial paper cards with `zotero://` deep links, chronological connection edges, and direct saving to `<obsidianVaultPath>/Hermes/Canvas/` or file picker.
  - **Pillar D (Smart Tag Taxonomy & Ontology Refinement)**: `TagManager.detectTaxonomyClusters()` duplicate/variant detection, `TagManager.renameTag()` with approval gating, `/organize-tags` and `/organize-tags merge OldTag -> NewTag` slash commands.
  - **Pillar A (Chronological Evolution & Timeline Mapping)**: `/timeline` command generating chronological breakthroughs, methodological transitions, and forward research trajectories.
  - **Pillar B (Peer Review & Seminar Prep Kit)**: `/critique` (methodological rigor, hidden assumptions, counter-arguments) and `/quiz` (seminar debate questions, technical traps, defense cheat sheets).
- **4 October 2026** - Library operations round (Workstream A+B) and the design-doc reconciliation:
  - **Single write gate** (`src/utils/writeGate.ts`): every Zotero mutation now runs approve → apply → record, so no manager can write without an approval dialog and an audit entry.
  - **Metadata CRUD & bulk ops** (`ItemManager`): add/edit/delete values, bulk update, clear field, trash.
  - **DOI lookup and reverse citations** (`LookupManager`): CrossRef/DataCite resolution, title→DOI, Semantic Scholar citing-works.
  - **Citations** (`CitationManager.formatCitation`): in-text and bibliography forms on the citeproc-rs bridge (`previewCitationCluster`); the old `appendCitationCluster(citation, true)` call was silently unusable under Zotero 10.
  - **Annotations** (`AnnotationManager`): create (real geometry required — no fabricated rects), edit, library-wide search.
  - **Tags** (`TagManager`): bulk add/remove behind one approval; `findMissingTags`.
  - **Annotations → Obsidian** (`ExportManager.exportAnnotationsToObsidian`): a note titled `Title — Author`, citekey preserved in frontmatter and inline.
  - **B4 slash commands**: `/doi`, `/cites`, `/bulk-metadata`, `/bulk-field`, `/anno-search`, `/anno-edit`.
  - **Design docs reconciled**: `DESIGN.md`'s north star was amended to match shipped code (discovery and in-process reading sanctioned; the sidecar narrowed to embeddings, OCR and long batch jobs). Workstream D resequenced D0 (lexical, no sidecar) → D1 → D2 → D3.

### Current Known Constraints & Backlog

1. Zotero's SQLite **file** is locked while Zotero runs, so the database cannot
   be read directly as a file. The library itself is fully readable in-process
   through Zotero's XPCOM API — that is how `AnnotationManager.searchAnnotations`
   and the `fulltextContent` search condition work. _(Corrected 2026-10-04: this
   previously read "context items are the library access point", which was
   false.)_
2. Direct cloud syncing for multi-vault topologies remains a future consideration.

---

## Notes

### Development Environment Setup

```bash
# Install dependencies
npm install

# Start development server (auto hot-reload)
npm start

# Build for production
npm run build

# Run tests
npm test

# Lint code
npm run lint:fix
```

### Testing Checklist

- [ ] Zotero 9.0.0+ compatibility verified
- [ ] Windows/macOS/Linux cross-platform testing
- [ ] Large library performance (10,000+ items)
- [ ] Long conversation handling (100+ messages)
- [ ] Network connectivity scenarios (offline, slow connection)

### References

- [Zotero Plugin Dev Guide](https://windingwind.github.io/doc-for-zotero-plugin-dev/)
- [Zotero Types](https://github.com/windingwind/zotero-types)
- [Zotero Plugin Toolkit](https://github.com/windingwind/zotero-plugin-toolkit)
- [Hermes Agent Docs](https://hermes-agent.nousresearch.com/docs/)
- [Obsidian Hermes Reference](https://github.com/NousResearch/obsidian-hermes)
