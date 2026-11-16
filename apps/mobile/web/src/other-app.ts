/**
 * THE OTHER APP, AS THE PAGE MAY KNOW IT: which product it is, whether it is on this phone, and two asks of native.
 * This is the port the frame's switch takes (the host's `device.otherApp`, which the frame adds): it draws the other
 * product's half from `state`, opens it with `open`, and on `absent` offers the store with `get`. The page never sees
 * a code, an address or the other app's sign-in; native does every part of the switch.
 */
import type { Signal } from "@ohmail/app/host";
import type { OtherAppState, ShellApp, ShellConfig, SwitchPlace } from "../../src/shell/bridge-kinds";
import type { Bridge } from "./bridge";

export interface OtherAppDoor {
  /** The other product: the calendar from the mail's app, the mail from the calendar's. */
  readonly product: ShellApp;
  readonly state: Signal<OtherAppState>;
  /** Opens it at a place of this app's direction; `absent` when no app took the press. */
  open(place: SwitchPlace): Promise<"opened" | "absent">;
  /** Opens its store page; false where none could be opened. */
  get(): Promise<boolean>;
}

export function otherAppDoor(bridge: Bridge, config: Pick<ShellConfig, "app" | "other">): OtherAppDoor {
  let value = config.other;
  const listeners = new Set<() => void>();
  const set = (next: OtherAppState) => {
    if (next === value) return;
    value = next;
    for (const l of listeners) l();
  };
  bridge.on((e) => {
    if (e.type === "other") set(e.state);
  });
  return {
    product: config.app === "ohmail" ? "ohcal" : "ohmail",
    state: {
      read: () => value,
      subscribe(changed) {
        listeners.add(changed);
        return () => listeners.delete(changed);
      },
    },
    async open(place) {
      const { went } = await bridge.request("switch.open", { to: place });
      // A press the system took no app for says the other app is not here, until native reads it again.
      if (went === "absent") set("absent");
      return went;
    },
    async get() {
      return (await bridge.request("switch.store", {})).opened;
    },
  };
}
