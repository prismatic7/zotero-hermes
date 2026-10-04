---
name: zotero-ref
description: Technical references, API documentation, and Zotero-specific knowledge. Load when checking API details, manifest requirements, or UI/UX standards.
---

# Zotero Reference Skill

This skill provides technical references and API documentation for Zotero plugin development.

## Purpose

To provide quick access to Zotero API patterns, manifest requirements, and UI guidelines.

## Scope

This skill covers:

- Zotero API reference
- Manifest requirements
- UI/UX standards
- File format specifications
- External resources

## Bundled Resources

- `references/references.md`: External docs, types, and MCP server info

## Zotero API Quick Reference

### Items

```typescript
// Get item by ID
const item = await Zotero.Items.getAsync(itemID);

// Get all items in library
const items = await Zotero.Items.getAll(libraryID);

// Get selected items
const selected = Zotero.getActiveZoteroPane().getSelectedItems();

// Create new item
const item = new Zotero.Item("note");
item.libraryID = Zotero.Libraries.userLibraryID;
await item.saveTx();
```

### Collections

```typescript
// Get all collections
const collections = await Zotero.Collections.getAll(libraryID);

// Get items in collection
const items = await collection.getChildItems();
```

### Notes

```typescript
// Get note content
const content = note.getNote();

// Set note content
note.setNote("New content");
await note.saveTx();

// Get parent item
const parent = await Zotero.Items.getAsync(note.parentID);
```

### PDF Annotations

```typescript
// Get annotations for item
const annotations = await item.getAnnotations();

// Create annotation
const annotation = new Zotero.Item("annotation");
annotation.parentID = pdfItem.id;
annotation.annotationType = "highlight";
annotation.annotationText = "Selected text";
await annotation.saveTx();
```

## Directory resolution (Zotero 10 — read this before touching paths)

`Zotero.Profile.dir` and `Zotero.DataDirectory.dir` are **plain strings** in
Zotero 10, not `nsIFile`. Verified live in Zotero 10.0.5:

```
typeof Zotero.Profile.dir          -> "string"
typeof Zotero.Profile.dir.clone    -> "undefined"
Zotero.Profile.dir.clone()         -> TypeError: p.clone is not a function
typeof Zotero.DataDirectory.dir    -> "string"
```

`getProfileDirectory()` / `getZoteroDirectory()` still exist but are
**deprecated** — they log a warning and just wrap
`Zotero.File.pathToFile(dir)` (`xpcom/zotero.js:1047`).

The old idiom is a trap, because the string wins the `||` and `.clone()`
then throws:

```typescript
// WRONG — Profile.dir is a string, so this throws at .clone()
const profileDir =
  (Zotero as any).Profile?.dir || Zotero.getProfileDirectory?.();
const dir = profileDir.clone() as nsIFile;
```

```typescript
// RIGHT — go through the shared helper
import {
  getProfileDir,
  getDataDir,
  ensureHermesDir,
  getProfileDirPath,
  getDataDirPath,
} from "../../utils/zoteroPaths";

const baseDir = getProfileDir() || getDataDir(); // nsIFile | null
const dirPath = ensureHermesDir(baseDir, "workspace"); // creates + returns path
const dataPath = getDataDirPath(); // string
```

`src/utils/zoteroPaths.ts` converts the string via
`Zotero.File.pathToFile()` and still tolerates an `nsIFile` (mock or older
Zotero), so it is the only place that should know about the shape.

Two related API facts worth remembering:

- `Zotero.Items.getAsync(ids)` returns an **array** when given an array, and
  the object itself when given a single id (`dataObjects.js:152-211`). A test
  stub returning a bare object silently skips `array.filter()` code paths.
- `nsIFile.isDirectory` is a boolean **property**, not a method.

## Manifest Requirements

### Required Fields

```json
{
  "manifest_version": 2,
  "name": "Hermes Agent for Zotero",
  "version": "0.1.0",
  "description": "AI-powered research assistant",
  "author": "techne-tools",
  "applications": {
    "zotero": {
      "id": "hermes@techne-tools.org",
      "strict_min_version": "7.0",
      "strict_max_version": "10.*"
    }
  }
}
```

### Version Compatibility

- Zotero 9.0.0+ required (current: 10.x, Firefox 140 ESR)
- Firefox 140 ESR based (Zotero 10; was 115 ESR in Zotero 9)
- Check compatibility with Zotero beta releases

## Annotations (verified against Zotero 10.0.5 source, 2026-10-04)

Creating an annotation by hand is order-sensitive. Getting it wrong throws, or
silently writes a corrupt item:

```typescript
// Zotero 10.0.5 contracts — all line refs to xpcom/data/item.js
const ann = new Zotero.Item("annotation");
ann.parentItemID = pdfItem.id; // the PDF attachment, not the parent item
// 1. annotationType MUST be assigned FIRST (:4510) — other props throw before it
ann.annotationType = "highlight"; // highlight|underline|note|text|image|ink
// 2. annotationText is ONLY legal on highlight/underline (:4530)
ann.annotationText = "quoted text";
ann.annotationComment = "my note";
// 3. annotationColor must match /^#[a-f0-9]{6}$/i (:4537)
ann.annotationColor = "#ffd400";
ann.annotationPageLabel = "12";
// 4. annotationPosition is the ONLY geometry. There is no default rect —
//    never fabricate `rects: [[0,0,100,20]]`: that writes a highlight at a
//    location that does not exist. Refuse instead.
ann.annotationPosition = '{"pageIndex":12,"rects":[[1,2,3,4]]}';
await ann.saveTx();
```

Searching annotations uses Zotero's own conditions (`xpcom/data/searchConditions.js:725-795`),
all at `level: 'annotation'`:

```typescript
const search = new Zotero.Search();
// `search.libraryID = …` throws (read-only); the Search() constructor already
// scopes to the user library.
search.addCondition("annotationText", "contains", "term"); // contains|doesNotContain
search.addCondition("annotationComment", "contains", "term");
search.addCondition("annotationType", "is", "highlight");
search.addCondition("annotationColor", "is", "#ffd400");
const ids = await search.search();
```

Do **not** use `Zotero.Annotations.saveFromJSON()` to create annotations — it is
an _importer_ and requires an existing key (`annotations.js:214`).

## Citations

Citation generation must use `previewCitationCluster`; it does not mutate engine
state, so calls for different items are independent.

```typescript
const style = Zotero.Styles.get(styleID); // keyed on the styleID URI ONLY
if (!style) throw new Error("style not found");
// getCiteProc(locale, format, { cache }) — matches quickCopy.js:46
const engine = style.getCiteProc(undefined, "text", { cache: true });
try {
  engine.updateItems([item.id]);
  const inText = engine.previewCitationCluster(
    { citationItems: [{ id: item.id }], properties: {} },
    [],
    [],
    "text",
  );
  const bib = engine.makeBibliography(); // [meta, string[]] — entries at [1]
} finally {
  engine.free(); // a cite-process engine holds a wasm instance; leaking one per citation is real cost
}
```

Do **not** use `appendCitationCluster(citation, true)` and expect `[[id, string], …]`.
Zotero 10 uses the **citeproc-rs bridge**, whose `appendCitationCluster(citation)`
takes ONE argument and returns a different shape — the old call was silently
unusable.

`Zotero.Styles.get()` accepts only a full styleID URI. Resolve a short name
("chicago") through `Zotero.Styles.getVisible()` and match `title`/`shortTitle`.
Always return the resolved style's own `styleID`, never the string the caller typed.

## OCR — not available via the plugin API

There is **no `Zotero.OCR`** and no OCR entry point in Zotero 10.0.5. A grep for
an OCR surface across the extracted tree hits one file, `xpcom/recognizeDocument.js`,
and that is the _metadata_-recognition path: it requires an existing text layer
(`recognizePDF.couldNotRead`) and POSTs the document to a **remote** Zotero
service (`_getBaseURL() + 'recognize'`, `:373`). Do not promise scanned-item OCR
as a plugin capability; it needs an external engine plus its own spike.

## Directories (Zotero 10)

`Zotero.Profile.dir` and `Zotero.DataDirectory.dir` are **plain strings** in
Zotero 10 — they were `nsIFile` objects in Zotero 9. Calling `.clone()` on them
throws `TypeError: p.clone is not a function`, silently. Convert with
`Zotero.File.pathToFile()` (see `src/utils/zoteroPaths.ts`).

## UI Guidelines

### XUL Elements

- Use `vbox` and `hbox` for layout
- Use `label` for text
- Use `button` for actions
- Use `textbox` for input

### Styling

- Use CSS variables for theming
- Support dark/light mode
- Follow Zotero's native look and feel
- Test with different themes

### Accessibility

- Add tooltips to all interactive elements
- Support keyboard navigation
- Use ARIA labels where appropriate
- Test with screen readers

## External Resources

### Official Documentation

- [Zotero Plugin Dev Guide](https://windingwind.github.io/doc-for-zotero-plugin-dev/)
- [Zotero Types](https://github.com/windingwind/zotero-types)
- [Zotero Plugin Toolkit](https://github.com/windingwind/zotero-plugin-toolkit)

### Community

- [Zotero Forums](https://forums.zotero.org/)
- [Zotero Discord](https://discord.gg/zotero)
- [Zotero Chinese Community](https://zotero-chinese.com/)

### Hermes Agent

- [Hermes Agent Docs](https://hermes-agent.nousresearch.com/docs/)
- [ACP Protocol Spec](https://github.com/NousResearch/hermes-agent/blob/main/docs/acp.md)
- [Hermes GitHub](https://github.com/NousResearch/hermes-agent)

## File Format Specifications

### Zotero Note Format

- HTML subset supported
- Special tags: `<p>`, `<div>`, `<span>`, `<br>`, `<b>`, `<i>`, `<u>`, `<a>`, `<img>`, `<table>`, `<tr>`, `<td>`, `<blockquote>`, `<pre>`, `<code>`, `<h1>`-`<h6>`, `<ul>`, `<ol>`, `<li>`, `<sub>`, `<sup>`, `<strike>`
- Citations use special `<span class="citation">` format
- Images stored as attachments

### Citation Styles

- CSL 1.0.2 format
- Support for 10,000+ styles
- Custom styles can be added
