/** @vitest-environment jsdom */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it } from "vitest";

import en from "../../webapp/messages/en.json";
import { configureSelfHostDoor } from "../src/self-host.js";

/**
 * THE MIDDLE DOOR ON A GENUINELY FRESH INSTALL — the one condition a test fixture supplies by
 * accident, and the reason this file has its own shell rather than reusing the chooser suite's.
 *
 * ── WHAT WAS MEASURED, AND WHERE ──────────────────────────────────────────────────────────────
 *
 * On a fresh HOME on the Omarchy guest, with the SHIPPED 0.15.0 build (which carries this door —
 * `Checking your server` and `/cloud/probe` are both in its binary), the app's own log says:
 *
 *     ohmail engine: not started — nothing set OHMAIL_IMAP_HOST, OHMAIL_IMAP_USER
 *
 * and no engine process exists at all. The shell is therefore `NotConfigured`, and `Engine::request`
 * answers every bridge request from that state with
 *
 *     the engine has not been configured: nothing set OHMAIL_IMAP_HOST, OHMAIL_IMAP_USER
 *
 * So the door's first act — asking the engine about a candidate server — cannot be answered by any
 * transport, because there is no process to answer it. The person is shown a sentence about the
 * engine not being configured, on the screen whose whole job is to configure it, and nothing is
 * ever configured.
 *
 * ── WHY THE SHELL HERE REFUSES RATHER THAN ANSWERS ────────────────────────────────────────────
 *
 * The chooser suite's shell answers `engine_request` whatever the state, which is what made this
 * defect invisible to it: with a shell that always answers, probe-first works on a fresh install.
 * This fixture fails the way the shipped shell fails — the refusal is that shell's own sentence,
 * verbatim — and it starts answering only once something has been configured.
 */

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;

interface Host {
  __TAURI_INTERNALS__?: { invoke: Invoke; transformCallback?: unknown };
}
const host = globalThis as unknown as Host;

/** The shell's own words for a bridge request made with nothing configured (`engine.rs:2337`). */
const NOT_CONFIGURED =
  "the engine has not been configured: nothing set OHMAIL_IMAP_HOST, OHMAIL_IMAP_USER";

const OPERATOR_ORIGIN = "https://ohmail.example.com";
const OPERATOR_BASE = `${OPERATOR_ORIGIN}/api`;
const ADDRESS = "mila@example.com";

function encode(status: number, body = "", statusText = "OK"): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText, h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

interface Fresh {
  asked: Array<{ command: string; payload?: Record<string, unknown> }>;
  /** The base the shell has been configured with, or "" while nothing has been. */
  base: string;
  /** What `POST /cloud/probe` answers once there IS an engine to ask. */
  probe: { status: number; body: string };
  /** Make the shell refuse the undo, which is the one state the person has to be told about. */
  logoutFails: boolean;
}

/**
 * A FRESH INSTALL: nothing configured, no engine, and a bridge that refuses accordingly.
 *
 * `engine_status` answers `not_configured` — the state the shell reports on a fresh HOME, with
 * `mode: null` — until a configure lands, and `engine_request` REJECTS with the shell's own
 * sentence for as long as that is true.
 */
function fresh(probe?: { status: number; body: string }): Fresh {
  const it: Fresh = {
    asked: [],
    base: "",
    logoutFails: false,
    probe: probe ?? {
      status: 200,
      body: JSON.stringify({ ok: true, base: OPERATOR_BASE, target: `${OPERATOR_BASE}/hello`, flavor: "selfhost" }),
    },
  };
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      it.asked.push({ command, payload });
      if (command === "engine_status") {
        return it.base === ""
          ? { state: "not_configured", mode: null, missing: ["OHMAIL_IMAP_HOST", "OHMAIL_IMAP_USER"] }
          : { state: "serving", mode: "cloud", flavor: "selfhost", address: ADDRESS, mailboxId: "mbx-1", credentialState: "absent" };
      }
      if (command === "engine_configure") {
        const config = payload!.config as { mode?: string; cloudUrl?: string };
        it.base = config.cloudUrl ?? "";
        return { state: "starting", mode: config.mode ?? "cloud" };
      }
      if (command === "engine_logout") {
        /* THE SHELL'S OWN UNDO: `config.json` is removed and the state goes back to
           `not_configured` (`engine.rs`, the sign-out). Modelled here because the fresh arm
           depends on it — an install left configured for an address that did not answer comes
           back as a chosen door with no chooser. */
        if (it.logoutFails) throw new Error("the settings file could not be removed");
        it.base = "";
        return { state: "not_configured", mode: null, missing: ["config.json"] };
      }
      if (command === "engine_request") {
        /* THE SHELL'S REFUSAL, and it is a rejected promise rather than a status: `Engine::request`
           returns `Err(String)`, which Tauri surfaces to the window as a rejection. */
        if (it.base === "") throw new Error(NOT_CONFIGURED);
        const url = String(payload!.url ?? "");
        if (url === "/cloud/probe") return encode(it.probe.status, it.probe.body);
        return encode(404, '{"error":{"code":"not_found","message":"no such route"}}', "Not Found");
      }
      throw new Error(`unexpected command ${command}`);
    },
  };
  return it;
}

afterEach(() => {
  delete host.__TAURI_INTERNALS__;
});

describe("the middle door on a fresh install", () => {
  it("completes: the address step proves the server and configures for it", async () => {
    const it = fresh();

    const step = await configureSelfHostDoor(OPERATOR_ORIGIN, ADDRESS);

    /* THE WHOLE ROW. Before the fix this was the shell's "the engine has not been configured"
       sentence, on the screen whose job is to configure it. */
    expect(step.problem).toBeNull();
    expect(step.status?.state).toBe("serving");
    // …and the install is pointed at the operator's API base, never the bare origin.
    expect(
      it.asked
        .filter((a) => a.command === "engine_configure")
        .map((a) => String((a.payload!.config as { cloudUrl?: string }).cloudUrl ?? "")),
    ).toEqual([OPERATOR_BASE]);
  });

  /**
   * AND IT STILL REFUSES A SERVER THAT IS NOT THERE. The fresh arm configures before it can ask —
   * there is no engine to ask — so the refusal has to come from the engine that results, in the
   * engine's own words, or the fresh install would walk past a typo into a password form.
   */
  it("refuses a candidate that does not answer, in the server's own words", async () => {
    const it = fresh({
      status: 502,
      body: JSON.stringify({
        error: {
          code: "cloud_probe_failed",
          message: `Nothing is answering at ${OPERATOR_BASE}/hello. Check the address and the port.`,
          details: { kind: "refused", target: `${OPERATOR_BASE}/hello` },
        },
      }),
    });

    const step = await configureSelfHostDoor(OPERATOR_ORIGIN, ADDRESS);

    expect(step.problem).toContain(`Nothing is answering at ${OPERATOR_BASE}/hello`);
    // The engine WAS asked — a fresh install's refusal is the server's, not the shell's.
    expect(
      it.asked.filter((a) => a.command === "engine_request").map((a) => String(a.payload!.url ?? "")),
    ).toContain("/cloud/probe");
    // And the sentence is not about this app's own configuration.
    expect(step.problem).not.toContain("has not been configured");

    /* AND THE INSTALL IS PUT BACK. `gateFor` routes on the settings, so an install left pointed
       at an address that did not answer comes back after a quit as a chosen door with no session
       — the mail client and a sign-in surface, and no chooser to correct the typo in. */
    expect(it.asked.map((a) => a.command)).toContain("engine_logout");
    expect(it.base).toBe("");
  });

  /**
   * AND WHEN THE UNDO ITSELF FAILS, the person is told — because then the server's sentence alone
   * is incomplete: this install IS configured for that address.
   */
  it("says so when it cannot put the install back", async () => {
    const it = fresh({
      status: 502,
      body: JSON.stringify({
        error: {
          code: "cloud_probe_failed",
          message: `Nothing is answering at ${OPERATOR_BASE}/hello.`,
          details: { kind: "refused", target: `${OPERATOR_BASE}/hello` },
        },
      }),
    });
    it.logoutFails = true;

    const step = await configureSelfHostDoor(OPERATOR_ORIGIN, ADDRESS);

    expect(step.problem).toContain("Nothing is answering at");
    expect(step.problem).toContain("This computer is now set up for that address");
    expect(step.problem).toContain("Open this door again");
    // The claim is true: the settings still name that base.
    expect(it.base).toBe(OPERATOR_BASE);
  });

  /** A malformed address is still refused with no engine touched at all. */
  it("refuses an address that is not a server address before it configures anything", async () => {
    const it = fresh();
    const step = await configureSelfHostDoor("ohmail.example.com/mail", ADDRESS);
    expect(step.problem).toContain("does not look like a server address");
    expect(it.asked).toHaveLength(0);
  });
});

/**
 * THE SAME DOOR, DRIVEN THROUGH THE CHOOSER — the rig cell's shape as a test: type the address,
 * press Continue, and the password step has to appear.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

describe("the middle door on a fresh install, through the chooser", () => {
  let root: Root | null = null;
  let mount: HTMLElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    mount?.remove();
    root = null;
    mount = null;
  });

  it("reaches the password step", async () => {
    fresh();
    const { DoorChooser } = await import("../src/DoorChooser.js");
    mount = document.createElement("div");
    document.body.append(mount);
    root = createRoot(mount);
    await act(async () => {
      root!.render(
        h(NextIntlClientProvider, {
          locale: "en",
          messages: en as never,
          timeZone: "Europe/Zurich",
          children: h(DoorChooser, { start: "server", onEntered: () => {} }),
        }),
      );
    });

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    for (const [id, value] of [["server-origin", OPERATOR_ORIGIN], ["server-address", ADDRESS]] as const) {
      const input = mount.querySelector<HTMLInputElement>(`#${id}`)!;
      await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    const button = [...mount.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Continue"))!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // The password step is the proof the address step passed. Before the fix the card stayed on
    // the address, with a sentence about the engine not being configured.
    expect(mount.querySelector("#server-password")).not.toBeNull();
    expect(mount.querySelector(".join-error")?.textContent ?? "").toBe("");
  });
});
