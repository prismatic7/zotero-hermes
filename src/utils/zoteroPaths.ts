import type Addon from "../addon";

/**
 * Zotero directory helpers.
 *
 * Zotero 10 changed these APIs: `Zotero.Profile.dir` and
 * `Zotero.DataDirectory.dir` are now **plain strings** (file paths), not
 * `nsIFile`. Only `Zotero.File.pathToFile()` turns a path into an
 * `nsIFile`, and only an `nsIFile` has `clone()` / `append()` / `create()`.
 *
 * Calling `.clone()` (or `.path`) directly on `Zotero.Profile.dir` silently
 * returns the wrong thing or throws — which is how conversation
 * persistence, the audit log, the agent workspace and local export all
 * failed to resolve their directories. `Zotero.getProfileDirectory()` and
 * `Zotero.getZoteroDirectory()` still exist but are deprecated (they log a
 * warning and just wrap `pathToFile(dir)`).
 *
 * Always go through these helpers rather than touching the raw properties.
 */

/** Resolve the Zotero profile directory as an `nsIFile`, or `null`. */
export function getProfileDir(): nsIFile | null {
  return pathToDir((Zotero as any).Profile?.dir);
}

/** Resolve the Zotero data directory as an `nsIFile`, or `null`. */
export function getDataDir(): nsIFile | null {
  return pathToDir((Zotero as any).DataDirectory?.dir);
}

/** Resolve the Zotero profile directory path as a string, or `""`. */
export function getProfileDirPath(): string {
  const dir = (Zotero as any).Profile?.dir;
  return typeof dir === "string" ? dir : "";
}

/** Resolve the Zotero data directory path as a string, or `""`. */
export function getDataDirPath(): string {
  const dir = (Zotero as any).DataDirectory?.dir;
  return typeof dir === "string" ? dir : "";
}

/**
 * Ensure `<base>/zotero-hermes/<folder>` exists and return its path, or `""`
 * if no base directory can be resolved or it cannot be created.
 */
export function ensureHermesDir(
  base: nsIFile | null,
  folder: string,
  addon?: Addon,
): string {
  if (!base) return "";
  try {
    const dir = base.clone();
    dir.append("zotero-hermes");
    if (folder) dir.append(folder);
    if (!dir.exists()) {
      dir.create(Components.interfaces.nsIFile.DIRECTORY_TYPE as number, 0o755);
    }
    return dir.path;
  } catch (e) {
    addon?.log(`[zoteroPaths] Failed to create zotero-hermes/${folder}:`, e);
    return "";
  }
}

/**
 * Turn a path or `nsIFile` into an `nsIFile`. Tolerates the older shape
 * (where these properties were already `nsIFile`) so the helpers keep
 * working if Zotero reverts or a mock supplies one.
 */
function pathToDir(value: unknown): nsIFile | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return Zotero.File.pathToFile(value);
    } catch {
      return null;
    }
  }
  if (typeof (value as nsIFile).clone === "function") {
    return value as nsIFile;
  }
  return null;
}
