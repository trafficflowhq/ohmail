/**
 * THE SHELL'S PAGE: the phone's web view runs this, from the app's own files. `boot` comes first: it
 * finds the bridge and installs the words door before any other module can write to storage. Then
 * the page reads the kept words, asks native what it is to be, builds the client engine over the
 * bridge, answers the host contract for its setting and mounts the frame over it.
 */
import { bridge, kept } from "./boot";
import catalogue from "./catalogue";
import { createRoot, type Root } from "react-dom/client";
import { startSyncScheduler, type SyncStatus } from "@ohmail/app-logic/session/sync-scheduler";
import { unsentDraftsOf, type NoticePermission } from "./engine-package";
import { benchDoor, type BenchDoor } from "./bench";
import { note, type Bridge } from "./bridge";
import { createPhoneEngine, keptStoreOf } from "./engine";
import { phoneFrameSupplies } from "./frame-supplies";
import { phoneHost } from "./host";
import type { KeptStorage } from "./kept-storage";
import { takeOldCopy } from "./old-copy";
import { ownStorage } from "./owner";
import { PhonePage } from "./page";
import { onlineEvents, phoneSignals } from "./signals";
import { Standing } from "./standing";

const element = document.getElementById("root");

async function start(bridge: Bridge, kept: KeptStorage, root: Root): Promise<void> {
  // The native copy of a person's words first, for the scope native names: nothing reads storage before it is the
  // native set. The scope is native's word, never the storage's: every mailbox's page writes the same storage.
  const { words, refused } = await bridge.request("kept", {});
  const config = await bridge.request("config", {});
  await kept.adopt(words, refused, config.scope);
  ownStorage(config.scope);
  // The phone's old copy of this mailbox, taken once, before the engine reads its own. One that could not be taken
  // stays, unmarked: the next start takes it again, filling only what this one lacks.
  if (config.oldCopy === "present") {
    const store = keptStoreOf(bridge, config.scope);
    try {
      await store.load();
      await takeOldCopy(bridge, config.scope, store, localStorage);
    } catch {
      note(bridge, "copyNotTaken");
    } finally {
      store.close();
    }
  }
  const { engine, store } = createPhoneEngine(config, bridge);
  // The emulator bench's door, in a page built for the bench alone (the build drops this branch otherwise).
  if (__OHMAIL_BENCH__) (window as unknown as { __ohmailBench?: BenchDoor }).__ohmailBench = benchDoor(engine, store, localStorage);
  const signals = phoneSignals(bridge, config.facts, () => unsentDraftsOf(engine.read()).length);
  let permission: NoticePermission = config.notifications;
  const frame = phoneFrameSupplies(config.place, (fragment) => void bridge.request("place", { fragment }).catch(() => {}));
  const facts = { setting: config.setting, scope: config.scope, accountId: config.accountId, build: config.build };
  const host = phoneHost(engine, facts, {
    signOut: async () => { await bridge.request("act", { act: "signOut" }); },
    frame,
    notifications: {
      permission: () => permission,
      request: async () => {
        const answer = await bridge.request("act", { act: "notifications.request" });
        permission = answer.permission ?? permission;
        return permission;
      },
    },
    signals,
  });
  /* The phone polls: no event stream (wake: null). A wake from native (the app back in front, or a push) drains now. */
  const sync = (status: (s: SyncStatus) => void) =>
    startSyncScheduler(engine, {
      onStatus: status,
      online: onlineEvents(signals.online),
      wake: null,
      pushWakes: (woke) => signals.wake.subscribe(() => woke()),
    });
  root.render(
    <PhonePage
      host={host}
      locale={config.language}
      catalogue={catalogue}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
      sync={sync}
      drawn={() => void bridge.request("ready", { place: frame.address.read() }).catch(() => {})}
    />,
  );
}

if (bridge && kept && element) {
  const root = createRoot(element);
  root.render(<Standing />);
  void start(bridge, kept, root);
}
