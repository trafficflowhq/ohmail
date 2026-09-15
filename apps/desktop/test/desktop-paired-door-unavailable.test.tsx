/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import en from "../../webapp/messages/en.json";
import { DOOR_COPY } from "../src/door-copy.js";
import { PAIRED_DOOR_AVAILABLE, proveHostLink } from "../src/doors.js";
import { parsePairLink } from "@ohmail/client-engine";

/**
 * ═══ "ANOTHER COMPUTER" SAYS IT CANNOT BE WALKED, INSTEAD OF FAILING AT THE THIRD STEP ═════
 *
 * The door was offered and could not be completed from any state a new install is in. Three
 * components each require something one of the others is supposed to supply, and no path
 * supplies all three. The two Rust halves were read on 2026-09-15 against this tip's sources:
 *
 *  1. `plan_with` under the ONLY door shape `config::parse` admits for this flavor — a pinned
 *     link with no mailbox address — answers `Inert(NotConfigured { missing:
 *     ["OHMAIL_MAILBOX_ADDRESS"] })`, because `REQUIRED_CLOUD_VARS` demands the address for
 *     every cloud launch and `config::env_for` composes it only when the door carries one. The
 *     same door WITH an address spawns, so the reading is about the address.
 *  2. `config::parse` refuses a pin-less link as a host door — "a door that opens another
 *     computer needs that computer's identity from the pairing link" — and an ordinary tailnet
 *     link is pin-less, because `originNeedsPin` demands a pin from IP literals and not from
 *     DNS names. The same link WITH a pin is admitted, with `address: None`.
 *  3. is below, in this runner: step one asks the LOCAL engine, and a fresh install has no
 *     configured engine to answer.
 *
 * So the door refuses AT STEP ONE. The tile stays listed and marked — a door removed from the
 * screen is a product that quietly got smaller, and the person arriving with a pairing link in
 * their hand needs to read why it will not work here rather than find nothing. What is not
 * shipped is the third-step dead end: a link pasted, checked, and refused by a shell the window
 * never asked.
 *
 * `PAIRED_DOOR_AVAILABLE` is the deciding line. a later change flips it and this file is what says so.
 */

/* Without this React's `act` does not flush, warns, and every assertion below would be about
   a render that had not settled. Every rendering file in this directory sets it. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = React.createElement;
/* TYPED FOR `createElement`, which picks its last overload for a props object with no
   `children` and reports the provider as unassignable — the shape several files in this
   directory carry as a pinned error. Declared here instead, so this file adds none. */
const Intl = NextIntlClientProvider as unknown as React.FunctionComponent<{
  locale: string;
  messages: unknown;
  timeZone: string;
  children?: React.ReactNode;
}>;
/* The same spelling `desktop-door-chooser.test.tsx` uses: this React's `act` is on the
   namespace rather than a named export the type declarations admit. */
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

interface Invoke { (command: string, payload?: Record<string, unknown>): Promise<unknown> }
interface Host { __TAURI_INTERNALS__?: { invoke: Invoke } }
const host = globalThis as Host;

afterEach(() => {
  delete host.__TAURI_INTERNALS__;
});

describe("reading 3 — the probe asks an engine a fresh install does not have", () => {
  /**
   * WHAT THE SHELL ACTUALLY ANSWERS, not a stand-in that throws its own words: `Engine::request`
   * has a named refusal per state, and on an install that has chosen no door yet the state is
   * `NotConfigured` — the engine was never launched because nothing told it which mailbox to
   * open. Tauri turns that `Err(String)` into a rejected invoke, which is what this is.
   */
  it("proveHostLink on an install with no running engine is refused unreachable", async () => {
    host.__TAURI_INTERNALS__ = {
      invoke: (command) => {
        if (command !== "engine_request") throw new Error(`unexpected ${command}`);
        return Promise.reject(
          new Error(
            "the engine has not been configured: nothing set OHMAIL_IMAP_HOST, OHMAIL_IMAP_USER, "
            + "OHMAIL_KEK",
          ),
        );
      },
    };
    const link = parsePairLink(
      `https://192.168.1.24:8443/pair#k1.${"a".repeat(43)}.tok_xyz`,
    );
    expect(link, "the fixture link does not parse").not.toBeNull();

    const proof = await proveHostLink(link!);
    expect(proof.base).toBeNull();
    expect(proof.refusal?.kind).toBe("unreachable");
    /* THE PROBE NEVER REACHED A SERVER. There is no network answer here to classify — the
       request did not leave this process, because the process it goes to is not running. */
    expect(proof.refusal?.status).toBeNull();
  });
});

describe("the door says so at step one", () => {
  let root: Root | null = null;
  let mount: HTMLElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    mount?.remove();
    root = null;
    mount = null;
  });

  const render = async (): Promise<HTMLElement> => {
    const { DoorChooser } = await import("../src/DoorChooser.js");
    mount = document.createElement("div");
    document.body.append(mount);
    root = createRoot(mount);
    await act(async () => {
      root!.render(
        h(
          Intl,
          { locale: "en", messages: en, timeZone: "Europe/Zurich" },
          h(DoorChooser, { onEntered: () => {} }),
        ),
      );
    });
    return mount;
  };

  const tiles = (el: HTMLElement): HTMLButtonElement[] =>
    [...el.querySelectorAll<HTMLButtonElement>(".door-tile")];

  const hostTile = (el: HTMLElement): HTMLButtonElement => {
    const found = tiles(el).filter(
      (t) => (t.querySelector(".door-name")?.textContent ?? "") === DOOR_COPY.doorHostName,
    );
    if (found.length !== 1) throw new Error(`${found.length} tiles named the paired door`);
    return found[0]!;
  };

  it("the tile is still listed, with the other three", async () => {
    const el = await render();
    expect(tiles(el)).toHaveLength(4);
    expect(tiles(el).map((t) => t.querySelector(".door-name")!.textContent)[1])
      .toBe("Another computer");
  });

  it("the tile carries the sentence and cannot be pressed", async () => {
    const el = await render();
    const tile = hostTile(el);
    expect(tile.textContent).toContain(DOOR_COPY.doorHostUnavailable);
    expect(tile.disabled).toBe(true);
  });

  /**
   * THE SECOND WAY IN, and it is the one somebody actually arrives by: a pairing link pasted
   * into the self-hosted door's address field is routed to this door before any dial. That
   * route must answer the same sentence rather than opening a pane that cannot finish.
   */
  it("a pairing link pasted into the server door is answered with the same sentence", async () => {
    host.__TAURI_INTERNALS__ = {
      invoke: (command) => Promise.reject(new Error(`nothing may be asked here: ${command}`)),
    };
    const el = await render();
    const server = tiles(el).find(
      (t) => (t.querySelector(".door-name")?.textContent ?? "") === DOOR_COPY.doorServerName,
    );
    await act(async () => {
      server!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const field = el.querySelector<HTMLInputElement>("#server-origin");
    expect(field, "the self-hosted door's address field is not on screen").toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(field!, `https://192.168.1.24:8443/pair#k1.${"a".repeat(43)}.tok_xyz`);
      field!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = [...el.querySelectorAll("button")].find((b) => b.type === "submit");
    await act(async () => {
      submit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(el.textContent).toContain(DOOR_COPY.doorHostUnavailable);
    /* AND NOT THE PANE. `#host-link` is the paired door's own field; reaching it is the dead
       end this lane exists to remove. */
    expect(el.querySelector("#host-link")).toBeNull();
  });

  it("the deciding line is one line, and it is what a later change flips", () => {
    expect(PAIRED_DOOR_AVAILABLE).toBe(false);
  });
});
