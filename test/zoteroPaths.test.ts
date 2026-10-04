import { expect } from "chai";
import {
  ensureHermesDir,
  getDataDir,
  getDataDirPath,
  getProfileDir,
  getProfileDirPath,
} from "../src/utils/zoteroPaths";

/**
 * These run against the REAL Zotero runtime booted by the test harness
 * (zotero-plugin test), not a mock. They lock in the Zotero 10 shape that
 * `zoteroPaths` exists to paper over: `Zotero.Profile.dir` and
 * `Zotero.DataDirectory.dir` are plain STRINGS, and only
 * `Zotero.File.pathToFile()` produces something with `.clone()`/`.append()`.
 *
 * Regression context: the plugin previously did
 *   (Zotero as any).Profile?.dir || Zotero.getProfileDirectory?.()
 * then called `.clone()` on the result. Because `Profile.dir` is a string,
 * `.clone` was undefined and the call threw "p.clone is not a function",
 * silently disabling conversation persistence, the audit log, the agent
 * workspace and local export.
 */
describe("zoteroPaths (live Zotero runtime)", function () {
  it("exposes Profile.dir and DataDirectory.dir as strings", function () {
    const z = Zotero as any;
    expect(typeof z.Profile?.dir).to.equal("string");
    expect(z.Profile.dir.length).to.be.greaterThan(0);
    // clone() is the nsIFile method that does NOT exist on the string path
    expect(typeof z.Profile.dir.clone).to.equal("undefined");
  });

  it("resolves both directories to a real cloneable nsIFile", function () {
    for (const [name, dir, path] of [
      ["profile", getProfileDir(), getProfileDirPath()],
      ["data", getDataDir(), getDataDirPath()],
    ] as const) {
      expect(dir, `${name} dir should resolve`).to.not.be.null;
      expect(typeof (dir as nsIFile).clone).to.equal("function");
      expect((dir as nsIFile).path, `${name} nsIFile.path`).to.equal(path);
      expect(path.length, `${name} path`).to.be.greaterThan(0);
    }
  });

  it("composes <profile>/zotero-hermes/<folder> and never throws", function () {
    const profile = getProfileDir();
    expect(profile, "profile dir should resolve").to.not.be.null;
    const dirPath = ensureHermesDir(profile, "workspace");
    expect(dirPath).to.not.equal("");
    expect(dirPath.endsWith("/zotero-hermes/workspace")).to.be.true;
    // NOTE: directory creation is deliberately NOT asserted here. Earlier
    // test files replace the Zotero global with a mock whose Profile.dir is a
    // non-existent path (/Users/test/...), and the harness itself points
    // Profile.dir at a synthetic path, so create() cannot be observed.
  });

  it("returns an empty path for a null base directory", function () {
    expect(ensureHermesDir(null, "workspace")).to.equal("");
  });
});
