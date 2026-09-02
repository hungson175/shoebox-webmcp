/* Shoebox H0/H1 capability probe. Local browser APIs only; no remote inputs. */

export const PROBE_TIMEOUTS = Object.freeze({
  WORKER: 5000,
  INDEXED_DB: 3000,
  OPFS: 5000,
  GPU: 3000,
});

export const MAX_TIMEOUT_MS = Math.max(...Object.values(PROBE_TIMEOUTS));
export const KNOWN_ERROR_NAMES = Object.freeze(["NotSupportedError", "AbortError", "NotAllowedError"]);
const IDB_DATABASE = "shoebox-probe";
const IDB_STORE = "probe-results";
const IDB_KEY = "round-trip";
const OPFS_PREFIX = "probe-";
const OPFS_FILE = "byte-check.bin";
const OPFS_MOVED_FILE = "byte-check-moved.bin";
const PROBE_BYTES = new Uint8Array([83, 72, 79, 69, 66, 79, 88, 45, 80, 82, 79, 66, 69]);
const RESULT_STATES = Object.freeze(["PASS", "FAIL", "UNAVAILABLE"]);
const RESULT_IMPACTS = Object.freeze(["NONE", "KILL", "GAP", "FALLBACK"]);

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function cloneAndFreeze(value) {
  const copy = typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
  return freezeDeep(copy);
}

function clock() {
  return typeof performance?.now === "function" ? performance.now() : Date.now();
}

function durationSince(start) {
  return Math.max(0, Math.round(clock() - start));
}

function namedError(name, message) {
  if (typeof DOMException === "function") return new DOMException(message, name);
  const error = new Error(message);
  error.name = name;
  return error;
}

function errorName(error) {
  return typeof error?.name === "string" && error.name ? error.name : "Error";
}

export function createResult(name, status, detail, error = null, durationMs = 0, impact = "NONE", extra = {}) {
  const safeStatus = RESULT_STATES.includes(status) ? status : "FAIL";
  const safeImpact = RESULT_IMPACTS.includes(impact) ? impact : "FAIL";
  const safeError = error ? (typeof error === "string" ? error : errorName(error)) : null;
  return freezeDeep({
    name,
    status: safeStatus,
    detail: String(detail),
    errorName: safeError,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
    impact: safeImpact,
    ...extra,
  });
}

function unavailable(name, detail, start, impact = "FALLBACK", extra = {}) {
  return createResult(name, "UNAVAILABLE", detail, null, durationSince(start), impact, extra);
}

function failed(name, error, detail, start, impact, extra = {}) {
  const nameOfError = errorName(error);
  return createResult(name, "FAIL", `${detail} (${nameOfError})`, nameOfError, durationSince(start), impact, extra);
}

export function withTimeout(promise, label, timeoutMs = MAX_TIMEOUT_MS) {
  const requested = Number(timeoutMs);
  const milliseconds = Number.isFinite(requested)
    ? Math.max(1, Math.min(Math.round(requested), MAX_TIMEOUT_MS))
    : MAX_TIMEOUT_MS;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(namedError("TimeoutError", `${label} timed out`)), milliseconds);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || namedError("AbortError", "IndexedDB request failed"));
    request.onblocked = () => reject(namedError("AbortError", "IndexedDB request blocked"));
  });
}

function openProbeDatabase() {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(IDB_DATABASE, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(IDB_STORE)) {
          request.result.createObjectStore(IDB_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || namedError("AbortError", "IndexedDB open failed"));
      request.onblocked = () => reject(namedError("AbortError", "IndexedDB open blocked"));
    } catch (error) {
      reject(error);
    }
  });
}

function deleteProbeDatabase() {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.deleteDatabase(IDB_DATABASE);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || namedError("AbortError", "IndexedDB cleanup failed"));
      request.onblocked = () => reject(namedError("AbortError", "IndexedDB cleanup blocked"));
    } catch (error) {
      reject(error);
    }
  });
}

function idbAction(db, mode, operation) {
  return new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(IDB_STORE, mode);
      const request = operation(transaction.objectStore(IDB_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || namedError("AbortError", "IndexedDB action failed"));
      transaction.onabort = () => reject(transaction.error || namedError("AbortError", "IndexedDB transaction aborted"));
      transaction.onerror = () => reject(transaction.error || namedError("AbortError", "IndexedDB transaction failed"));
    } catch (error) {
      reject(error);
    }
  });
}

async function idbRoundTrip(db) {
  await idbAction(db, "readwrite", (store) => store.put("ok", IDB_KEY));
  const value = await idbAction(db, "readonly", (store) => store.get(IDB_KEY));
  if (value !== "ok") throw namedError("DataError", "IndexedDB round-trip mismatch");
  await idbAction(db, "readwrite", (store) => store.delete(IDB_KEY));
}

export async function probeIndexedDb() {
  const start = clock();
  if (!globalThis.indexedDB || typeof globalThis.indexedDB.open !== "function") {
    return unavailable("indexeddb", "indexedDB.open is unavailable", start, "KILL");
  }
  let db = null;
  let result;
  let cleanupError = null;
  try {
    db = await withTimeout(openProbeDatabase(), "IndexedDB", PROBE_TIMEOUTS.INDEXED_DB);
    await withTimeout(idbRoundTrip(db), "IndexedDB", PROBE_TIMEOUTS.INDEXED_DB);
    result = createResult("indexeddb", "PASS", "put/get/delete round-trip completed", null, durationSince(start), "NONE", {
      cleanup: "PENDING",
    });
  } catch (error) {
    result = failed("indexeddb", error, "IndexedDB put/get/delete failed", start, "KILL");
  } finally {
    try {
      db?.close();
      await withTimeout(deleteProbeDatabase(), "IndexedDB cleanup", PROBE_TIMEOUTS.INDEXED_DB);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError) {
    return failed("indexeddb", cleanupError, "IndexedDB cleanup failed", start, "KILL", { cleanup: "FAIL" });
  }
  return createResult(result.name, result.status, result.detail, result.errorName, durationSince(start), result.impact, {
    ...result,
    cleanup: "PASS",
  });
}

function workerMessage(worker) {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event) => resolve(event.data);
    worker.onerror = (event) => reject(event.error || namedError("ErrorEvent", "Worker error"));
    worker.postMessage("round-trip");
  });
}

export async function probeWorker() {
  const start = clock();
  if (typeof Worker !== "function" || typeof Blob !== "function" || typeof URL?.createObjectURL !== "function") {
    return unavailable("worker", "new Worker is unavailable", start, "KILL");
  }
  let worker = null;
  let objectUrl = null;
  try {
    const source = 'self.onmessage = () => self.postMessage("shoebox-probe-ok");';
    objectUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    worker = new Worker(objectUrl, { type: "module" });
    const response = await withTimeout(workerMessage(worker), "Worker", PROBE_TIMEOUTS.WORKER);
    if (response !== "shoebox-probe-ok") throw namedError("DataError", "Worker response mismatch");
    return createResult("worker", "PASS", "dedicated Worker round-trip completed", null, durationSince(start), "NONE");
  } catch (error) {
    return failed("worker", error, "dedicated Worker round-trip failed", start, "KILL");
  } finally {
    worker?.terminate();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

export async function probeImageBitmap() {
  const start = clock();
  if (typeof OffscreenCanvas !== "function" || typeof createImageBitmap !== "function") {
    return unavailable("createImageBitmap", "OffscreenCanvas or createImageBitmap is unavailable", start, "FALLBACK");
  }
  let bitmap = null;
  try {
    const canvas = new OffscreenCanvas(64, 64);
    const context = canvas.getContext("2d");
    if (!context) throw namedError("NotSupportedError", "OffscreenCanvas 2d context unavailable");
    context.fillStyle = "#4776e6";
    context.fillRect(0, 0, 64, 64);
    bitmap = await withTimeout(createImageBitmap(canvas), "createImageBitmap", 3000);
    if (!bitmap) throw namedError("NotSupportedError", "createImageBitmap returned no bitmap");
    return createResult("createImageBitmap", "PASS", "generated local OffscreenCanvas decoded", null, durationSince(start), "NONE");
  } catch (error) {
    return failed("createImageBitmap", error, "generated local image decode failed", start, "FALLBACK");
  } finally {
    bitmap?.close();
  }
}

function randomProbeSuffix() {
  const bytes = new Uint32Array(1);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return bytes[0].toString(36);
  }
  return Math.floor(Math.random() * 0xffffffff).toString(36);
}

function probeDirectoryName() {
  return `${OPFS_PREFIX}${Date.now().toString(36)}-${randomProbeSuffix()}`;
}

async function writeProbeBytes(fileHandle) {
  let writable = null;
  try {
    writable = await fileHandle.createWritable();
    await writable.write(PROBE_BYTES);
  } finally {
    try {
      await writable?.close();
    } catch {
      // The primary write error, if any, is more useful than a close error.
    }
  }
}

async function readProbeBytes(fileHandle) {
  const file = await fileHandle.getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== PROBE_BYTES.length || bytes.some((byte, index) => byte !== PROBE_BYTES[index])) {
    throw namedError("DataError", "OPFS byte check mismatch");
  }
}

async function removeProbeEntries(root, names) {
  let firstError = null;
  for (const name of [...names].reverse()) {
    try {
      await withTimeout(root.removeEntry(name, { recursive: true }), "OPFS cleanup", PROBE_TIMEOUTS.OPFS);
    } catch (error) {
      firstError ||= error;
    }
  }
  if (firstError) throw firstError;
}

export async function probeOpfs() {
  const start = clock();
  const storage = globalThis.navigator?.storage;
  if (!storage || typeof storage.getDirectory !== "function") {
    return unavailable("opfs", "navigator.storage.getDirectory is unavailable", start, "KILL");
  }
  let root = null;
  const createdNames = [];
  let result;
  let cleanupError = null;
  try {
    root = await withTimeout(storage.getDirectory(), "OPFS", PROBE_TIMEOUTS.OPFS);
    const directoryName = probeDirectoryName();
    const movedDirectoryName = `${directoryName}-move`;
    const sourceDirectory = await withTimeout(
      root.getDirectoryHandle(directoryName, { create: true }),
      "OPFS directory",
      PROBE_TIMEOUTS.OPFS,
    );
    createdNames.push(directoryName);
    const movedDirectory = await withTimeout(
      root.getDirectoryHandle(movedDirectoryName, { create: true }),
      "OPFS move directory",
      PROBE_TIMEOUTS.OPFS,
    );
    createdNames.push(movedDirectoryName);
    const sourceFile = await withTimeout(
      sourceDirectory.getFileHandle(OPFS_FILE, { create: true }),
      "OPFS file",
      PROBE_TIMEOUTS.OPFS,
    );
    await withTimeout(writeProbeBytes(sourceFile), "OPFS write", PROBE_TIMEOUTS.OPFS);
    await withTimeout(readProbeBytes(sourceFile), "OPFS read", PROBE_TIMEOUTS.OPFS);

    let moveStatus = "PASS";
    let moveError = null;
    if (typeof sourceFile.move !== "function") {
      moveStatus = "FAIL";
      moveError = namedError("NotSupportedError", "OPFS move is unavailable");
    } else {
      try {
        await withTimeout(sourceFile.move(movedDirectory, OPFS_MOVED_FILE), "OPFS move", PROBE_TIMEOUTS.OPFS);
        const movedFile = await withTimeout(
          movedDirectory.getFileHandle(OPFS_MOVED_FILE),
          "OPFS moved file",
          PROBE_TIMEOUTS.OPFS,
        );
        await withTimeout(readProbeBytes(movedFile), "OPFS moved-file read", PROBE_TIMEOUTS.OPFS);
      } catch (error) {
        moveStatus = "FAIL";
        moveError = error;
      }
    }
    const moveDetail = moveStatus === "PASS"
      ? "directory acquire and byte-exact write/read/move completed"
      : `directory acquire and byte-exact write/read passed; move failed (${errorName(moveError)})`;
    result = createResult("opfs", "PASS", moveDetail, moveError, durationSince(start), moveStatus === "PASS" ? "NONE" : "GAP", {
      subchecks: { writeRead: "PASS", move: moveStatus },
      fallback: moveStatus === "PASS" ? null : "copy-verify-remove",
      cleanup: "PENDING",
    });
  } catch (error) {
    result = failed("opfs", error, "OPFS write/read capability failed", start, "KILL", {
      subchecks: { writeRead: "FAIL", move: "UNAVAILABLE" },
      cleanup: "PENDING",
    });
  } finally {
    if (root && createdNames.length) {
      try {
        await removeProbeEntries(root, createdNames);
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  if (cleanupError) {
    return failed("opfs", cleanupError, "OPFS cleanup failed", start, "KILL", {
      ...(result?.subchecks ? { subchecks: result.subchecks } : {}),
      cleanup: "FAIL",
    });
  }
  return createResult(result.name, result.status, result.detail, result.errorName, durationSince(start), result.impact, {
    ...result,
    cleanup: "PASS",
  });
}

export function probePickerPresence() {
  const start = clock();
  if (typeof globalThis.showDirectoryPicker !== "function") {
    return unavailable("picker", "showDirectoryPicker is unavailable; stock Chrome fallback", start, "FALLBACK", {
      humanOutcome: "UNAVAILABLE",
    });
  }
  return createResult("picker", "PASS", "showDirectoryPicker is present; human click required", null, durationSince(start), "FALLBACK", {
    humanOutcome: "UNAVAILABLE",
  });
}

export async function onHumanPickerClick(event) {
  const start = clock();
  if (!event?.isTrusted) {
    return failed("picker", namedError("NotAllowedError", "untrusted picker click ignored"), "human picker click rejected", start, "FALLBACK", {
      humanOutcome: "FAIL",
    });
  }
  if (typeof globalThis.showDirectoryPicker !== "function") {
    return unavailable("picker", "showDirectoryPicker is unavailable; stock Chrome fallback", start, "FALLBACK", {
      humanOutcome: "UNAVAILABLE",
    });
  }
  try {
    const handle = await globalThis.showDirectoryPicker();
    void handle;
    return createResult("picker", "PASS", "human picker returned a directory handle; name withheld", null, durationSince(start), "FALLBACK", {
      humanOutcome: "PASS",
    });
  } catch (error) {
    const nameOfError = errorName(error);
    const status = nameOfError === "AbortError" || nameOfError === "NotAllowedError" ? "UNAVAILABLE" : "FAIL";
    return createResult("picker", status, `human picker did not return a handle (${nameOfError})`, nameOfError, durationSince(start), "FALLBACK", {
      humanOutcome: status === "UNAVAILABLE" ? "UNAVAILABLE" : "FAIL",
    });
  }
}

export function probeDropHandle() {
  const start = clock();
  const prototype = globalThis.DataTransferItem?.prototype;
  if (!prototype || typeof prototype.getAsFileSystemHandle !== "function") {
    return unavailable("dropHandle", "DataTransferItem.getAsFileSystemHandle is unavailable", start, "FALLBACK");
  }
  return createResult("dropHandle", "PASS", "DataTransferItem.getAsFileSystemHandle is present", null, durationSince(start), "FALLBACK");
}

export function probeWebkitDirectory() {
  const start = clock();
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    return unavailable("webkitdirectory", "input.webkitdirectory cannot be inspected here", start, "FALLBACK");
  }
  const input = document.createElement("input");
  const supported = "webkitdirectory" in input;
  return supported
    ? createResult("webkitdirectory", "PASS", "input.webkitdirectory is present", null, durationSince(start), "FALLBACK")
    : unavailable("webkitdirectory", "input.webkitdirectory is unavailable", start, "FALLBACK");
}

export async function probeGpu() {
  const start = clock();
  const gpu = globalThis.navigator?.gpu;
  if (!gpu || typeof gpu.requestAdapter !== "function") {
    return unavailable("webgpu", "navigator.gpu.requestAdapter is unavailable; WASM fallback", start, "FALLBACK");
  }
  try {
    const adapter = await withTimeout(gpu.requestAdapter(), "WebGPU", PROBE_TIMEOUTS.GPU);
    if (!adapter) return unavailable("webgpu", "navigator.gpu.requestAdapter returned no adapter; WASM fallback", start, "FALLBACK");
    return createResult("webgpu", "PASS", "navigator.gpu.requestAdapter returned an adapter", null, durationSince(start), "FALLBACK");
  } catch (error) {
    return failed("webgpu", error, "navigator.gpu.requestAdapter failed; WASM fallback", start, "FALLBACK");
  }
}

export async function runAutomaticProbes() {
  return Promise.all([
    probeWorker(),
    probeIndexedDb(),
    probeImageBitmap(),
    probeOpfs(),
    probePickerPresence(),
    probeDropHandle(),
    probeWebkitDirectory(),
    probeGpu(),
  ]);
}

let visibleResults = [];

export function setVisibleResults(results) {
  visibleResults = cloneAndFreeze(results);
  renderResults(visibleResults);
  return visibleResults;
}

export function getVisibleResults() {
  return visibleResults;
}

const RESULT_ELEMENT_IDS = Object.freeze({
  worker: "status-worker",
  indexeddb: "status-indexeddb",
  createImageBitmap: "status-createimagebitmap",
  opfs: "status-opfs",
  picker: "status-picker",
  dropHandle: "status-drop-handle",
  webkitdirectory: "status-webkitdirectory",
  webgpu: "status-webgpu",
});

function resultDetail(result) {
  const facts = [result.detail];
  if (result.errorName) facts.push(`error: ${result.errorName}`);
  if (result.impact !== "NONE") facts.push(`impact: ${result.impact}`);
  return facts.join(" · ");
}

function renderResults(results) {
  if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
  for (const result of results) {
    const item = document.getElementById(RESULT_ELEMENT_IDS[result.name]);
    if (!item) continue;
    const state = item.querySelector?.(".state");
    const detail = item.querySelector?.(".detail");
    if (state) state.textContent = result.status;
    if (detail) detail.textContent = `${resultDetail(result)} · ${result.durationMs} ms`;
  }
  const picker = results.find((result) => result.name === "picker");
  if (picker) {
    const pickerResult = document.getElementById("picker-result");
    if (pickerResult) pickerResult.textContent = `Picker result: ${picker.humanOutcome || "UNAVAILABLE"} — ${resultDetail(picker)}`;
  }
}

function publishPickerResult(result) {
  const next = visibleResults.filter((item) => item.name !== "picker");
  setVisibleResults([...next, result]);
}

function bindHumanPicker() {
  if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
  const button = document.getElementById("human-picker");
  button?.addEventListener("click", (event) => {
    if (!event.isTrusted) {
      onHumanPickerClick(event).then(publishPickerResult).catch(() => undefined);
      return;
    }
    onHumanPickerClick(event).then(publishPickerResult).catch((error) => {
      publishPickerResult(failed("picker", error, "human picker handler failed", clock(), "FALLBACK", { humanOutcome: "FAIL" }));
    });
  });
}

export function statusToolDescriptor() {
  return {
    name: "shoebox_probe_status",
    description: "Return the local Shoebox capability results; this read-only tool never opens a folder picker.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async execute() {
      return cloneAndFreeze(visibleResults);
    },
  };
}

export async function registerProbeStatusTool() {
  const context = typeof document !== "undefined" ? document.modelContext : undefined;
  if (!context || typeof context.registerTool !== "function") {
    return { registered: false, reason: "document.modelContext is unavailable" };
  }
  const controller = new AbortController();
  const descriptor = statusToolDescriptor();
  await context.registerTool(descriptor, { signal: controller.signal });
  return { registered: true, descriptor, controller };
}

export async function startProbe() {
  bindHumanPicker();
  const results = await runAutomaticProbes();
  setVisibleResults(results);
  const registration = await registerProbeStatusTool();
  const toolStatus = document.getElementById("tool-status");
  if (toolStatus) {
    toolStatus.textContent = registration.registered
      ? "WebMCP status tool: PASS — registered after automatic probes settled."
      : "WebMCP status tool: UNAVAILABLE — browser has no document.modelContext.";
  }
  return { results, registration };
}

if (typeof document !== "undefined") {
  startProbe().catch((error) => {
    const fallback = failed("probe", error, "automatic probe runner failed", clock(), "KILL");
    setVisibleResults([fallback]);
  });
}
