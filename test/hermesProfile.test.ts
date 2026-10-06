import { expect } from "chai";
import {
  buildAcpArguments,
  isValidProfileName,
  profileExists,
  resolveHermesProfile,
} from "../src/modules/hermes/HermesProfile";

/**
 * These tests exercise the profile gate that decides whether the ACP session
 * runs scoped (`hermes -p <name> acp`) or against the default profile. Two
 * behaviours matter and both are asserted here:
 *
 *   1. Only a well-formed name pointing at an existing profile directory is
 *      passed through — anything else must resolve to `null` (default
 *      profile), because `hermes -p <missing> acp` exits immediately.
 *   2. The argument array is exactly `["acp"]` or `["-p", name, "acp"]`, so a
 *      configured name cannot inject extra CLI arguments.
 */
describe("HermesProfile", function () {
  const HOME = "/tmp/hermes-profile-test-home";

  /**
   * Fake nsIFile surface with a fixed set of existing directories.
   *
   * NOTE: `isDirectory` is modelled as a boolean PROPERTY, not a method —
   * that is how nsIFile actually behaves in the Firefox sandbox, and calling it
   * as a method throws at runtime (see AGENTS.md). A regression test below
   * asserts the method form is never defined, so this stub cannot paper over a
   * `isDirectory()` call in the implementation.
   */
  function stubFileSystem(existing: string[]) {
    (globalThis as any).__realComponents = (globalThis as any).Components;
    const stub = {
      classes: {
        "@mozilla.org/file/local;1": {
          createInstance: () => ({
            initWithPath(path: string) {
              (this as any)._path = path;
            },
            exists() {
              return existing.includes((this as any)._path);
            },
            get isDirectory() {
              return existing.includes((this as any)._path);
            },
            get isExecutable() {
              return true;
            },
          }),
        },
      },
      interfaces: { nsIFile: {} },
    };
    (globalThis as any).Components = stub;
  }

  afterEach(function () {
    if ((globalThis as any).__realComponents) {
      (globalThis as any).Components = (globalThis as any).__realComponents;
      delete (globalThis as any).__realComponents;
    }
  });

  describe("nsIFile shape", function () {
    it("treats isDirectory as a property, not a method", function () {
      // Guards the AGENTS.md gotcha: `isDirectory()` throws in the sandbox.
      // If the implementation regresses to a method call, the stub used by the
      // other tests would silently accept it — so assert it here.
      stubFileSystem([`${HOME}/profiles/zotero-hermes`]);
      const file = ((globalThis as any).Components.classes as any)[
        "@mozilla.org/file/local;1"
      ].createInstance(
        ((globalThis as any).Components.interfaces as any).nsIFile,
      );
      file.initWithPath(`${HOME}/profiles/zotero-hermes`);
      expect(typeof file.isDirectory).to.not.equal("function");
      expect(file.isDirectory).to.equal(true);
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
    it("returns true only for a directory under <home>/profiles/", function () {
      stubFileSystem([`${HOME}/profiles/zotero-hermes`]);
      expect(profileExists("zotero-hermes", HOME)).to.equal(true);
      expect(profileExists("enodios", HOME)).to.equal(false);
    });

    it("is false without a home directory", function () {
      stubFileSystem([`${HOME}/profiles/zotero-hermes`]);
      expect(profileExists("zotero-hermes", "")).to.equal(false);
    });
  });

  describe("resolveHermesProfile", function () {
    it("returns null for an empty preference (use the default profile)", function () {
      stubFileSystem([]);
      expect(resolveHermesProfile("", HOME)).to.equal(null);
      expect(resolveHermesProfile("   ", HOME)).to.equal(null);
    });

    it("returns the name when the profile exists", function () {
      stubFileSystem([`${HOME}/profiles/zotero-hermes`]);
      expect(resolveHermesProfile("zotero-hermes", HOME)).to.equal(
        "zotero-hermes",
      );
    });

    it("returns null for a configured name that does not exist", function () {
      stubFileSystem([`${HOME}/profiles/enodios`]);
      expect(resolveHermesProfile("zotero-hermes", HOME)).to.equal(null);
    });

    it("returns null for a malformed name even if the path exists", function () {
      stubFileSystem([`${HOME}/profiles/../..`]);
      expect(resolveHermesProfile("../..", HOME)).to.equal(null);
    });

    it("trims surrounding whitespace from a pasted name", function () {
      stubFileSystem([`${HOME}/profiles/zotero-hermes`]);
      expect(resolveHermesProfile("  zotero-hermes  ", HOME)).to.equal(
        "zotero-hermes",
      );
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
