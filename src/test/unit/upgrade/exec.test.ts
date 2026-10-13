import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { runExec } from "../../../upgrade/exec";

const NODE = process.execPath;

function request(args: string[], overrides: Partial<Parameters<typeof runExec>[0]> = {}): Parameters<typeof runExec>[0] {
  return {
    executable: NODE,
    args,
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxOutputBytes: 4_000,
    knownSecrets: [],
    signal: new AbortController().signal,
    ...overrides
  };
}

describe("runExec", () => {
  it("reports a zero exit code and captures output", async () => {
    const result = await runExec(request(["-e", "console.log('hello from child')"]));
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.match(result.output, /hello from child/);
  });

  it("reports a non-zero exit code", async () => {
    const result = await runExec(request(["-e", "console.error('bad'); process.exit(3)"]));
    assert.equal(result.exitCode, 3);
    assert.match(result.output, /bad/);
  });

  it("does not interpret shell metacharacters (no shell is involved)", async () => {
    const result = await runExec(request(["-e", "console.log(process.argv.slice(1).join('|'))", "a;echo INJECTED"]));
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /a;echo INJECTED/);
    assert.doesNotMatch(result.output.replace("a;echo INJECTED", ""), /^INJECTED$/m);
  });

  it("stops a command that exceeds its timeout", async () => {
    const result = await runExec(request(["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 200 }));
    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
  });

  it("stops a command when the signal is aborted", async () => {
    const controller = new AbortController();
    const pending = runExec(request(["-e", "setTimeout(() => {}, 60000)"], { signal: controller.signal }));
    setTimeout(() => {
      controller.abort();
    }, 150);
    const result = await pending;
    assert.equal(result.cancelled, true);
  });

  it("redacts known secrets from output", async () => {
    const result = await runExec(request(["-e", "console.log('token=sk-secretvalue123456')"], { knownSecrets: ["sk-secretvalue123456"] }));
    assert.doesNotMatch(result.output, /sk-secretvalue123456/);
    assert.match(result.output, /REDACTED/);
  });

  it("caps output and keeps the newest part", async () => {
    const script = "for (let i = 0; i < 2000; i++) console.log('line ' + i); console.log('END-MARKER');";
    const result = await runExec(request(["-e", script], { maxOutputBytes: 500 }));
    assert.equal(result.outputTruncated, true);
    assert.match(result.output, /END-MARKER/);
    assert.ok(result.output.length <= 1_600);
  });

  it("reports a spawn error for a missing executable", async () => {
    const result = await runExec(request([], { executable: "/nonexistent/patchpilot-binary" }));
    assert.equal(result.exitCode, null);
    assert.ok(result.spawnError !== undefined);
  });
});
