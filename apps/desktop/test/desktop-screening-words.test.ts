/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import messages from "../../webapp/messages/en.json";
import { DesktopScreeningWords } from "../src/DesktopScreeningWords.js";

/**
 * "WHAT REACHES YOUR OHBOX" — the pane, mounted, on each door and each way the engine can answer.
 *
 * `desktop-shell.test.ts` asserts what this file's SOURCE says: that the control is the shared one
 * and the transport is the bridge. That is a structural claim and it cannot see the two things a
 * person actually experiences — whether the section appears at all, and what it says when it does.
 * Both of those have been wrong here in ways a source assertion was blind to:
 *
 *  · the section was drawn on ONE door and the reason recorded for withholding it on the other was
 *    about a control in a different application, which this window cannot render;
 *  · the sentence under the heading described one of the two places the words go, because the
 *    other was not wired — a narrowing that had to be undone in lockstep with the wiring, and
 *    nothing but a rendering test can hold the two together.
 *
 * So this file drives it: a stand-in shell answers `engine_request` in the shell's own encoding,
 * and every case below asserts what is on screen.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host { __TAURI_INTERNALS__?: { invoke: Invoke } }
const host = globalThis as unknown as Host;

/** Encode an answer exactly as the shell's `engine_request` does — length, metadata, bytes. */
function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

/** What a door that serves the route answers to the read. */
const PREFERENCE = JSON.stringify({
  ohboxPolicy: null,
  ohboxBar: "Only people who write to me by hand.",
  defaultBar: "Keep my Ohbox for real people writing to me.",
});

const OFFLINE_BODY = JSON.stringify({
  error: { code: "offline_read_only", message: "this install is offline", retryable: true },
});

interface Asked { method: string; url: string; body?: string }

/** A shell whose engine answers every request with one status and one body. */
function shellAnswering(status: number, body: string) {
  const asked: Asked[] = [];
  host.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      if (command !== "engine_request") return null;
      const bytes = Uint8Array.from((payload?.body as number[]) ?? []);
      asked.push({
        method: String(payload?.method ?? "GET"),
        url: String(payload?.url ?? ""),
        ...(bytes.byteLength > 0 ? { body: new TextDecoder().decode(bytes) } : {}),
      });
      return encode(status, body);
    },
  };
  return asked;
}

let hostEl: HTMLDivElement;
let root: Root;

async function mount(door: "local" | "cloud" | null): Promise<void> {
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root.render(h(
      NextIntlClientProvider,
      { locale: "en", messages, timeZone: "UTC" },
      h(DesktopScreeningWords, { door }),
    ));
  });
  /* One more turn of the loop: the pane reads its value in an effect, so the first render is
     always the empty one and the assertion belongs after the answer has landed. */
  await act(async () => { await Promise.resolve(); });
}

const text = (): string => hostEl.textContent ?? "";
const textareas = (): HTMLTextAreaElement[] => [...hostEl.querySelectorAll("textarea")];

afterEach(async () => {
  await act(() => root.unmount());
  hostEl.remove();
  delete host.__TAURI_INTERNALS__;
});

describe("the Ohbox-words pane", () => {
  it("draws the editor on the STANDALONE door, with the mailbox's stored words in it", async () => {
    shellAnswering(200, PREFERENCE);
    await mount("local");
    expect(text()).toContain("What reaches your Ohbox");
    expect(textareas()).toHaveLength(1);
    expect(textareas()[0]!.value).toBe("Only people who write to me by hand.");
  });

  /**
   * THE REGRESSION THIS FILE WAS ADDED FOR.
   *
   * A hosted-door install used to get no editor at all. The engine forwards both verbs of this
   * route to the account, so there was never a technical reason for the absence — only a note
   * saying the account "already has this control in the client it signs into", which is true of a
   * browser tab and false of this window: the hosted client's copy of the section reaches for an
   * API client that is not part of this build.
   */
  it("draws the SAME editor on the hosted door, where the engine forwards the route", async () => {
    const asked = shellAnswering(200, PREFERENCE);
    await mount("cloud");
    expect(text()).toContain("What reaches your Ohbox");
    expect(textareas()).toHaveLength(1);
    expect(asked.map((a) => `${a.method} ${a.url}`)).toEqual(["GET /account/screening"]);
  });

  /**
   * THE SENTENCE IS THE CLAIM, so it is asserted rather than described.
   *
   * It names BOTH places the words go. It was deliberately narrowed to the Screener for as long as
   * the filing loop did not hand them over, and this assertion is what stops the narrowing being
   * quietly reinstated — or, worse, the widening being kept after somebody removes the wiring.
   */
  it("says the words are used as mail is filed AND when the Screener is asked", async () => {
    shellAnswering(200, PREFERENCE);
    await mount("local");
    expect(text()).toMatch(/as your mail is filed/);
    expect(text()).toMatch(/senders waiting in your Screener/);
    // The no-model case is still stated, because an install without one is a supported install.
    expect(text()).toMatch(/filed by rules either way/);
    /* And the retired promise is NOT here. The old sentence limited the words to the moment
       somebody presses the suggestion button; a build that reverted the loop and kept this pane
       would be making a claim the code no longer supports. */
    expect(text()).not.toMatch(/Used when you ask the model about the senders/);
  });

  /**
   * OFFLINE IS NAMED. A section that vanishes with the network reads as writing that was lost.
   */
  it("says where the words are, instead of disappearing, while a hosted account is unreachable", async () => {
    shellAnswering(503, OFFLINE_BODY);
    await mount("cloud");
    expect(text()).toContain("What reaches your Ohbox");
    expect(text()).toMatch(/can’t be edited while this install is offline/);
    // …and offers no box, because there is nothing a press could do with it.
    expect(textareas()).toHaveLength(0);
  });

  it("draws nothing on a door whose engine serves no such route", async () => {
    shellAnswering(404, JSON.stringify({ error: { code: "not_found" } }));
    await mount("cloud");
    expect(text()).toBe("");
  });

  /**
   * A hosted door with nobody signed in answers `409 not_signed_in`. There is no account, so there
   * are no words and nothing true to say about them — silence, not an error card.
   */
  it("draws nothing when the hosted door has nobody signed in", async () => {
    shellAnswering(409, JSON.stringify({ error: { code: "not_signed_in", message: "not signed in" } }));
    await mount("cloud");
    expect(text()).toBe("");
  });

  it("asks the engine nothing until the shell has said which door this is", async () => {
    const asked = shellAnswering(200, PREFERENCE);
    await mount(null);
    expect(asked).toEqual([]);
    expect(text()).toBe("");
  });

  /** The write goes back down the same route, names only the bar, and re-seeds from the answer. */
  it("saves the bar through PATCH, naming that axis and no other", async () => {
    const asked = shellAnswering(200, PREFERENCE);
    await mount("local");
    const box = textareas()[0]!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value",
      )!.set!;
      setter.call(box, "Only my sister and my bank.");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...hostEl.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save")!;
    await act(async () => { save.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    const patch = asked.find((a) => a.method.toUpperCase() === "PATCH");
    expect(patch, "the Save button wrote nothing").toBeDefined();
    expect(patch!.url).toBe("/account/screening");
    expect(JSON.parse(patch!.body!)).toEqual({ ohboxBar: "Only my sister and my bank." });
  });
});
