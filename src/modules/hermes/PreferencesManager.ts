/**
 * Manages Hermes preferences and settings.
 */
export class PreferencesManager {
  private readonly addon: any;
  private readonly defaults: Record<string, any> = {
    "extensions.zotero.hermes.binaryPath": "",
    "extensions.zotero.hermes.profileName": "",
    "extensions.zotero.hermes.connectionMode": "stdio",
    "extensions.zotero.hermes.apiUrl": "",
    "extensions.zotero.hermes.apiKey": "",
    "extensions.zotero.hermes.chatAgentName": "Hermes",
    "extensions.zotero.hermes.autoSave": true,
    "extensions.zotero.hermes.showReasoning": true,
    "extensions.zotero.hermes.showToolUse": true,
    "extensions.zotero.hermes.showTokenCount": false,
    "extensions.zotero.hermes.enableDebugMode": false,
    "extensions.zotero.hermes.enableCitations": true,
    "extensions.zotero.hermes.enableAnnotations": true,
    "extensions.zotero.hermes.enableTags": true,
    "extensions.zotero.hermes.hasSeenOnboarding": false,
    "extensions.zotero.hermes.enableTypingSound": false,
    "extensions.zotero.hermes.enableHapticFeedback": false,
    "extensions.zotero.hermes.allowTerminal": false,
    "extensions.zotero.hermes.conversationOrganization": "flat",
    "extensions.zotero.hermes.chatSaveFolder": "hermes",
    "extensions.zotero.hermes.currentPersona": "default",
    "extensions.zotero.hermes.obsidianVaultPath": "",
  };

  constructor(addon: any) {
    this.addon = addon;
    this.initializeDefaults();
  }

  private initializeDefaults(): void {
    for (const [key, value] of Object.entries(this.defaults)) {
      if (Zotero.Prefs.get(key, true) === undefined) {
        Zotero.Prefs.set(key, value, true);
      }
    }
  }

  public get<T>(key: string, defaultValue?: T): T {
    const fullKey = key.startsWith("extensions.zotero.hermes.")
      ? key
      : `extensions.zotero.hermes.${key}`;
    const value = Zotero.Prefs.get(fullKey, true);
    return value !== undefined ? (value as T) : (defaultValue as T);
  }

  public set<T extends string | number | boolean>(key: string, value: T): void {
    const fullKey = key.startsWith("extensions.zotero.hermes.")
      ? key
      : `extensions.zotero.hermes.${key}`;
    Zotero.Prefs.set(fullKey, value, true);
  }

  public getHermesPath(): string {
    return this.get<string>("binaryPath", "");
  }

  public setHermesPath(path: string): void {
    this.set("binaryPath", path);
  }

  /**
   * Name of the Hermes profile the ACP session runs as. Empty means the
   * default profile (which carries the user's personal memory).
   */
  public getHermesProfileName(): string {
    return this.get<string>("profileName", "");
  }

  public setHermesProfileName(name: string): void {
    this.set("profileName", name);
  }

  public getConnectionMode(): string {
    return this.get<string>("connectionMode", "stdio");
  }

  public setConnectionMode(mode: string): void {
    this.set("connectionMode", mode);
  }

  public async switchConnectionMode(mode: string): Promise<void> {
    this.setConnectionMode(mode);
    const hermes = this.addon.data?.hermes;
    if (!hermes) return;

    try {
      hermes.client?.disconnect();
    } catch (err) {
      this.addon.log(
        `Error disconnecting old client on mode switch: ${(err as Error).message}`,
      );
    }

    if (mode === "api") {
      const { HermesApiClient } = await import("./HermesApiClient");
      hermes.client = new HermesApiClient(this.addon);
    } else {
      const { HermesClient } = await import("./HermesClient");
      hermes.client = new HermesClient(this.addon);
    }
    this.addon.log(`Switched Hermes connection mode to ${mode}`);
  }
}
