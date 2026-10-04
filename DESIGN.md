# DESIGN — Hermes Agent for Zotero

**Design north star.** This document is the target state for the plugin's
design. When code and this document disagree, flag the conflict — do not
silently pick a side.

## North Star

**The plugin's job is not storing chat history. It is making the user's
research library answer back.** Every design decision is measured against
this: does it put the researcher in a conversation with their own library,
with zero context-switching?

## Design Principles

1. **Zotero-first context.** The agent answers from the user's actual
   library — attached items, notes, annotations, tags, and full text — never
   from hallucinated database access. Two access modes are sanctioned:
   - **Context** — attached items are described in the prompt. Zero cost, and
     the primary path.
   - **Discovery** — the plugin may read the library in-process through
     Zotero's own XPCOM API, and may query external bibliographic services
     (CrossRef, DataCite, Semantic Scholar) for metadata the library does not
     contain. Discovery is sanctioned; _invention_ is not. Anything the agent
     states about the library must trace to a read that actually happened.
     Verified 2026-10-04: `Zotero.Search` exposes a `fulltextContent` condition
     backed by a real full-text implementation (`searchConditions.js:793`,
     `search.js:677-696`), so whole-library lexical search needs no sidecar.
     Heavier capability — embeddings, OCR, unattended batch work — belongs to
     the sidecar (see **Sidecar Boundary**).
2. **Local by default.** ACP/stdio mode spawns the local `hermes` binary.
   The user's data stays on their machine. API mode is opt-in for remote
   gateways.
3. **Sandbox-aware.** The plugin runs in Zotero's Firefox 140 ESR sandbox
   (Zotero 10; was 115 ESR under Zotero 9). React synthetic events are
   unreliable; all interaction uses native `addEventListener` via refs. No
   `dangerouslySetInnerHTML`, no `DOMParser`.
4. **Human-in-the-loop for writes.** Note creation, annotation writes, and
   tag application route through `ApprovalDialog`. The agent proposes; the
   user disposes.
5. **Fail visibly, never silently.** Connection errors, send failures, and
   approval rejections surface as user-facing messages. Debug logging is
   gated behind a preference.

## Component Architecture

```
HermesChatView (state + orchestration)
├── ChatHeader        — toolbar: search, conversations, attach, new, settings
├── SidePanels        — conversation list, search bar, session settings, onboarding
├── MessageList       — message list + typing indicator + error bar
│   └── ChatMessageItem — per-message: copy, save-note, edit, collapsible reasoning/tool, terminal abort
├── ContextBar        — attached item chips
├── InputArea         — textarea + send/stop button + slash dropdown
└── TokenDashboard    — usage footer
```

## State Model

- **Messages** — `ChatMessage[]` in React state, mirrored in `stateRef` for
  native callbacks, persisted via `ChatManager` (debounced 500ms) to
  `ConversationManager` JSON files.
- **Streaming** — `useStreamBuffer` collects chunks in refs and flushes via
  `setTimeout(50ms)`; reasoning messages are spliced before the assistant
  message.
- **Typing safety** — a 60s timeout restarts on every non-terminal update and
  clears on `stop`/`usage`/`session_info`/`error`. Prevents a stuck
  "Hermes is thinking".

## Security Model

- **Subprocess** — the `hermes` binary is spawned directly with an argument
  array (no shell), so a configured path with metacharacters cannot inject
  commands.
- **Approval & Audit** — all Zotero writes (notes, annotations, tags,
  metadata) require user approval via `ApprovalDialog`, serialised through a
  queue, and record persistent entries in `AuditLog`.
- **Terminal gating** — `terminal_output` updates are blocked unless the
  `allowTerminal` preference is enabled.
- **Secrets** — credentials (API keys for Semantic Scholar or any future
  service) live in the vault, never in Zotero prefs and never in the audit
  log. _(Corrected 2026-10-04: this section previously placed the API key in
  Zotero prefs, which contradicts the vault decision and would have put a
  secret in a world-readable profile.)_
- **No hardcoded paths** — Zotero data/profile directories are resolved at
  runtime; no user-specific paths in source.

## Known Constraints

- **SQLite is locked to the plugin, but the library is not.** Zotero holds an
  exclusive lock on `zotero.sqlite` while it runs, so opening the database
  file directly is not possible — and never was the right approach. Zotero's
  own XPCOM API is fully available in-process and is how the plugin reads the
  library. _(Corrected 2026-10-04: this section previously stated "context
  items are the only library access", which was false — `searchAnnotations`
  and the `fulltextContent` search condition both read the library directly,
  and the live-runtime tests exercise that path.)_
- PDF content extraction requires the PDF to be in Zotero storage.
- Large conversations may benefit from virtualized scrolling (not yet
  implemented).

## Sidecar Boundary

The sidecar is an **additive** component, not a precondition for reading the
library. It exists for capability the plugin genuinely cannot host:

| Belongs in the plugin (in-process)           | Belongs in the sidecar                       |
| -------------------------------------------- | -------------------------------------------- |
| Reading items, notes, annotations, tags      | Embedding generation / vector index          |
| Lexical full-text search (`fulltextContent`) | Semantic (meaning-based) retrieval           |
| Bibliographic lookup (CrossRef/DataCite/S2)  | OCR for scanned PDFs with no text layer      |
| Single-item writes behind `ApprovalDialog`   | Long unattended batch jobs (progress/resume) |

Two rules keep the boundary honest:

1. **Nothing that works in-process moves to the sidecar** to satisfy an
   architectural preference. A daemon has a cost — startup, lifecycle, a
   failure mode — and that cost must buy capability, not tidiness.
2. **The plugin stays useful with the sidecar absent.** If a feature cannot
   degrade gracefully when the sidecar is not running, it is in the wrong
   tier.

## Open Questions

1. **Conversation branching** — editing a user message truncates history and
   re-sends. Should branches be first-class (multiple parallel branches per
   conversation)?
2. **Virtualized scrolling** — needed for very large conversations. Priority
   is low until real-world usage demands it.
