import { CustodyLedger } from "./custody-ledger.js";

export interface ThumbnailResult {
  blob: Blob;
  width: number;
  height: number;
  mimeType: string;
}

type RenderThumbnail = (
  bitmap: ImageBitmap,
  width: number,
  height: number,
  mimeType: string,
  quality: number,
) => Promise<Blob>;

interface BrowserThumbnailPipelineOptions {
  createImageBitmap?: (source: ImageBitmapSource) => Promise<ImageBitmap>;
  render?: RenderThumbnail;
  maxEdge?: number;
  mimeType?: string;
  quality?: number;
  ledger: CustodyLedger;
}

async function defaultRender(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  mimeType: string,
  quality: number,
): Promise<Blob> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D thumbnail context unavailable");
    context.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type: mimeType, quality });
  }
  if (typeof document === "undefined") throw new Error("thumbnail canvas unavailable");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D thumbnail context unavailable");
  context.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("thumbnail encoding failed"))),
      mimeType,
      quality,
    );
  });
}

export class BrowserThumbnailPipeline {
  private readonly decode: (source: ImageBitmapSource) => Promise<ImageBitmap>;
  private readonly render: RenderThumbnail;
  private readonly maxEdge: number;
  private readonly mimeType: string;
  private readonly quality: number;
  private readonly ledger: CustodyLedger;

  constructor(options: BrowserThumbnailPipelineOptions) {
    this.decode = options.createImageBitmap ?? globalThis.createImageBitmap.bind(globalThis);
    this.render = options.render ?? defaultRender;
    this.maxEdge = options.maxEdge ?? 96;
    this.mimeType = options.mimeType ?? "image/webp";
    this.quality = options.quality ?? 0.82;
    this.ledger = options.ledger;
    if (!Number.isSafeInteger(this.maxEdge) || this.maxEdge < 1) throw new RangeError("maxEdge must be positive");
  }

  async create(file: File, options: { countAsRequested?: boolean } = {}): Promise<ThumbnailResult> {
    const bitmap = await this.decode(file);
    try {
      const scale = Math.min(1, this.maxEdge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const blob = await this.render(bitmap, width, height, this.mimeType, this.quality);
      if (options.countAsRequested) this.ledger.recordRequestedThumbnail(width, height);
      return { blob, width, height, mimeType: blob.type || this.mimeType };
    } finally {
      bitmap.close();
    }
  }
}
