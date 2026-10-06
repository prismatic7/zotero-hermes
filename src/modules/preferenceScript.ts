import { config } from "../../package.json";

/**
 * Initialize the Hermes preferences UI.
 * Called when the Zotero preferences pane is opened.
 */
export async function registerPrefsScripts(_window: Window) {
  if (!addon.data.prefs) {
    addon.data.prefs = {
      window: _window,
      columns: [],
      rows: [],
    };
  } else {
    addon.data.prefs.window = _window;
  }
  bindPrefEvents();
  updateConnectionModeUI();
}

/**
 * Show/hide fields based on the selected connection mode.
 */
function updateConnectionModeUI(): void {
  const doc = addon.data.prefs?.window?.document;
  if (!doc) return;

  const modeDropdown = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-connection-mode`,
  ) as any;
  const localSettings = doc.getElementById(
    `${config.addonRef}-local-settings`,
  ) as HTMLElement | null;
  const remoteSettings = doc.getElementById(
    `${config.addonRef}-remote-settings`,
  ) as HTMLElement | null;

  if (!modeDropdown || !localSettings || !remoteSettings) return;

  const mode = modeDropdown.value || "stdio";

  if (mode === "api") {
    localSettings.style.display = "none";
    remoteSettings.style.display = "";
  } else {
    localSettings.style.display = "";
    remoteSettings.style.display = "none";
  }
}

function bindPrefEvents(): void {
  const doc = addon.data.prefs?.window?.document;
  if (!doc) return;

  // Connection mode dropdown — toggle visible sections and hot-swap active client
  const modeDropdown = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-connection-mode`,
  );
  const onModeChange = async () => {
    updateConnectionModeUI();
    const mode = (modeDropdown as any)?.value || "stdio";
    await addon.data.hermes?.preferences?.switchConnectionMode(mode);
  };
  modeDropdown?.addEventListener("command", onModeChange);
  modeDropdown?.addEventListener("change", onModeChange);

  // Test Local Connection button
  const testLocalBtn = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-test-local`,
  );
  testLocalBtn?.addEventListener("click", async () => {
    try {
      const pathInput = doc.getElementById(
        `zotero-prefpane-${config.addonRef}-binary-path`,
      ) as HTMLInputElement | null;
      const configuredPath =
        pathInput?.value ||
        addon.data.hermes?.preferences?.getHermesPath() ||
        "";

      const hermes = addon.data.hermes;
      const { isHermesAvailable } = await import("./hermes/HermesBinaryFinder");
      const available = isHermesAvailable(configuredPath);

      if (!available) {
        throw new Error(
          configuredPath
            ? `Hermes binary not found at "${configuredPath}".`
            : "Hermes binary not found in system PATH or default locations.",
        );
      }

      // Validate the profile selection before anyone relies on it: a missing
      // profile makes `hermes -p <name> acp` exit immediately, and the client
      // silently falls back to the default profile (personal memory included).
      const profileInput = doc.getElementById(
        `zotero-prefpane-${config.addonRef}-profile-name`,
      ) as HTMLInputElement | null;
      const configuredProfile =
        profileInput?.value?.trim() ||
        addon.data.hermes?.preferences?.getHermesProfileName() ||
        "";

      if (configuredProfile) {
        const { resolveHermesProfile } = await import("./hermes/HermesProfile");
        const { getHomeDir } = await import("./hermes/HermesBinaryFinder");
        const resolved = resolveHermesProfile(
          configuredProfile,
          `${getHomeDir()}/.hermes`,
        );
        if (!resolved) {
          throw new Error(
            `Hermes profile "${configuredProfile}" is invalid or does not exist under ~/.hermes/profiles/. Create it with: hermes profile create ${configuredProfile}`,
          );
        }
      }

      // If local client is active, verify connection
      if (hermes?.client && "setupStdioHandlers" in (hermes.client as any)) {
        if (!hermes.client.getIsConnected()) {
          await hermes.client.connect();
        }
      }

      (doc.defaultView as any)?.alert(
        "Local connection successful! Hermes binary found and ready.",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      (doc.defaultView as any)?.alert(`Local connection failed: ${message}`);
    }
  });

  // Test Remote Connection button
  const testRemoteBtn = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-test-remote`,
  );
  testRemoteBtn?.addEventListener("click", async () => {
    try {
      const urlInput = doc.getElementById(
        `zotero-prefpane-${config.addonRef}-api-url`,
      ) as HTMLInputElement | null;
      const keyInput = doc.getElementById(
        `zotero-prefpane-${config.addonRef}-api-key`,
      ) as HTMLInputElement | null;

      const apiUrl = (
        urlInput?.value ||
        addon.data.hermes?.preferences?.get("apiUrl", "") ||
        ""
      ).replace(/\/$/, "");

      const apiKey =
        keyInput?.value ||
        addon.data.hermes?.preferences?.get("apiKey", "") ||
        "";

      if (!apiUrl) {
        (doc.defaultView as any)?.alert(
          "Please enter a server address before testing.",
        );
        return;
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const response = await fetch(`${apiUrl}/health`, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "Unknown error");
        throw new Error(`Health check failed (${response.status}): ${text}`);
      }

      (doc.defaultView as any)?.alert(
        "Remote connection successful! Hermes server is online.",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      (doc.defaultView as any)?.alert(`Remote connection failed: ${message}`);
    }
  });

  // Reset Onboarding button
  const resetOnboardingBtn = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-reset-onboarding`,
  );
  resetOnboardingBtn?.addEventListener("click", () => {
    const hermes = addon.data.hermes;
    if (hermes?.preferences) {
      hermes.preferences.set("hasSeenOnboarding", false);
      (doc.defaultView as any)?.alert(
        "Welcome message will appear next time you open chat.",
      );
    }
  });
}
