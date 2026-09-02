import type { LibraryItem } from "./types.js";

export interface CustodySnapshot {
  indexedFiles: number;
  localBytes: number;
  bytesUploaded: 0;
  thumbnailGroupsRequested: number;
  thumbnailPixelsRequested: number;
}

/** A page-local counter. No method exists for recording an upload. */
export class CustodyLedger {
  private readonly indexed = new Map<string, number>();
  private requestedGroups = 0;
  private requestedPixels = 0;

  recordIndexed(items: Iterable<Pick<LibraryItem, "id" | "size">>): void {
    for (const entry of items) this.indexed.set(entry.id, entry.size);
  }

  recordRequestedThumbnail(width: number, height: number): void {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
      throw new RangeError("thumbnail dimensions must be positive safe integers");
    }
    this.requestedGroups += 1;
    this.requestedPixels += width * height;
  }

  reset(): void {
    this.indexed.clear();
    this.requestedGroups = 0;
    this.requestedPixels = 0;
  }

  snapshot(): CustodySnapshot {
    return {
      indexedFiles: this.indexed.size,
      localBytes: [...this.indexed.values()].reduce((sum, size) => sum + size, 0),
      bytesUploaded: 0,
      thumbnailGroupsRequested: this.requestedGroups,
      thumbnailPixelsRequested: this.requestedPixels,
    };
  }
}
