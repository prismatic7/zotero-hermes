import { config } from "../package.json";
import { ColumnOptions, DialogHelper } from "zotero-plugin-toolkit";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    env: "development" | "production";
    initialized?: boolean;
    ztoolkit: ZToolkit;
    hermes?: {
      client:
        | import("./modules/hermes/HermesClient").HermesClient
        | import("./modules/hermes/HermesApiClient").HermesApiClient;
      chat: import("./modules/hermes/ChatManager").ChatManager;
      notes: import("./modules/hermes/NoteManager").NoteManager;
      items: import("./modules/hermes/ItemManager").ItemManager;
      citations: import("./modules/hermes/CitationManager").CitationManager;
      annotations: import("./modules/hermes/AnnotationManager").AnnotationManager;
      tags: import("./modules/hermes/TagManager").TagManager;
      lookups: import("./modules/hermes/LookupManager").LookupManager;
      conversations: import("./modules/hermes/ConversationManager").ConversationManager;
      preferences: import("./modules/hermes/PreferencesManager").PreferencesManager;
      approvalDialog: import("./modules/hermes/ApprovalDialog").ApprovalDialog;
      debug: import("./utils/DebugLogger").DebugLogger;
      auditLog: import("./utils/AuditLog").AuditLog;
      exports: import("./modules/hermes/ExportManager").ExportManager;
    };
    locale?: {
      current: any;
    };
    prefs?: {
      window: Window;
      columns: Array<ColumnOptions>;
      rows: Array<{ [dataKey: string]: string }>;
    };
    dialog?: DialogHelper;
  };
  public hooks: typeof hooks;
  public api: object;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
    };
    this.hooks = hooks;
    this.api = {};
  }

  public log(message: string, ...data: any[]): void {
    const line = `[Hermes] ${message}`;
    Zotero.debug(line);
    if (typeof console !== "undefined") {
      console.log(line);
      if (data.length) {
        console.log(`[Hermes] data:`, data);
      }
    }
  }
}

export default Addon;
