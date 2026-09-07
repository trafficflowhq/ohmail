/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import en from "../../webapp/messages/en.json";

/**
 * ═══ A PAIRING LINK PASTED INTO THE SELF-HOSTED DOOR'S ADDRESS FIELD ═══════════════════════
 *
 * Both doors ask for "an address", and the link somebody is holding came from the other
 * computer's Settings → Devices — so pasting it into the wrong field is the ordinary mistake, not
 * an exotic one.
 *
 * Left alone it is answered by the SELF-HOSTED door's refusals, which are about self-hosting. The
 * worst of them tells a person to put a root certificate in a folder: advice that cannot help with
 * a pairing link, and which reads as a configuration problem with a server they may not have.
 *
 * ── WHY THIS IS A RENDER TEST AND NOT A SOURCE READ ────────────────────────────────────────
 *
 * It was written first as a source read — assert the routing appears before the dial, assert the
 * strings are there — and that guard COULD NOT FIRE. Disabling the branch with `false &&` left
 * every asserted string in place and the test stayed green, which is a guard measuring text while
 * claiming to measure behaviour. So it drives the real component: paste the link, press the
 * button, and look at what is on screen and at what left the window.
 *
 * ── ZERO FETCHES IS HALF THE CLAIM ─────────────────────────────────────────────────────────
 *
 * `hostLinkProblem` parses and opens nothing, so a link recognised here costs no connection at
 * all — nothing is configured and the previous door's mirror is untouched. Letting the self-host
 * path take it would have replaced the engine to prove an address that was never a server, and
 * `enforceMirrorOwner` discards a mirror on exactly that. The shell here therefore THROWS on any
 * invocation: the test cannot pass if the window dialled.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host { __TAURI_INTERNALS__?: { invoke: Invoke } }
const host = globalThis as Host;

let root: Root | null = null;
let mount: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  mount?.remove();
  mount = null;
  delete host.__TAURI_INTERNALS__;
});

/** Every invocation is a failure here — see the header. */
function refusingShell(): { calls: string[] } {
  const calls: string[] = [];
  host.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      calls.push(`${command} ${(payload as { url?: string } | undefined)?.url ?? ""}`.trim());
      throw new Error(`the window dialled: ${command}`);
    },
  };
  return { calls };
}

async function openServerDoor(): Promise<HTMLElement> {
  const { DoorChooser } = await import("../src/DoorChooser.js");
  mount = document.createElement("div");
  document.body.append(mount);
  root = createRoot(mount);
  await act(async () => {
    root!.render(
      h(
        NextIntlClientProvider,
        { locale: "en", messages: en as never, timeZone: "Europe/Zurich" },
        h(DoorChooser, { start: "server", onEntered: () => {} }),
      ),
    );
  });
  return mount;
}

const type = async (el: HTMLElement, id: string, value: string): Promise<void> => {
  const field = el.querySelector<HTMLInputElement>(`#${id}`);
  if (!field) throw new Error(`no #${id} — found: ${[...el.querySelectorAll("input")].map((i) => i.id).join(", ")}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const submit = async (el: HTMLElement): Promise<void> => {
  const form = el.querySelector("form");
  if (!form) throw new Error("no form on the server door");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
};

const PIN = "D".repeat(43);
const LINK = `https://192.168.1.24:8443/pair#k1.${PIN}.tok_pasted`;

describe("a pinned pairing link in the self-hosted address field", () => {
  it("opens the paired door instead, and dials nothing", async () => {
    const shell = refusingShell();
    const el = await openServerDoor();
    /* The premise: we really are on the self-hosted door. */
    expect(el.textContent, "not on the self-hosted door").toContain("Your own server");

    await type(el, "server-origin", LINK);
    await type(el, "server-address", "mila@example.com");
    await submit(el);

    /* THE PAIRED DOOR IS NOW ON SCREEN. Its own lead names where the link comes from. */
    expect(el.textContent, "the window stayed on the self-hosted door").toContain("Another computer");
    expect(el.textContent).toContain("Paste the pairing link from ohmail on that computer");
    /* AND THE OPERATOR-CA SENTENCE — the advice this routing exists to prevent — is gone. */
    expect(el.textContent, "the certificate advice was shown for a pairing link")
      .not.toMatch(/root certificate/i);
    /* ZERO FETCHES. Nothing was configured, so the previous door's mirror is untouched. */
    expect(shell.calls, "the window dialled before recognising the link").toEqual([]);
  });

  /**
   * AN UNPINNED LINK IS LEFT ALONE, and that is the rule rather than a gap.
   *
   * `https://host/pair#<token>` on a real hostname is genuinely ambiguous — that is also what a
   * self-hosted origin looks like with a fragment — so capturing it would be a guess, and a guess
   * that takes somebody off the door they chose. `k1.` is unambiguous; nothing else is taken.
   */
  it("an UNPINNED link is left to the self-hosted door", async () => {
    refusingShell();
    const el = await openServerDoor();
    await type(el, "server-origin", "https://ohmail.example.com/pair#tok_plain");
    await type(el, "server-address", "mila@example.com");
    await submit(el);
    /* Still the self-hosted door — it may refuse the address, but it does not hand it away. */
    expect(el.textContent).toContain("Your own server");
    expect(el.textContent).not.toContain("Paste the pairing link from ohmail on that computer");
  });

  /* AND AN ORDINARY ADDRESS still reaches the self-hosted path — without this, the case above
     would pass just as well for a routing that captured everything. */
  it("an ordinary server address still goes to the self-hosted door", async () => {
    const shell = refusingShell();
    const el = await openServerDoor();
    await type(el, "server-origin", "https://ohmail.example.com");
    await type(el, "server-address", "mila@example.com");
    await submit(el);
    expect(el.textContent).toContain("Your own server");
    /* It DID try to dial — which is the self-hosted door doing its job. */
    expect(shell.calls.length, "an ordinary address was captured by the pairing route")
      .toBeGreaterThan(0);
  });
});
