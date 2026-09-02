import type { LibraryItem } from "./types.js";

interface IndexedDbPhotoIndexOptions {
  indexedDB?: IDBFactory;
  dbName?: string;
}

const STORE = "photos";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), {
      once: true,
    });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")), {
      once: true,
    });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed")), {
      once: true,
    });
  });
}

export class IndexedDbPhotoIndex {
  private readonly factory: IDBFactory;
  private readonly name: string;
  private database?: Promise<IDBDatabase>;

  constructor(options: IndexedDbPhotoIndexOptions = {}) {
    this.factory = options.indexedDB ?? globalThis.indexedDB;
    if (!this.factory) throw new Error("IndexedDB is not supported in this browser");
    this.name = options.dbName ?? "shoebox-photo-index";
  }

  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = this.factory.open(this.name, 1);
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE, { keyPath: "id" });
        }
      });
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB open failed")), {
        once: true,
      });
    });
    return this.database;
  }

  async putMany(items: Iterable<LibraryItem>): Promise<void> {
    const entries = [...items];
    if (entries.length === 0) return;
    const database = await this.open();
    const transaction = database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    for (const entry of entries) store.put(entry);
    await transactionDone(transaction);
  }

  async replaceAll(items: Iterable<LibraryItem>): Promise<void> {
    const entries = [...items];
    const database = await this.open();
    const transaction = database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    store.clear();
    for (const entry of entries) store.put(entry);
    await transactionDone(transaction);
  }

  async get(id: string): Promise<LibraryItem | undefined> {
    const database = await this.open();
    const transaction = database.transaction(STORE, "readonly");
    const result = await requestResult(transaction.objectStore(STORE).get(id));
    await transactionDone(transaction);
    return result as LibraryItem | undefined;
  }

  async list(): Promise<LibraryItem[]> {
    const database = await this.open();
    const transaction = database.transaction(STORE, "readonly");
    const result = await requestResult(transaction.objectStore(STORE).getAll());
    await transactionDone(transaction);
    return (result as LibraryItem[]).sort((left, right) => left.id.localeCompare(right.id));
  }

  async clear(): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).clear();
    await transactionDone(transaction);
  }

  async close(): Promise<void> {
    if (this.database) (await this.database).close();
    this.database = undefined;
  }
}
