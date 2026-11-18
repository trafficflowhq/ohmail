/**
 * THE EMULATOR BENCH'S DOOR. Compiled only into a page built with `--bench`: the page's build refuses a release page
 * that carries its marker, and the app's build refuses a bench page unless it is built for the bench. Through the web
 * view's debugging port (debug builds only), a driver types into a kept family as the composer does, queues a send as
 * Send does, and reads counts, so the proofs nobody can time by hand (a kill 0 to 300 ms after a key, 0 to 400 ms
 * after a send) run at the engine's level until the places that draw them are registered.
 */
import type { EmailAddress, EngineMutation } from "@ohmail/wire";
import type { MirrorStore, OhmailEngine } from "./engine-package";
import { OUTBOX_TYPE } from "./engine-package";
import { isKept } from "../../src/shell/kept-families";
import type { LinkInTarget, SwitchPlace } from "../../src/shell/bridge-kinds";
import type { OtherAppDoor } from "./other-app";

/** The marker a release page must never carry. */
export const BENCH_MARKER = "ohmail-bench-door";

interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  setItem(key: string, value: string): void;
}

export interface BenchDoor {
  readonly marker: string;
  /** A keystroke into a kept family, written as the composer writes it: through the words door, natively first. */
  words(key: string, text: string): void;
  /** A letter queued as Send queues it; answers the engine's status for it. */
  send(letter: { to: string[]; subject: string; body: string; mailboxId: string }): Promise<string>;
  /** Counts only: the queue's sends, and the kept words of this page. */
  counts(): { outbox: number; words: number };
  /** A press of the switch, as the frame's switch will make it; answers what native did. */
  switchTo(place: SwitchPlace): Promise<"opened" | "absent">;
  /** The last place the other app opened this one at, held until a seat takes it; null when none came. */
  arrival(): LinkInTarget | null;
}

export function benchDoor(
  engine: OhmailEngine, store: MirrorStore, storage: StorageLike,
  other: { readonly door: OtherAppDoor; readonly arrival: () => LinkInTarget | null },
): BenchDoor {
  return {
    switchTo: (place) => other.door.open(place),
    arrival: other.arrival,
    marker: BENCH_MARKER,
    words(key, text) {
      if (!isKept(key)) throw new Error("the bench types into a kept family only");
      storage.setItem(key, text);
    },
    async send(letter) {
      const to: EmailAddress[] = letter.to.map((address) => ({ name: null, address }));
      const m: EngineMutation = {
        kind: "mail_send", inReplyTo: null, body: letter.body, subject: letter.subject, mailboxId: letter.mailboxId, to,
      };
      return (await engine.mutate(m)).status;
    },
    counts() {
      let words = 0;
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key !== null && isKept(key)) words += 1;
      }
      return { outbox: store.entries(OUTBOX_TYPE).length, words };
    },
  };
}
