import { CommitExecutor, StagedPlan, type CommitReceipt } from "./commit-executor.js";
import { CustodyLedger, type CustodySnapshot } from "./custody-ledger.js";
import { IndexedDbPhotoIndex } from "./indexeddb-photo-index.js";
import type { LibraryItem, StagedMove } from "./types.js";

interface LibraryStoreOptions {
  index: IndexedDbPhotoIndex;
  ledger: CustodyLedger;
  plan?: StagedPlan;
  commitExecutor?: CommitExecutor;
}

/** The integration seam consumed by the UI and state-machine slices. */
export class LibraryStore {
  private readonly index: IndexedDbPhotoIndex;
  private readonly ledger: CustodyLedger;
  private readonly plan: StagedPlan;
  private readonly executor: CommitExecutor;

  constructor(options: LibraryStoreOptions) {
    this.index = options.index;
    this.ledger = options.ledger;
    this.plan = options.plan ?? new StagedPlan();
    this.executor = options.commitExecutor ?? new CommitExecutor();
  }

  async replace(items: Iterable<LibraryItem>): Promise<void> {
    const entries = [...items];
    await this.index.replaceAll(entries);
    this.ledger.reset();
    this.ledger.recordIndexed(entries);
  }

  list(): Promise<LibraryItem[]> {
    return this.index.list();
  }

  custody(): CustodySnapshot {
    return this.ledger.snapshot();
  }

  stage(move: StagedMove): void {
    this.plan.stage(move);
  }

  stagedMoves(): StagedMove[] {
    return this.plan.list();
  }

  planSummary(): { moves: number; deletes: 0 } {
    return this.plan.summary();
  }

  discard(): void {
    this.plan.discard();
  }

  async commit(): Promise<CommitReceipt> {
    const receipt = await this.executor.execute(this.plan.list());
    this.plan.discard();
    return receipt;
  }
}
