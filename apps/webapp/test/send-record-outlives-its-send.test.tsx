/** @vitest-environment jsdom */
/**
 * A SEND RECORD OUTLIVES ITS SEND (step 1: the red routes).
 * The web send-lock record is the only thing that turns a replayed send's ending back into its
 * composer, and several sites delete records by AGE or by REPLACEMENT while the send they name is
 * still on the durable outbox. Each case below drives one deleting site with the shell's wiring
 * (`useMailSend`, `useComposeAutosave`, `settleCompose`) over the real HttpAdapter and asserts the
 * safe outcome: one delivery per message, and a composer cleared once its send has gone.
 * The fake server replays a key it holds and has no one-hour content claim, so a fresh key for the
 * same words is a second delivery here, as it is on the real service past that hour.
 */
/* @reads: packages/app-logic/src/writing/mail-send.ts */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { HttpAdapter, MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import type { MirrorStore } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { dto, listen, mailServer } from "../../mobile/test/helpers/mail-server";
import type { ComposeFields } from "@ohmail/app-logic/writing/compose";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const FIRST = "See you tomorrow, Bo.";
const REPLY = "Thanks, Ada.";
let root: Root | null = null;
const settle = async (n = 30): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
};
async function unmount(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  root = null; document.body.innerHTML = "";
}
const EMPTY = ({ to: "", cc: "", bcc: "", subject: "", body: "", html: "", fromMailboxId: "mb-1", sig: null } as never) as ComposeFields;
const fieldsFor = (body: string): ComposeFields => ({ to: "bo@fake.test", cc: "", bcc: "", subject: "Hello", body, html: "", fromMailboxId: "mb-1", sig: null } as never);
const replyTo = (body: string) => ({ kind: "mail_send", inReplyTo: "m-1", body, subject: "Re: Invoice", to: [{ name: "Ada", address: "ada@fake.test" }], mailboxId: "mb-1" });
const forwardOf = (body: string) => ({ kind: "mail_send", inReplyTo: null, forwardOf: "m-1", body, subject: "Fwd: Invoice", to: [{ name: null, address: "cy@fake.test" }], mailboxId: "mb-1" });

async function world() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("m-1", { subject: "Invoice", from: { name: "Ada", address: "ada@fake.test" } }));
  const memory = new MemoryMirrorStore(); await memory.load();
  // `hold`: a gate the `/send` requests wait on, to keep one on the wire.
  const net: { offline: boolean; hold: Promise<void> | null } = { offline: false, hold: null };
  const tabs: Array<{ dead: boolean }> = [];
  const engine = (store: MirrorStore = memory) => {
    for (const t of tabs) t.dead = true;
    const me = { dead: false }; tabs.push(me);
    return new OhmailEngine({
      store,
      adapter: new HttpAdapter({ baseUrl: origin, fetch: (u: string, i?: RequestInit) => (me.dead || (net.offline && !String(u).includes("/sync")) ? Promise.reject(new TypeError("fetch failed"))
        : net.hold !== null && String(u).endsWith("/send") ? net.hold.then(() => fetch(u, i)) : fetch(u, i)) } as never),
    });
  };
  const keys = (): number => new Set(fake.seen.filter((r) => r.method === "POST" && r.url.endsWith("/send")).map((r) => r.key)).size;
  const sentBodies = (): string[] => fake.draftRows().filter((d) => (d as { status?: string }).status === "sent").map((d) => String((d as { body?: string }).body));
  return { fake, net, engine, keys, sentBodies };
}

/** The compose surface as the shell wires it, plus the reply and forward lanes' presses. */
async function surface(engine: OhmailEngine) {
  const { useMailSend, SEND_IN_FLIGHT_PHASES, sendPendingInOutbox, replyDockState } = await import("@ohmail/app-logic/writing/mail-send");
  const { useMailSendText } = await import("../app/shell/mail-send-text.js");
  const { useComposeAutosave } = await import("@ohmail/app-logic/writing/compose-autosave");
  const { readComposeDraft, writeComposeDraft } = await import("@ohmail/app-logic/writing/compose");
  const initial = readComposeDraft(null);
  let api!: {
    body: () => string; held: () => boolean; edit: (a: string, b: string) => Promise<void>; press: () => Promise<void>;
    reply: (b: string) => Promise<void>; forward: (b: string) => Promise<void>; dockPhase: (lane: string) => string;
    withdraw: (lane: string) => Promise<string>;
  };
  const Probe = (): null => {
    const [fields, setF] = React.useState<ComposeFields>({ ...EMPTY, ...initial } as ComposeFields);
    // A render per engine notify, as the shell renders: the hold's read runs at render.
    const [, force] = React.useReducer((x: number) => x + 1, 0);
    React.useEffect(() => engine.subscribe(() => force()), []);
    const settleRef = React.useRef<(rowId: string | null, about: boolean) => void>(() => {});
    const mail = useMailSend(engine as never, null, (() => {}) as never,
      useMailSendText(), ((key: string, m: { draftId?: string | null }, about: boolean) => { if (key === "compose") settleRef.current(m.draftId ?? null, about); }) as never);
    const autosave = useComposeAutosave({
      engine: engine as never, fields, mailboxId: "mb-1", active: true,
      sendInFlight: SEND_IN_FLIGHT_PHASES.has(mail.stateOf("compose").phase) || sendPendingInOutbox(engine as never, "compose") || mail.restoredPending("compose"),
      onCleared: () => { setF(EMPTY); },
      scope: null,
    });
    settleRef.current = (rowId, about) => { autosave.settleCompose({ kind: "sentByMirror", rowId, aboutThisCompose: about }); };
    const send = mail.send as unknown as (m: unknown, o?: unknown) => void;
    api = {
      body: () => fields.body,
      held: () => mail.restoredPending("compose"),
      edit: async (a, b) => { await act(async () => { setF((f) => { const n = { ...f, body: f.body.replace(a, b) }; writeComposeDraft(n, null); return n; }); }); },
      press: async () => {
        if (fields.body === "") return;
        await act(async () => { send({ kind: "mail_send", inReplyTo: null, body: fields.body, subject: "Hello", to: [{ name: null, address: "bo@fake.test" }], mailboxId: "mb-1", ...(autosave.draftId ? { draftId: autosave.draftId } : {}) }); });
      },
      reply: async (b) => { await act(async () => { send(replyTo(b)); }); },
      forward: async (b) => { await act(async () => { send(forwardOf(b), { surface: "inline" }); }); },
      // The dock's state as the shell hands it to `InlineReply` (`replySendState`).
      dockPhase: (lane) => replyDockState(engine as never, mail.stateOf(lane), lane).phase,
      // The dock's Cancel, as `closeReply` presses it.
      withdraw: async (lane) => { let said = ""; await act(async () => { said = await mail.withdraw(lane); }); return said; },
    };
    return null;
  };
  const host = document.createElement("div"); document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(Probe) })); });
  return {
    body: () => api.body(), held: () => api.held(), edit: (a: string, b: string) => api.edit(a, b), press: () => api.press(),
    reply: (b: string) => api.reply(b), forward: (b: string) => api.forward(b), dockPhase: (lane: string) => api.dockPhase(lane),
    withdraw: (lane: string) => api.withdraw(lane),
  };
}

type Rec = { at: number; lane: string; key: string };
async function jar(): Promise<Rec[]> {
  const { sendLocksKey } = await import("@ohmail/app-logic/writing/send-lock");
  return JSON.parse(window.localStorage.getItem(sendLocksKey(null)) ?? "[]") as Rec[];
}
async function ageJar(ms: number): Promise<void> {
  const { sendLocksKey } = await import("@ohmail/app-logic/writing/send-lock");
  window.localStorage.setItem(sendLocksKey(null), JSON.stringify((await jar()).map((r) => ({ ...r, at: r.at - ms }))));
}
const lanes = async (): Promise<string[]> => (await jar()).map((r) => r.lane).sort();
const buffered = async (): Promise<string> => (await import("@ohmail/app-logic/writing/compose")).readComposeDraft(null).body;
async function online(w: Awaited<ReturnType<typeof world>>, e: OhmailEngine): Promise<void> {
  w.net.offline = false;
  for (let i = 0; i < 3; i++) { await act(async () => { await e.syncOnce(); }); await settle(10); }
  await settle(40);
}

/** A new message sent offline from the composer, and the tab closed with it on the outbox. */
async function composeSentOffline(w: Awaited<ReturnType<typeof world>>): Promise<void> {
  const { writeComposeDraft } = await import("@ohmail/app-logic/writing/compose");
  writeComposeDraft(fieldsFor(FIRST), null);
  const e1 = w.engine();
  const s1 = await surface(e1);
  await act(async () => { await e1.start(); });
  w.net.offline = true;
  await s1.press();
  await settle(20);
  expect(e1.pendingMutations(), "premise: the send waits on the outbox").toHaveLength(1);
  await unmount();
}

/** A reply (or an inline forward) sent offline from its dock, its scratch written first, and the tab closed. */
async function replySentOffline(w: Awaited<ReturnType<typeof world>>, kind: "reply" | "forward" = "reply"): Promise<void> {
  const { writeReplyDraft } = await import("@ohmail/app-logic/writing/mail-send");
  writeReplyDraft(kind === "reply" ? "m-1" : "fwd:m-1", { text: REPLY, html: "" }, null);
  const e1 = w.engine();
  const s1 = await surface(e1);
  await act(async () => { await e1.start(); });
  w.net.offline = true;
  if (kind === "reply") await s1.reply(REPLY); else await s1.forward(REPLY);
  await settle(20);
  expect(e1.pendingMutations(), "premise: the reply waits on the outbox").toHaveLength(1);
  await unmount();
}

beforeEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); });
afterEach(async () => { await unmount(); vi.restoreAllMocks(); });

const AGES = [["25 h", DAY + HOUR], ["6 d 23 h", 7 * DAY - HOUR], ["7 d 1 h", 7 * DAY + HOUR], ["8 d", 8 * DAY]] as const;

describe("REPLY-SWEEP: a press on another lane leaves a waiting compose's record alone (resumeSendLock's age sweep)", () => {
  for (const [label, later] of AGES) {
    for (const lane of ["reply", "forward"] as const) {
      it(`${label}, a ${lane} pressed while the compose send waits: still held, delivered once, composer cleared`, async () => {
        const w = await world();
        await composeSentOffline(w);
        await ageJar(later);
        const e2 = w.engine();
        const s2 = await surface(e2);
        await act(async () => { await e2.start(); });
        await settle(30);
        expect(s2.held(), "premise: the composer is held while its send waits").toBe(true);
        if (lane === "reply") await s2.reply(REPLY); else await s2.forward("FYI, Cy.");
        await settle(20);
        const afterPress = { held: s2.held(), composeRecords: (await jar()).filter((r) => r.lane === "compose").length };
        // Still offline: an edited Send of the held composer is refused while its send waits.
        await s2.edit("tomorrow", "Friday"); await s2.press(); await settle(20);
        await online(w, e2);
        expect({
          afterPress,
          composeDeliveries: w.sentBodies().filter((b) => b.includes("Bo.")),
          body: s2.body(), buffer: await buffered(),
        }, "the other lane's press deleted the waiting record").toEqual({
          afterPress: { held: true, composeRecords: 1 },
          composeDeliveries: [FIRST],
          body: "", buffer: "",
        });
      }, 60_000);
    }
  }
});

describe("COMPOSE-READ-SWEEPS-A-WAITING-REPLY: the composer's hold read leaves another lane's waiting record alone (allSendLocks)", () => {
  for (const [label, later] of AGES) {
    it(`${label}: a reply that waited keeps its record while it waits, goes once, and its dock is emptied`, async () => {
      const { readReplyDraft } = await import("@ohmail/app-logic/writing/mail-send");
      const w = await world();
      await replySentOffline(w);
      await ageJar(later);
      w.net.offline = true;
      const e2 = w.engine();
      await surface(e2);
      const atMount = await lanes();
      await act(async () => { await e2.start(); });
      await settle(30);
      const afterRestore = await lanes();
      await online(w, e2);
      /* Once the ending is heard the record is no longer owed: past the age limit the next read
         sweeps it (the control that the sweep still runs), inside it the record stays for a
         re-press of the same words. Either way nothing is left in the dock to press again. */
      expect({
        atMount, afterRestore, delivered: w.fake.deliveries().length, keys: w.keys(),
        afterReplay: await lanes(), dock: readReplyDraft("m-1", null).text,
      }, "the compose hold's read swept the waiting reply's record").toEqual({
        atMount: ["m-1"], afterRestore: ["m-1"], delivered: 1, keys: 1,
        afterReplay: later > 7 * DAY ? [] : ["m-1"], dock: "",
      });
    }, 60_000);
  }
});

describe("ADOPTED-REPLY-ENDING-LEAVES-ITS-SCRATCH (measured beside the routes, not a deletion site)", () => {
  for (const [label, later] of [AGES[0], AGES[3]] as const) for (const kind of ["reply", "forward"] as const) {
    it(`${label}: a restored ${kind} confirmed by the replay clears its dock's scratch`, async () => {
      const { readReplyDraft } = await import("@ohmail/app-logic/writing/mail-send");
      const w = await world();
      await replySentOffline(w, kind);
      await ageJar(later);
      const e2 = w.engine();
      await surface(e2);
      await act(async () => { await e2.start(); });
      await online(w, e2);
      expect({ delivered: w.fake.deliveries().length, scratch: readReplyDraft(kind === "reply" ? "m-1" : "fwd:m-1", null).text },
        "the reply went and its words stayed in the dock").toEqual({ delivered: 1, scratch: "" });
    }, 60_000);
  }
});

describe("RESTORED-DOCK-CLEAR: a restored reply's dock is held while its send waits, so the ending clears only the words that went", () => {
  for (const [label, later] of [AGES[0], AGES[3]] as const) for (const kind of ["reply", "forward"] as const) {
    it(`${label}: a restored ${kind}'s dock is not editable while it waits, and a rewrite cannot be lost`, async () => {
      const { readReplyDraft, writeReplyDraft } = await import("@ohmail/app-logic/writing/mail-send");
      const lane = kind === "reply" ? "m-1" : "fwd:m-1";
      const w = await world();
      await replySentOffline(w, kind);
      await ageJar(later);
      w.net.offline = true;
      const e2 = w.engine();
      const s2 = await surface(e2);
      await act(async () => { await e2.start(); });
      await settle(30);
      const dockWhileWaiting = s2.dockPhase(lane);
      /* The person tries to rewrite the dock. `InlineReply` makes its editor editable only when the
         phase is neither sending nor queued, and its scratch is written per edit. */
      const editable = dockWhileWaiting !== "sending" && dockWhileWaiting !== "queued";
      const REWRITE = "Second thought: can we talk Monday?";
      if (editable) writeReplyDraft(lane, { text: REWRITE, html: "" }, null);
      await online(w, e2);
      const scratch = readReplyDraft(lane, null).text;
      expect({
        dockWhileWaiting, delivered: w.fake.deliveries().length, keys: w.keys(),
        wordsLost: editable && scratch !== REWRITE, dockAfter: s2.dockPhase(lane), scratch,
      }, "the restored dock took new words and the ending cleared them").toEqual({
        dockWhileWaiting: "queued", delivered: 1, keys: 1, wordsLost: false, dockAfter: "idle", scratch: "",
      });
    }, 60_000);
  }

  it("the shell hands the dock its state through replyDockState", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const shell = readFileSync(resolve(process.cwd(), "apps/webapp/app/shell/shell-compose.ts"), "utf8");
    expect(shell).toContain("const state = replyDockState(engine, mailSend.stateOf(lane), lane);");
  });
});

/* The restored send was attempted by the last session (this host has no shared disk, so the attempt
   wrote the wire fact): a Cancel the server cannot answer is held and owed, never "withdrawn". */
describe("RESTORED-DOCK-CANCEL: a restored reply's Cancel asks the server, held until it answers", () => {
  for (const [label, later] of [AGES[0], AGES[3]] as const) for (const kind of ["reply", "forward"] as const) {
    it(`${label}: Cancel on a restored ${kind} offline is held; online the server withdraws it: nothing delivered, the dock free, the record released`, async () => {
      const lane = kind === "reply" ? "m-1" : "fwd:m-1";
      const w = await world();
      await replySentOffline(w, kind);
      await ageJar(later);
      w.net.offline = true;
      const e2 = w.engine();
      const s2 = await surface(e2);
      await act(async () => { await e2.start(); });
      await settle(30);
      const before = s2.dockPhase(lane);
      const said = await s2.withdraw(lane);
      const afterCancel = { dock: s2.dockPhase(lane), records: (await jar()).filter((r) => r.lane === lane).length };
      await online(w, e2);
      const end = { dock: s2.dockPhase(lane), records: (await jar()).filter((r) => r.lane === lane).length };
      expect({ before, said, afterCancel, end, delivered: w.fake.deliveries().length, tombstoned: w.fake.withdrawnKeys().length },
        "Cancel on the restored dock").toEqual({
        before: "queued", said: "unreachable", afterCancel: { dock: "queued", records: 1 },
        end: { dock: "idle", records: 0 }, delivered: 0, tombstoned: 1,
      });
    }, 60_000);
  }

  it("a restored reply already on the wire: Cancel says it has gone, the dock stays held, and it goes once", async () => {
    const lane = "m-1";
    const w = await world();
    await replySentOffline(w);
    let release!: () => void;
    w.net.hold = new Promise<void>((r) => { release = r; });
    const e2 = w.engine();
    const s2 = await surface(e2);
    await act(async () => { await e2.start(); });
    // The reconnect's sync drives the replay; its `/send` waits at the gate, on the wire.
    w.net.offline = false;
    const syncing: Array<Promise<unknown>> = [];
    for (let i = 0; i < 100 && e2.inFlightMutations().length === 0; i++) {
      if (i % 20 === 0) await act(async () => { syncing.push(e2.syncOnce()); });
      await settle(1);
    }
    expect(e2.inFlightMutations().length, "premise: the replay's request is on the wire").toBe(1);
    const said = await s2.withdraw(lane);
    const held = s2.dockPhase(lane);
    release(); w.net.hold = null;
    await act(async () => { await Promise.all(syncing); });
    await online(w, e2);
    expect({ said, held, delivered: w.fake.deliveries().length, keys: w.keys(), after: s2.dockPhase(lane) },
      "a Cancel pressed while the reply was on the wire").toEqual({
      said: "already_sent", held: "queued", delivered: 1, keys: 1, after: "idle",
    });
  }, 60_000);
});

describe("OWN-PRESS: a window's own press is judged by its own outbox view", () => {
  it("a message sent and confirmed in this window releases its record (written after the view, pressed here)", async () => {
    const { writeComposeDraft } = await import("@ohmail/app-logic/writing/compose");
    const w = await world();
    writeComposeDraft(fieldsFor(FIRST), null);
    const e = w.engine();
    const s = await surface(e);
    await act(async () => { await e.start(); });
    await s.press();
    await settle(40);
    expect({ delivered: w.fake.deliveries().length, records: (await jar()).length, phase: s.held() },
      "this window's own confirmed send was read as another window's and its record kept").toEqual({ delivered: 1, records: 0, phase: false });
  }, 60_000);
});

describe("SECOND-COMPOSE-EVICTS: another composer's press leaves a waiting compose's record alone (claimSendLock and resumeSendLock's spent sweep)", () => {
  for (const [label, later] of [["1 h", HOUR], ["8 d", 8 * DAY]] as const) {
    it(`${label}: a second tab presses a different new message while the first tab's send waits`, async () => {
      const { claimSendLock, resumeSendLock, sendIdentity, SEND_LOCK_FORMAT } = await import("@ohmail/app-logic/writing/send-lock");
      const { sendLockOwed } = await import("@ohmail/app-logic/writing/mail-send");
      const w = await world();
      await composeSentOffline(w);
      await ageJar(later);
      const e2 = w.engine();
      const s2 = await surface(e2);
      await act(async () => { await e2.start(); });
      await settle(30);
      expect(s2.held(), "premise: the composer is held while its send waits").toBe(true);
      /* THE SECOND TAB'S PRESS, on the jar both tabs share: `useMailSend.send` runs exactly these
         two calls for a compose-lane press that joins nothing, under that tab's own session. Its
         wire half is not this case's subject. What it knows is owed is read off the account's one
         outbox, which both tabs' mirrors load from the same database: modelled by the first
         composer's engine, which holds that same row. */
      const owed = sendLockOwed(e2);
      const other = { kind: "mail_send", inReplyTo: null, body: "Lunch on Monday, Cy?", subject: "Lunch", to: [{ name: null, address: "cy@fake.test" }], mailboxId: "mb-1" };
      const id = sendIdentity(other as never, "tab-2-session");
      const resumed = resumeSendLock("compose", id, Date.now(), owed, null);
      claimSendLock({
        v: SEND_LOCK_FORMAT, lane: "compose", key: crypto.randomUUID(), at: Date.now(), draftId: null, fp: id.fp,
        ...(id.subjects[0] !== undefined ? { subject: id.subjects[0] } : {}), session: "tab-2-session", bfp: "tab-2-buffer",
      }, owed, null);
      const afterOther = { resumed, held: s2.held(), composeRecords: (await jar()).filter((r) => r.lane === "compose").length };
      await online(w, e2);
      const afterNet = { body: s2.body(), buffer: await buffered() };
      await s2.edit("tomorrow", "Friday"); await s2.press(); await settle(30);
      await act(async () => { await e2.syncOnce(); }); await settle(20);
      expect({ afterOther, afterNet, deliveries: w.sentBodies().filter((b) => b.includes("Bo.")) },
        "the second tab's press deleted the first tab's waiting record").toEqual({
        afterOther: { resumed: null, held: true, composeRecords: 2 },
        afterNet: { body: "", buffer: "" },
        deliveries: [FIRST],
      });
    }, 60_000);
  }
});
