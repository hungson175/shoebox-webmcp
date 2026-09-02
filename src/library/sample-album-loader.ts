import { CustodyLedger } from "./custody-ledger.js";
import type { DirectoryHandleLike, LibraryItem } from "./types.js";

interface SampleManifest {
  files: Array<{ path: string }>;
}

interface SampleAlbumLoaderOptions {
  origin: string;
  root: DirectoryHandleLike;
  fetcher?: typeof fetch;
  ledger: CustodyLedger;
}

function containsTraversal(raw: string): boolean {
  const path = raw.split(/[?#]/, 1)[0] ?? raw;
  return path.split("/").some((part) => {
    try {
      return decodeURIComponent(part) === "..";
    } catch {
      return true;
    }
  });
}

function safeRelativePath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || containsTraversal(path)) {
    throw new Error(`unsafe sample path: ${path}`);
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === ".")) throw new Error(`unsafe sample path: ${path}`);
  return parts.join("/");
}

function sameOriginUrl(raw: string, origin: string): URL {
  if (containsTraversal(raw)) throw new Error("URL traversal is not allowed");
  const base = new URL(origin);
  const url = new URL(raw, base);
  if (url.origin !== base.origin) throw new Error("sample assets must be same-origin");
  return url;
}

function isManifest(value: unknown): value is SampleManifest {
  if (!value || typeof value !== "object" || !Array.isArray((value as SampleManifest).files)) return false;
  return (value as SampleManifest).files.every(
    (entry) => Boolean(entry) && typeof entry === "object" && typeof entry.path === "string",
  );
}

async function directoryForPath(
  root: DirectoryHandleLike,
  parts: string[],
): Promise<DirectoryHandleLike> {
  let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
  return directory;
}

export class SampleAlbumLoader {
  private readonly origin: string;
  private readonly root: DirectoryHandleLike;
  private readonly fetcher: typeof fetch;
  private readonly ledger: CustodyLedger;

  constructor(options: SampleAlbumLoaderOptions) {
    this.origin = new URL(options.origin).origin;
    this.root = options.root;
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.ledger = options.ledger;
  }

  async install(manifestPath: string): Promise<LibraryItem[]> {
    const manifestUrl = sameOriginUrl(manifestPath, this.origin);
    const manifestResponse = await this.fetcher(manifestUrl.href);
    if (!manifestResponse.ok) throw new Error(`sample manifest fetch failed: ${manifestResponse.status}`);
    const rawManifest: unknown = await manifestResponse.json();
    if (!isManifest(rawManifest)) throw new Error("invalid sample manifest");

    // Validate the complete manifest before performing the first OPFS write.
    const paths = rawManifest.files.map(({ path }) => safeRelativePath(path));
    const manifestDirectory = new URL(".", manifestUrl);
    const items: LibraryItem[] = [];

    for (const relativePath of paths) {
      const assetUrl = sameOriginUrl(new URL(relativePath, manifestDirectory).href, this.origin);
      const response = await this.fetcher(assetUrl.href);
      if (!response.ok) throw new Error(`sample asset fetch failed (${response.status}): ${relativePath}`);
      const blob = await response.blob();
      const parts = relativePath.split("/");
      const name = parts.pop()!;
      const directory = await directoryForPath(this.root, parts);
      const fileHandle = await directory.getFileHandle(name, { create: true });
      const writer = await fileHandle.createWritable();
      await writer.write(blob);
      await writer.close();
      const storedFile = await fileHandle.getFile();
      items.push({
        id: `sample:${relativePath}`,
        name,
        relativePath,
        size: storedFile.size,
        type: storedFile.type || blob.type,
        lastModified: storedFile.lastModified,
        source: "sample",
        writable: true,
        file: storedFile,
        fileHandle,
        directoryHandle: directory,
      });
    }

    this.ledger.recordIndexed(items);
    return items;
  }
}

export async function openOpfsRoot(
  storage: { getDirectory(): Promise<DirectoryHandleLike> } = navigator.storage as unknown as {
    getDirectory(): Promise<DirectoryHandleLike>;
  },
): Promise<DirectoryHandleLike> {
  return storage.getDirectory();
}
