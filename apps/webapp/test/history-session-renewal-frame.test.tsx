/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { STORE_ANSWER_TIMEOUT_MS, type OhmailEngine } from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { getByText } from "@testing-library/dom";
import messages from "../messages/en.json";
import historyWords from "../../../packages/app/messages/history.en.json";
import { stubDom, unmountAll } from "./_draft-shell";
import { MailShell } from "./_mail-shell";
import {
  markSessionAlive, registerSessionProbe, resetSessionTruthForTests,
} from "@ohmail/app-logic/session/session-truth";
import { FIXTURE_NOW, storeFixture, storeRows } from "./_store-fixture";

/**
 * A 401 ON HISTORY'S READ IS THE SESSION'S ANSWER, NOT THE SERVER'S. The access cookie lapses every
 * fifteen minutes; History's store reads go through the engine's transport, which does not renew,
 * so the read met the 401, History said "Your server did not answer" and kept the recent mail for
 * good, while the renewal another request made answered 204 a moment later. History now asks the
 * renewal itself, says it is loading while that is out, and asks again once it answers.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const N = 120;
const SENTENCE = messages.history.storeUnavailable;

let roots: Root[] = [];
beforeEach(() => {
  stubDom();
  history.replaceState(null, "", "#/history");
});
afterEach(async () => {
  for (const r of roots) await act(() => { r.unmount(); });
  roots = [];
  await unmountAll();
  resetSessionTruthForTests();
  vi.useRealTimers();
});

async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
}

async function mountHistory(engine: OhmailEngine): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={{ ...messages, ...historyWords }} now={FIXTURE_NOW} timeZone="UTC">
        <ThemeProvider storageKey={null}>
          <ToastHost>
            <MailShell engine={engine} />
          </ToastHost>
        </ThemeProvider>
      </NextIntlClientProvider>,
    );
  });
  return host;
}

const said = (host: HTMLElement): string => host.textContent ?? "";

describe("History over a session renewal", () => {
  it("a 401 asks the renewal, says nothing about the server, and History re-asks once it answers", async () => {
    let status: number | null = 401;
    const probes: number[] = [];
    registerSessionProbe(() => { probes.push(Date.now()); });
    const fx = await storeFixture(storeRows(N), { refuse: () => status });
    const host = await mountHistory(fx.engine);
    await settle();

    expect(said(host), "a refused session read as a silent server").not.toContain(SENTENCE);
    expect(probes.length, "nothing asked for the renewal").toBe(1);
    expect(fx.timelineCalls()).toBe(1);

    status = null;
    await act(async () => { markSessionAlive(); });
    await settle();

    expect(fx.timelineCalls(), "no second ask after the renewal").toBe(2);
    expect(said(host)).not.toContain(SENTENCE);
    expect(getByText(host, `${N.toLocaleString("en-US")} messages`)).toBeTruthy();
  });

  it("CONTROL — a server fault is the server's answer: said at once, no renewal asked, no re-ask", async () => {
    const probes: number[] = [];
    registerSessionProbe(() => { probes.push(Date.now()); });
    const fx = await storeFixture(storeRows(N), { refuse: () => 503 });
    const host = await mountHistory(fx.engine);
    await settle();

    expect(said(host)).toContain(SENTENCE);
    expect(probes.length).toBe(0);
    await act(async () => { markSessionAlive(); });
    await settle();
    expect(fx.timelineCalls()).toBe(1);
  });

  it("CONTROL — refused again after the renewal, it says so and does not ask for another", async () => {
    const probes: number[] = [];
    registerSessionProbe(() => { probes.push(Date.now()); });
    const fx = await storeFixture(storeRows(N), { refuse: () => 401 });
    const host = await mountHistory(fx.engine);
    await settle();
    await act(async () => { markSessionAlive(); });
    await settle();

    expect(fx.timelineCalls()).toBe(2);
    expect(said(host)).toContain(SENTENCE);
    expect(probes.length, "a server refusing every session drove a refresh loop").toBe(1);
  });

  it("CONTROL — a renewal that never answers ends at the store's own ceiling, with the sentence", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    registerSessionProbe(() => {});
    const fx = await storeFixture(storeRows(N), { refuse: () => 401 });
    const host = await mountHistory(fx.engine);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(said(host)).not.toContain(SENTENCE);

    await act(async () => { await vi.advanceTimersByTimeAsync(STORE_ANSWER_TIMEOUT_MS); });
    expect(said(host)).toContain(SENTENCE);
  });
});
