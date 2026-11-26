import type { MutationEffect } from "../mutations.js";
import type { StorePageCache } from "../store-pages.js";
import type { EntityReader, MirrorStore } from "../store.js";

type Entry<T = unknown> = { id: string; entity: T; seq: number };

/** Read-through view: the mirror with the optimistic overlay applied on top. */
class OverlayReader implements EntityReader {
  private merged = new Map<string, { stamp: number; rows: Entry[] }>();
  private mergedRevision = -1;
  private mergedEffects: readonly (readonly MutationEffect[])[] = [];

  constructor(
    private readonly store: MirrorStore,
    private readonly overlays: Map<string, MutationEffect[]>,
    private readonly rev: () => number,
    /** Decisions kept past their overlay ({@link KeptDecision}): read first, so any live verb wins. */
    private readonly kept: ReadonlyMap<string, { readonly effects: readonly MutationEffect[] }> = new Map(),
  ) {}

  private overlayFor(type: string, id: string): MutationEffect | undefined {
    let hit: MutationEffect | undefined;
    for (const d of this.kept.values()) {
      for (const e of d.effects) if (e.type === type && e.id === id) hit = e;
    }
    for (const effects of this.overlays.values()) {
      for (const e of effects) if (e.type === type && e.id === id) hit = e; // last wins
    }
    return hit;
  }

  get<T = unknown>(type: string, id: string): T | undefined {
    const o = this.overlayFor(type, id);
    if (o) return o.entity === null ? undefined : (o.entity as T);
    return this.store.get<T>(type, id);
  }

  /** The newest overlay effect on this entity, if any verb in flight or shadowed has one. */
  overlaid(type: string, id: string): { entity: unknown } | undefined {
    const o = this.overlayFor(type, id);
    return o ? { entity: o.entity } : undefined;
  }

  private mergedEntries<T>(type: string): readonly Entry<T>[] | undefined {
    if (this.overlays.size === 0 && this.kept.size === 0 && this.mergedEffects.length === 0) return undefined;
    const revision = this.rev();
    const effects = [...Array.from(this.kept.values(), (d) => d.effects), ...this.overlays.values()];
    // A durable write can yield after replacing effects but before publishing a new revision.
    if (revision !== this.mergedRevision || effects.length !== this.mergedEffects.length ||
        effects.some((group, i) => group !== this.mergedEffects[i])) {
      this.merged.clear();
      this.mergedRevision = revision;
      this.mergedEffects = effects;
    }
    const stamp = this.store.stampOf(type);
    const cached = this.merged.get(type);
    if (cached?.stamp === stamp) return cached.rows as Entry<T>[];
    if (!effects.some((group) => group.some((e) => e.type === type))) return undefined;

    // An OVERLAID row keeps the STORE's seq, because the seq is a fact about the log and an
    // overlay is a fact about this tab. A row that exists only as an overlay has never been in the
    // log at all and reads 0 — which no windowed prune can mistake for "already here", and the
    // prune reads the store directly anyway.
    const byId = new Map<string, Entry<T>>();
    for (const e of this.store.entries<T>(type)) byId.set(e.id, e);
    for (const group of effects) {
      for (const e of group) {
        if (e.type !== type) continue;
        if (e.entity === null) byId.delete(e.id);
        else byId.set(e.id, { id: e.id, entity: e.entity as T, seq: byId.get(e.id)?.seq ?? 0 });
      }
    }
    const rows = [...byId.values()];
    this.merged.set(type, { stamp, rows });
    return rows;
  }

  entries<T = unknown>(type: string): Entry<T>[] {
    return this.mergedEntries<T>(type)?.map((entry) => ({ ...entry })) ?? this.store.entries<T>(type);
  }

  list<T = unknown>(type: string): T[] {
    return this.mergedEntries<T>(type)?.map((entry) => entry.entity) ?? this.store.list<T>(type);
  }

  version(): number {
    return this.store.version() * 1_000_003 + this.rev();
  }

  /**
   * {@link version}'s arithmetic, per type — and the overlay rev rides EVERY type rather than
   * only the ones an overlay touches. An overlay is a message moving, being filed or being
   * deleted before the server has said so; folding its rev into every stamp costs a rebuild of
   * derivations that did not need one, and the alternative — deciding which types an overlay
   * reaches — is a second opinion about mutation effects that would drift from the first.
   * Conservative on purpose: a needless rebuild is a cost, a missed one is a stale screen.
   */
  stampOf(type: string): number {
    return this.store.stampOf(type) * 1_000_003 + this.rev();
  }

  stampExcept(ignore: readonly string[]): number {
    return this.store.stampExcept(ignore) * 1_000_003 + this.rev();
  }
}

/**
 * WHAT A VERB READS ITS TARGET FROM — `base` (the mirror), and for a message the mirror has no
 * record of, the row a History or Search page holds. A tombstone, or an overlay that removed the
 * row, reads gone: the page's older copy never answers for a row this device saw deleted.
 */
class PageFallbackReader implements EntityReader {
  constructor(
    private readonly base: EntityReader,
    private readonly overlay: OverlayReader | null,
    private readonly store: MirrorStore,
    private readonly pages: StorePageCache,
  ) {}

  get<T = unknown>(type: string, id: string): T | undefined {
    const v = this.base.get<T>(type, id);
    if (v !== undefined || type !== "message") return v;
    if (this.overlay?.overlaid(type, id) !== undefined || this.store.record(type, id) !== undefined) return undefined;
    return this.pages.find(id) as T | undefined;
  }

  list<T = unknown>(type: string): T[] { return this.base.list<T>(type); }
  entries<T = unknown>(type: string): Array<{ id: string; entity: T; seq: number }> { return this.base.entries<T>(type); }
  version(): number { return this.base.version(); }
  stampOf(type: string): number { return this.base.stampOf(type); }
  stampExcept(ignore: readonly string[]): number { return this.base.stampExcept(ignore); }
}

export {
  OverlayReader, PageFallbackReader,
};
