/**
 * SCROLL-SWEEP GEOMETRY for a GROUPED list — Receipts' day groups.
 *
 * React Native's `onLayout` answers coordinates relative to the view's DIRECT PARENT. The
 * receipts rows sit four levels under the scroll content (content → panel → day group →
 * items container → row), so a row's own `y` says where it sits INSIDE ITS DAY, not on the
 * screen: the first row of every day group is `y ≈ 0`. Measured against the scroll line
 * raw, that marked the first row of every day — including days entirely off-screen — as
 * "scrolled past" the moment the line cleared the topmost row, and on a live account that
 * persisted READ state onto mail nobody had seen.
 *
 * This ledger records each level's own offset as its `onLayout` fires and answers the sweep
 * in SCROLL-CONTENT coordinates: a row has passed the line only when
 * `panel + group + items + row.y + row.h <= line`. Rows whose chain is not fully measured
 * yet are never answered as passed — an unmeasured offset defaults to "not past", because
 * marking mail read is the irreversible half of a guess.
 *
 * Pure and renderer-free so the root suite can hold the geometry without a device: the
 * off-screen-group case is pinned red in `test/live-screens.test.ts`.
 */
export class GroupedSweepLedger {
  private panelY: number | null = null;
  private groups = new Map<string, { y: number | null; itemsY: number | null }>();
  private rows = new Map<string, { group: string; y: number; h: number }>();

  private groupOf(label: string): { y: number | null; itemsY: number | null } {
    let g = this.groups.get(label);
    if (!g) {
      g = { y: null, itemsY: null };
      this.groups.set(label, g);
    }
    return g;
  }

  /** The panel's offset inside the scroll content (the header block sits above it). */
  setPanel(y: number): void {
    this.panelY = y;
  }

  /** One day group's offset inside the panel. */
  setGroup(label: string, y: number): void {
    this.groupOf(label).y = y;
  }

  /** The group's rows container offset inside the group (below the day heading). */
  setItems(label: string, y: number): void {
    this.groupOf(label).itemsY = y;
  }

  /** One row's offset and height inside its rows container. */
  setRow(id: string, group: string, y: number, h: number): void {
    this.rows.set(id, { group, y, h });
  }

  /** A stale list re-render: forget rows the list no longer holds. */
  reset(): void {
    this.rows.clear();
    this.groups.clear();
    this.panelY = null;
  }

  /**
   * PRUNE against the rendered generation: keep only the rows and groups the list currently
   * holds. `onLayout` only ever ADDS — a row the projection re-homed (a consent or rule
   * change re-presenting mail elsewhere) kept its stale measurement here, a later scroll
   * answered it as passed, and the sweep — which deliberately checks the RAW folder — marked
   * mail that was never on screen as read. The caller prunes on every
   * list change; RN re-fires `onLayout` for anything whose frame moved, so surviving entries
   * stay current.
   */
  retain(rowIds: Iterable<string>, groupKeys: Iterable<string>): void {
    const keepRows = new Set(rowIds);
    const keepGroups = new Set(groupKeys);
    for (const id of [...this.rows.keys()]) {
      if (!keepRows.has(id)) this.rows.delete(id);
    }
    for (const key of [...this.groups.keys()]) {
      if (!keepGroups.has(key)) this.groups.delete(key);
    }
  }

  /**
   * Every row whose FOOT is above the line, in scroll-content coordinates. A row whose
   * offset chain is incomplete is not passed — never a guess in the read-marking direction.
   */
  passed(line: number): string[] {
    if (this.panelY === null) return [];
    const out: string[] = [];
    for (const [id, row] of this.rows) {
      const g = this.groups.get(row.group);
      if (!g || g.y === null || g.itemsY === null) continue;
      if (this.panelY + g.y + g.itemsY + row.y + row.h <= line) out.push(id);
    }
    return out;
  }
}
