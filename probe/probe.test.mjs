import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const INDEX = path.join(ROOT, "probe", "index.html");
const SCRIPT = path.join(ROOT, "probe", "probe.js");
let probeModulePromise;

const LIVE_ORIGIN_TRIAL_META =
  '<meta http-equiv="origin-trial" content="An2udOLsUVYin2YuygomRe8nO8qa5GA6th8xcWUQwoZ9A4D5wLJUbu1wgHaZbBM6YbHKnaxMD+yCEYiAzS3wrQIAAABUeyJvcmlnaW4iOiJodHRwczovL2h1bmdzb24xNzUuZ2l0aHViLmlvOjQ0MyIsImZlYXR1cmUiOiJXZWJNQ1AiLCJleHBpcnkiOjE3OTQ4NzM2MDB9">';

function readOwned(file, label) {
  assert.equal(fs.existsSync(file), true, `${label} must exist before contract checks`);
  return fs.readFileSync(file, "utf8");
}

async function loadProbeModule() {
  probeModulePromise ??= import("./probe.js?contract-test");
  return probeModulePromise;
}

const tests = [
  ["index has the live origin-trial meta before application scripts", () => {
    const html = readOwned(INDEX, "probe/index.html");
    const metaAt = html.indexOf(LIVE_ORIGIN_TRIAL_META);
    const firstScriptAt = html.search(/<script\b/i);
    assert.notEqual(metaAt, -1, "live placeholder origin-trial meta must be copied exactly");
    assert.notEqual(firstScriptAt, -1, "application script tag is required");
    assert.ok(metaAt < firstScriptAt, "origin-trial meta must precede every application script");
  }],
  ["origin-trial token payload has the live origin, WebMCP feature, and expiry", () => {
    const html = readOwned(INDEX, "probe/index.html");
    const token = html.match(/<meta http-equiv="origin-trial" content="([^"]+)"/i)?.[1];
    assert.ok(token, "origin-trial token must be present in HTML");
    const bytes = Buffer.from(token, "base64");
    const payloadStart = bytes.indexOf(123);
    assert.notEqual(payloadStart, -1, "origin-trial token must contain a JSON payload");
    const payload = JSON.parse(bytes.subarray(payloadStart).toString("utf8"));
    assert.equal(payload.origin, "https://hungson175.github.io:443");
    assert.equal(payload.feature, "WebMCP");
    assert.equal(payload.expiry, 1794873600);
  }],
  ["index visibly exposes every capability result and trusted picker action", () => {
    const html = readOwned(INDEX, "probe/index.html");
    for (const marker of [
      "worker",
      "indexeddb",
      "createimagebitmap",
      "opfs",
      "picker",
      "drop-handle",
      "webkitdirectory",
      "webgpu",
      "PASS",
      "FAIL",
      "UNAVAILABLE",
      "human-picker",
    ]) {
      assert.match(html.toLowerCase(), new RegExp(marker.toLowerCase()), `missing visible marker: ${marker}`);
    }
  }],
  ["index has no remote asset or inline secret boundary", () => {
    const html = readOwned(INDEX, "probe/index.html");
    assert.doesNotMatch(html, /<(?:script|img|link|iframe)\b[^>]+(?:src|href)=["']https?:\/\//i);
    assert.doesNotMatch(html, /(?:api[_-]?key|authorization|password|client[_-]?secret)\s*[:=]/i);
    assert.match(html, /<link\s+rel="icon"\s+href="data:image\/svg\+xml,/i, "probe must not generate a favicon request");
    assert.doesNotMatch(html, /stub pending/i, "judge-visible markup must not describe the live probe as a stub");
  }],
  ["probe source names every bounded automatic capability check", () => {
    const script = readOwned(SCRIPT, "probe/probe.js");
    for (const marker of [
      "Worker",
      "indexedDB",
      "createImageBitmap",
      "navigator.storage.getDirectory",
      ".move(",
      "showDirectoryPicker",
      "getAsFileSystemHandle",
      "webkitdirectory",
      "navigator.gpu",
      "requestAdapter",
      "withTimeout",
      "MAX_TIMEOUT_MS",
      "setTimeout",
    ]) {
      assert.match(script, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing probe marker: ${marker}`);
    }
    assert.match(script, /new Worker\([^;]+\{\s*type\s*:\s*["']module["']\s*\}\)/s, "Worker probe must use a real module Worker");
    assert.match(script, /new OffscreenCanvas\(64,\s*64\)/, "bitmap probe must exercise the accepted 64px canvas");
  }],
  ["probe source exposes the closed harmless status descriptor", () => {
    const script = readOwned(SCRIPT, "probe/probe.js");
    assert.match(script, /shoebox_probe_status/);
    assert.match(script, /additionalProperties\s*:\s*false/);
    assert.match(script, /readOnlyHint\s*:\s*true/);
    assert.match(script, /Object\.freeze/);
    assert.match(script, /registerProbeStatusTool/);
  }],
  ["automatic probes and registration have explicit separate entry points", () => {
    const script = readOwned(SCRIPT, "probe/probe.js");
    assert.match(script, /runAutomaticProbes/);
    assert.match(script, /registerProbeStatusTool/);
    assert.match(script, /onHumanPickerClick/);
  }],
  ["probe result contract carries visible terminal states and bounded error facts", () => {
    const source = `${readOwned(INDEX, "probe/index.html")}\n${readOwned(SCRIPT, "probe/probe.js")}`;
    for (const marker of ["PASS", "FAIL", "UNAVAILABLE", "errorName", "durationMs", "detail"]) {
      assert.match(source, new RegExp(marker), `missing result-contract field: ${marker}`);
    }
  }],
  ["probe source does not read secrets, cookies, paths, or make a network request", () => {
    const script = readOwned(SCRIPT, "probe/probe.js");
    for (const forbidden of [
      /\bfetch\s*\(/i,
      /XMLHttpRequest/i,
      /document\.cookie/i,
      /localStorage/i,
      /sessionStorage/i,
      /navigator\.credentials/i,
      /authorization/i,
      /api[_-]?key/i,
      /client[_-]?secret/i,
    ]) {
      assert.doesNotMatch(script, forbidden, `forbidden boundary in probe source: ${forbidden}`);
    }
  }],
  ["picker is represented as human-only rather than a tool capability", () => {
    const html = readOwned(INDEX, "probe/index.html");
    const script = readOwned(SCRIPT, "probe/probe.js");
    assert.match(html, /human-picker/i);
    assert.match(script, /showDirectoryPicker/);
    assert.doesNotMatch(script, /shoebox_probe_status[\s\S]{0,300}showDirectoryPicker/);
  }],
  ["source contains cleanup, native registration, and fallback/kill control seams", () => {
    const script = readOwned(SCRIPT, "probe/probe.js");
    for (const marker of [
      "Promise.race",
      "indexedDB.deleteDatabase",
      "removeEntry",
      "finally",
      "isTrusted",
      "document.modelContext",
      "structuredClone",
      "KILL",
      "GAP",
      "FALLBACK",
    ]) {
      assert.match(script, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing control seam: ${marker}`);
    }
  }],
  ["runtime exports the exact acceptance timeout contract", async () => {
    const probe = await loadProbeModule();
    assert.deepEqual(probe.PROBE_TIMEOUTS, {
      WORKER: 5000,
      INDEXED_DB: 3000,
      OPFS: 5000,
      GPU: 3000,
    });
  }],
  ["runtime timeout rejects with a visible TimeoutError", async () => {
    const probe = await loadProbeModule();
    await assert.rejects(
      probe.withTimeout(new Promise(() => undefined), "contract-test", 20),
      (error) => error?.name === "TimeoutError",
    );
  }],
  ["runtime status descriptor is closed, read-only, and returns a frozen clone", async () => {
    const probe = await loadProbeModule();
    const visible = [{
      name: "worker",
      status: "PASS",
      detail: "round-trip completed",
      errorName: null,
      durationMs: 1,
      impact: "NONE",
    }];
    probe.setVisibleResults(visible);
    let descriptor;
    globalThis.document = {
      modelContext: {
        async registerTool(value) {
          descriptor = value;
        },
      },
    };
    await probe.registerProbeStatusTool();
    assert.equal(descriptor.name, "shoebox_probe_status");
    assert.deepEqual(descriptor.inputSchema, {
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    assert.deepEqual(descriptor.annotations, { readOnlyHint: true });
    const result = await descriptor.execute({});
    assert.deepEqual(result, visible);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result[0]), true);
    visible[0].status = "FAIL";
    assert.equal(result[0].status, "PASS");
    delete globalThis.document;
  }],
];

async function main() {
  let failures = 0;
  for (const [name, test] of tests) {
    try {
      await test();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${name}: ${error.message}`);
    }
  }

  console.log(`RESULT ${tests.length - failures}/${tests.length} passing`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
