/**
 * Scroll-sweep geometry for a grouped list — Receipts' day groups. RN's `onLayout` answers
 * coordinates relative to the view's direct parent, and the receipts rows sit four levels under
 * the scroll content, so a row's own `y` says where it sits inside its day: the first row of
 * every day group is `y ≈ 0`, and measured raw against the scroll line that marked mail in
 * entirely off-screen days as read. This ledger records each level's own offset as its
 * `onLayout` fires and answers in scroll-content coordinates: passed only when `panel + group +
 * items + row.y + row.h <= line`. An unmeasured chain defaults to "not past" — marking mail read
 * is the irreversible half of a guess. Pure and renderer-free.
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
    return this.frames().filter((f) => f.bottom <= line).map((f) => f.id);
  }

  /** A row whose cell left the list: its frame is no longer kept current. */
  drop(id: string): void {
    this.rows.delete(id);
  }

  /** Every fully measured row's frame in scroll-content coordinates. */
  frames(): SweepFrame[] {
    if (this.panelY === null) return [];
    const out: SweepFrame[] = [];
    for (const [id, row] of this.rows) {
      const g = this.groups.get(row.group);
      if (!g || g.y === null || g.itemsY === null) continue;
      const top = this.panelY + g.y + g.itemsY + row.y;
      out.push({ id, top, bottom: top + row.h });
    }
    return out;
  }
}

/** A row's frame in scroll-content coordinates. */
export interface SweepFrame {
  id: string;
  top: number;
  bottom: number;
}

/** Where the list stands: its offset and its own height. */
export interface SweepView {
  y: number;
  height: number;
}

/**
 * A STREAM'S SEEN RUN (Reads, Receipts): a row is passed only once a look the person drove has had
 * it on screen above the read line, and its foot has cleared the line. The looks are the reports
 * while the finger moves the list, the screen where it lifts, and the screen a fling comes to rest
 * on. The fling's glide, the list holding its place while mail arrives above, a place coming back
 * and every other scroll the app makes are not looked at. A visit starts from nothing (`restart`).
 */
export class SeenRun {
  private shown = new Set<string>();
  private by: "app" | "finger" | "lifted" | "glide" = "app";

  constructor(private readonly readLine: number) {}

  restart(): void {
    this.shown.clear();
    this.by = "app";
  }

  drag(): void {
    this.by = "finger";
  }

  scroll(v: SweepView, frames: Iterable<SweepFrame>): string[] {
    return this.by === "finger" ? this.look(v, frames) : [];
  }

  lift(v: SweepView, frames: Iterable<SweepFrame>): string[] {
    if (this.by !== "finger") return [];
    this.by = "lifted";
    return this.look(v, frames);
  }

  glide(): void {
    if (this.by === "lifted") this.by = "glide";
  }

  land(v: SweepView, frames: Iterable<SweepFrame>): string[] {
    if (this.by !== "glide") return [];
    this.by = "app";
    return this.look(v, frames);
  }

  private look(v: SweepView, frames: Iterable<SweepFrame>): string[] {
    const line = v.y + v.height * this.readLine;
    const out: string[] = [];
    for (const f of frames) {
      if (f.top < line && f.bottom > v.y) this.shown.add(f.id);
      if (f.bottom <= line && this.shown.has(f.id)) out.push(f.id);
    }
    return out;
  }
}
