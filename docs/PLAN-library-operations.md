# PLAN — Library Operations (v0.4.0)

**Status:** in progress · **Branch:** `feat/library-operations`
**Base:** `6bfba6d` on `main` · **Created:** 2026-10-04

## Decisions taken (operator, 2026-10-04)

| Decision          | Choice                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool architecture | **Sidecar MCP server** — plugin serves Zotero tools over localhost; the agent acts on the library autonomously. Unlocks RAG, batch jobs, OCR, summarise-to-annotations. |
| RAG substrate     | **`Zotero.FullText` + citation graph** — FTS5 chunks Zotero already indexes, cite by item/attachment/page. No vector store, no API cost, deterministic.                 |
| First workstream  | **Group A+B (items 1–8)** — no new architecture, fully testable.                                                                                                        |

## Architectural pivot (supersedes the MCP-removal decision)

Two commits back, MCP was removed from this plugin: `HermesClient.ts` sends
`mcpServers: []` and `systemPrompt.ts` instructs the agent that no tools exist.
The operator has now chosen the opposite. Evidence that the premise has changed:

- Hermes's ACP adapter **honours per-session MCP servers** and rebuilds the
  agent tool surface: `acp_adapter/server.py:616` `new_session` →
  `_register_session_mcp_servers()` (`:427`) → `register_mcp_servers(configs)`
  → `agent.tools = get_tool_definitions(...)`. Stdio config shape is built at
  `server.py:170` (`_mcp_server_config`: `{command, args, env}`).
- Zotero can host the server: `Zotero.Server.Endpoints` is a plugin-extensible
  HTTP registry (`xpcom/server/server.js:345-350`, registry `:666`,
  `supportedMethods` `:407`). Port 23119 is already open.
- Zotero can spawn a process: `Zotero.Utilities.Internal.subprocess()`
  (`xpcom/utilities_internal.js:709`; used internally at `zotero.js:1683`).

**Consequence:** the agent stops talking _about_ a metadata blob and starts
_operating on_ the library. Items 1–8 are written as **clean methods on the
managers** so the eventual MCP tool layer wraps them rather than duplicating
them.

> **CONFLICT FLAG — DESIGN.md.** `DESIGN.md` states as a design principle
> "Metadata is provided in context, **not discovered**", and lists as a Known
> Constraint "the agent cannot read it [SQLite] directly; context items are the
> only library access". The sidecar decision contradicts both. Per the repo's
> conflict rule this is flagged, not silently resolved. Revising DESIGN.md's
> North Star is the operator's call and is **not** done in this workstream.

## Non-negotiables carried over

- Every Zotero write routes through `ApprovalDialog` and records an `AuditLog`
  entry (`DESIGN.md` §Security Model). New write paths must honour this.
- Fleet invariant: **never delete.** Destructive operations are "trash, with an
  explicit operator call" — no `eraseTx` on user data.
- Failure mode is **fail visibly, never silently**.
- Verification gates are run with the checker's **own scope** (see
  `.agent/skills/zotero-ops/SKILL.md`).

## Workstream A — Metadata, DOI, citations

| Item | Deliverable                                                                                          | Module                              |
| ---- | ---------------------------------------------------------------------------------------------------- | ----------------------------------- |
| A1   | Add / edit / delete metadata values, single and bulk. Destructive = trash only.                      | `ItemManager`                       |
| A2   | DOI retrieve + update via CrossRef/DataCite, `Zotero.Translate.Search` fallback                      | `ItemManager` + new `LookupManager` |
| A3   | Reverse citation lookup (DOI → citing works) via Semantic Scholar                                    | `LookupManager`                     |
| A4   | Clear citations: APA 7 default, in-text vs bibliography, copy/export                                 | `CitationManager`                   |
| A5   | Metadata lint + triage: missing DOI/date/creators, malformed dates, duplicate keys, retraction flags | new `MetadataLinter`                |

## Workstream B — Tags, annotations, Obsidian

| Item | Deliverable                                                                           | Module              |
| ---- | ------------------------------------------------------------------------------------- | ------------------- |
| B1   | Bulk add / delete / edit tags across a selection or a saved search                    | `TagManager`        |
| B2   | Annotations: read (exists), **add**, **edit**, library-wide search                    | `AnnotationManager` |
| B3   | Send annotations to Obsidian as a note titled **`Title — Author`**, never the citekey | `ExportManager`     |
| B4   | Workstream A+B slash commands wrapping the above                                      | `SlashCommands`     |

## Workstream C — Library organisation (later)

Collections management, duplicate detection/merge, taxonomy application,
book → bookSection generation with CrossRef chapter lookup + `addRelatedItem`.

## Workstream D — Agentic tier (later, depends on sidecar)

**Narrowed 2026-10-04.** The sidecar was originally justified by "RAG over the
library", but whole-library **lexical** search turned out to be available
in-process: `Zotero.Search` exposes a `fulltextContent` condition backed by a
real full-text implementation (`searchConditions.js:793`, `search.js:677-696`).
That half of RAG needs no daemon. The sidecar therefore carries only what the
plugin genuinely cannot host:

- **Semantic retrieval** — embedding generation and a vector index. This is
  the real "R" in RAG: finding a passage by meaning, not by keyword.
- **OCR repair** — an external engine writing a text layer back into an
  attachment that has none.
- **Long unattended batch jobs** — progress and resume across hours, where the
  plugin's UI-bound lifetime is the wrong host.

Sidecar MCP server + tool registration; `summarise-source-to-annotations`
(which depends on semantic retrieval, not on the daemon itself).

### Sequencing within D

1. **D0 — lexical retrieval (no sidecar).** A `Zotero.Search`-backed
   full-text query surface over the library. Ships first, because it needs no
   new infrastructure and unblocks real use.
2. **D1 — semantic retrieval (sidecar).** Embeddings + vector index over
   extracted full text. The first genuinely sidecar-dependent capability.
3. **D2 — OCR repair (sidecar).** Scanned attachments with no text layer.
4. **D3 — batch maintenance jobs** with progress/resume.

Each tier must degrade gracefully when the sidecar is absent: D0 always works;
D1–D3 report unavailability rather than failing obscurely.

## Sequencing

1. `zoteroPaths`-style foundation: shared write helper (approval + audit +
   trash-not-delete) so every new mutation path is consistent.
2. A1 metadata CRUD + tests.
3. A2/A3 lookups (`LookupManager`) + tests, network mocked.
4. A4 citations + A5 linter.
5. B1 tags, B2 annotations, B3 Obsidian export.
6. B4 slash commands; CHANGELOG, README, PRODUCT.md feature inventory.

## Open risks

- **Network features (A2, A3, C).** Semantic Scholar rate-limits
  unauthenticated calls; an API key belongs in the vault, not prefs. Not yet
  verified — treat any figure as approximate until measured.
- **OCR (D) is not available through the plugin API — verified 2026-10-04.**
  Evidence: a grep for an OCR surface across the whole extracted Zotero 10.0.5
  tree hits **one** file, `xpcom/recognizeDocument.js`. `Zotero.OCR` is not
  assigned anywhere. `Zotero.RecognizeDocument` is the _metadata_-recognition
  path: it requires an **existing text layer** (`recognizePDF.couldNotRead`)
  and POSTs the document to a **remote Zotero service** (`_getBaseURL() +
'recognize'`, `recognizeDocument.js:373`). So it is neither an OCR engine nor
  local. A scanned-item OCR feature needs its own spike — an external engine
  (Tesseract via the sidecar, or a local model) writing a text layer back into
  the attachment — and must not be promised as a plugin capability.

- **`DESIGN.md` conflict — RESOLVED 2026-10-04.** The design doc claimed
  _"metadata is provided in context, not discovered"_ and _"context items are
  the only library access"_. Both were contradicted by shipped code
  (`LookupManager` discovers from external services; `AnnotationManager`
  reads the library in-process). Decision taken: **amend the north star to
  match reality** — discovery and in-process reading are sanctioned; the
  sidecar becomes additive and is narrowed to embeddings, OCR and long batch
  work. `DESIGN.md` now carries a **Sidecar Boundary** section stating the
  tier rules, and a worked **D0 → D3** sequencing. The sidecar is no longer a
  precondition for Workstream D's first and most useful tier.
