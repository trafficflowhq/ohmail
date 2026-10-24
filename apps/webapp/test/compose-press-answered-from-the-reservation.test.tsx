/** @vitest-environment jsdom */
/**
 * A COMPOSE PRESS THE SERVER ANSWERS FROM ITS RESERVATION SAYS SO (the cross-window send fix, the
 * ruling's 'already sent' row). A send confirmed while nobody listened leaves its record standing,
 * so the same message pressed again resumes that key and the server answers from the reservation
 * with `firstSend`: "Message sent." there claimed a delivery that did not happen. The sentence keys
 * on `firstSend`, never on the key having been resumed, and the composer settles either way. A record
 * over a SETTLED key is spent: that press is a new key and
 * the server's duplicate claim answers it, naming the first send — never "Message sent.".
 */
/* @reads: apps/webapp/app/shell/mail-send.ts */
import { afterEach, beforeEach, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { MemoryMirrorStore, MutationRejectedError, OhmailEngine, type EngineMutation } from "@ohmail/client-engine";
import messages from "../messages/en.json";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
let root: Root | null = null;

function engineOver(reserved: Set<string>, deliveries: string[], pressed: string[] = [], claimed = new Set<string>(), loseFirst = false): OhmailEngine {
  return new OhmailEngine({
    store: new MemoryMirrorStore(),
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date().toISOString() }),
      fetchBody: async () => null,
      mutate: async (m: EngineMutation, o: { idempotencyKey: string }) => {
        if (m.kind !== "mail_send") return { changes: [], seq: null };
        pressed.push(o.idempotencyKey);
        if (reserved.has(o.idempotencyKey)) return { changes: [], seq: null, firstSend: { status: "sent", at: new Date().toISOString() } };
        // THE SERVER'S CONTENT CLAIM (`SEND_DUPLICATE_WINDOW_MS`): the same words under a new key within the hour.
        const words = String((m as { body?: string }).body);
        if (claimed.has(words)) {
          throw new MutationRejectedError("This message was already sent; nothing was sent now.", {
            status: 409, code: "duplicate_send", retryable: false, details: { firstSend: { status: "sent", at: new Date().toISOString() } },
          });
        }
        reserved.add(o.idempotencyKey);
        claimed.add(words);
        deliveries.push(o.idempotencyKey);
        if (loseFirst && deliveries.length === 1) throw new MutationRejectedError("network failure: Failed to fetch", { code: "network", retryable: true });
        return { changes: [], seq: null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
    } as never,
  });
}

const MESSAGE = {
  kind: "mail_send", inReplyTo: null, body: "See you Friday, Bo.", subject: "Friday",
  to: [{ name: null, address: "bo@fake.test" }], mailboxId: "mb-1",
};

async function mount(engine: OhmailEngine, said: string[], settled: string[]): Promise<() => Promise<void>> {
  const { useMailSend } = await import("../app/shell/mail-send.js");
  let press!: () => Promise<void>;
  const Probe = (): null => {
    const mail = useMailSend(engine as never, ((text: string) => { said.push(text); }) as never,
      ((key: string) => { settled.push(key); }) as never);
    press = async () => { await act(async () => { (mail.send as unknown as (m: unknown) => void)(MESSAGE); }); };
    return null;
  };
  const host = document.createElement("div"); document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(Probe) })); });
  return () => press();
}
const settleAll = async (): Promise<void> => { for (let i = 0; i < 200; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };

beforeEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.innerHTML = ""; });

for (const shape of ["a record left standing, the server holding its key", "no record: a first delivery"] as const) {
  it(`${shape}: the sentence follows firstSend, and the composer settles`, async () => {
    const { claimSendLock, sendIdentity, SEND_LOCK_FORMAT } = await import("../app/shell/send-lock.js");
    const { composeSessionId } = await import("../app/shell/compose.js");
    const { sendLockOwed } = await import("../app/shell/mail-send.js");
    const reserved = new Set<string>(); const deliveries: string[] = [];
    const engine = engineOver(reserved, deliveries);
    // The record's key is still OWED: the outbox has not been read, so no key is settled.
    if (shape === "no record: a first delivery") await engine.start();
    if (shape === "a record left standing, the server holding its key") {
      const id = sendIdentity(MESSAGE as never, composeSessionId());
      reserved.add("K-earlier");
      claimSendLock({ v: SEND_LOCK_FORMAT, lane: "compose", key: "K-earlier", at: Date.now(), draftId: null, fp: id.fp,
        ...(id.subjects[0] !== undefined ? { subject: id.subjects[0] } : {}), ...(id.session !== null ? { session: id.session } : {}) }, sendLockOwed(engine));
    }
    const said: string[] = []; const settled: string[] = [];
    const press = await mount(engine, said, settled);
    await press(); await settleAll();
    expect({ said, settled: settled.includes("compose"), deliveries: deliveries.length }).toEqual(
      shape === "no record: a first delivery"
        ? { said: ["Message sent."], settled: true, deliveries: 1 }
        : { said: ["This message had already been sent. It went once."], settled: true, deliveries: 0 },
    );
  });
}

it("a record over a SETTLED key is spent — the press is a new key, the server's duplicate claim answers it, nothing is sent", async () => {
  const { claimSendLock, sendIdentity, SEND_LOCK_FORMAT } = await import("../app/shell/send-lock.js");
  const { composeSessionId } = await import("../app/shell/compose.js");
  const { sendLockOwed } = await import("../app/shell/mail-send.js");
  const reserved = new Set<string>(["K-earlier"]); const deliveries: string[] = []; const pressed: string[] = [];
  const engine = engineOver(reserved, deliveries, pressed, new Set([MESSAGE.body]));
  await engine.start();
  const id = sendIdentity(MESSAGE as never, composeSessionId());
  claimSendLock({ v: SEND_LOCK_FORMAT, lane: "compose", key: "K-earlier", at: Date.now(), draftId: null, fp: id.fp,
    ...(id.subjects[0] !== undefined ? { subject: id.subjects[0] } : {}), ...(id.session !== null ? { session: id.session } : {}) }, sendLockOwed(engine));
  const said: string[] = []; const settled: string[] = [];
  const press = await mount(engine, said, settled);
  await press(); await settleAll();
  expect({ newKey: pressed.length === 1 && pressed[0] !== "K-earlier", said, deliveries: deliveries.length })
    .toEqual({ newKey: true, said: [], deliveries: 0 });
});

it("this press's own answer lost: its retry is answered from its own reservation, and the sentence is the delivery", async () => {
  const reserved = new Set<string>(); const deliveries: string[] = []; const pressed: string[] = [];
  const engine = engineOver(reserved, deliveries, pressed, new Set(), true);
  await engine.start();
  const said: string[] = []; const settled: string[] = [];
  const press = await mount(engine, said, settled);
  await press(); await settleAll();
  await act(async () => { window.dispatchEvent(new Event("online")); });
  await settleAll();
  expect({ said, settled: settled.includes("compose"), deliveries: deliveries.length, asked: pressed.length, keys: new Set(pressed).size })
    .toEqual({ said: ["Message sent."], settled: true, deliveries: 1, asked: 2, keys: 1 });
});
