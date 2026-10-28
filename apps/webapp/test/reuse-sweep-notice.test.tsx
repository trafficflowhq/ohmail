/** @vitest-environment jsdom */
/**
 * THE SIGN-IN AFTER A REUSE SWEEP IS TOLD OF IT, ONCE. The session read's `reuseSweeps` reach the
 * account strip through the per-owner feed; OK sends one acknowledgement and the strip goes at once,
 * a re-read while that is out does not bring it back, and a refused one does. Another account's jar
 * shows nothing of this one's feed.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const S = en.settings;
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fresh id per case: an acknowledged sweep stays put away for the life of the page. */
let sweep = { id: "", at: "2026-10-28T18:32:49.000Z", client: "web" };
let listed: unknown[] | undefined;
let acks: unknown[] = [];
let ackAnswer: () => Promise<Response>;
const realFetch = globalThis.fetch;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  sweep = { ...sweep, id: randomUUID() };
  listed = [sweep];
  acks = [];
  ackAnswer = async () => new Response(null, { status: 204 });
  document.cookie = "tf_owner=acct_A; Path=/";
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/auth/reuse-sweeps/ack")) {
      acks.push(JSON.parse(String(init?.body)));
      return ackAnswer();
    }
    if (u.includes("/auth/session")) {
      return json({
        scope: "full", user: { userId: "u-a", accountId: "acct_A", email: "a@lichtgrat.example", displayName: "A" },
        ...(listed ? { reuseSweeps: listed } : {}),
      });
    }
    return json({});
  }) as typeof fetch;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  globalThis.fetch = realFetch;
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
});

/** The session read the shell's confirm makes, which publishes the feed. */
async function read(): Promise<void> {
  const { auth } = await import("../app/api-client");
  await act(async () => { await auth.session(); });
}

async function mount(): Promise<void> {
  const { ReuseSweepStrip } = await import("../app/(product)/mailbox/ReuseSweepStrip");
  await act(async () => {
    root.render(h(NextIntlClientProvider, { locale: "en", messages: en, timeZone: "UTC", children: h(ReuseSweepStrip) }));
  });
}

const settle = (): Promise<void> => act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
/** How many times the strip names the swept browser: once is shown once. */
const told = (): number => (host.textContent ?? "").split(S.reuseClientWeb).length - 1;
const pressOk = async (): Promise<void> => {
  const ok = [...host.querySelectorAll("button")].find((b) => b.textContent === S.reuseSweepsOk);
  expect(ok, "no OK on the strip").toBeDefined();
  await act(async () => { ok!.click(); });
  await settle();
};

describe("the reuse sweeps a new sign-in is told of", () => {
  it("are shown once; OK sends one acknowledgement with the ids, and the strip goes", async () => {
    await read();
    await mount();
    expect(told()).toBe(1);
    expect(host.textContent).toContain("ohmail ended a sign-in to your account");
    await pressOk();
    expect(acks).toEqual([{ ids: [sweep.id] }]);
    expect(told()).toBe(0);
    await read();
    expect(told(), "a later read brought an acknowledged sweep back").toBe(0);
  });

  it("a re-read while the acknowledgement is out does not bring it back; a refused one does", async () => {
    let answer!: (r: Response) => void;
    ackAnswer = () => new Promise<Response>((resolve) => { answer = resolve; });
    await read();
    await mount();
    await pressOk();
    expect(told(), "OK did not take the strip away at once").toBe(0);
    await read();
    expect(told(), "a read while the press was out brought it back").toBe(0);
    await act(async () => { answer(json({ error: { code: "db_busy", message: "busy" } }, 503)); });
    await settle();
    expect(told(), "a refused acknowledgement left nothing to press").toBe(1);
    expect(acks).toHaveLength(1);
  });

  it("another account's jar shows nothing of this account's feed; nothing listed draws nothing", async () => {
    await read();
    document.cookie = "tf_owner=acct_B; Path=/";
    await mount();
    expect(told()).toBe(0);
    document.cookie = "tf_owner=acct_A; Path=/";
    listed = undefined;
    await read();
    expect(told()).toBe(0);
    expect(host.querySelector("button")).toBeNull();
  });
});
