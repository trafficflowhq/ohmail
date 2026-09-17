/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import en from "../../webapp/messages/en.json";
import { DOOR_COPY } from "../src/door-copy.js";
import {
  PAIRED_DOOR_AVAILABLE,
  enterHostDoor,
  proveHostLink,
  startWalk,
  walkExpired,
} from "../src/doors.js";
import { parsePairLink } from "@ohmail/client-engine";

/**
 * ═══ "ANOTHER COMPUTER" COMPLETES FROM A FRESH INSTALL ══════════════════════════════════════
 *
 * Replaces `desktop-paired-door-unavailable.test.tsx`, whose closing line said the design that
 * makes the door walkable flips `PAIRED_DOOR_AVAILABLE` and that a file would say so. This is it.
 *
 * Held HERE is the WINDOW's half: which engine answers step one — the running one where there is
 * a door, one started for the CANDIDATE where there is none — that the token is never sent to ask
 * a question, and that ONE clock bounds the whole walk.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = React.createElement;
const Intl = NextIntlClientProvider as unknown as React.FunctionComponent<{
  locale: string;
  messages: unknown;
  timeZone: string;
  children?: React.ReactNode;
}>;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/**
 * The frame the SHELL answers `engine_request` with — a 4-byte big-endian meta length, the meta,
 * then the body. Composed here rather than stubbed as a convenience object, so this file's one
 * running-engine case is about the bridge the window actually speaks.
 */
function encode(status: number, body = ""): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

interface Invoke { (command: string, payload?: Record<string, unknown>): Promise<unknown> }
interface Host { __TAURI_INTERNALS__?: { invoke: Invoke } }
const host = globalThis as Host;

/** The fixture link: an IP literal, so `originNeedsPin` wants the pin, and a pin of the right shape. */
const PIN = "a".repeat(43);
const LINK = `https://192.168.1.24:8443/pair#k1.${PIN}.tok_xyz`;
const link = (): ReturnType<typeof parsePairLink> => parsePairLink(LINK);

afterEach(() => {
  delete host.__TAURI_INTERNALS__;
});

describe("which engine answers step one", () => {
  it("an install with NO door starts a candidate, and the base it reports is the engine's", async () => {
    const seen: { command: string; payload?: Record<string, unknown> }[] = [];
    host.__TAURI_INTERNALS__ = {
      invoke: (command, payload) => {
        seen.push({ command, ...(payload ? { payload } : {}) });
        /* `mode: null` is a fresh install, and the field is always present for this reason. */
        if (command === "engine_status") return Promise.resolve({ state: "not_configured", mode: null });
        if (command === "host_candidate_probe") {
          return Promise.resolve({
            status: 200,
            body: { ok: true, flavor: "desktop-host", base: "https://192.168.1.24:8443" },
            leftMs: 42_000,
          });
        }
        return Promise.reject(new Error(`unexpected ${command}`));
      },
    };

    const proof = await proveHostLink(link()!);
    expect(proof.refusal).toBeNull();
    /* THE BASE THE ENGINE MEASURED, not the typed origin — a desktop host serves at the root and
       a self-host stack under `/api`, and which one answered is a fact only that side holds. */
    expect(proof.base).toBe("https://192.168.1.24:8443");

    expect(seen.map((s) => s.command)).toEqual(["engine_status", "host_candidate_probe"]);
    const asked = seen[1]!.payload!;
    expect(asked.origin).toBe("https://192.168.1.24:8443");
    expect(asked.pin).toBe(PIN);
    expect(typeof asked.budgetMs).toBe("number");
    /* THE TOKEN IS NOT SENT TO ASK A QUESTION. It is single-use and is spent at the redeem; a
       probe that carried it would spend it on a step nobody has agreed to yet. Asserted over the
       WHOLE payload rather than by naming a field, so a differently-named one is caught too. */
    expect(JSON.stringify(asked)).not.toContain("tok_xyz");
  });

  it("an install WITH a door asks its running engine, and starts no candidate", async () => {
    // NOT A FALLBACK. Deciding by "try the bridge, then the candidate" would make the ordinary
    // case depend on a failure first and would start a candidate engine on an install that has a
    // mirror to lose. The branch is on whether there is a door.
    const seen: string[] = [];
    host.__TAURI_INTERNALS__ = {
      invoke: (command) => {
        seen.push(command);
        if (command === "engine_status") {
          return Promise.resolve({ state: "serving", mode: "cloud", flavor: "desktop-host" });
        }
        if (command === "engine_request") {
          return Promise.resolve(encode(200, JSON.stringify({ ok: true, base: "https://192.168.1.24:8443" })));
        }
        return Promise.reject(new Error(`unexpected ${command}`));
      },
    };

    const proof = await proveHostLink(link()!);
    expect(proof.base).toBe("https://192.168.1.24:8443");
    expect(seen).toContain("engine_request");
    expect(seen).not.toContain("host_candidate_probe");
  });

  it("a candidate that answers pin_mismatch comes back as that kind, not as a transport failure", async () => {
    // THE REFUSAL VOCABULARY IS THE ROUTE'S OWN in both branches. A second classification on this
    // side would describe something the window did not observe, and the card translates `kind`.
    host.__TAURI_INTERNALS__ = {
      invoke: (command) => {
        if (command === "engine_status") return Promise.resolve({ state: "not_configured", mode: null });
        if (command === "host_candidate_probe") {
          return Promise.resolve({
            status: 502,
            body: {
              error: {
                code: "cloud_probe_failed",
                message: "The computer that answered is not the one this link came from",
                details: { kind: "pin_mismatch" },
              },
            },
          });
        }
        return Promise.reject(new Error(`unexpected ${command}`));
      },
    };

    const proof = await proveHostLink(link()!);
    expect(proof.base).toBeNull();
    expect(proof.refusal?.kind).toBe("pin_mismatch");
    expect(proof.refusal?.status).toBe(502);
    /* The sentence is the engine's, whole — and it names no fingerprint. */
    expect(proof.refusal?.message).not.toContain(PIN);
  });
});

describe("one budget, entered at the top and naming the segment it runs out in", () => {
  it("a walk with nothing left refuses before it starts anything", async () => {
    // A CEILING PER SEGMENT IS NO CEILING: four segments with a clock each left a press pending
    // at two minutes with nothing end-to-end. This is the whole-walk bound, asked at each entry.
    let clock = 1_000;
    const spent = startWalk(0, () => clock);
    host.__TAURI_INTERNALS__ = {
      invoke: (command) => {
        if (command === "engine_status") return Promise.resolve({ state: "not_configured", mode: null });
        throw new Error(`nothing may be started on a spent walk: ${command}`);
      },
    };

    const proof = await proveHostLink(link()!, spent);
    expect(proof.refusal?.kind).toBe("out_of_time");
    expect(proof.refusal?.message).toContain("starting up");

    // …and the REDEEM's segment is named differently, because the two send somebody to look in
    // different places — and the redeem's is the costly one: the token is single-use.
    clock += 1;
    const atRedeem = walkExpired(spent, "finishing the pairing");
    expect(atRedeem?.message).toContain("finishing the pairing");
    expect(atRedeem?.message).not.toContain("starting up");
  });

  it("the door step refuses on a spent walk without writing a configuration", async () => {
    const seen: string[] = [];
    host.__TAURI_INTERNALS__ = {
      invoke: (command) => {
        seen.push(command);
        return Promise.reject(new Error(`nothing may be asked here: ${command}`));
      },
    };
    const out = await enterHostDoor(link()!, "https://192.168.1.24:8443", startWalk(0));
    expect(out.refusal?.kind).toBe("out_of_time");
    /* NOTHING WAS CONFIGURED. `engine_configure` writes the settings file and replaces the engine;
       reaching it with no time left would take the app down to report a clock. */
    expect(seen).not.toContain("engine_configure");
  });

  it("a walk with time left is not refused — the bound is the walk, not the step", async () => {
    // THE POSITIVE CONTROL, so the two arms above are about a spent clock rather than about the
    // budget refusing everything it is asked.
    expect(walkExpired(startWalk(60_000), "starting up")).toBeNull();
  });
});

describe("the door is on the screen and can be pressed", () => {
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

  it("the tile is listed with the other three, and is no longer disabled", async () => {
    const el = await render();
    expect(tiles(el)).toHaveLength(4);
    const tile = hostTile(el);
    expect(tile.disabled).toBe(false);
    /* AND THE SENTENCE IS GONE. It is still in `door-copy.ts` — a door that becomes unwalkable
       again says why — but a walkable door that carries it would be a false state on screen. */
    expect(tile.textContent).not.toContain(DOOR_COPY.doorHostUnavailable);
  });

  it("pressing it opens the pane that takes the link", async () => {
    host.__TAURI_INTERNALS__ = {
      invoke: (command) =>
        command === "engine_status"
          ? Promise.resolve({ state: "not_configured", mode: null })
          : Promise.reject(new Error(`unexpected ${command}`)),
    };
    const el = await render();
    await act(async () => {
      hostTile(el).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    /* `#host-link` is the paired door's own field — reaching it was the dead end, and reaching it
       is now the door. */
    expect(el.querySelector("#host-link")).toBeTruthy();
  });

  it("the deciding line is one line, and this is the file that says it is true", () => {
    expect(PAIRED_DOOR_AVAILABLE).toBe(true);
  });
});
