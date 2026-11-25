export interface SimEvent {
  t: number;
  seq: number;
  fn: () => void;
}

/** Binary min-heap ordered by (time, insertion sequence), which makes event order deterministic. */
export class EventHeap {
  private items: SimEvent[] = [];

  get size(): number {
    return this.items.length;
  }

  peekTime(): number {
    return this.items.length ? this.items[0]!.t : Infinity;
  }

  push(e: SimEvent): void {
    const a = this.items;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(a[p]!, e)) break;
      a[i] = a[p]!;
      i = p;
    }
    a[i] = e;
  }

  pop(): SimEvent | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      let i = 0;
      const n = a.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && less(a[r]!, a[l]!) ? r : l;
        if (less(last, a[c]!)) break;
        a[i] = a[c]!;
        i = c;
      }
      a[i] = last;
    }
    return top;
  }
}

function less(x: SimEvent, y: SimEvent): boolean {
  return x.t < y.t || (x.t === y.t && x.seq < y.seq);
}
