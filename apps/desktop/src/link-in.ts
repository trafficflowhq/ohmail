/**
 * A MAIL LINK HANDED IN FROM OUTSIDE THE WINDOW, held until the frame takes it. The OS hands a `mailto:` to the shell,
 * this window claims it and offers it here; the mounted frame takes it once, at mount and on every arrival, so a link
 * that arrives before a mailbox is connected becomes the composer the moment one is.
 */
import type { LinkedDraft, LinkIn } from "@ohmail/app/host";

export interface LinkSlot extends LinkIn {
  /** A link arrived: it replaces one not yet taken, and whoever listens is told. */
  offer(draft: LinkedDraft): void;
}

export function linkSlot(): LinkSlot {
  let held: LinkedDraft | null = null;
  const listeners = new Set<() => void>();
  return {
    take() {
      const taken = held;
      held = null;
      return taken;
    },
    subscribe(arrived) {
      listeners.add(arrived);
      return () => {
        listeners.delete(arrived);
      };
    },
    offer(draft) {
      held = draft;
      for (const arrived of [...listeners]) arrived();
    },
  };
}
