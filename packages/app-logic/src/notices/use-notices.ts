/**
 * THE ONE CALLER OF A SURFACE'S EMITTER. Mounted once, where the shell holds the copy the rail
 * reads. At each settle of the copy it takes a sample, asks the gate what may be drawn, and hands
 * the emitter each answer. Nothing else calls an emitter's `post`: the gate decides, the emitter
 * draws, and this joins the two.
 *
 * Keyed by the account's scope. A new scope starts from no sample again, so the first sample of
 * the next account draws nothing, and whatever the surface drew for the account left is taken
 * back before anything of the next one is drawn.
 */
import { useEffect, useRef } from "react";
import {
  decideNotices,
  noticeSampleOf,
  type EntityReader,
  type NoticeChoices,
  type NoticeEmitter,
  type NoticePermission,
  type NoticeSample,
} from "@ohmail/client-engine";

/**
 * A surface's emitter as its shell hands it in: the seam's emitter, and the taking back. `takeBack`
 * closes what this surface drew and still shows, and stops what it set to ring later, at sign-out
 * and at an account switch. It never throws, and a surface whose platform gives no way back says
 * so where it is built.
 */
export interface HostNoticeEmitter extends NoticeEmitter {
  takeBack(): void;
}

/** What the caller reads at each settle. Read then, never held: a switch pressed a moment ago counts. */
export interface NoticeReads {
  /** The person's choices on this device. */
  choices(): NoticeChoices;
  /** What the platform says about drawing notices at all. */
  permission(): NoticePermission;
  /** How many devices are paired with the account; `null` where this surface is not told. */
  devices(): number | null;
}

/**
 * The caller without React: what the hook below runs, and what a test drives. `settle` is one
 * settle of the copy under `scope`; `end` is the shell going away.
 */
export class NoticeCaller {
  private scope: string | null = null;
  private before: NoticeSample | null = null;

  constructor(
    private readonly emitter: HostNoticeEmitter,
    private readonly reads: NoticeReads,
  ) {}

  /** One settle of the copy `reader` shows for the account `scope`. */
  settle(scope: string, reader: EntityReader): void {
    if (scope !== this.scope) {
      // Another account, or the first: what was drawn for the one left goes, and nothing of this
      // one is an event until there is something of its own to compare against.
      if (this.scope !== null) this.takeBack();
      this.scope = scope;
      this.before = null;
    }
    const after = noticeSampleOf(reader, this.reads.devices());
    const before = this.before;
    this.before = after;
    const answer = decideNotices(
      before,
      after,
      this.reads.choices(),
      this.reads.permission(),
      this.emitter.carries,
    );
    for (const notice of answer) this.emitter.post(notice);
  }

  /** The shell is gone: sign-out, or the account's frame taken down. What was drawn for it goes too. */
  end(): void {
    if (this.scope !== null) this.takeBack();
    this.scope = null;
    this.before = null;
  }

  private takeBack(): void {
    try {
      this.emitter.takeBack();
    } catch {
      /* An emitter never throws; one that does takes nothing else down. */
    }
  }
}

/** What the shell hands the hook. */
export interface NoticesMount {
  /** The copy the rail reads, so a notice's number and the rail's never disagree. */
  readonly reader: EntityReader;
  /** Moves whenever the copy does. */
  readonly version: number;
  /** The copy has settled: mid-catch-up a count is still moving, and is no event. */
  readonly settled: boolean;
  /** The account the copy is of; `null` while there is none. */
  readonly scope: string | null;
  /** The surface's emitter, or `none` where it draws none. */
  readonly emitter: HostNoticeEmitter | "none";
  readonly reads: NoticeReads;
}

/**
 * Mount the caller. The emitter and the reads are taken once per emitter: a shell hands in the
 * same emitter for its life, and the reads are functions read at each settle.
 */
export function useNotices(mount: NoticesMount): void {
  const { reader, version, settled, scope, emitter } = mount;
  const reads = useRef(mount.reads);
  reads.current = mount.reads;
  const caller = useRef<NoticeCaller | null>(null);

  useEffect(() => {
    if (emitter === "none") return undefined;
    const made = new NoticeCaller(emitter, {
      choices: () => reads.current.choices(),
      permission: () => reads.current.permission(),
      devices: () => reads.current.devices(),
    });
    caller.current = made;
    return () => {
      made.end();
      if (caller.current === made) caller.current = null;
    };
  }, [emitter]);

  useEffect(() => {
    if (!settled || scope === null) return;
    caller.current?.settle(scope, reader);
  }, [reader, version, settled, scope, emitter]);
}
