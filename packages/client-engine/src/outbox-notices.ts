/**
 * THE NOTICE CHANNEL OF ONE SHARED OUTBOX DISK — the browser mirror's (`idb.ts`) and the paired
 * page's. One `BroadcastChannel` per disk: a post reaches every other window's listeners, never its
 * own. Opened on first use and unreferenced, so a store that never posts holds nothing open.
 */
import { isOutboxKey, type OutboxNotice, type OutboxNotices } from "./store.js";

/** A `BroadcastChannel`, or what a test hands in its place. */
export interface NoticeChannel {
  postMessage(data: unknown): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/** The channel the windows over one disk share — named by the disk, so per account or pairing. */
export function outboxNoticeChannel(diskName: string): string {
  return `ohmail.outbox.${diskName}`;
}

function browserChannel(name: string): NoticeChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const ch = new BroadcastChannel(name) as unknown as NoticeChannel & { unref?: () => void };
  ch.unref?.();
  return ch;
}

const isNotice = (n: unknown): n is OutboxNotice =>
  typeof n === "object" && n !== null && typeof (n as { t?: unknown }).t === "string";

export class OutboxNoticeBus {
  private channel: NoticeChannel | null | undefined;
  private readonly listeners = new Set<(n: OutboxNotice) => void>();

  constructor(
    private readonly name: string,
    private readonly open: (name: string) => NoticeChannel | null = browserChannel,
  ) {}

  /** The channel as the engine uses it, or `null` where this host has none. */
  notices(): OutboxNotices | null {
    if (this.opened() === null) return null;
    return {
      post: (n) => this.post(n),
      listen: (cb) => {
        this.listeners.add(cb);
        return () => { this.listeners.delete(cb); };
      },
    };
  }

  post(n: OutboxNotice): void {
    try { this.opened()?.postMessage(n); } catch { /* a closed channel says nothing */ }
  }

  /** `changed`, once, when any of these `type:id` keys names an outbox row. */
  changed(keys: Iterable<string>): void {
    for (const key of keys) {
      if (!isOutboxKey(key)) continue;
      this.post({ t: "changed" });
      return;
    }
  }

  close(): void {
    this.channel?.close();
    this.channel = null;
    this.listeners.clear();
  }

  private opened(): NoticeChannel | null {
    if (this.channel !== undefined) return this.channel;
    let ch: NoticeChannel | null = null;
    try { ch = this.open(this.name); } catch { ch = null; }
    if (ch !== null) {
      ch.onmessage = (ev) => {
        if (!isNotice(ev.data)) return;
        for (const cb of [...this.listeners]) cb(ev.data);
      };
    }
    this.channel = ch;
    return ch;
  }
}
