/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";
import { currentUpdateOffer, resetUpdateStoreForTests } from "@ohmail/app-logic/doors/app-update";
import { DEFAULT_LOCALE, setActiveCatalog } from "../../webapp/app/shell/locale";
import { updateAnswerSentence, updateVerbLabel } from "../../webapp/app/shell/update-answer";
import { UpdateLine } from "../../webapp/app/shell/UpdateLine";
import { bridgeFetch } from "../src/bridge-fetch.js";
import { listenForUpdateAnswers } from "../src/update-answer-door.js";

/**
 * A SERVER THAT SAYS THIS APP IS TOO OLD IS HEARD IN THE WINDOW, and the one line offers the verb that
 * asks the updater now. Driven from the bridge's own door with a stand-in shell: a 426 arms the line,
 * its verb presses the shell's updater (`updatePress`, the check or restart; the window names nothing),
 * and a 503 "being updated" says so with no verb until the next answer lifts it.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

interface Host { __TAURI_INTERNALS__?: { invoke: (c: string, p?: Record<string, unknown>) => Promise<unknown> } }
const host = globalThis as Host;

function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}
const envelope = (code: string): string => JSON.stringify({ error: { code, message: code, retryable: true } });

let el: HTMLDivElement | null = null;
let root: Root | null = null;
let off: (() => void) | null = null;

async function mount(locale: "en" | "de" = "en"): Promise<HTMLDivElement> {
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  const messages = locale === "en" ? en : de;
  await act(async () => { root!.render(h(NextIntlClientProvider, { locale, messages: messages as never, children: h(UpdateLine) })); });
  return el;
}

afterEach(async () => {
  off?.();
  off = null;
  if (root) await act(async () => root!.unmount());
  el?.remove();
  root = null;
  el = null;
  delete host.__TAURI_INTERNALS__;
  resetUpdateStoreForTests();
  setActiveCatalog(DEFAULT_LOCALE, null);
});

const shellSays = (status: number, body: string): void => {
  host.__TAURI_INTERNALS__ = { invoke: async () => encode(status, body) };
};
const verb = (): HTMLButtonElement | null => el?.querySelector<HTMLButtonElement>(".ul-do") ?? null;

describe("the desktop window and a server that says this app is too old", () => {
  it("shows the sentence with Update, and pressing it asks the updater", async () => {
    const press = vi.fn(async () => undefined);
    off = listenForUpdateAnswers(press);
    const line = await mount();
    shellSays(426, envelope("client_too_old"));
    await act(async () => { await bridgeFetch("/mailboxes"); });
    expect(line.textContent).toContain("This ohmail is too old for its server.");
    expect(verb()!.textContent).toBe("Update");
    await act(async () => { verb()!.click(); });
    expect(press).toHaveBeenCalledTimes(1);
  });

  it("says it in German, with Aktualisieren", async () => {
    off = listenForUpdateAnswers(async () => undefined);
    const line = await mount("de");
    shellSays(426, envelope("client_too_old"));
    await act(async () => { await bridgeFetch("/mailboxes"); });
    expect(line.textContent).toContain("Dieses ohmail ist zu alt für seinen Server.");
    expect(verb()!.textContent).toBe("Aktualisieren");
  });

  it("BEING UPDATED: the sentence with no verb, lifted by the next ordinary answer", async () => {
    off = listenForUpdateAnswers(async () => undefined);
    const line = await mount();
    shellSays(503, envelope("server_updating"));
    await act(async () => { await bridgeFetch("/mailboxes"); });
    expect(line.textContent).toContain("ohmail is being updated and will be back shortly.");
    expect(verb()).toBeNull();
    shellSays(200, "{}");
    await act(async () => { await bridgeFetch("/mailboxes"); });
    expect(currentUpdateOffer()).toBeNull();
  });

  it("a press the shell refuses is swallowed: a mail client never goes down over its update button", async () => {
    off = listenForUpdateAnswers(async () => { throw new Error("the shell said no"); });
    await mount();
    shellSays(426, envelope("client_too_old"));
    await act(async () => { await bridgeFetch("/mailboxes"); });
    await act(async () => { verb()!.click(); });
    expect(currentUpdateOffer()?.kind).toBe("tooOld");
  });
});

/**
 * A SURFACE THAT IS NOT THE LINE (a sign-in form's refusal, an error's message) says the line's own
 * words: the sentence and the verb are read from the line's keys, in the window's language.
 */
describe("the line's words, for a surface that is not the line", () => {
  it("are the catalogue's in both languages, and English where no catalogue is active", () => {
    const english = [updateAnswerSentence("tooOld"), updateAnswerSentence("serverUpdating"), updateVerbLabel("update"), updateVerbLabel("reload")];
    expect(english).toEqual([en.update.lineTooOld, en.update.lineServerUpdating, en.update.lineUpdateAction, en.update.lineReloadAction]);
    setActiveCatalog("de", de as never);
    expect([updateAnswerSentence("tooOld"), updateAnswerSentence("serverUpdating"), updateVerbLabel("update"), updateVerbLabel("reload")])
      .toEqual([de.update.lineTooOld, de.update.lineServerUpdating, de.update.lineUpdateAction, de.update.lineReloadAction]);
    expect(updateVerbLabel("update")).toBe("Aktualisieren");
  });
});
