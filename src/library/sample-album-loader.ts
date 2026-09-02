import { CustodyLedger } from "./custody-ledger.js";
import type { DirectoryHandleLike, LibraryItem } from "./types.js";

interface SampleManifestEntry {
  id: string;
  path: string;
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

function manifestEntries(value: unknown): SampleManifestEntry[] | null {
  if (!value || typeof value !== "object") return null;
  const manifest = value as {
    files?: Array<{ path?: unknown }>;
    photos?: Array<{ id?: unknown; relative_path?: unknown }>;
  };
  if (Array.isArray(manifest.photos)) {
    if (!manifest.photos.every((entry) =>
      Boolean(entry) && typeof entry.id === "string" && entry.id.length > 0 &&
      typeof entry.relative_path === "string"
    )) return null;
    return manifest.photos.map((entry) => ({
      id: entry.id as string,
      path: entry.relative_path as string,
    }));
  }
  if (Array.isArray(manifest.files)) {
    if (!manifest.files.every((entry) => Boolean(entry) && typeof entry.path === "string")) return null;
    return manifest.files.map((entry) => ({
      id: `sample:${entry.path as string}`,
      path: entry.path as string,
    }));
  }
  return null;
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
    const rawEntries = manifestEntries(rawManifest);
    if (!rawEntries) throw new Error("invalid sample manifest");

    // Validate the complete manifest before performing the first OPFS write.
    const entries = rawEntries.map(({ id, path }) => ({ id, path: safeRelativePath(path) }));
    if (new Set(entries.map(({ id }) => id)).size !== entries.length) {
      throw new Error("duplicate sample photo id");
    }
    if (new Set(entries.map(({ path }) => path)).size !== entries.length) {
      throw new Error("duplicate sample photo path");
    }
    const manifestDirectory = new URL(".", manifestUrl);
    const items: LibraryItem[] = [];

    for (const { id, path: relativePath } of entries) {
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
        id,
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
