import type { DirectoryHandleLike, FileHandleLike, LibraryItem, LibrarySource } from "./types.js";

interface DataTransferItemLike {
  kind: string;
  getAsFileSystemHandle?: () => Promise<DirectoryHandleLike | FileHandleLike | null>;
}

interface BrowserFolderSourceOptions {
  showDirectoryPicker?: (options: { mode: "readwrite" }) => Promise<DirectoryHandleLike>;
}

const IMAGE_EXTENSION = /\.(?:avif|gif|heic|heif|jpe?g|png|webp)$/i;

function isImage(file: File): boolean {
  if (IMAGE_EXTENSION.test(file.name)) return true;
  // A known non-image extension wins over a misleading MIME declaration.
  return !/\.[^./]+$/.test(file.name) && file.type.startsWith("image/");
}

function idFor(source: LibrarySource, path: string): string {
  return `${source}:${path}`;
}

async function itemFromHandle(
  fileHandle: FileHandleLike,
  directoryHandle: DirectoryHandleLike,
  relativePath: string,
  source: "picker" | "drop",
): Promise<LibraryItem | null> {
  const file = await fileHandle.getFile();
  if (!isImage(file)) return null;
  return {
    id: idFor(source, relativePath),
    name: file.name || fileHandle.name,
    relativePath,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
    source,
    writable: true,
    file,
    fileHandle,
    directoryHandle,
  };
}

async function walk(
  directory: DirectoryHandleLike,
  source: "picker" | "drop",
  prefix = "",
): Promise<LibraryItem[]> {
  const items: LibraryItem[] = [];
  for await (const handle of directory.values()) {
    const path = prefix ? `${prefix}/${handle.name}` : handle.name;
    if (handle.kind === "directory") items.push(...(await walk(handle, source, path)));
    else {
      const entry = await itemFromHandle(handle, directory, path, source);
      if (entry) items.push(entry);
    }
  }
  return items.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export class BrowserFolderSource {
  private readonly picker?: BrowserFolderSourceOptions["showDirectoryPicker"];

  constructor(options: BrowserFolderSourceOptions = {}) {
    this.picker = options.showDirectoryPicker;
  }

  async openPicker(): Promise<LibraryItem[]> {
    const picker = this.picker ?? (globalThis as typeof globalThis & {
      showDirectoryPicker?: BrowserFolderSourceOptions["showDirectoryPicker"];
    }).showDirectoryPicker;
    if (!picker) throw new Error("showDirectoryPicker is not supported in this browser");
    const root = await picker({ mode: "readwrite" });
    return walk(root, "picker");
  }

  async openDroppedItems(items: Iterable<DataTransferItemLike>): Promise<LibraryItem[]> {
    const opened: LibraryItem[] = [];
    for (const item of items) {
      if (item.kind !== "file" || !item.getAsFileSystemHandle) continue;
      const handle = await item.getAsFileSystemHandle();
      if (!handle) continue;
      if (handle.kind === "directory") opened.push(...(await walk(handle, "drop")));
      else {
        // A lone dropped file has no removable parent directory, so it is staged as read-only.
        const file = await handle.getFile();
        if (isImage(file)) {
          opened.push({
            id: idFor("drop", handle.name),
            name: handle.name,
            relativePath: handle.name,
            size: file.size,
            type: file.type,
            lastModified: file.lastModified,
            source: "drop",
            writable: false,
            file,
            fileHandle: handle,
          });
        }
      }
    }
    return opened.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  openWebkitFiles(files: Iterable<File>): LibraryItem[] {
    const opened: LibraryItem[] = [];
    for (const file of files) {
      if (!isImage(file)) continue;
      const rawPath = file.webkitRelativePath || file.name;
      const parts = rawPath.split("/").filter(Boolean);
      const relativePath = parts.length > 1 ? parts.slice(1).join("/") : parts[0] ?? file.name;
      opened.push({
        id: idFor("webkit", relativePath),
        name: file.name,
        relativePath,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
        source: "webkit",
        writable: false,
        file,
      });
    }
    return opened.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }
}
