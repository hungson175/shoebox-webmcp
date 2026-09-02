import type { CommitReceipt } from "./commit-executor.js";
import type { CustodySnapshot } from "./custody-ledger.js";
import type { LibraryItem, StagedMove } from "./types.js";

/**
 * Inject this narrow adapter into the engine. The engine retains ownership of
 * selection, staged-plan state, and all WebMCP registration.
 */
export interface LibraryPort {
  replace(items: Iterable<LibraryItem>): Promise<void>;
  list(): Promise<LibraryItem[]>;
  custody(): CustodySnapshot;
  commitMoves(moves: readonly StagedMove[]): Promise<CommitReceipt>;
}
