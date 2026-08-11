/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * ═══ SIGNING IN WITHOUT RETYPING ANYTHING ═══════════════════════════════════════════════════
 *
 * The hosted door's browser path used to end with a person reading a short code off a web page and
 * typing it into this window. It now ends with a press in the browser: the page hands the code back
 * over the `ohmail://` scheme and the app comes forward signed in.
 *
 * What makes that safe is a commitment. A URL scheme is claimed by whichever program on the machine
 * registered it and nothing authenticates that, so before the browser is opened the mail engine on
 * this machine invents a PKCE verifier, keeps it in its own memory, and publishes only
 * `sha256(verifier)` — which travels in the page's URL and binds the code the page mints. A program
 * that intercepts the link receives a code it cannot spend.
 *
 * ── WHAT THIS FILE ASSERTS THAT NOTHING ELSE CAN ────────────────────────────────────────────
 *
 * `desktop-doors.test.ts` drives the decisions and `desktop-native.test.ts` drives the two edges.
 * Neither can see the SCREEN, and three of the four things that can go wrong here are visible only
 * from a mounted component:
 *
 *  1. the press actually starts a handoff and the commitment reaches the shell;
 *  2. an activation is answered — the code lands in the field AND is sent — rather than the event
 *     being registered and dropped;
 *  3. the sign-in that follows an activation does NOT reconfigure the engine. This is the sharp
 *     one. `engine_configure` REPLACES the engine, and the verifier the whole handoff rests on
 *     lives in that process's memory; a reconfigure at that moment throws it away and the account
 *     answers a perfectly good code with the same sentence it gives an expired one, because
 *     telling those apart is exactly what it refuses to do. Nothing fails loudly;
 *  4. the retype field is still on screen, because a scheme handler can be missing or claimed by
 *     something that does nothing visible, and a screen whose only way forward is a button in
 *     another application is a dead end.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────
 *
 *  · open the page without the commitment                   → the first case goes red;
 *  · register the listener and never call `onSubmitCode`    → the second goes red;
 *  · route the activation through `enterCloudDoorWithCode`  → the third goes red (a second
 *    `engine_configure` appears in the traffic, which is the verifier being discarded);
 *  · remove the field once the browser has been opened      → the fourth goes red.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/** Challenge-shaped: 43 characters of base64url, which is what a SHA-256 digest encodes to. */
const CHALLENGE = "0123456789abcdefghijklmnopqrstuvwxyzABCDEF_";

interface Asked {
  command: string;
  payload?: Record<string, unknown>;
}

/** Encode an answer exactly as the shell's `engine_request` does. */
function encode(status: number, body = "", statusText = "OK"): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText, h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

let asked: Asked[] = [];
let callbacks: Map<number, (payload: unknown) => void>;
/** What the challenge route answers. Null makes the engine refuse to start a handoff. */
let mintedChallenge: string | null = CHALLENGE;

/** Deliver an event the way the runtime does — the payload inside its envelope. */
function emit(event: string, payload: unknown): void {
  const listen = asked.find(
    (a) => a.command === "plugin:event|listen" && a.payload?.event === event,
  );
  if (!listen) throw new Error(`nothing is listening for ${event}`);
  callbacks.get(listen.payload!.handler as number)!({ event, id: 1, payload });
}

beforeEach(() => {
  asked = [];
  callbacks = new Map();
  mintedChallenge = CHALLENGE;
  let next = 1;
  host.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => {
      const id = next++;
      callbacks.set(id, cb);
      return id;
    },
    invoke: async (command, payload) => {
      asked.push({ command, payload });
      if (command === "engine_configure") return { state: "starting", mode: "cloud" };
      if (command === "engine_status") {
        return { state: "serving", mode: "cloud", mailboxId: "mbx-1", credentialState: "absent" };
      }
      if (command === "engine_request") {
        const url = String(payload?.url ?? "");
        if (url === "/cloud/signin/challenge") {
          return encode(200, JSON.stringify(mintedChallenge === null ? {} : { challenge: mintedChallenge }));
        }
        return encode(200, '{"status":"signed_in"}');
      }
      if (command === "open_link") return null;
      if (command === "plugin:event|listen") return next;
      throw new Error(`unexpected command ${command}`);
    },
  };
});

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

/**
 * Mount the chooser straight on the hosted door.
 *
 * The modules are reloaded per case: `native.ts` keeps ONE shell-side listener for the life of the
 * window and swaps the handler behind it (there is no way to unlisten — that would cost a second
 * core permission this window is deliberately not granted), so a second case sharing the module
 * would find nothing registered against its own fake shell.
 */
async function mount(): Promise<{ el: HTMLElement; entered: unknown[] }> {
  vi.resetModules();
  const { DoorChooser } = await import("../src/DoorChooser.js");
  const entered: unknown[] = [];
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(h(DoorChooser, { start: "cloud", onEntered: (r: unknown) => entered.push(r) }));
  });
  return { el: mountPoint, entered };
}

function buttonSaying(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(label),
  );
  if (!found) {
    throw new Error(
      `no button saying "${label}" — found: ${
        [...el.querySelectorAll("button")].map((b) => b.textContent).join(" | ")
      }`,
    );
  }
  return found;
}

const click = async (button: HTMLButtonElement): Promise<void> => {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

async function type(el: HTMLElement, id: string, value: string): Promise<void> {
  const input = el.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`no field #${id} on screen`);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Every bridge request the window made, as `METHOD /path` with the decoded body. */
function bridged(): { url: string; body: string }[] {
  return asked
    .filter((a) => a.command === "engine_request")
    .map((a) => ({
      url: String(a.payload!.url),
      body: new TextDecoder().decode(Uint8Array.from(a.payload!.body as number[])),
    }));
}

/** Switch to the browser path and fill the address in. */
async function browserPath(el: HTMLElement): Promise<void> {
  await click(buttonSaying(el, "Sign in with browser"));
  await type(el, "cloud-address", "mila@ohmail.app");
}

describe("the hosted door's browser path", () => {
  it("configures the door, mints a commitment, and opens the page with it", async () => {
    const { el } = await mount();
    await browserPath(el);
    await click(buttonSaying(el, "Open ohmail.app"));

    // The engine exists before the commitment does — it is the process the verifier lives in.
    const order = asked.map((a) =>
      a.command === "engine_request" ? String(a.payload!.url) : a.command,
    );
    expect(order.indexOf("engine_configure")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("engine_configure"))
      .toBeLessThan(order.indexOf("/cloud/signin/challenge"));

    /* AND THE PAGE IS NAMED, NEVER ADDRESSED. The window passes the place key and 43 characters;
       the shell owns the scheme, the host, the path and the parameter's spelling. */
    const opened = asked.find((a) => a.command === "open_link")!;
    expect(opened.payload).toEqual({ key: "link-desktop", challenge: CHALLENGE });
  });

  it("keeps the retype field on screen after the browser has been opened", async () => {
    const { el } = await mount();
    await browserPath(el);
    await click(buttonSaying(el, "Open ohmail.app"));

    // A scheme handler can be missing, or claimed by something that does nothing visible. The page
    // shows the code beside its button for exactly this, and so does this screen.
    expect(el.querySelector("#cloud-handoff"), "the retype field is gone").not.toBeNull();
    expect(el.textContent ?? "").toMatch(/type the code/i);
    // …and the words describe the flow that now happens.
    expect(el.textContent ?? "").toMatch(/comes forward signed in/);
  });

  it("says so, and opens nothing, when the engine will not start a handoff", async () => {
    mintedChallenge = null;
    const { el } = await mount();
    await browserPath(el);
    await click(buttonSaying(el, "Open ohmail.app"));

    /* NO BROWSER AT ALL. A page opened without the commitment mints an UNBOUND code — one any
       program that claimed `ohmail://` could spend — while this install goes on waiting for a
       link. Refusing is the only answer that leaves everybody believing the same thing. */
    expect(asked.some((a) => a.command === "open_link")).toBe(false);
    expect(el.textContent ?? "").toMatch(/Type the code in instead/);
  });
});

describe("an ohmail:// activation", () => {
  it("puts the code in the field and signs in with it", async () => {
    const { el, entered } = await mount();
    await browserPath(el);
    await click(buttonSaying(el, "Open ohmail.app"));

    await act(async () => { emit("link:code", "handoff-code-9"); });

    // VISIBLE, not just sent: somebody who pressed a button in another application and came back
    // to this one should be able to see what arrived — and can retry with it if it is refused.
    expect(el.querySelector<HTMLInputElement>("#cloud-handoff")!.value).toBe("handoff-code-9");

    const signin = bridged().find((r) => r.url === "/cloud/signin");
    expect(signin, "the activation was heard and nothing was sent").toBeDefined();
    // ONLY the code. The verifier is the ENGINE's and never travels through this window.
    expect(JSON.parse(signin!.body)).toEqual({ handoffCode: "handoff-code-9" });
    expect(entered).toHaveLength(1);
  });

  /**
   * THE ASSERTION THIS FILE EXISTS FOR.
   *
   * `engine_configure` replaces the engine, and the verifier the code is bound to lives in that
   * process's memory. Exactly ONE configure may happen in the whole flow — the one that made the
   * engine before the commitment was minted. A second one silently unbinds a live code.
   */
  it("never restarts the engine between the commitment and the claim", async () => {
    const { el } = await mount();
    await browserPath(el);
    await click(buttonSaying(el, "Open ohmail.app"));
    const before = asked.filter((a) => a.command === "engine_configure").length;
    expect(before).toBe(1);

    await act(async () => { emit("link:code", "handoff-code-9"); });

    expect(
      asked.filter((a) => a.command === "engine_configure"),
      "the engine was reconfigured after the commitment — the verifier is gone and the code the " +
        "browser is showing can no longer be claimed by anybody",
    ).toHaveLength(before);
  });

  it("does not restart the engine for a code that is RETYPED after a handoff either", async () => {
    const { el } = await mount();
    await browserPath(el);
    await click(buttonSaying(el, "Open ohmail.app"));

    // The page's own fallback: the button did nothing, so the code is typed in by hand. It is
    // still a BOUND code, so this path must not discard the verifier either.
    await type(el, "cloud-handoff", "handoff-code-9");
    await click(buttonSaying(el, "Sign in"));

    expect(asked.filter((a) => a.command === "engine_configure")).toHaveLength(1);
    expect(bridged().filter((r) => r.url === "/cloud/signin")).toHaveLength(1);
  });

  it("is ignored on the password form, which nobody asked to have submitted", async () => {
    const { el } = await mount();
    await browserPath(el);
    await click(buttonSaying(el, "Open ohmail.app"));
    // Back to the password form — a half-typed password is in front of the person now, and an
    // event from another application must not submit a sign-in under them.
    await click(buttonSaying(el, "Use my password instead"));

    const before = bridged().length;
    await act(async () => { emit("link:code", "handoff-code-9"); });
    expect(bridged()).toHaveLength(before);
  });

  it("carries no code and no address into a shell command, ever", async () => {
    const { el } = await mount();
    await browserPath(el);
    await click(buttonSaying(el, "Open ohmail.app"));
    await act(async () => { emit("link:code", "handoff-code-9"); });

    /* The handoff code is worth a session for two minutes, and the shell is the process that
       writes a log file and a settings file. It never sees one: the code goes down the bridge,
       addressed to the engine, exactly as the mailbox password does. Read over the payloads of
       everything that is NOT `engine_request`, because that command's body is a number array and a
       string search over it would find nothing whatever it contained. */
    const commands = asked.filter((a) => a.command !== "engine_request");
    const wire = JSON.stringify(commands);
    expect(wire).not.toContain("handoff-code-9");
    expect(wire).toContain(CHALLENGE); // …the public half does cross, and that is the whole design
  });
});
