import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { chooseCleanTarget, MAX_TARGET_CANDIDATES, newerStableCandidates } from "../../../upgrade/targets";
import { registryPackage } from "./helpers";

describe("newerStableCandidates", () => {
  it("returns stable versions newer than current, newest first", () => {
    const registry = registryPackage({ ecosystem: "npm", name: "a", versions: ["1.0.0", "1.2.0", "1.1.0", "0.9.0", "2.0.0-beta.1"] });
    assert.deepEqual(newerStableCandidates("npm", "1.0.0", registry), ["1.2.0", "1.1.0"]);
  });

  it("excludes npm-deprecated and PyPI-yanked versions", () => {
    const npm = registryPackage({ ecosystem: "npm", name: "a", versions: ["1.0.0", "1.1.0", "1.2.0"], deprecated: { "1.2.0": "bad" } });
    assert.deepEqual(newerStableCandidates("npm", "1.0.0", npm), ["1.1.0"]);
    const pypi = registryPackage({ ecosystem: "pypi", name: "x", versions: ["1.0", "1.1", "1.2"], yanked: ["1.2"] });
    assert.deepEqual(newerStableCandidates("pypi", "1.0", pypi), ["1.1"]);
  });

  it("excludes Maven pre-releases such as -RC and -SNAPSHOT", () => {
    const registry = registryPackage({ ecosystem: "maven", name: "g:a", versions: ["3.5", "3.6.0-RC1", "3.6.0-SNAPSHOT", "3.6.0"] });
    assert.deepEqual(newerStableCandidates("maven", "3.5", registry), ["3.6.0"]);
  });

  it("limits the list to the top candidates", () => {
    const versions = Array.from({ length: 9 }, (_, i) => `1.${String(i + 1)}.0`);
    const registry = registryPackage({ ecosystem: "npm", name: "a", versions: ["1.0.0", ...versions] });
    const candidates = newerStableCandidates("npm", "1.0.0", registry);
    assert.equal(candidates.length, MAX_TARGET_CANDIDATES);
    assert.equal(candidates[0], "1.9.0");
  });
});

describe("chooseCleanTarget", () => {
  it("picks the newest candidate with zero advisories", () => {
    const counts = new Map([["2.0.0", 1], ["1.9.0", 0], ["1.8.0", 0]]);
    assert.equal(chooseCleanTarget(["2.0.0", "1.9.0", "1.8.0"], counts), "1.9.0");
  });

  it("treats unknown candidates as not clean", () => {
    assert.equal(chooseCleanTarget(["2.0.0"], new Map()), undefined);
  });

  it("returns undefined when every candidate has advisories", () => {
    assert.equal(chooseCleanTarget(["2.0.0", "1.9.0"], new Map([["2.0.0", 2], ["1.9.0", 1]])), undefined);
  });
});
