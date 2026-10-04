---
name: zotero-dev
description: Core development patterns for Zotero plugins. Load when implementing features, editing src/modules/, handling Zotero API calls, or managing plugin lifecycle.
---

# Zotero Development Skill

This skill provides patterns and rules for developing Zotero plugins with the Hermes Agent integration.

## Purpose

To ensure consistent development across the Zotero Hermes plugin, proper code organization, and adherence to Zotero's development patterns.

## Scope

This skill covers:

- Implementing new plugin features
- TypeScript/JavaScript coding conventions
- Zotero API usage patterns
- Plugin debugging and troubleshooting
- Project structure and organization

## Core Rules

- Follow established patterns for Zotero plugin development
- Use appropriate tools and conventions from zotero-plugin-toolkit
- Test thoroughly across different Zotero versions (target 9.0.0+, current 10.x)
- Document important decisions and patterns
- Prefer XUL/XHTML for UI components (Zotero's native UI system)
- Use React only where appropriate (chat components, complex UIs)

## Bundled Resources

- `references/plugin-guidelines.md`: Zotero plugin best practices
- `references/agent-dos-donts.md`: Critical development guidelines
- `references/code-patterns.md`: Implementation patterns and examples
- `references/coding-conventions.md`: Code style and organization
- `references/commands-settings.md`: Command and settings implementation
- `references/common-tasks.md`: Frequently needed operations
- `references/live-runtime-debugging.md`: Probing the user's running Zotero over Firefox RDP when there is no log — protocol, what reads over the channel, and the `undefined`-means-failed-probe rule

## Zotero-Specific Patterns

### UI Components

Zotero uses XUL/XHTML for its UI. When creating UI elements:

```typescript
// Good - Using ztoolkit.UI for XUL elements
const button = ztoolkit.UI.createElement(doc, "button", {
  id: "hermes-send-btn",
  class: "hermes-btn-primary",
  properties: {
    label: "Send",
  },
  listeners: {
    command: () => handleSend(),
  },
});

// Good - Using React for complex chat components
// Mount React root in XUL container
const root = createRoot(container);
root.render(<ChatComponent />);
```

### Event Handling

```typescript
// Zotero notifier pattern
const callback = {
  notify: async (event, type, ids, extraData) => {
    if (!addon?.data.alive) return;
    addon.hooks.onNotify(event, type, ids, extraData);
  },
};
const notifierID = Zotero.Notifier.registerObserver(callback, [
  "tab",
  "item",
  "file",
]);
```

### Item Operations

```typescript
// Reading item data
const item = await Zotero.Items.getAsync(itemID);
const title = item.getDisplayTitle();
const note = item.getNote();

// Creating items
const note = new Zotero.Item("note");
note.libraryID = Zotero.Libraries.userLibraryID;
note.setNote(content);
await note.saveTx();
```

## Security Guidelines

- All file/note modifications require user approval
- Use Zotero's preference system for secure storage
- Validate all paths before file operations
- Sanitize user input before processing
- Never execute arbitrary code from AI responses

## Performance Considerations

- Batch operations when possible
- Use virtual scrolling for large lists
- Debounce rapid UI updates
- Lazy load heavy components
- Profile memory usage regularly
