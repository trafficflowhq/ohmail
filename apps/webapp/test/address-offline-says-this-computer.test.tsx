/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { MutationRejectedError, OhmailEngine, REASK_MAX } from "@ohmail/client-engine";
import { DEMO_NOW, FixturesAdapter } from "@ohmail/testing/adapter";
import messages from "../messages/en.json";
import { AddressView } from "../app/views/AddressView";
import { KeymapProvider } from "../app/shell/keymap";

/**
 * On the paired desktop with the account out
 * of reach, the door refuses an address count (503 `offline_read_only`) rather than answer it from
 * the mirror. The view said "Your server did not answer" and offered a Try again that could only
 * be refused again; it now says the rows are this computer's mail, and the pass is asked again on
 * the first drain the account answers (the store reads' one rule).
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const JONAS = "jonas@lichtgrat.example";
let host: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

function engineFailing(fail: () => unknown) {
  const asked = { n: 0, down: true };
  const engine = new OhmailEngine({
    adapter: new FixturesAdapter(),
    now: () => DEMO_NOW,
    serverAddressSearch: async () => {
      asked.n += 1;
      if (asked.down) throw fail();
      return { items: [], total: 0, direction: "from" };
    },
  });
  return { engine, asked };
}

async function mount(engine: OhmailEngine): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC" now={DEMO_NOW}>
      <KeymapProvider><AddressView engine={engine} version={1} now={DEMO_NOW} address={JONAS} onOpen={() => {}} /></KeymapProvider>
    </NextIntlClientProvider>,
  ));
  return host;
}
const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };
const offline = () => new MutationRejectedError("this install is offline", { status: 503, code: "offline_read_only", retryable: true });
const tryAgain = (el: HTMLElement) => [...el.querySelectorAll("button")].filter((b) => b.textContent === messages.search.addressRetry);

describe("the address view on a paired desktop whose account is out of reach", () => {
  it("says the rows are this computer's mail, with no Try again", async () => {
    const { engine } = engineFailing(offline);
    await engine.start();
    const el = await mount(engine);
    await settle();
    expect(el.textContent).toContain(messages.search.addressOffline);
    expect(el.textContent).not.toContain(messages.search.scopeUnanswered);
    expect(tryAgain(el)).toHaveLength(0);
  });

  it("control: a server that answered with a fault keeps its sentence and its Try again", async () => {
    const { engine } = engineFailing(() => new MutationRejectedError("boom", { status: 500, code: "internal", retryable: true }));
    await engine.start();
    const el = await mount(engine);
    await settle();
    expect(el.textContent).toContain(messages.search.scopeUnanswered);
    expect(tryAgain(el)).toHaveLength(1);
  });

  it("is asked again on the first drain the account answers, and the view says the archive's answer", async () => {
    const { engine, asked } = engineFailing(offline);
    await engine.start();
    const el = await mount(engine);
    await settle();
    expect(asked.n).toBe(1);
    asked.down = false;
    await act(async () => { await engine.syncOnce(); });
    await settle();
    expect(asked.n).toBe(2);
    expect(el.textContent).not.toContain(messages.search.addressOffline);
  });

  it(`a door that keeps refusing while drains complete is asked at most ${REASK_MAX} times`, async () => {
    const { engine, asked } = engineFailing(offline);
    await engine.start();
    await mount(engine);
    await settle();
    for (let i = 0; i < REASK_MAX + 2; i++) { await act(async () => { await engine.syncOnce(); }); await settle(); }
    expect(asked.n, "re-asked past the cap, or never").toBe(1 + REASK_MAX);
  });
});
