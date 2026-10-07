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
 * mistyped preference must never be passed through.
 *
 * A broken request must NOT fall back to the default profile. The default
 * carries the user's personal memory (SOUL.md, MEMORY.md) and full skill set,
 * which is exactly what scoping exists to keep out of this surface; silently
 * substituting it for a profile the user asked for is a disclosure, and logging
 * about it is not a substitute for not doing it. `resolveConfiguredProfile`
 * therefore distinguishes "deliberately blank" from "asked for and broken", and
 * callers refuse to start on the latter.
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

/**
 * Decide whether an nsIFile-like object is a directory, tolerating both shapes
 * the platform has shipped:
 *
 *   - a boolean PROPERTY (`file.isDirectory`) — the form AGENTS.md documents;
 *   - a METHOD (`file.isDirectory()`) — what the current Zotero 10 sandbox
 *     actually returns (`function isDirectory() { [native code] }`, verified
 *     empirically).
 *
 * Guessing one shape is unsafe in both directions: calling a property throws
 * "is not a function", and reading a method as a bare property is always
 * truthy (so a directory check would silently accept regular files). Inspect
 * the type instead.
 */
export function isDirectoryLike(file: {
  isDirectory?: unknown;
  exists?: () => boolean;
}): boolean {
  const value = file?.isDirectory;
  if (typeof value === "function") {
    return Boolean((value as () => boolean).call(file));
  }
  return Boolean(value);
}

function fileExists(path: string): boolean {
  try {
    const file = (Components.classes as any)[
      "@mozilla.org/file/local;1"
    ].createInstance((Components.interfaces as any).nsIFile);
    file.initWithPath(path);
    return file.exists() && isDirectoryLike(file);
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

export type ResolvedProfile =
  /** A well-formed, existing profile: run scoped as `-p <name>`. */
  | { kind: "profile"; name: string }
  /** No profile was requested: the default profile is the intended target. */
  | { kind: "default" }
  /** A profile WAS requested but cannot be used. Callers must not fall back. */
  | { kind: "invalid"; requested: string };

/**
 * Resolve a configured profile name into an explicit decision.
 *
 * Differs from `resolveHermesProfile` in one way that matters: it never
 * conflates "no profile requested" with "profile requested but broken". The
 * distinction is what lets a caller refuse to start rather than silently
 * connecting as the default profile, which would expose the personal memory
 * this feature exists to scope away.
 *
 * @param configuredName - The name from preferences (may be empty).
 * @param hermesHome - The Hermes home directory (`HOME/.hermes`), or `""`.
 */
export function resolveConfiguredProfile(
  configuredName: string,
  hermesHome: string,
): ResolvedProfile {
  const name = (configuredName || "").trim();
  if (!name) return { kind: "default" };
  if (!isValidProfileName(name) || !profileExists(name, hermesHome)) {
    return { kind: "invalid", requested: name };
  }
  return { kind: "profile", name };
}

/**
 * Check whether a profile name is usable, returning the reason when it is not.
 *
 * @param configuredName - The name from preferences (may be empty).
 * @param hermesHome - The Hermes home directory (`HOME/.hermes`), or `""`.
 * @returns `null` when usable (or intentionally blank); otherwise a message
 *          suitable for surfacing to the user.
 */
export function describeProfileProblem(
  configuredName: string,
  hermesHome: string,
): string | null {
  const resolved = resolveConfiguredProfile(configuredName, hermesHome);
  if (resolved.kind !== "invalid") return null;
  return (
    `Hermes profile "${resolved.requested}" is invalid or does not exist under ` +
    `${hermesHome}/profiles/. Create it with: hermes profile create ${resolved.requested}`
  );
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
  const resolved = resolveConfiguredProfile(configuredName, hermesHome);
  return resolved.kind === "profile" ? resolved.name : null;
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
