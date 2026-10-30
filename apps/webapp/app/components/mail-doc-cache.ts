/**
 * THE SANITIZED DOCUMENT, KEPT. `MessageBody` turns a message's html into the document its frame
 * loads — two tree counts, the sanitizer and the document build — and that work was redone for
 * every card on every switch into News or Receipts: sixty documents per press, most of a second on
 * a large mirror. A message's document is a pure function of the inputs below, so it is kept.
 *
 * SCOPED TO ONE ENGINE (`mailDocCacheFor`), never a module map keyed by message id: two engines
 * are two mailboxes, and an id is only unique inside one. A WeakMap on the engine, so a mailbox the
 * host let go of takes its documents with it; `forgetMailDocs` (sign-out, erasure) empties every
 * cache at once.
 *
 * THE KEY IS EVERY INPUT THAT CHANGES THE OUTPUT, and the consent-gated one in particular: the
 * document carries proxied picture addresses only when `proxied` (the reader's consent, the
 * account's auto mode, a source the frame's policy can state) — the `imageProxy` prop is present
 * whenever a proxy EXISTS, consent or not, and a key built on it would serve pictures after the
 * account went back to asking. A proxied document is served only while the window may still read
 * this account's bytes (`syncMayRead`, asked at every lookup, never remembered): a hit hands the
 * renderer addresses minted earlier, so the question `remote-images.ts` asks before minting is
 * asked again here. The html is held on the entry and compared whole — a replaced body is a miss,
 * and overwrites.
 */
import type { OhmailEngine } from "@ohmail/client-engine";
import { syncMayRead } from "../shell/sync-scheduler";

/** Entries kept per engine, least recently used first out. */
export const MAIL_DOC_ENTRIES_MAX = 200;
/** Characters of kept documents per engine: the second bound, for a run of heavy newsletters. */
export const MAIL_DOC_CHARS_MAX = 8 * 1024 * 1024;

/** What decides a message's document — the memo's own dependencies, nothing else. */
export interface MailDocInputs {
  messageId: string;
  html: string;
  /** The consent-gated proxy is in use: `proxy !== null`, never the `imageProxy` prop. */
  proxied: boolean;
  imgSource: string | null;
  cidImages: ReadonlyMap<string, string> | undefined;
  resolvedRemoteImages: ReadonlyMap<string, string> | undefined;
  loadPixels: boolean;
  hasText: boolean;
  darkWanted: boolean;
  /** The subject is a forward's: the history fold differs. */
  forward: boolean;
  /** A marked link asks in a tab of its own, so it carries no `href` (`link-ask.ts`). */
  askInPage: boolean;
}

/** A frame's fitted height, remembered for the next element that shows the same document. */
export interface MailDocFit {
  width: number;
  height: string;
}

interface Entry<T> {
  html: string;
  value: T;
  chars: number;
}

export interface MailDocCache<T> {
  /** The kept document for these inputs, or `undefined` (a miss, or a proxied one past the gate). */
  read(inputs: MailDocInputs): { value: T } | undefined;
  write(inputs: MailDocInputs, value: T, chars: number): void;
  fitOf(frameKey: string): MailDocFit | undefined;
  setFit(frameKey: string, fit: MailDocFit): void;
  clear(): void;
  readonly size: number;
}

/** Map identities as numbers, held weakly — a key must not keep a picture map alive. */
const serials = new WeakMap<object, number>();
let nextSerial = 1;
function serialOf(o: object | undefined): number {
  if (!o) return 0;
  let n = serials.get(o);
  if (n === undefined) {
    n = nextSerial++;
    serials.set(o, n);
  }
  return n;
}

function keyOf(i: MailDocInputs): string {
  return [
    i.messageId,
    i.proxied ? "p" : "-",
    i.imgSource ?? "",
    serialOf(i.cidImages),
    serialOf(i.resolvedRemoteImages),
    i.loadPixels ? "x" : "-",
    i.hasText ? "t" : "-",
    i.darkWanted ? "d" : "-",
    i.forward ? "f" : "-",
    i.askInPage ? "a" : "-",
  ].join("\u0000");
}

/** Bumped by {@link forgetMailDocs}; a cache from an older generation empties itself on use. */
let generation = 0;

class Cache<T> implements MailDocCache<T> {
  private entries = new Map<string, Entry<T>>();
  private fits = new Map<string, MailDocFit>();
  private chars = 0;
  private gen = generation;

  constructor(private readonly engine: OhmailEngine) {}

  private fresh(): void {
    if (this.gen === generation) return;
    this.gen = generation;
    this.clear();
  }

  get size(): number {
    this.fresh();
    return this.entries.size;
  }

  read(inputs: MailDocInputs): { value: T } | undefined {
    this.fresh();
    if (inputs.proxied && !syncMayRead(this.engine)) return undefined;
    const key = keyOf(inputs);
    const hit = this.entries.get(key);
    if (!hit || hit.html !== inputs.html) return undefined;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return { value: hit.value };
  }

  write(inputs: MailDocInputs, value: T, chars: number): void {
    this.fresh();
    if (inputs.proxied && !syncMayRead(this.engine)) return;
    const key = keyOf(inputs);
    const old = this.entries.get(key);
    if (old) {
      this.entries.delete(key);
      this.chars -= old.chars;
    }
    if (chars > MAIL_DOC_CHARS_MAX) return;
    this.entries.set(key, { html: inputs.html, value, chars });
    this.chars += chars;
    for (const [k, e] of this.entries) {
      if (this.entries.size <= MAIL_DOC_ENTRIES_MAX && this.chars <= MAIL_DOC_CHARS_MAX) break;
      this.entries.delete(k);
      this.chars -= e.chars;
    }
  }

  fitOf(frameKey: string): MailDocFit | undefined {
    this.fresh();
    return this.fits.get(frameKey);
  }

  setFit(frameKey: string, fit: MailDocFit): void {
    this.fresh();
    this.fits.delete(frameKey);
    this.fits.set(frameKey, fit);
    if (this.fits.size > MAIL_DOC_ENTRIES_MAX) {
      const oldest = this.fits.keys().next().value;
      if (oldest !== undefined) this.fits.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
    this.fits.clear();
    this.chars = 0;
  }
}

const caches = new WeakMap<OhmailEngine, Cache<unknown>>();

/** This engine's documents — one cache per engine instance, made on first use. */
export function mailDocCacheFor<T>(engine: OhmailEngine): MailDocCache<T> {
  let c = caches.get(engine);
  if (!c) {
    c = new Cache<unknown>(engine);
    caches.set(engine, c);
  }
  return c as MailDocCache<T>;
}

/** Every engine's documents gone, at once: the browser is being handed back (`sign-out.ts`). */
export function forgetMailDocs(): void {
  generation += 1;
}
