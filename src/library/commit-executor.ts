import type { StagedMove } from "./types.js";

export interface CommitReceipt {
  committed: number;
  movedNatively: number;
  copiedAndVerified: number;
}

async function equalFiles(left: File, right: File): Promise<boolean> {
  if (left.size !== right.size) return false;
  const [leftBytes, rightBytes] = await Promise.all([left.arrayBuffer(), right.arrayBuffer()]);
  const a = new Uint8Array(leftBytes);
  const b = new Uint8Array(rightBytes);
  for (let index = 0; index < a.byteLength; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

function validateTargetName(name: string): void {
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new Error(`invalid target filename: ${name}`);
  }
}

export class CommitExecutor {
  async execute(moves: readonly StagedMove[]): Promise<CommitReceipt> {
    const seen = new Set<string>();
    for (const move of moves) {
      if (seen.has(move.id)) throw new Error(`duplicate staged move id: ${move.id}`);
      seen.add(move.id);
      validateTargetName(move.targetName);
    }

    let movedNatively = 0;
    let copiedAndVerified = 0;
    for (const move of moves) {
      if (move.fileHandle.move) {
        try {
          await move.fileHandle.move(move.targetDirectory, move.targetName);
          movedNatively += 1;
          continue;
        } catch {
          // FileSystemHandle.move is not universally implemented. A verified copy is the fallback.
        }
      }

      const sourceFile = await move.fileHandle.getFile();
      const targetHandle = await move.targetDirectory.getFileHandle(move.targetName, { create: true });
      const writer = await targetHandle.createWritable();
      await writer.write(sourceFile);
      await writer.close();
      const copiedFile = await targetHandle.getFile();
      if (!(await equalFiles(sourceFile, copiedFile))) {
        throw new Error(`copy verification failed for ${move.fileHandle.name}`);
      }
      await move.sourceDirectory.removeEntry(move.fileHandle.name);
      copiedAndVerified += 1;
    }

    return { committed: movedNatively + copiedAndVerified, movedNatively, copiedAndVerified };
  }
}

export class StagedPlan {
  private readonly moves = new Map<string, StagedMove>();

  stage(move: StagedMove): void {
    if (this.moves.has(move.id)) throw new Error(`staged move already exists: ${move.id}`);
    validateTargetName(move.targetName);
    this.moves.set(move.id, move);
  }

  list(): StagedMove[] {
    return [...this.moves.values()];
  }

  summary(): { moves: number; deletes: 0 } {
    return { moves: this.moves.size, deletes: 0 };
  }

  discard(): void {
    this.moves.clear();
  }
}
