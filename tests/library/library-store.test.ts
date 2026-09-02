import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  BrowserFolderSource,
  BrowserThumbnailPipeline,
  CommitExecutor,
  CustodyLedger,
  IndexedDbPhotoIndex,
  SampleAlbumLoader,
  StagedPlan,
  type DirectoryHandleLike,
  type FileHandleLike,
  type LibraryItem,
} from "../../src/library/index.js";

const bytes = (value: string) => new TextEncoder().encode(value);

class MemoryFileHandle implements FileHandleLike {
  readonly kind = "file" as const;
  move?: (destination: DirectoryHandleLike, newName?: string) => Promise<void>;
  private body: Uint8Array;

  constructor(
    readonly name: string,
    value: string,
    options: { move?: MemoryFileHandle["move"] } = {},
  ) {
    this.body = bytes(value);
    this.move = options.move;
  }

  async getFile(): Promise<File> {
    return new File([this.body], this.name, {
      type: "image/jpeg",
      lastModified: 42,
    });
  }

  async createWritable() {
    return {
      write: async (value: Blob | BufferSource) => {
        this.body = value instanceof Blob
          ? new Uint8Array(await value.arrayBuffer())
          : new Uint8Array(ArrayBuffer.isView(value) ? value.buffer : value);
      },
      close: async () => undefined,
    };
  }

  content(): string {
    return new TextDecoder().decode(this.body);
  }
}

class MemoryDirectoryHandle implements DirectoryHandleLike {
  readonly kind = "directory" as const;
  readonly children = new Map<string, MemoryDirectoryHandle | MemoryFileHandle>();
  readonly removed: string[] = [];

  constructor(readonly name: string, private readonly corruptWrites = false) {}

  add(handle: MemoryDirectoryHandle | MemoryFileHandle) {
    this.children.set(handle.name, handle);
    return handle;
  }

  async *values() {
    yield* this.children.values();
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const current = this.children.get(name);
    if (current instanceof MemoryDirectoryHandle) return current;
    if (!options?.create) throw new DOMException("missing", "NotFoundError");
    const created = new MemoryDirectoryHandle(name, this.corruptWrites);
    this.children.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const current = this.children.get(name);
    if (current instanceof MemoryFileHandle) return current;
    if (!options?.create) throw new DOMException("missing", "NotFoundError");
    const created = new MemoryFileHandle(name, "");
    if (this.corruptWrites) {
      created.createWritable = async () => ({
        write: async () => {
          const corrupt = new MemoryFileHandle(name, "corrupt");
          this.children.set(name, corrupt);
        },
        close: async () => undefined,
      });
    }
    this.children.set(name, created);
    return created;
  }

  async removeEntry(name: string) {
    this.removed.push(name);
    this.children.delete(name);
  }
}

function item(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: "picker:holiday/a.jpg",
    name: "a.jpg",
    relativePath: "holiday/a.jpg",
    size: 3,
    type: "image/jpeg",
    lastModified: 42,
    source: "picker",
    writable: true,
    ...overrides,
  };
}

describe("SampleAlbumLoader", () => {
  it("installs same-origin sample files into nested OPFS paths and counts only local bytes", async () => {
    const root = new MemoryDirectoryHandle("root");
    const ledger = new CustodyLedger();
    const responses = new Map<string, Response>([
      [
        "https://example.test/sample/manifest.json",
        new Response(JSON.stringify({ files: [{ path: "day-1/a.jpg" }, { path: "b.jpg" }] })),
      ],
      ["https://example.test/sample/day-1/a.jpg", new Response("abc", { headers: { "content-type": "image/jpeg" } })],
      ["https://example.test/sample/b.jpg", new Response("12345", { headers: { "content-type": "image/jpeg" } })],
    ]);
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const response = responses.get(String(input));
      if (!response) throw new Error(`unexpected URL ${String(input)}`);
      return response;
    });

    const loader = new SampleAlbumLoader({
      origin: "https://example.test",
      root,
      fetcher,
      ledger,
    });
    const loaded = await loader.install("/sample/manifest.json");

    expect(loaded.map(({ relativePath, writable, source }) => ({ relativePath, writable, source }))).toEqual([
      { relativePath: "day-1/a.jpg", writable: true, source: "sample" },
      { relativePath: "b.jpg", writable: true, source: "sample" },
    ]);
    expect((await (await root.getDirectoryHandle("day-1")).getFileHandle("a.jpg")).content()).toBe("abc");
    expect(ledger.snapshot()).toEqual({
      indexedFiles: 2,
      localBytes: 8,
      bytesUploaded: 0,
      thumbnailGroupsRequested: 0,
      thumbnailPixelsRequested: 0,
    });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith("https://example.test/"))).toBe(true);
  });

  it.each([
    "https://tracker.invalid/manifest.json",
    "/sample/../secret/manifest.json",
  ])("rejects cross-origin and traversing manifest URL %s before fetching", async (manifestUrl) => {
    const fetcher = vi.fn();
    const loader = new SampleAlbumLoader({
      origin: "https://example.test",
      root: new MemoryDirectoryHandle("root"),
      fetcher,
      ledger: new CustodyLedger(),
    });

    await expect(loader.install(manifestUrl)).rejects.toThrow(/same-origin|traversal/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects traversal inside a manifest without writing outside the sample root", async () => {
    const root = new MemoryDirectoryHandle("root");
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ files: [{ path: "../escape.jpg" }] })),
    );
    const loader = new SampleAlbumLoader({
      origin: "https://example.test",
      root,
      fetcher,
      ledger: new CustodyLedger(),
    });

    await expect(loader.install("/manifest.json")).rejects.toThrow(/path/i);
    expect([...root.children]).toHaveLength(0);
  });
});

describe("BrowserFolderSource", () => {
  it("opens a picker read-write and recursively indexes image handles", async () => {
    const root = new MemoryDirectoryHandle("holiday");
    root.add(new MemoryFileHandle("root.jpg", "a"));
    const nested = root.add(new MemoryDirectoryHandle("day-2")) as MemoryDirectoryHandle;
    nested.add(new MemoryFileHandle("nested.png", "bb"));
    nested.add(new MemoryFileHandle("notes.txt", "ignore"));
    const showDirectoryPicker = vi.fn(async () => root);
    const source = new BrowserFolderSource({ showDirectoryPicker });

    const opened = await source.openPicker();

    expect(showDirectoryPicker).toHaveBeenCalledWith({ mode: "readwrite" });
    expect(opened.map((entry) => entry.relativePath)).toEqual(["day-2/nested.png", "root.jpg"]);
    expect(opened.every((entry) => entry.writable && entry.source === "picker")).toBe(true);
  });

  it("reads drag-drop directory handles without converting them to uploadable Files", async () => {
    const root = new MemoryDirectoryHandle("drop");
    root.add(new MemoryFileHandle("one.jpg", "one"));
    const getAsFileSystemHandle = vi.fn(async () => root);
    const source = new BrowserFolderSource();

    const opened = await source.openDroppedItems([
      { kind: "file", getAsFileSystemHandle },
      { kind: "string", getAsFileSystemHandle: vi.fn() },
    ]);

    expect(getAsFileSystemHandle).toHaveBeenCalledOnce();
    expect(opened).toMatchObject([{ relativePath: "one.jpg", source: "drop", writable: true }]);
  });

  it("uses webkitRelativePath as an explicitly read-only fallback", async () => {
    const first = new File(["one"], "one.jpg", { type: "image/jpeg", lastModified: 1 });
    Object.defineProperty(first, "webkitRelativePath", { value: "holiday/day-1/one.jpg" });
    const text = new File(["notes"], "notes.txt", { type: "text/plain" });
    Object.defineProperty(text, "webkitRelativePath", { value: "holiday/notes.txt" });
    const source = new BrowserFolderSource();

    const opened = source.openWebkitFiles([first, text]);

    expect(opened).toMatchObject([
      {
        name: "one.jpg",
        relativePath: "day-1/one.jpg",
        source: "webkit",
        writable: false,
      },
    ]);
    expect(opened[0]?.file).toBe(first);
  });
});

describe("IndexedDbPhotoIndex", () => {
  let factory: IDBFactory;

  beforeEach(() => {
    factory = new IDBFactory();
  });

  it("persists, replaces and lists metadata by stable id", async () => {
    const index = new IndexedDbPhotoIndex({ indexedDB: factory, dbName: "shoebox-test" });
    await index.putMany([item(), item({ id: "sample:b.jpg", name: "b.jpg", relativePath: "b.jpg" })]);
    await index.putMany([item({ size: 99 })]);

    expect(await index.get("picker:holiday/a.jpg")).toMatchObject({ size: 99 });
    expect((await index.list()).map(({ id }) => id)).toEqual(["picker:holiday/a.jpg", "sample:b.jpg"]);
  });

  it("clears only this library index", async () => {
    const index = new IndexedDbPhotoIndex({ indexedDB: factory, dbName: "shoebox-clear" });
    await index.putMany([item()]);
    await index.clear();
    expect(await index.list()).toEqual([]);
  });
});

describe("BrowserThumbnailPipeline", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fits within 96px, closes the bitmap and records exactly the rendered pixels", async () => {
    const close = vi.fn();
    const bitmap = { width: 400, height: 200, close } as unknown as ImageBitmap;
    const render = vi.fn(async () => new Blob(["thumb"], { type: "image/webp" }));
    const ledger = new CustodyLedger();
    const pipeline = new BrowserThumbnailPipeline({
      createImageBitmap: vi.fn(async () => bitmap),
      render,
      maxEdge: 96,
      ledger,
    });

    const result = await pipeline.create(
      new File(["photo"], "a.jpg", { type: "image/jpeg" }),
      { countAsRequested: true },
    );

    expect(render).toHaveBeenCalledWith(bitmap, 96, 48, "image/webp", 0.82);
    expect(result).toMatchObject({ width: 96, height: 48, mimeType: "image/webp" });
    expect(close).toHaveBeenCalledOnce();
    expect(ledger.snapshot().thumbnailPixelsRequested).toBe(96 * 48);
  });

  it("does not count ordinary grid thumbnails as pixels requested by the model", async () => {
    const bitmap = { width: 100, height: 100, close: vi.fn() } as unknown as ImageBitmap;
    const ledger = new CustodyLedger();
    const pipeline = new BrowserThumbnailPipeline({
      createImageBitmap: vi.fn(async () => bitmap),
      render: vi.fn(async () => new Blob(["thumb"])),
      ledger,
    });

    await pipeline.create(new File(["x"], "grid.jpg"));

    expect(ledger.snapshot().thumbnailGroupsRequested).toBe(0);
    expect(ledger.snapshot().thumbnailPixelsRequested).toBe(0);
  });

  it("never upscales a small source and closes the bitmap when rendering fails", async () => {
    const close = vi.fn();
    const bitmap = { width: 40, height: 30, close } as unknown as ImageBitmap;
    const pipeline = new BrowserThumbnailPipeline({
      createImageBitmap: vi.fn(async () => bitmap),
      render: vi.fn(async () => {
        throw new Error("canvas failed");
      }),
      ledger: new CustodyLedger(),
    });

    await expect(pipeline.create(new File(["x"], "x.jpg"))).rejects.toThrow("canvas failed");
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("CommitExecutor", () => {
  it("uses the native move operation when present and does not copy or remove", async () => {
    const source = new MemoryDirectoryHandle("source");
    const target = new MemoryDirectoryHandle("target");
    const move = vi.fn(async () => undefined);
    const handle = source.add(new MemoryFileHandle("a.jpg", "abc", { move })) as MemoryFileHandle;
    const executor = new CommitExecutor();

    const receipt = await executor.execute([
      { id: "move-1", sourceDirectory: source, fileHandle: handle, targetDirectory: target, targetName: "keeper.jpg" },
    ]);

    expect(move).toHaveBeenCalledWith(target, "keeper.jpg");
    expect(target.children).toHaveLength(0);
    expect(source.removed).toEqual([]);
    expect(receipt).toEqual({ committed: 1, movedNatively: 1, copiedAndVerified: 0 });
  });

  it("falls back to copy, byte verification, then removal in that order", async () => {
    const events: string[] = [];
    const source = new MemoryDirectoryHandle("source");
    const target = new MemoryDirectoryHandle("target");
    const handle = source.add(new MemoryFileHandle("a.jpg", "abc")) as MemoryFileHandle;
    const originalGetFileHandle = target.getFileHandle.bind(target);
    target.getFileHandle = async (...args) => {
      const fileHandle = await originalGetFileHandle(...args);
      const originalWritable = fileHandle.createWritable.bind(fileHandle);
      fileHandle.createWritable = async () => {
        const writer = await originalWritable();
        return {
          write: async (value) => {
            events.push("copy");
            await writer.write(value);
          },
          close: writer.close,
        };
      };
      const originalGetFile = fileHandle.getFile.bind(fileHandle);
      fileHandle.getFile = async () => {
        events.push("verify");
        return originalGetFile();
      };
      return fileHandle;
    };
    const originalRemove = source.removeEntry.bind(source);
    source.removeEntry = async (name) => {
      events.push("remove");
      return originalRemove(name);
    };

    const receipt = await new CommitExecutor().execute([
      { id: "move-1", sourceDirectory: source, fileHandle: handle, targetDirectory: target, targetName: "a.jpg" },
    ]);

    expect(events).toEqual(["copy", "verify", "remove"]);
    expect((target.children.get("a.jpg") as MemoryFileHandle).content()).toBe("abc");
    expect(receipt).toEqual({ committed: 1, movedNatively: 0, copiedAndVerified: 1 });
  });

  it("refuses to remove the source when copied bytes do not verify", async () => {
    const source = new MemoryDirectoryHandle("source");
    const target = new MemoryDirectoryHandle("target", true);
    const handle = source.add(new MemoryFileHandle("a.jpg", "abc")) as MemoryFileHandle;

    await expect(
      new CommitExecutor().execute([
        { id: "move-1", sourceDirectory: source, fileHandle: handle, targetDirectory: target, targetName: "a.jpg" },
      ]),
    ).rejects.toThrow(/verification/i);
    expect(source.removed).toEqual([]);
    expect(source.children.has("a.jpg")).toBe(true);
  });
});

describe("StagedPlan", () => {
  it("Discard clears staged moves without touching any file-system handle", () => {
    const source = new MemoryDirectoryHandle("source");
    const target = new MemoryDirectoryHandle("target");
    const handle = source.add(new MemoryFileHandle("a.jpg", "abc")) as MemoryFileHandle;
    const plan = new StagedPlan();
    plan.stage({ id: "move-1", sourceDirectory: source, fileHandle: handle, targetDirectory: target, targetName: "a.jpg" });

    expect(plan.summary()).toEqual({ moves: 1, deletes: 0 });
    plan.discard();

    expect(plan.summary()).toEqual({ moves: 0, deletes: 0 });
    expect(source.children.has("a.jpg")).toBe(true);
    expect(source.removed).toEqual([]);
    expect(target.children).toHaveLength(0);
  });
});
