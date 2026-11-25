/**
 * THE PHONE'S CLIENT ENGINE, composed in the page as the desktop's window composes its own: the
 * adapter over the bridge (native adds the server, the base and the bearer), inside the account rule,
 * over the page's copy partitioned by the scope native minted. The engine's own outbox replay is on;
 * the queue's rows are written natively before the copy publishes them (the keeper's store).
 */
import { HttpAdapter, OhmailEngine, SYNC_ENTITY_TYPES, type MirrorStore } from "./engine-package";
import { KeptIdbStore } from "./kept-store";
import { BROWSER_WINDOW } from "@ohmail/app-logic/session/store-windows";
import type { ShellConfig } from "../../src/shell/bridge-kinds";
import { accountGuarded } from "./account-guard";
import type { Bridge } from "./bridge";
import { accountFetch } from "./account-fetch";
import { bridgeFetch } from "./bridge-fetch";

export interface PhoneEngine {
  readonly engine: OhmailEngine;
  readonly store: MirrorStore;
}

/** The page's copy of one scope, its queue kept natively first. */
export function keptStoreOf(bridge: Bridge, scope: string, calendarOnly = false): KeptIdbStore {
  return new KeptIdbStore({ owner: scope, calendarOnly }, {
    rows: async () => (await bridge.request("keptRows", { scope })).rows,
    write: async (puts, deletes) => (await bridge.request("keepRows", { scope, puts, deletes })).kept,
  });
}

/** `store` is the page's copy: the keeper's store in the shell, a plain one in a test that needs none. */
export function createPhoneEngine(
  config: ShellConfig,
  bridge: Bridge,
  store: MirrorStore = keptStoreOf(bridge, config.scope, config.app === "ohcal"),
): PhoneEngine {
  const paired = config.setting !== "standalone";
  const calendarOnly = config.app === "ohcal";
  const adapter = new HttpAdapter({
    // Root-relative: native composes the server and the base. No cookie is ever read on the page.
    baseUrl: "",
    fetch: bridgeFetch(bridge, config.scope),
    getCookie: () => null,
    // The two `/hello` reads a paired server answers; the phone's own engine is this same build.
    forwardPartsCheck: paired && !calendarOnly,
    scheduleFilesCheck: paired && !calendarOnly,
    calendarOnly,
    ...(calendarOnly ? {
      saveCalendarSettings: (body) => accountFetch(bridge, config.scope)("/calendar/settings", "PATCH", body),
    } : {}),
  });
  const engine = new OhmailEngine({
    adapter: accountGuarded(adapter, config.accountId),
    store,
    // The phone's bound on its copy: 90 days, 5,000 to 10,000 rows, as on the web and the desktop.
    storePolicy: BROWSER_WINDOW,
    types: [...SYNC_ENTITY_TYPES],
    calendarOnly,
    uuid: () => crypto.randomUUID(),
    inlineImageUrls: "object",
    // One page per scope: every kept row is this engine's. With the web view's own locks on, a row
    // only the keeper holds (the view's storage emptied) would name a dead owner and never be sent.
    locks: null,
  });
  return { engine, store };
}
