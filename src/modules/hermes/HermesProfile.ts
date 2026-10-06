/**
 * Hermes profile resolution for ACP mode.
 *
 * Hermes can run against a named profile (`hermes -p <name> ...`), which gives
 * that surface its own persona, memory, skills, plugins, and session store
 * under `~/.hermes/profiles/<name>/`. Pointing the sidebar at a dedicated
 * profile keeps the user's personal memory (standing facts, preferences) and
 * their full skill/plugin set out of the Zotero research surface.
 *
 * IMPORTANT: `HERMES_PROFILE` is NOT read by the CLI — only `-p <name>` or a
 * `HERMES_HOME` override actually scope the run. We use the `-p` form.
 *
 * Only a profile that exists on disk is used: `hermes -p <missing> acp` exits
 * with "Profile '<name>' does not exist" and the connection dies, so a stale or
 * mistyped preference must never be passed through. Falling back to the default
 * profile keeps the sidebar working.
 */

/**
 * A profile name that is safe to pass as a bare argument and as a single path
 * segment. Mirrors the CLI's own rule: lowercase alphanumerics, `-`, `_`.
 * Rejecting other input prevents a configured name from escaping the profiles
 * directory and probing arbitrary paths.
 */
const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Return the profile name if it is well-formed, otherwise `""`. */
export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_PATTERN.test(name);
}

function fileExists(path: string): boolean {
  try {
    const file = (Components.classes as any)[
      "@mozilla.org/file/local;1"
    ].createInstance((Components.interfaces as any).nsIFile);
    file.initWithPath(path);
    // `exists()` is a method; `isDirectory` is a boolean PROPERTY on nsIFile.
    // Calling isDirectory() throws "is not a function" in the sandbox.
    return file.exists() && file.isDirectory;
  } catch {
    return false;
  }
}

/**
 * Check whether a profile exists at `<hermesHome>/profiles/<name>/`.
 *
 * @param name - Candidate profile name from preferences.
 * @param hermesHome - The Hermes home directory (`HOME/.hermes`), or `""`.
 */
export function profileExists(name: string, hermesHome: string): boolean {
  if (!name || !hermesHome) return false;
  if (!isValidProfileName(name)) return false;
  const base = hermesHome.endsWith("/") ? hermesHome.slice(0, -1) : hermesHome;
  return fileExists(`${base}/profiles/${name}`);
}

/**
 * Resolve the profile name to run ACP against.
 *
 * @param configuredName - The name from preferences (may be empty).
 * @param hermesHome - The Hermes home directory (`HOME/.hermes`), or `""`.
 * @returns The profile name to pass to `-p`, or `null` for the default profile.
 */
export function resolveHermesProfile(
  configuredName: string,
  hermesHome: string,
): string | null {
  const name = (configuredName || "").trim();
  if (!name) return null;
  if (!isValidProfileName(name)) return null;
  if (!profileExists(name, hermesHome)) return null;
  return name;
}

/**
 * Build the CLI argument array for an ACP invocation, including `-p <profile>`
 * when a scoped profile is resolved. Exported for tests — the argument list is
 * the security-relevant part of the spawn, so it is verified independently of
 * the subprocess layer.
 *
 * @param profile - Profile name from `resolveHermesProfile`, or `null`.
 */
export function buildAcpArguments(profile: string | null): string[] {
  if (!profile || !isValidProfileName(profile)) return ["acp"];
  // `-p` must precede the subcommand; Hermes parses it as a top-level flag.
  return ["-p", profile, "acp"];
}
