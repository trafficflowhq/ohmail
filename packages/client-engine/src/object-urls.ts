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
  /** URLs minted elsewhere (the desktop shell's staged previews), released by their own call. */
  private readonly releases = new Map<string, () => void>();

  /**
   * Record a URL this ledger did not mint — a desktop preview the shell staged on disk — so every
   * revoke, owner release and teardown releases it like any other: `release` runs exactly once.
   */
  adopt(owner: string, url: string, release: () => void): void {
    let held = this.byOwner.get(owner);
    if (!held) {
      held = new Set<string>();
      this.byOwner.set(owner, held);
    }
    held.add(url);
    this.ownerOf.set(url, owner);
    this.releases.set(url, release);
  }

  /** Whether `url` was adopted rather than minted, i.e. carries no bytes in this document. */
  isAdopted(url: string | undefined): boolean {
    return url !== undefined && this.releases.has(url);
  }

  /** The adopted URLs one message holds. */
  adoptedOf(owner: string): string[] {
    return [...(this.byOwner.get(owner) ?? [])].filter((url) => this.releases.has(url));
  }

  /** The message a live URL is held for, or `undefined` once it is revoked (or was never here). */
  heldFor(url: string): string | undefined {
    return this.ownerOf.get(url);
  }

  /** Whether THIS ledger minted `url` for `owner` and has not revoked it: never an adopted URL. */
  mintedFor(owner: string, url: string | undefined): boolean {
    return url !== undefined && this.ownerOf.get(url) === owner && !this.releases.has(url);
  }

  /**
   * Create a URL for `blob` and record the debt under `owner`. `undefined` where the runtime has
   * no `URL.createObjectURL` (SSR, node) — and where the call itself THROWS: Expo's runtime
   * installs one that throws `Cannot create URL for blob` whenever the native blob store exports
   * no URI scheme, which is every Android app without a `blob_provider_authority` resource
   * (measured on a paired device — the unguarded call landed every attachment `failed`). The
   * URL is a convenience, never the byte carrier; a mint that cannot mint is no mint.
   */
  mint(owner: string, blob: Blob): string | undefined {
    const U = (globalThis as { URL?: { createObjectURL?: (b: Blob) => string } }).URL;
    if (typeof U?.createObjectURL !== "function") return undefined;
    let url: string;
    try {
      url = U.createObjectURL(blob);
    } catch {
      return undefined;
    }
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
    const release = this.releases.get(url);
    if (release) {
      this.releases.delete(url);
      try {
        release();
      } catch {
        /* the shell's own sweep removes a file a failed release left */
      }
      return;
    }
    const U = (globalThis as { URL?: { revokeObjectURL?: (u: string) => void } }).URL;
    U?.revokeObjectURL?.(url);
  }
}
