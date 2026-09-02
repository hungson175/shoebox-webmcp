export type LibrarySource = "sample" | "picker" | "drop" | "webkit";

export interface WritableLike {
  write(value: Blob | BufferSource): Promise<void>;
  close(): Promise<void>;
}

export interface FileHandleLike {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<WritableLike>;
  move?: (destination: DirectoryHandleLike, newName?: string) => Promise<void>;
}

export interface DirectoryHandleLike {
  readonly kind: "directory";
  readonly name: string;
  values(): AsyncIterableIterator<DirectoryHandleLike | FileHandleLike>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface LibraryItem {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  type: string;
  lastModified: number;
  source: LibrarySource;
  writable: boolean;
  file?: File;
  fileHandle?: FileHandleLike;
  directoryHandle?: DirectoryHandleLike;
}

export interface StagedMove {
  id: string;
  sourceDirectory: DirectoryHandleLike;
  fileHandle: FileHandleLike;
  targetDirectory: DirectoryHandleLike;
  targetName: string;
}
