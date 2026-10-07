import { expect } from "chai";
import {
  buildAcpArguments,
  describeProfileProblem,
  isDirectoryLike,
  isValidProfileName,
  profileExists,
  resolveConfiguredProfile,
  resolveHermesProfile,
} from "../src/modules/hermes/HermesProfile";

/**
 * These tests exercise the profile gate that decides whether the ACP session
 * runs scoped (`hermes -p <name> acp`) or against the default profile. Three
 * behaviours matter and all are asserted here:
 *
 *   1. Only a well-formed name pointing at an existing profile *directory* is
 *      passed through — anything else resolves to `null` (default profile),
 *      because `hermes -p <missing> acp` exits immediately.
 *   2. A regular file that happens to carry a profile name must NOT count as a
 *      profile (that is what `isDirectory` is doing in this check).
 *   3. The argument array is exactly `["acp"]` or `["-p", name, "acp"]`, so a
 *      configured name cannot inject extra CLI arguments.
 *
 * Filesystem setup uses raw XPCOM (`@mozilla.org/file/local;1`) rather than
 * `Zotero.File.pathToFile`, deliberately: earlier test files in this suite
 * replace the `Zotero` global with mocks, and mocha runs every suite's `before`
 * hooks before the first test — so `Zotero.File` is NOT trustworthy here.
 * The production `fileExists()` likewise goes through raw Components, so this
 * test exercises the same path the plugin does.
 */
describe("HermesProfile", function () {
  let NS_IFILE_DIRECTORY = 0;
  let NS_IFILE_FILE = 0;
  let base = "";

  /** Raw XPCOM nsIFile for a path — independent of any Zotero mock. */
  function rawFile(path: string): any {
    const file = (Components.classes as any)[
      "@mozilla.org/file/local;1"
    ].createInstance(Components.interfaces.nsIFile);
    file.initWithPath(path);
    return file;
  }

  function mkdir(path: string): void {
    const dir = rawFile(path);
    if (!dir.exists()) dir.create(NS_IFILE_DIRECTORY, 0o755);
  }

  function mkfile(path: string): void {
    const file = rawFile(path);
    if (!file.exists()) file.create(NS_IFILE_FILE, 0o644);
  }

  before(function () {
    // nsIFile constants are read inside the hook, not at describe scope
    // (mocha/no-setup-in-describe).
    NS_IFILE_DIRECTORY = Components.interfaces.nsIFile.DIRECTORY_TYPE;
    NS_IFILE_FILE = Components.interfaces.nsIFile.NORMAL_FILE_TYPE;

    const props = (Components.classes as any)[
      "@mozilla.org/file/directory_service;1"
    ].getService(Components.interfaces.nsIProperties);
    const tmp = props.get("TmpD", Components.interfaces.nsIFile) as nsIFile;
    // Only ONE component is appended: create() does not make intermediate
    // directories, so a nested path would fail here.
    base = `${tmp.path}/hermes-profile-test-${Date.now()}-${Math.floor(
      Math.random() * 1e6,
    )}`;

    mkdir(base);
    mkdir(`${base}/profiles`);
    // Two real profile directories, and a plain file that claims a profile
    // name (which must NOT count as a profile).
    mkdir(`${base}/profiles/zotero-hermes`);
    mkdir(`${base}/profiles/enodios`);
    mkfile(`${base}/profiles/not-a-directory`);

    // Fail loudly rather than letting every fs-dependent assertion report a
    // misleading negative if setup silently failed.
    expect(rawFile(base).exists(), `setup dir should exist: ${base}`).to.equal(
      true,
    );
    expect(
      rawFile(`${base}/profiles/zotero-hermes`).exists(),
      "profile dir should exist",
    ).to.equal(true);
    expect(
      rawFile(`${base}/profiles/not-a-directory`).exists(),
      "decoy file should exist",
    ).to.equal(true);
  });

  after(function () {
    try {
      const dir = rawFile(base);
      if (dir.exists()) dir.remove(true);
    } catch {
      // Best effort — the OS reclaims the temp dir regardless.
    }
  });

  describe("isDirectoryLike", function () {
    it("accepts a boolean property (the documented nsIFile shape)", function () {
      expect(isDirectoryLike({ isDirectory: true })).to.equal(true);
      expect(isDirectoryLike({ isDirectory: false })).to.equal(false);
    });

    it("accepts a method (the shape this runtime actually returns)", function () {
      expect(isDirectoryLike({ isDirectory: () => true })).to.equal(true);
      expect(isDirectoryLike({ isDirectory: () => false })).to.equal(false);
    });

    it("never treats a method reference as truthy", function () {
      // The dangerous failure mode: reading a method as a bare property is
      // always truthy, which would make a regular FILE pass a directory check.
      expect(isDirectoryLike({ isDirectory: () => false })).to.equal(false);
    });

    it("is false for a missing or undefined shape", function () {
      expect(isDirectoryLike({})).to.equal(false);
      expect(isDirectoryLike({ isDirectory: undefined })).to.equal(false);
    });
  });

  describe("isValidProfileName", function () {
    it("accepts the names the CLI accepts", function () {
      expect(isValidProfileName("zotero-hermes")).to.equal(true);
      expect(isValidProfileName("enodios")).to.equal(true);
      expect(isValidProfileName("coder_2")).to.equal(true);
      expect(isValidProfileName("a")).to.equal(true);
    });

    it("rejects path traversal and shell-shaped input", function () {
      expect(isValidProfileName("../../etc/passwd")).to.equal(false);
      expect(isValidProfileName("a/b")).to.equal(false);
      expect(isValidProfileName("../enodios")).to.equal(false);
      expect(isValidProfileName("-p")).to.equal(false);
      expect(isValidProfileName("--profile")).to.equal(false);
      expect(isValidProfileName("has space")).to.equal(false);
      expect(isValidProfileName("")).to.equal(false);
      expect(isValidProfileName("UPPER")).to.equal(false);
    });
  });

  describe("profileExists", function () {
    it("is true for a real profile directory", function () {
      expect(profileExists("zotero-hermes", base)).to.equal(true);
      expect(profileExists("enodios", base)).to.equal(true);
    });

    it("is false for a name with no directory", function () {
      expect(profileExists("missing", base)).to.equal(false);
    });

    it("is false when the path exists but is a FILE", function () {
      expect(profileExists("not-a-directory", base)).to.equal(false);
    });

    it("is false without a home directory", function () {
      expect(profileExists("zotero-hermes", "")).to.equal(false);
    });

    it("is false for a malformed name", function () {
      expect(profileExists("../profiles", base)).to.equal(false);
    });

    it("tolerates a trailing slash on the home directory", function () {
      expect(profileExists("zotero-hermes", `${base}/`)).to.equal(true);
    });
  });

  describe("resolveHermesProfile", function () {
    it("returns null for an empty preference (use the default profile)", function () {
      expect(resolveHermesProfile("", base)).to.equal(null);
      expect(resolveHermesProfile("   ", base)).to.equal(null);
    });

    it("returns the name when the profile exists", function () {
      expect(resolveHermesProfile("zotero-hermes", base)).to.equal(
        "zotero-hermes",
      );
    });

    it("returns null for a configured name that does not exist", function () {
      expect(resolveHermesProfile("not-created", base)).to.equal(null);
    });

    it("returns null for a name that is only a file", function () {
      expect(resolveHermesProfile("not-a-directory", base)).to.equal(null);
    });

    it("returns null for a malformed name", function () {
      expect(resolveHermesProfile("../..", base)).to.equal(null);
    });

    it("trims surrounding whitespace from a pasted name", function () {
      expect(resolveHermesProfile("  zotero-hermes  ", base)).to.equal(
        "zotero-hermes",
      );
    });
  });

  describe("resolveConfiguredProfile", function () {
    it("reports the default profile only for an intentionally blank setting", function () {
      expect(resolveConfiguredProfile("", base)).to.deep.equal({
        kind: "default",
      });
      expect(resolveConfiguredProfile("   ", base)).to.deep.equal({
        kind: "default",
      });
    });

    it("reports a profile when the name is valid and exists", function () {
      expect(resolveConfiguredProfile("zotero-hermes", base)).to.deep.equal({
        kind: "profile",
        name: "zotero-hermes",
      });
    });

    // The whole point of this function: a requested-but-unusable profile must
    // NOT be reported as "default", because the caller would then connect as
    // the default profile and expose the personal memory scoping exists to
    // keep out. resolveHermesProfile returns null for all three cases below;
    // this must distinguish them from a blank setting.
    it("reports invalid (not default) for a name that does not exist", function () {
      expect(resolveConfiguredProfile("not-created", base)).to.deep.equal({
        kind: "invalid",
        requested: "not-created",
      });
    });

    it("reports invalid (not default) for a name that is only a file", function () {
      expect(resolveConfiguredProfile("not-a-directory", base)).to.deep.equal({
        kind: "invalid",
        requested: "not-a-directory",
      });
    });

    it("reports invalid (not default) for a malformed name", function () {
      expect(resolveConfiguredProfile("../..", base)).to.deep.equal({
        kind: "invalid",
        requested: "../..",
      });
    });

    it("reports invalid when no hermes home is known", function () {
      expect(resolveConfiguredProfile("zotero-hermes", "")).to.deep.equal({
        kind: "invalid",
        requested: "zotero-hermes",
      });
    });
  });

  describe("describeProfileProblem", function () {
    it("is silent for an intentionally blank setting", function () {
      expect(describeProfileProblem("", base)).to.equal(null);
      expect(describeProfileProblem("   ", base)).to.equal(null);
    });

    it("is silent for a usable profile", function () {
      expect(describeProfileProblem("zotero-hermes", base)).to.equal(null);
    });

    it("names the requested profile and the recovery command", function () {
      const problem = describeProfileProblem("not-created", base);
      expect(problem).to.be.a("string");
      expect(problem).to.contain('"not-created"');
      expect(problem).to.contain("hermes profile create not-created");
    });
  });

  describe("buildAcpArguments", function () {
    it("passes no profile flag by default", function () {
      expect(buildAcpArguments(null)).to.deep.equal(["acp"]);
    });

    it("scopes the run with -p before the subcommand", function () {
      expect(buildAcpArguments("zotero-hermes")).to.deep.equal([
        "-p",
        "zotero-hermes",
        "acp",
      ]);
    });

    it("refuses to emit a flag for a malformed profile", function () {
      expect(buildAcpArguments("../../etc/passwd")).to.deep.equal(["acp"]);
      expect(buildAcpArguments("")).to.deep.equal(["acp"]);
    });
  });
});
