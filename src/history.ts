/**
 * A single undo/redo stack shared by Assemble and Animate mode. Entries are
 * snapshot-based: each op captures before/after JSON of exactly the slice it
 * mutated (a skeleton doc, or one body's clips), so undo is trivially correct
 * and never partially applies.
 */
export interface HistoryEntry {
  label: string;
  undo(): void;
  redo(): void;
}

const CAP = 100;

export class History {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];

  push(e: HistoryEntry): void {
    this.past.push(e);
    if (this.past.length > CAP) this.past.shift();
    this.future = [];
  }

  undo(): string | null {
    const e = this.past.pop();
    if (!e) return null;
    e.undo();
    this.future.push(e);
    return e.label;
  }

  redo(): string | null {
    const e = this.future.pop();
    if (!e) return null;
    e.redo();
    this.past.push(e);
    return e.label;
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }
  canRedo(): boolean {
    return this.future.length > 0;
  }
}
