/**
 * THE PHONE'S FACTS AS THE HOST CONTRACT'S SIGNALS, fed by the bridge's events: the fold, the
 * insets, the keyboard's height, back, a wake, and a letter handed in from outside. Native asks the
 * page two questions (`ask`): whether back was taken (handlers newest first, the first to answer true
 * took it) and how many unsent letters the page holds; the page answers each at once.
 */
import type { BackSignal, FoldReading, KeyboardReading, LinkIn, LinkedDraft, SafeInsets, Signal, WakeSignal } from "@ohmail/app/host";
import { parseMailto, type NoticePermission } from "./engine-package";
import type * as Wire from "../../src/shell/bridge-kinds";
import type { ShellConfig } from "../../src/shell/bridge-kinds";
import type { Bridge } from "./bridge";
import { backHandlers, cell } from "./cells";

/*
 * The bridge carries each fact in its own shape (the app's program cannot type the contract's door); here, where the
 * two meet, each is held equal to the contract's both ways. A field added on one side only fails to compile.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends readonly true[]> = T;
export type BridgeShapesAreTheContracts = Holds<[
  Same<Wire.FoldReading, FoldReading>, Same<Wire.SafeInsets, SafeInsets>, Same<Wire.KeyboardReading, KeyboardReading>,
  Same<Wire.LinkedDraft, LinkedDraft>, Same<Wire.NoticePermission, NoticePermission>,
]>;

/** The sync loop's "online" source, from native's network facts: each listener is told when the phone comes back online. */
export function onlineEvents(online: Signal<boolean>) {
  const offs = new Map<() => void, () => void>();
  return {
    addEventListener(_type: "online", listener: () => void): void {
      let was = online.read();
      offs.get(listener)?.();
      offs.set(listener, online.subscribe(() => {
        const now = online.read();
        if (now && !was) listener();
        was = now;
      }));
    },
    removeEventListener(_type: "online", listener: () => void): void {
      offs.get(listener)?.();
      offs.delete(listener);
    },
  };
}

export interface PhoneSignals {
  readonly posture: Signal<FoldReading>;
  readonly insets: Signal<SafeInsets>;
  readonly keyboard: Signal<KeyboardReading>;
  readonly online: Signal<boolean>;
  readonly back: BackSignal;
  readonly wake: WakeSignal;
  readonly linkIn: LinkIn;
}

export function phoneSignals(bridge: Bridge, facts: ShellConfig["facts"], unsent: () => number): PhoneSignals {
  const posture = cell(facts.posture);
  const insets = cell(facts.insets);
  const keyboard = cell(facts.keyboard);
  const online = cell(facts.online);
  const back = backHandlers();
  const wakes = new Set<(why: "foreground" | "push") => void>();
  const drafts: LinkedDraft[] = [];
  const arrivals = new Set<() => void>();
  const handIn = (draft: LinkedDraft) => {
    drafts.push(draft);
    for (const a of arrivals) a();
  };
  bridge.on((e) => {
    switch (e.type) {
      case "posture": return posture.set(e.reading);
      case "insets": return insets.set(e.insets);
      case "keyboard": return keyboard.set(e.reading);
      case "network": return online.set(e.online);
      case "wake": for (const w of wakes) w(e.why); return;
      case "linkIn": if (e.target.to === "compose") handIn(e.target.draft); return;
      case "mailto": {
        const draft = parseMailto(e.url);
        if (draft !== null) handIn(draft);
        return;
      }
      case "ask": {
        const answer = e.what === "back"
          ? { askId: e.askId, what: "back" as const, took: back.took() }
          : { askId: e.askId, what: "unsent" as const, unsent: unsent() };
        void bridge.request("answer", answer).catch(() => {});
        return;
      }
      default:
        return;
    }
  });
  return {
    posture,
    insets,
    keyboard,
    online,
    back: { subscribe: back.subscribe },
    wake: {
      subscribe(woke) {
        wakes.add(woke);
        return () => wakes.delete(woke);
      },
    },
    linkIn: {
      take: () => drafts.shift() ?? null,
      subscribe(arrived) {
        arrivals.add(arrived);
        return () => arrivals.delete(arrived);
      },
    },
  };
}
