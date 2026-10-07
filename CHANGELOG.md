# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- **Scoped Hermes profile (`profileName` preference).** The ACP session could
  only ever run as the user's **default** Hermes profile, because the spawned
  child inherits `HERMES_HOME`. Every sidebar conversation therefore carried the
  user's personal SOUL.md and MEMORY.md into a research-library context, and
  composed a ~70 KB system prompt. A new **Hermes Profile** field (Local mode)
  spawns `hermes -p <name> acp` instead, so the conversation runs with that
  profile's own persona, memory, and skills.
  - `src/modules/hermes/HermesProfile.ts` — profile resolution and the CLI
    argument builder. A name is only passed through when it is well-formed
    (lowercase alphanumerics, `-`, `_` — no path traversal, no shell-shaped
    input) **and** exists as a directory under `~/.hermes/profiles/<name>/`.
  - `resolveConfiguredProfile()` returns an explicit three-way outcome —
    `{kind: "profile"}`, `{kind: "default"}`, or `{kind: "invalid"}` — so
    "nothing was requested" can never be confused with "something was requested
    and is broken". `HermesClient.connect()` now **throws** on `invalid` instead
    of falling back to the default profile with a log line: `hermes -p
<missing> acp` exits immediately, so a stale or mistyped preference must
    never reach the argv — but substituting the default profile for a profile
    the user asked for discloses the personal memory this feature exists to
    scope away, and logging does not undo a disclosure.
  - `isDirectoryLike()` — the directory check tolerates both `nsIFile` shapes
    (a boolean property _and_ a method). The live Zotero 10 sandbox returns a
    **method**, contradicting the property form recorded in AGENTS.md;
    tolerance matters because reading a method as a bare property is always
    truthy and would accept regular files as directories.
  - `describeProfileProblem()` — returns `null` when the setting is usable or
    intentionally blank, otherwise a message naming the requested profile and
    the exact `hermes profile create <name>` recovery command. Shared by the
    preferences Test Connection button and the client, so both report the same
    reason.
  - 29 new unit tests (260 total, all passing) covering name validation,
    existence gating, the file-vs-directory distinction, the
    requested-but-broken vs intentionally-blank distinction, and the emitted
    argv.

### Fixed

- **Test Connection no longer reports success for a profile the live session is
  not using.** When a stdio client was already connected, the button skipped
  `connect()` entirely — so it validated the profile _directory_ on disk and
  reported success while the running ACP session still used the previous
  profile. A green tick for a scope that is not in force. It now reconnects so
  the session adopts the selected profile, and the success message names the
  profile actually in effect.
- **A deliberately cleared profile field is honoured.** The field was read with
  `profileInput?.value?.trim() || getHermesProfileName()`, so an empty string
  fell through to the saved name: clearing the field and pressing Test
  Connection tested the _old_ profile while the visible field requested the
  default. The input now wins whenever it is present, blank included.

### Changed

- `PreferencesManager.getHermesProfileName()` / `setHermesProfileName()` and the
  `Hermes Profile` preferences field. The Test Connection button now also
  validates the configured profile and reports the exact
  `hermes profile create <name>` command when it is missing.
- `resolveHermesProfile()` is retained and still returns `string | null`; it is
  now a thin wrapper over `resolveConfiguredProfile()` for callers that only
  need the name.
- Dependabot now groups `react`/`react-dom`/`@types/react`/`@types/react-dom`
  together. They span `dependencies` and `devDependencies`, so Dependabot split
  them into separate PRs (#19, #21) and each failed alone on peer resolution —
  bumping `react` to 19 needs `@types/react@19` while the branch still carried
  `@types/react-dom@18`, which peers on `@types/react@^18`.
- README and ARCHITECTURE security notes updated for profile scoping.

## [0.4.0] — 2026-10-04

### Added

- **Library operations round (Workstream A+B).** Metadata CRUD, DOI lookup,
  reverse-citation lookup, clear citations, bulk tags, and annotation
  create/edit/search — all routed through one approval + audit gate.
  - **B4 — slash commands for the whole round.** `/doi` (resolve a DOI, or find
    one from the attached item's title via CrossRef), `/cites` (which works cite
    the attached item — Semantic Scholar, marking hits already in the library),
    `/bulk-metadata` (edit a field across a collection), `/bulk-field` (same
    across attached items), `/anno-search` (library-wide annotation search), and
    `/anno-edit` (edit an annotation's comment/colour/text/page). The
    `field=value` argument parser is now shared with `/metadata` rather than
    duplicated per command.
  - `src/utils/writeGate.ts` — a single write path for every Zotero mutation:
    approve → apply → record. Before this, each manager invented its own
    mutation path, so some writes logged an audit entry and some did not.
    Bulk work made that inconsistency a safety problem.
  - `src/modules/hermes/LookupManager.ts` — CrossRef/DataCite DOI resolution
    and title→DOI lookup; Semantic Scholar reverse citations (DOI → citing
    works).
  - `ItemManager` — add/edit/delete metadata values, bulk update, clear field,
    trash. Protected fields are enforced _before_ alias mapping.
  - `TagManager` — bulk add/remove behind one approval; `findMissingTags`.
  - `AnnotationManager` — create, edit and library-wide search.
  - `CitationManager` — `formatCitation` returns in-text and bibliography
    forms with the resolved style.
  - `ExportManager.exportAnnotationsToObsidian` — export an item's PDF
    annotations as a standalone Obsidian note titled **`Title — Author`**
    (B3). The citekey is deliberately _not_ the note name: it is a citation
    handle, not a filing name, and it changes when Better BibTeX re-pins. It
    is recorded in frontmatter (`citekey:`, plus an `aliases:` entry so
    search-by-citekey still resolves the note) and cited inline in the body.
    Highlights render as blockquotes; `note`/`text` annotations render as
    prose, because they are the reader's own thinking rather than source
    text. Annotations are grouped by page. Re-export refuses to overwrite a
    note that differs from current output unless explicitly told to —
    a note in the vault may carry hand edits.

### Fixed

- **Citation generation was silently dead**: `CitationManager` called
  `appendCitationCluster(citation, true)` and expected the citeproc-js
  `[[id, string], …]` return shape. Zotero 10 uses the citeproc-rs bridge,
  whose `appendCitationCluster(citation)` takes **one** argument and returns a
  differently-shaped object. Rewritten on `previewCitationCluster(citation,
[], [], format)` — Zotero's own idiom (`quickCopy.js:287`, `cite.js:205`) —
  and the engine is `free()`d after use.
- **`AnnotationManager` fabricated a highlight position**: when no position was
  supplied it wrote `rects: [[0,0,100,20]]`, placing a highlight at a location
  that does not exist. It now refuses rather than inventing geometry.
- **`updateItemMetadata` protected-field check was bypassable**: the alias map
  ran before the guard, so an aliased protected field could slip through.
- **Approval dialogs hid which item was being changed**: bulk tag operations
  showed `Add tags — 3 item(s)`. The target now names the items, so the user
  can see what they are approving.
- **`getStyleByIDOrName` returned the caller's raw string** instead of the
  style's canonical `styleID`, which is wrong whenever Zotero maps a renamed
  style.
- **Every Zotero directory silently failed to resolve**: Zotero 10 changed
  `Zotero.Profile.dir` and `Zotero.DataDirectory.dir` from `nsIFile` objects
  to **plain strings**. The plugin picked `Profile.dir` first and called
  `.clone()` on it — `TypeError: p.clone is not a function` — which silently
  disabled conversation persistence, the audit log, the agent workspace
  directory and local export. Resolution now goes through a shared
  `src/utils/zoteroPaths.ts` helper that converts the string via
  `Zotero.File.pathToFile()` (and still tolerates an `nsIFile`).
- **Child-note titles were always dropped**: `extractItemData` discarded a
  note title whenever it was a prefix of the note body. Zotero derives a
  note's title from its first line, so that is the normal case — the
  condition was inverted and every note arrived as `title: undefined`.
- **`TagManager.renameTag` crashed on real libraries**: it calls
  `.filter()` on `Zotero.Items.getAsync(itemIDs)`, which is correct (an
  array in, an array out), but the test stub returned a bare object — so the
  code path was never exercised. The stub now models the real contract.
- **The sidebar opened into a collapsed pane**: the Hermes pane is mounted
  inside `#zotero-item-pane`, and a collapsed item pane is hard-clamped by
  Zotero to 37px. The sidebar therefore rendered as a thin sliver while every
  plugin-side step still reported success. The pane is now expanded before
  mounting and the user's collapse state is restored on close.
- **The slash-command popup rendered across the window titlebar**:
  `.hermes-slash-dropdown` is `position: absolute; bottom: 100%`, but its
  wrapper declared no `position`, so the dropdown anchored to the XUL
  `item-pane` instead of the input area and positioned itself above it.
- **Slash-command rows overflowed into each other**: Zotero's main-window
  stylesheet applies an unqualified `button { max-height: 25px }` to every
  button, clamping each row while its wrapped description needed up to 60px.
  Measured live at `offsetHeight` 25 before the reset.

### Notes

- **OCR is not available through the plugin API.** A grep for an OCR surface
  across the extracted Zotero 10.0.5 tree hits one file,
  `xpcom/recognizeDocument.js`, and `Zotero.OCR` is not assigned anywhere.
  `Zotero.RecognizeDocument` is _metadata_ recognition: it requires an
  existing text layer and POSTs the document to a remote Zotero service.
  Scanned-item OCR needs its own spike (an external engine writing a text
  layer back into the attachment) and is not promised here.

## [0.3.4] — 2026-10-04

### Fixed

- **"Ask Hermes About Item" failed silently**: the entry was appended
  directly to `#zotero-itemmenu`. Zotero 10 builds that popup itself and
  hides every child it does not own, so the item was never shown and the
  command never fired. Re-registered through Zotero's supported
  `Zotero.MenuManager.registerMenu({ target: "main/library/item" })` API.
- **Item context menu now answers from metadata**: clicking the entry
  builds `ContextItem`s from the selected items and sends them with the
  prompt, so answers stay grounded in the item's metadata rather than
  relying on the model knowing the title.
- **Reader selection actions were dead**: `Zotero.Reader` has no
  `getReader()` method and `ReaderInstance` has no `getSelectedText()`
  (verified against Zotero 10.0.5). Selection is now read from the
  reader's `_iframeWindow` Selection.
- **Reader popup/context menus never rendered**: the
  `renderTextSelectionPopup` handler destructured `{ reader, doc, popup }`
  and called `popup.appendChild()`; Zotero dispatches these as a
  `CustomEvent` with `{ reader, doc, append, params }` and requires
  `append(...)`. The handler now uses the real API. A
  `createViewContextMenu` handler was added because
  `renderTextSelectionPopup` only fires for existing annotations, not for
  a fresh text selection.
- **Item context menu could not be unregistered**: `registerMenu`
  returns the _namespaced_ key (`CSS.escape(pluginID + "-" + menuID)`),
  so `unregisterMenu` was being called with the bare `menuID` and never
  matched. The returned key is now stored and used on shutdown.
- **Menu opened the sidebar but the prompt never appeared**: the
  dispatch was deferred with a fixed 200 ms timer, but React 18's
  `createRoot().render()` is asynchronous — the timer could fire before
  `HermesChatView`'s `onExternalPrompt` subscription effect ran, and an
  empty listener set silently dropped the prompt. `ChatManager` now
  buffers prompts dispatched with no subscriber (capped at 20) and
  replays them on the first subscription; the hand-off is synchronous
  and no longer depends on a delay racing the mount.

## [0.3.3] — 2026-09-18

### Added

- **Global Keyboard Accelerator (Pillar E)**:
  - Added native `Cmd+Shift+H` (macOS) / `Ctrl+Shift+H` (Windows/Linux) window accelerator to toggle the Hermes sidebar from anywhere in Zotero.
  - Automatically focuses the chat input upon opening.
  - Clean event listener registration and teardown on window unload/addon shutdown.
- **Obsidian Canvas & Knowledge Graph Generator (Pillar C)**:
  - Added `ExportManager.exportToCanvas()`: Converts conversation and attached papers into a spatial Obsidian Canvas (`.canvas`) JSON graph.
  - Places paper cards in structured grid layouts with deep `zotero://` links, citekeys, and abstract excerpts, and connects chronological predecessor/successor edges.
  - Added `/canvas [filename]` slash command and dedicated `CanvasIcon` export button in `ChatHeader`.
  - Saves directly to `<obsidianVaultPath>/Hermes/Canvas/<filename>.canvas` or prompts via `nsIFilePicker`.
- **Smart Tag Taxonomy & Ontology Refinement (Pillar D)**:
  - Added `TagManager.detectTaxonomyClusters()`: Normalizes tags, identifies casing/punctuation duplicates, and extracts hierarchical category trees.
  - Added `TagManager.renameTag()`: Merges and renames tags across items with user approval gating (`ApprovalDialog`) and `AuditLog` records.
  - Added `/organize-tags` and `/organize-tags merge OldTag -> NewTag` slash commands.
- **Chronological Literature Evolution & Timeline Mapping (Pillar A)**:
  - Added `/timeline` slash command: Analyzes attached items/collections chronologically, tracing breakthroughs, methodological transitions, and current research frontiers.
- **Peer Review & Seminar Prep Kit (Pillar B)**:
  - Added `/critique` slash command: Executes rigorous academic peer-review stress-testing on assumptions, confounding variables, and threats to internal/external validity.
  - Added `/quiz` slash command: Generates provocative seminar discussion questions, technical trap questions, and defense cheat sheets.

## [0.3.2] — 2026-09-18

### Added

- **Obsidian & Markdown Note Export Bridge (Feature 4)**:
  - `ExportManager` formats conversations into clean Markdown with YAML frontmatter, wikilinks, and `zotero://` deep links.
  - Configurable `obsidianVaultPath` setting to export directly to `<vaultPath>/Hermes/<Title>.md`.
  - Slash command `/export` with support for Obsidian, file picker fallback, and Zotero rich note creation (`/export note`).
  - One-click export button in `ChatHeader` and conversation history list (`SidePanels`).
- **Cross-Paper Synthesis & Collection Analysis (Feature 1)**:
  - `ItemManager.attachCollection()` and `/collection [limit]` command to load all top-level items from the active collection into context.
  - `/compare` slash command: builds structured Markdown comparison matrix tables comparing research focus, methodology/dataset, findings, and limitations.
  - `/gaps` slash command: analyzes attached literature to extract unaddressed questions, empirical blind spots, and future research agendas.
  - Updated `systemPrompt.ts` with explicit multi-paper comparative synthesis guidelines.
- **Manuscript Drafting & Better BibTeX Integration (Feature 3)**:
  - Better BibTeX citekey extraction across BBT KeyManager, extra fields, and author-year fallbacks.
  - Added `@citekey` context injection for academic citation grounding.
  - `/draft-litreview` slash command: generates thematic publication-ready prose with `@citekey` citations.
  - Enhanced `/cite` slash command with Pandoc (`[@citekey]`), LaTeX (`\cite{citekey}`), and Typst (`@citekey`) drafting snippets.
- **Active Reader Deep Workflows (Feature 2)**:
  - Registered PDF reader context menu actions: "Explain Selection with Hermes" and "Critique Argument with Hermes".
  - Floating `⚡ Hermes` action button on the PDF reader text selection popup.
  - Decoupled prompt dispatching through `ChatManager.onExternalPrompt()` to seamlessly activate the sidebar and stream answers on selection.

## [0.3.1] — 2026-09-11

### Security

- **Sandbox escape mitigations** in markdown parsing and link delegation:
  - Disarmed dangerous URI schemes (`javascript:`, `file:`, `chrome:`, `data:`) in `MarkdownRenderer`, rendering them as inert text and guarding anchor rendering.
  - Added support for nested parentheses in markdown link URLs (e.g. Wikipedia disambiguation, JS function calls).
  - Added explicit `e.preventDefault()` fallback for any unhandled URI schemes in `HermesChatView` to prevent Gecko chrome-level execution.
- **Workspace sandboxing & database protection**:
  - Sandboxed Hermes ACP agent session `cwd` and `workdir` to `<profile>/zotero-hermes/workspace/` (isolated from `zotero.sqlite`).
  - Disabled ACP filesystem client capabilities (`readTextFile: false, writeTextFile: false`).
- **Path traversal prevention**:
  - Enforced strict ID regex (`/^[a-zA-Z0-9_-]+$/`) across all `ConversationManager` file access methods (`getConversationFile`, `saveConversation`, `loadConversationFromFile`, `deleteConversation`).
- **Dialog deadlock fix**:
  - Added native `cancel` and `close` listeners with settled guard to `ApprovalDialog` so pressing `Escape` resolves cleanly rather than deadlocking the approval queue.

### Fixed

- **Process spawn mutex**: Added `connectPromise` mutex in `HermesClient` to prevent concurrent calls from spawning multiple `hermes acp` child processes.
- **Cross-conversation stream bleeding**: Added `abortActiveStream()` and buffer clearing on chat switch, creation, or deletion; dropped reasoning chunks targeted at inactive conversations.
- **Debounced save race**: Captured target conversation ID in `ChatManager.scheduleSave()` to prevent delayed debounced writes from clobbering switched chats.
- **Duplicate SSE stop events**: Added `stopEmitted` guard in `HermesApiClient` to prevent spurious duplicate stop notifications from finally blocks.
- **Context synchronization**: Added `removeAttachedItem()` to `ItemManager` and wired `ContextBar.onRemoveItem` to keep UI context pills and internal item tracking synchronized.
- **Multi-window teardown**: Replaced global single-toolkit reference with a per-window `WeakMap<Window, any>` in `hooks.ts` to prevent window close from disrupting other open windows.

## [0.3.0] — 2026-09-10

### Added

- **OpenDesign redesign** — "Reading Room" design language across the chat view:
  - New typography system with bundled fonts (Source Sans 3, Source Serif 4, Source Code Pro)
  - Redesigned input area: auto-growing textarea (up to 6 lines, then scroll), centred send button, symmetric padding, cursor breathing room
  - Header matched to Zotero's native toolbar height (40px) and padding
  - Updated sidebar, preferences, and pane styles to the new design tokens
- **Identity correction** — plugin now ships as `hermes@techne-tools.org` (was `hermes@nousresearch.com`); author/homepage/bugs updated to the techne-tools org

### Changed

- Input area: textarea auto-grows with content; send button fixed height, vertically centred
- Header: `min-height` 44px → 40px, vertical padding removed to match Zotero toolbar
- Theme tokens: dark/light palette refined (accent `#0b6b54`/`#45be97`, muted text, input backgrounds)

### Fixed

- Duplicate icon import in `MessageList.tsx` (build failure)
- Stale Nous Research branding in manifest, package metadata, and docs

## [0.2.0] — 2026-09-08

### Added

- Zotero 10 compatibility (Mozilla 140 ESR): `strict_max_version` → `10.*`, esbuild target `firefox140`
- Toolkit 5.2.0 migration (`ZoteroToolkit` subpath import)

### Fixed

- `NoteManager.getAsync` return type widened for zotero-types 4.1.3
- Chai error serialization in test reporter (scaffold 0.9.2)
