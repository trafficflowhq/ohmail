/**
 * THE ENGINE'S OBJECT-URL LEDGER — minting a `blob:` URL and owing its revocation are one act.
 *
 * The obligation is recorded HERE, at creation, rather than in the attachment entry a release path
 * is allowed to delete first: an entry that is gone can no longer name the URL it would have
 * carried, and a URL nothing can name pins its whole bytes until the document dies. Every URL is
 * owned by one message id, so a per-message release drains that owner's bucket instead of walking
 * entries. Bounded by construction: a revoked URL leaves the ledger and an emptied owner leaves
 * with it, so `size` is exactly the URLs minted and not yet revoked.
 */
export class ObjectUrlLedger {
  private readonly byOwner = new Map<string, Set<string>>();
  private readonly ownerOf = new Map<string, string>();

  /**
   * Create a URL for `blob` and record the debt under `owner`. `undefined` where the runtime has
   * no `URL.createObjectURL` — SSR and the node test environment — so a caller degrades to an
   * item without byte-backing rather than throwing inside a render.
   */
  mint(owner: string, blob: Blob): string | undefined {
    const U = (globalThis as { URL?: { createObjectURL?: (b: Blob) => string } }).URL;
    if (typeof U?.createObjectURL !== "function") return undefined;
    const url = U.createObjectURL(blob);
    let held = this.byOwner.get(owner);
    if (!held) {
      held = new Set<string>();
      this.byOwner.set(owner, held);
    }
    held.add(url);
    this.ownerOf.set(url, owner);
    return url;
  }

  /**
   * Revoke one URL. A URL this ledger does not hold was already revoked (or was never minted
   * here), and a second `revokeObjectURL` for it would hide a second defect — so it is a no-op.
   */
  revoke(url: string | undefined): void {
    if (!url) return;
    const owner = this.ownerOf.get(url);
    if (owner === undefined) return;
    this.forget(owner, url);
    this.revokeNow(url);
  }

  /** Revoke and forget every URL minted for one message. */
  releaseOwner(owner: string): void {
    const held = this.byOwner.get(owner);
    if (!held) return;
    this.byOwner.delete(owner);
    for (const url of held) {
      this.ownerOf.delete(url);
      this.revokeNow(url);
    }
  }

  /** Revoke and forget everything — a teardown that is losing the whole engine. */
  releaseAll(): void {
    const all = [...this.ownerOf.keys()];
    this.byOwner.clear();
    this.ownerOf.clear();
    for (const url of all) this.revokeNow(url);
  }

  /** Minted and not yet revoked. The bound: never more than the live entries plus in-flight fetches. */
  get size(): number {
    return this.ownerOf.size;
  }

  /** Owners with at least one live URL. Zero once everything is released. */
  get ownerCount(): number {
    return this.byOwner.size;
  }

  private forget(owner: string, url: string): void {
    this.ownerOf.delete(url);
    const held = this.byOwner.get(owner);
    if (!held) return;
    held.delete(url);
    if (held.size === 0) this.byOwner.delete(owner);
  }

  private revokeNow(url: string): void {
    const U = (globalThis as { URL?: { revokeObjectURL?: (u: string) => void } }).URL;
    U?.revokeObjectURL?.(url);
  }
}
