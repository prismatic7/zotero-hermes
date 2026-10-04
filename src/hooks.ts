if (typeof console === "undefined") {
  const debugLog = (level: string, msg: any, args: any[]) => {
    const formatted = `${msg} ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`;
    if (typeof Zotero !== "undefined") {
      Zotero.debug(`[Hermes-${level}] ${formatted}`);
    }
  };

  (globalThis as any).console = {
    log: (msg: any, ...args: any[]) => debugLog("log", msg, args),
    warn: (msg: any, ...args: any[]) => debugLog("warn", msg, args),
    error: (msg: any, ...args: any[]) => debugLog("error", msg, args),
    info: (msg: any, ...args: any[]) => debugLog("info", msg, args),
    group: () => {},
    groupCollapsed: () => {},
    groupEnd: () => {},
    trace: () => {},
  };
}

import { UIExampleFactory } from "./modules/examples";
import { HermesClient } from "./modules/hermes/HermesClient";
import { HermesApiClient } from "./modules/hermes/HermesApiClient";
import { ChatManager } from "./modules/hermes/ChatManager";
import { NoteManager } from "./modules/hermes/NoteManager";
import { ItemManager } from "./modules/hermes/ItemManager";
import { CitationManager } from "./modules/hermes/CitationManager";
import { AnnotationManager } from "./modules/hermes/AnnotationManager";
import { ApprovalDialog } from "./modules/hermes/ApprovalDialog";
import { TagManager } from "./modules/hermes/TagManager";
import { ConversationManager } from "./modules/hermes/ConversationManager";
import { PreferencesManager } from "./modules/hermes/PreferencesManager";
import { ExportManager } from "./modules/hermes/ExportManager";
import { DebugLogger } from "./utils/DebugLogger";
import { AuditLog } from "./utils/AuditLog";
import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import type { ContextItem } from "./views/types";
import { mountHermesChat } from "./views/HermesChatView";

async function onStartup() {
  try {
    addon.log("Hermes startup: waiting for Zotero promises...");
    await Promise.all([
      Zotero.initializationPromise,
      Zotero.unlockPromise,
      Zotero.uiReadyPromise,
    ]);

    // Initialize locale FIRST
    initLocale();

    // Debug mode can now gate verbose logs below this point
    const debug = new DebugLogger(addon);

    // Audit log for recording all agent actions
    const auditLog = new AuditLog(addon);
    auditLog.record("connection", "Plugin startup", "success");

    // Initialize Hermes modules
    const approvalDialog = new ApprovalDialog(addon);
    const preferences = new PreferencesManager(addon);
    const connectionMode = preferences.getConnectionMode();
    let client;
    if (connectionMode === "api") {
      client = new HermesApiClient(addon);
    } else {
      client = new HermesClient(addon);
    }

    const chat = new ChatManager(addon);
    const notes = new NoteManager(addon, approvalDialog);
    const items = new ItemManager(addon);
    const citations = new CitationManager(addon);
    const annotations = new AnnotationManager(addon);
    const tags = new TagManager(addon, approvalDialog);
    const conversations = new ConversationManager(addon);
    const exports = new ExportManager(addon);

    addon.data.hermes = {
      client,
      chat,
      notes,
      items,
      citations,
      annotations,
      tags,
      conversations,
      preferences,
      approvalDialog,
      debug,
      auditLog,
      exports,
    };
    addon.log("Hermes modules initialized (mode: " + connectionMode + ")");
    // Load FTL/Stylesheets for all existing windows
    const mainWindows = Zotero.getMainWindows();
    if (mainWindows.length > 0) {
      await Promise.all(mainWindows.map((win) => onMainWindowLoad(win)));
    }

    // Register preferences pane in Zotero Settings
    try {
      Zotero.PreferencePanes.register({
        pluginID: addon.data.config.addonID,
        src: rootURI + "content/preferences.xhtml",
        label: getString("prefs-title"),
        image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
      });
    } catch (prefErr) {
      addon.log(
        `Failed to register preference pane: ${(prefErr as Error).message}`,
      );
    }

    addon.data.initialized = true;
    addon.log("Hermes startup complete");
  } catch (error) {
    addon.log(`Startup error: ${(error as Error).message}`);
    addon.log(`Startup stack: ${(error as Error).stack}`);
    throw error;
  }
}

/**
 * Register Hermes Toolbar Toggle Button and prepare full sidebar.
 */
function registerHermesSidebar(win: _ZoteroTypes.MainWindow): void {
  try {
    const doc = win.document;
    const syncBtn = doc.getElementById("zotero-tb-sync") as any;

    if (syncBtn && !doc.getElementById("zotero-hermes-tb-chat-toggle")) {
      const btn = doc.createXULElement("toolbarbutton") as any;
      btn.setAttribute("id", "zotero-hermes-tb-chat-toggle");
      const shortcutText = (Zotero as any).isMac
        ? "Cmd+Shift+H"
        : "Ctrl+Shift+H";
      btn.setAttribute("tooltiptext", `Toggle Hermes Chat (${shortcutText})`);
      btn.setAttribute("aria-label", `Toggle Hermes Chat (${shortcutText})`);
      btn.setAttribute("aria-pressed", "false");
      btn.setAttribute("tabindex", "0");
      btn.style.listStyleImage =
        "url('chrome://hermes/content/icons/hermes-sidenav.svg')";
      btn.style.mozUserFocus = "normal";

      const separator = doc.createElement("div") as any;
      separator.setAttribute("id", "hermes-tb-separator");
      separator.className = "zotero-tb-separator";

      // Insert right before sync button
      (syncBtn.parentNode as any).insertBefore(btn, syncBtn);
      (syncBtn.parentNode as any).insertBefore(separator, syncBtn);

      // Hook toggle click action
      btn.addEventListener("click", () => {
        toggleHermesSidebar(win);
      });

      // Global keyboard shortcut: Cmd+Shift+H (Mac) / Ctrl+Shift+H (Win/Linux)
      const keyHandler = (e: KeyboardEvent) => {
        const isAccel = (Zotero as any).isMac ? e.metaKey : e.ctrlKey;
        if (isAccel && e.shiftKey && (e.key === "H" || e.key === "h")) {
          e.preventDefault();
          e.stopPropagation();
          toggleHermesSidebar(win);
        }
      };
      win.addEventListener("keydown", keyHandler, true);
      (win as any)._hermesKeyHandler = keyHandler;

      // Deactivate Hermes if Beaver is activated to avoid overlapping panels
      const beaverToggle = doc.getElementById(
        "zotero-beaver-tb-chat-toggle",
      ) as any;
      if (beaverToggle && !beaverToggle.dataset.hermesListener) {
        beaverToggle.addEventListener("click", () => {
          const hermesBtn = doc.getElementById("zotero-hermes-tb-chat-toggle");
          if (hermesBtn && hermesBtn.getAttribute("aria-pressed") === "true") {
            toggleHermesSidebar(win);
          }
        });
        beaverToggle.dataset.hermesListener = "true";
      }

      // Synchronize initial layout state on startup/load
      if (btn.getAttribute("aria-pressed") === "true") {
        btn.setAttribute("aria-pressed", "false");
        toggleHermesSidebar(win);
      }

      addon.log("Hermes sidebar toggle button registered successfully");
    }
  } catch (error) {
    addon.log(
      `Failed to register Hermes sidebar toggle button: ${(error as Error).message}`,
    );
  }
}

/**
 * Open the Hermes sidebar and hand off a prompt.
 *
 * The dispatch is *synchronous*: `toggleHermesSidebar` mounts the React
 * view via `createRoot().render()`, but React 18 renders asynchronously,
 * so the view's `onExternalPrompt` subscription may not exist yet when
 * this returns. `ChatManager.dispatchExternalPrompt` buffers the prompt
 * in that case and replays it on the first subscription — so we do not
 * depend on a fixed delay racing the mount (the old 200ms timer could
 * fire before the effect ran, and an empty listener set silently dropped
 * the prompt: sidebar opened, prompt never appeared).
 */
function openSidebarAndPrompt(
  win: _ZoteroTypes.MainWindow,
  prompt: string,
  contextItems?: ContextItem[],
) {
  const doc = win.document;
  const toggleBtn = doc.getElementById("zotero-hermes-tb-chat-toggle");
  const pressed = toggleBtn?.getAttribute("aria-pressed");
  if (toggleBtn && pressed !== "true") {
    toggleHermesSidebar(win);
  }
  // Dispatch synchronously. ChatManager buffers the prompt when the
  // ChatView has not subscribed yet (React's createRoot().render() is
  // async), replaying it on subscribe — so no timer is needed here.
  addon.data.hermes?.chat.dispatchExternalPrompt(prompt, contextItems);
}

/**
 * Register the "Ask Hermes About Item" library item context menu entry
 * via Zotero's supported MenuManager API.
 */
function registerItemContextMenu(): void {
  const hermes = addon.data.hermes;
  if (!hermes) return;
  hermes.items.registerItemContextMenu(({ titles, contextItems }) => {
    const win = Zotero.getMainWindow();
    if (!win) return;
    openSidebarAndPrompt(
      win,
      hermes.items.buildItemPrompt(titles),
      contextItems,
    );
  });
}

/**
 * Register the reader text-selection "⚡ Hermes" action.
 *
 * Zotero 10 dispatches reader UI events as `CustomEvent({ detail: {
 * type: "render..." | "create...ContextMenu", append, params, reader }})`
 * — there is no `popup`/`doc` argument and no `popup.appendChild` step
 * (verified against Zotero 10.0.5 `resource/reader/reader.js`). The
 * callback MUST call `append(...)` synchronously or the reader throws.
 *
 * The previous implementation destructured `{ reader, doc, popup }` and
 * called `popup.appendChild(btn)`, so the button was never inserted and
 * the listener silently did nothing. Also, `renderTextSelectionPopup`
 * only fires for existing annotations: a fresh selection is only
 * surfaced through `createViewContextMenu`, so both are registered.
 */
function registerReaderActions(): void {
  const readerAPI = (Zotero as any).Reader;
  if (
    !readerAPI ||
    typeof readerAPI.registerEventListener !== "function" ||
    (addon as any)._readerEventRegistered
  ) {
    return;
  }
  (addon as any)._readerEventRegistered = true;

  const pluginID = addon.data.config.addonID;

  // Floating action button in the text-selection popup (shown on hover
  // over an existing highlight/underline).
  readerAPI.registerEventListener(
    "renderTextSelectionPopup",
    (event: any) => {
      try {
        const reader = event.reader;
        const text = event.params?.annotation?.text || "";
        if (!text) return;
        const doc = event.doc || reader?._iframeWindow?.document;
        if (!doc) return;

        const btn = doc.createElement("button");
        btn.className = "toolbar-button hermes-reader-popup-btn";
        btn.textContent = "⚡ Hermes";
        btn.title = "Explain selection with Hermes";
        btn.addEventListener("click", () => {
          void runReaderAction(reader, "explain", {
            text,
            page: reader?.state?.pageIndex,
          });
        });
        event.append(btn);
      } catch (err) {
        addon.log(
          `Failed to render reader selection popup button: ${(err as Error).message}`,
        );
      }
    },
    pluginID,
  );

  // Right-click "view" menu — the only surface that fires for a plain
  // text selection that has not yet been turned into an annotation.
  readerAPI.registerEventListener(
    "createViewContextMenu",
    (event: any) => {
      try {
        const reader = event.reader;
        if (!reader) return;
        const selected = getReaderSelectionText(reader);
        const makeItem = (label: string, mode: "explain" | "critique") => ({
          label,
          onCommand: () => {
            void runReaderAction(reader, mode, { text: selected });
          },
        });
        event.append(
          makeItem("Explain Selection with Hermes", "explain"),
          makeItem("Critique Argument with Hermes", "critique"),
        );
      } catch (err) {
        addon.log(
          `Failed to render reader context menu: ${(err as Error).message}`,
        );
      }
    },
    pluginID,
  );
}

/**
 * Read the current text selection inside a reader. `ReaderInstance` has
 * no `getSelectedText()`; the selection lives in its iframe window.
 */
function getReaderSelectionText(reader: any): string {
  try {
    const selection = reader?._iframeWindow?.getSelection?.();
    if (selection && typeof selection.toString === "function") {
      return selection.toString().trim();
    }
  } catch {
    // ignore
  }
  return "";
}

/**
 * Attach the item under the reader, open the sidebar, and dispatch the
 * explain/critique prompt.
 */
async function runReaderAction(
  reader: any,
  actionType: "explain" | "critique",
  opts: { text: string; page?: number },
): Promise<void> {
  const hermes = addon.data.hermes;
  if (!hermes) return;
  const text = opts.text || getReaderSelectionText(reader);
  if (!text) {
    addon.log("No text selected in active reader");
    return;
  }

  let title: string | undefined;
  try {
    if (reader?.itemID) {
      const item = Zotero.Items.get(reader.itemID);
      if (item) {
        await hermes.items.attachItem(item);
        title = hermes.items.getItemPromptText(item);
      }
    }
  } catch {
    // ignore — fall back to "the current document"
  }

  const prompt = hermes.items.buildReaderPrompt(actionType, {
    text,
    page: opts.page,
    title,
  });
  const win = Zotero.getMainWindow();
  if (win) openSidebarAndPrompt(win, prompt);
}

/**
 * Toggle the full-height Hermes sidebar view.
 */
function toggleHermesSidebar(win: _ZoteroTypes.MainWindow): void {
  try {
    const doc = win.document;
    const btn = doc.getElementById("zotero-hermes-tb-chat-toggle");
    if (!btn) return;

    const isPressed = btn.getAttribute("aria-pressed") === "true";

    const itemPane = doc.getElementById("zotero-item-pane") as any;
    const deck = doc.getElementById("zotero-item-pane-content") as any;
    const sidenav = doc.getElementById("zotero-view-item-sidenav") as any;
    if (!itemPane || !deck || !sidenav) return;

    let hermesPane = doc.getElementById("hermes-pane-library") as any;

    if (!isPressed) {
      // 1. Deactivate Beaver if active to avoid collisions
      const beaverToggle = doc.getElementById("zotero-beaver-tb-chat-toggle");
      if (
        beaverToggle &&
        beaverToggle.getAttribute("aria-pressed") === "true"
      ) {
        (beaverToggle as any).click();
      }

      // 2. Hide default Zotero details panel & vertical sidenav tabs
      deck.style.display = "none";
      sidenav.style.display = "none";

      // 3. Create full-height Hermes sidebar if needed
      if (!hermesPane) {
        hermesPane = doc.createXULElement("vbox") as any;
        hermesPane.setAttribute("id", "hermes-pane-library");
        hermesPane.className = "display-flex flex-1 h-full min-w-0";
        hermesPane.style.minWidth = "0px";
        hermesPane.style.width = "100%";

        const reactContainer = doc.createElement("div") as any;
        reactContainer.setAttribute("id", "hermes-react-root");
        reactContainer.setAttribute(
          "style",
          "width: 100%; height: 100%; display: flex; flex-direction: column;",
        );

        hermesPane.appendChild(reactContainer);
        itemPane.appendChild(hermesPane);
      }

      // 4. Show panel and mount React Chat
      hermesPane.style.display = "flex";

      const reactContainer = doc.getElementById("hermes-react-root") as any;
      if (reactContainer && !reactContainer.dataset.mounted) {
        try {
          const unmount = mountHermesChat(reactContainer as HTMLElement, addon);
          reactContainer.dataset.mounted = "true";
          reactContainer._unmount = unmount;
          addon.log(
            "Hermes Chat React component successfully mounted in full sidebar",
          );
        } catch (err) {
          addon.log(
            `Hermes React mount error in full sidebar: ${(err as Error).message}`,
          );
        }
      }

      btn.setAttribute("aria-pressed", "true");
      addon.log("Hermes full sidebar view toggled ON");

      // Auto-focus chat input on toggle
      win.setTimeout(() => {
        try {
          const textarea = doc.querySelector(
            ".hermes-chat-input",
          ) as HTMLTextAreaElement | null;
          textarea?.focus();
        } catch {
          // ignore
        }
      }, 100);
    } else {
      // Hide Hermes panel and restore default Zotero views
      if (hermesPane) {
        hermesPane.style.display = "none";
      }
      deck.style.display = "";
      sidenav.style.display = "";
      btn.setAttribute("aria-pressed", "false");
      addon.log("Hermes full sidebar view toggled OFF");
    }
  } catch (error) {
    addon.log(`Error toggling Hermes sidebar: ${(error as Error).message}`);
  }
}

/**
 * Remove all Hermes sidebar elements and restore layout.
 */
function unregisterHermesSidebar(win: Window): void {
  try {
    const doc = win.document;

    // 1. Remove toolbar button, separator, and keyboard listener
    if ((win as any)._hermesKeyHandler) {
      win.removeEventListener("keydown", (win as any)._hermesKeyHandler, true);
      delete (win as any)._hermesKeyHandler;
    }
    const btn = doc.getElementById("zotero-hermes-tb-chat-toggle");
    if (btn) {
      btn.parentNode?.removeChild(btn);
    }
    const separator = doc.getElementById("hermes-tb-separator");
    if (separator) {
      separator.parentNode?.removeChild(separator);
    }

    // 2. Clean up Hermes sidebar panel
    const hermesPane = doc.getElementById("hermes-pane-library") as any;
    if (hermesPane) {
      const reactContainer = doc.getElementById("hermes-react-root") as any;
      if (reactContainer && reactContainer._unmount) {
        try {
          reactContainer._unmount();
        } catch (e) {
          // ignore unmount errors
        }
      }
      hermesPane.parentNode?.removeChild(hermesPane);
    }

    // 3. Restore Zotero default sidebars
    const deck = doc.getElementById("zotero-item-pane-content") as any;
    if (deck) {
      deck.style.display = "";
    }
    const sidenav = doc.getElementById("zotero-view-item-sidenav") as any;
    if (sidenav) {
      sidenav.style.display = "";
    }
    addon.log("Hermes sidebar fully cleaned up and Zotero layout restored");
  } catch (error) {
    addon.log(`Error cleaning up Hermes sidebar: ${(error as Error).message}`);
  }
}

const windowToolkits = new WeakMap<Window, any>();

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for this window and store in per-window WeakMap
  const ztoolkit = createZToolkit();
  windowToolkits.set(win, ztoolkit);
  addon.data.ztoolkit = ztoolkit;

  // Initialize locale for this window
  initLocale();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  const popupWin = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({
      text: getString("startup-begin"),
      type: "default",
      progress: 0,
    })
    .show();

  await Zotero.Promise.delay(100);
  popupWin.changeLine({
    progress: 30,
    text: `[30%] ${getString("startup-begin")}`,
  });

  // Only essential UI setup
  UIExampleFactory.registerStyleSheet(win);

  // Register full-height sidebar and toolbar button
  registerHermesSidebar(win);

  // Register supported context-menu / reader integrations after the
  // window is ready, so Zotero.MenuManager and Zotero.Reader exist.
  Zotero.Promise.delay(300).then(() => {
    try {
      registerItemContextMenu();
      registerReaderActions();
    } catch (err) {
      addon.log(
        `Failed to register Hermes menu integrations: ${(err as Error).message}`,
      );
    }
  });

  await Zotero.Promise.delay(100);

  popupWin.changeLine({
    progress: 100,
    text: `[100%] ${getString("startup-finish")}`,
  });
  popupWin.startCloseTimer(5000);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  unregisterHermesSidebar(win);
  const winToolkit = windowToolkits.get(win);
  if (winToolkit) {
    winToolkit.unregisterAll();
    windowToolkits.delete(win);
  } else {
    addon.data.ztoolkit?.unregisterAll();
  }
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  // M5: disconnect the Hermes client so the ACP subprocess is killed
  // cleanly (no orphaned `hermes acp` processes after Zotero exits).
  try {
    addon.data.hermes?.client?.disconnect();
  } catch (error) {
    addon.log(
      `Error disconnecting Hermes client on shutdown: ${(error as Error).message}`,
    );
  }

  // Unregister the MenuManager item-context-menu entry.
  try {
    addon.data.hermes?.items.unregisterItemContextMenu();
  } catch (error) {
    addon.log(
      `Error unregistering Hermes item context menu: ${(error as Error).message}`,
    );
  }

  try {
    const mainWindows = Zotero.getMainWindows();
    for (const win of mainWindows) {
      unregisterHermesSidebar(win);
    }
    addon.log("Hermes sidebar unregistered from all windows during shutdown");
  } catch (error) {
    addon.log(
      `Error during shutdown unregistration: ${(error as Error).message}`,
    );
  }

  addon.data.ztoolkit?.unregisterAll();
  addon.data.dialog?.window?.close();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * Handle notify events.
 *
 * The plugin does not currently subscribe to Zotero item/collection
 * notifications — the chat UI reads state on demand. Keep this hook
 * registered (the scaffold requires it) but do not log every event;
 * that produces noise on every item change in the library.
 */
async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  // No-op: notifications are intentionally not handled yet.
  // If item-change reactivity is added later, dispatch here.
  void event;
  void type;
  void ids;
  void extraData;
}

/**
 * Handle preference UI events
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

/**
 * Handle keyboard shortcuts (removed - shortcuts not used)
 */
function onShortcuts(type: string) {
  // No shortcuts implemented
}

/**
 * Handle dialog events (removed - example dialogs not used)
 */
function onDialogEvents(type: string) {
  // No dialog events implemented
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
