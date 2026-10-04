# PRODUCT — Hermes Agent for Zotero

**Product intent.** What this plugin is for, who it serves, and what it is
not. This is the product north star; DESIGN.md is the design north star.

## One-Line Product Statement

A Zotero plugin that puts the Hermes Agent in a sidebar conversation with
the researcher's own library — attach items, ask questions, get answers
grounded in the actual metadata, notes, annotations, and tags.

## Who It Serves

- **Researchers** using Zotero as their reference manager who want an AI
  assistant that already knows their library.
- **Academics** who need citations, bibliographies, and tag organisation
  without leaving Zotero.
- **Hermes Agent users** who want the same assistant in their research
  workflow as in their terminal.

## What It Is NOT

- **Not a general chat client.** The agent's context is the Zotero library.
- **Not a replacement for Zotero's own search.** The plugin complements it
  with conversational access.
- **Not a cloud service.** Local by default; API mode is opt-in.

## Core Value Propositions

1. **Zero context-switching** — ask about a paper while looking at it.
2. **Grounded answers** — the agent answers from attached item metadata, not
   hallucinated database access.
3. **Library operations in conversation** — `/cite`, `/tag`, `/annotations`,
   `/savechat` turn the chat into a library tool.
4. **Local-first** — ACP/stdio mode keeps data on the machine.

## Feature Inventory (current)

| Feature                                 | Status                                 |
| --------------------------------------- | -------------------------------------- |
| AI chat sidebar (React)                 | ✅ Working (restored 2026-08-11)       |
| Attach selected items as context        | ✅ (Includes annotations, notes, text) |
| Dual connection (ACP stdio / API SSE)   | ✅                                     |
| Note save (`/savechat`, per-message 📝) | ✅                                     |
| PDF annotations (`/annotations`)        | ✅                                     |
| Citations (`/cite [style]`)             | ✅                                     |
| Tag suggestions (`/tag`)                | ✅                                     |
| Item metadata updates (`/metadata`)     | ✅ (gated via approval dialog)         |
| Conversation branching (first-class)    | ✅ (`< 1 / 2 >` branch switcher)       |
| Interactive action pills                | ✅ (`action:`, `apply-tag:`, etc.)     |
| Cmd+F message search                    | ✅                                     |
| Token dashboard                         | ✅                                     |
| Persona switcher (`/persona`)           | ✅                                     |
| Terminal output gating                  | ✅ (behind `allowTerminal` pref)       |
| Terminal abort button                   | ✅                                     |
| Windowed message list rendering         | ✅ (progressive windowing)             |
| Reader tab & selection awareness        | ✅                                     |
| DOI lookup (`/doi`, CrossRef/DataCite)  | ✅                                     |
| Reverse citations (`/cites`)            | ✅ (Semantic Scholar)                  |
| Bulk metadata edit (`/bulk-metadata`)   | ✅ (gated, per approval)               |
| Annotation search (`/anno-search`)      | ✅ (library-wide)                      |
| Annotation edit (`/anno-edit`)          | ✅ (gated)                             |
| Annotations → Obsidian note             | ✅ (`Title — Author`)                  |

## Roadmap (validated against user intent)

The roadmap below is the _user's_ intent, not an agent-generated feature
wishlist. It is deliberately small and focused on the research workflow.

1. **Stability** — real-world testing and bug fixes.
2. **Collection-level synthesis** — batch reasoning across entire collections.
3. **Dedicated Reader tab sidebar panel** — embedded viewport alongside PDF.

## Success Metrics

- The plugin loads without errors in Zotero 9 and 10.
- A user can attach an item, ask a question, and get a grounded answer.
- All write operations (notes, annotations, tags, metadata) require approval and are logged.
- No user-specific paths or secrets in the codebase.
