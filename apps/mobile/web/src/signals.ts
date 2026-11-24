/**
 * THE PHONE'S FACTS AS THE HOST CONTRACT'S SIGNALS, fed by the bridge's events: the fold, the
 * insets, the keyboard's height, back, a wake, and a letter handed in from outside. Native asks the
 * page two questions (`ask`): whether back was taken (handlers newest first, the first to answer true
 * took it) and how many unsent letters the page holds; the page answers each at once.
 */
import type { BackSignal, HostAddress, FoldReading, KeyboardReading, LinkIn, LinkedDraft, SafeInsets, Signal, WakeSignal } from "@ohmail/app/host";
import { closeTopOverlay } from "@ohmail/ui/base";
import { parseMailto, type MailNotice, type NOTICE_COUNT_MAX, type NoticePermission } from "./engine-package";
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
  Same<Wire.BridgeNotice, Exclude<MailNotice, { readonly kind: "scheduled" }>>,
  Same<typeof Wire.NOTICE_COUNT_MAX, typeof NOTICE_COUNT_MAX>,
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

export function phoneSignals(bridge: Bridge, facts: ShellConfig["facts"], unsent: () => number, address?: HostAddress): PhoneSignals {
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
  let held: { id: number; control: AbortController; keep: () => void } | null = null;
  // The active WebView can still receive input between posting its final exit and native receiving it.
  let exitPending: { id: number; release(): void } | null = null;
  const exitEnded = (id: number) => {
    if (exitPending?.id !== id) return;
    exitPending.release();
    exitPending = null;
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
      case "backEnded":
        exitEnded(e.askId);
        if (held?.id === e.askId) {
          held.control.abort();
          held = null;
        }
        return;
      case "ask": {
        if (e.what === "back") {
          const { askId } = e;
          // Native retires the previous physical press before issuing another.
          if (exitPending && exitPending.id !== askId) exitEnded(exitPending.id);
          const answer = (took: boolean | "held" | "prepare" | "discard") =>
            bridge.request("answer", { askId: askId, what: "back", took }).then((r) => r.accepted, () => false);
          if (closeTopOverlay()) { void answer(true); return; }
          if (held) { held.keep(); void answer(true); return; }
          if (back.took()) { void answer(true); return; }
          const control = new AbortController();
          const at = address?.read();
          const keep = () => {
            if (held?.id !== askId) return;
            held = null;
            control.abort();
            // A reply from native also proves that a final exit with a lost receipt was settled.
            void bridge.request("answer", { askId: askId, what: "back", took: true })
              .then(() => exitEnded(askId), () => {});
          };
          const current = () => held?.id === askId && address?.read() === at;
          held = { id: askId, control, keep };
          const reserved = answer("held");
          let prepared: Promise<boolean> | undefined;
          const prepare = () => prepared ??= (async () => (
            await reserved && current() && await answer("prepare") && current() && await answer(false) && current()
          ))();
          const askForDraft = () => address?.heldBefore("", () => finish(), { signal: control.signal, keep }) === true;

          async function finish(checkForDraft = false): Promise<boolean> {
            if (!await prepare() || !current()) {
              keep();
              return false;
            }
            const body = globalThis.document?.body;
            const ownInert = body !== undefined && !body.hasAttribute("inert");
            if (ownInert) body.setAttribute("inert", "");
            exitPending = { id: askId, release: () => { if (ownInert) body.removeAttribute("inert"); } };
            // An edit can register its hold while the native acknowledgement is on its way.
            if (checkForDraft && askForDraft()) {
              exitEnded(askId);
              return false;
            }
            try {
              const receipt = await bridge.request("answer", { askId: askId, what: "back", took: "discard" });
              exitEnded(askId);
              if (receipt.accepted && current()) {
                held = null;
                return true;
              }
            } catch {
              // A missing receipt leaves the hold in place until native acknowledges Keep or retires this press.
            }
            keep();
            return false;
          }

          if (!askForDraft()) void finish(true);
        } else {
          void bridge.request("answer", { askId: e.askId, what: "unsent", unsent: unsent() }).catch(() => {});
        }
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
