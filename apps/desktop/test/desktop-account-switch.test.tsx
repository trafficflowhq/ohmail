/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * ═══ SIGNING IN AS SOMEBODY ELSE ON AN INSTALL THAT ALREADY MIRRORS AN ACCOUNT ══════════════
 *
 * The engine refuses to put a session for one account over another account's mirror: the local
 * database, the world and the cursor all still belong to whoever was signed in last, and every read
 * dispatches through that local account id — so activating a different session over them would show
 * one person another person's mail. The engine's own tests are where that refusal is proven, and
 * they prove it by READING — signing in as the second account and asking for the first account's
 * message by id — rather than by inspecting a flag.
 *
 * This file is the other half of it: what the WINDOW does with the refusal. Being refused is
 * correct and being stuck is not — switching accounts on your own computer is an ordinary thing to
 * want — and the way through is not another try at the same request.
 *
 * ── WHY THE SECOND ATTEMPT HAS TO BE A DIFFERENT REQUEST ────────────────────────────────────
 *
 * A door that is already chosen signs in with ONE bridge request and deliberately never touches the
 * engine's lifetime; that is what keeps "sign in again" from taking somebody's mail off the screen
 * for the length of a restart. But it is also why that request can never be the one that switches
 * accounts: the engine cannot discard a database it already has open. Only the door CONFIGURE can —
 * it replaces the engine, and the replacement throws a foreign mirror away *before* opening
 * anything. So the chooser remembers the refusal and sends the next submit down that path.
 *
 * It is the same mechanism the browser handoff already uses to remember that a commitment is
 * outstanding, and it has to compose with it — hence the last two cases.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────
 *
 *  · drop `switchAccount` from the refusal in `doors.ts`        → "offers a way through" goes red
 *    (the second attempt is another bare `/cloud/signin`, and the person is stuck on a loop);
 *  · ignore `mustSwitch` in the password branch                 → same case, same reason;
 *  · pass `configured` unconditionally in `startHandoff`        → "a handoff started after a
 *    refusal" goes red: no `engine_configure` precedes the commitment, so the code would be
 *    claimed into the very engine that just refused it;
 *  · let `mustSwitch` outrank `handedOff` in `onSubmitCode`     → "does not restart the engine
 *    underneath an outstanding handoff" goes red with a second `engine_configure`, which is the
 *    verifier being discarded.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const CHALLENGE = "0123456789abcdefghijklmnopqrstuvwxyzABCDEF_";

/** The engine's answer when the account signing in is not the one this mirror holds. */
const MISMATCH = JSON.stringify({
  error: {
    code: "mirror_owner_mismatch",
    message:
      "this install is set up for a different ohmail account, so signing in here has to start " +
      "that account's mail over from scratch",
  },
});

interface Asked {
  command: string;
  payload?: Record<string, unknown>;
}

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
/**
 * How many sign-ins the engine refuses as a foreign account before accepting one.
 *
 * A COUNT rather than a flag, because the sequence is the assertion: the first attempt is refused,
 * and the second — which the window is supposed to send down a different path — succeeds. A fake
 * that refused forever could not tell "took the switch path" apart from "gave up".
 */
let refusalsLeft = 0;

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
  refusalsLeft = 0;
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
        if (url === "/cloud/signin/challenge") return encode(200, JSON.stringify({ challenge: CHALLENGE }));
        if (url === "/cloud/signin" && refusalsLeft > 0) {
          refusalsLeft -= 1;
          return encode(409, MISMATCH, "Conflict");
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
 * Mount the chooser on the hosted door as the SETTINGS pane opens it — the door is already chosen,
 * so `cloudAction` is `signIn` and the form is the one-request path. This is the surface the whole
 * hazard lives on: the engine is serving, the mirror is somebody's, and the address field is
 * editable.
 */
async function mount(): Promise<{ el: HTMLElement; entered: unknown[] }> {
  vi.resetModules();
  const { DoorChooser } = await import("../src/DoorChooser.js");
  const entered: unknown[] = [];
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(h(DoorChooser, {
      start: "cloud",
      cloudAction: "signIn",
      onEntered: (r: unknown) => entered.push(r),
    }));
  });
  return { el: mountPoint, entered };
}

function buttonSaying(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label));
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
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Fill the password form for `address` and press Sign in. */
async function signIn(el: HTMLElement, address: string): Promise<void> {
  await type(el, "cloud-address", address);
  await type(el, "cloud-password", "hunter2-and-then-some");
  await type(el, "cloud-totp", "123456");
  await click(buttonSaying(el, "Sign in"));
}

const commands = (): string[] =>
  asked.map((a) => (a.command === "engine_request" ? String(a.payload!.url) : a.command));

describe("a hosted sign-in refused because this install mirrors another account", () => {
  it("is reported, and does NOT restart the engine on its own", async () => {
    refusalsLeft = 1;
    const { el, entered } = await mount();
    await signIn(el, "second@ohmail.app");

    // The refusal is the engine's own sentence, in front of the person who typed the password.
    expect(el.textContent ?? "").toMatch(/different ohmail account/);
    // Nobody is let in on a refusal.
    expect(entered, "a refused sign-in was reported as entering the door").toHaveLength(0);
    // And the window did not take it upon itself to replace the engine behind somebody's back:
    // the discard is destructive, so it happens on the next deliberate press, not on this one.
    expect(commands().filter((c) => c === "engine_configure")).toHaveLength(0);
  });

  it("OFFERS A WAY THROUGH: the next attempt reconfigures the door, then signs in", async () => {
    refusalsLeft = 1;
    const { el, entered } = await mount();
    await signIn(el, "second@ohmail.app");
    expect(entered).toHaveLength(0);

    // The same form, pressed again — this is all somebody has to do.
    await click(buttonSaying(el, "Sign in"));

    // THE SWITCH. A configure appears where the first attempt had none, and it names the address in
    // the field rather than the one the install was mirroring — that configure is what makes the
    // replacement engine discard the foreign mirror before it opens the database.
    const order = commands();
    const configure = asked.find((a) => a.command === "engine_configure")!;
    expect(configure.payload!.config).toMatchObject({ mode: "cloud", address: "second@ohmail.app" });
    // …and the sign-in follows it rather than preceding it.
    expect(order.lastIndexOf("engine_configure")).toBeLessThan(order.lastIndexOf("/cloud/signin"));
    expect(entered, "the second attempt did not get in").toHaveLength(1);

    // THE SECRETS STILL NEVER TOUCH THE SHELL, on the path a person only reaches while being
    // refused — which is exactly the path least likely to be looked at again.
    expect(JSON.stringify(configure.payload)).not.toContain("hunter2");
    expect(JSON.stringify(configure.payload)).not.toContain("123456");
  });

  it("does not reconfigure on an ordinary refusal that is not about the mirror's owner", async () => {
    // A wrong password must not cost a restart. Only a mirror-owner mismatch changes the path.
    const { el } = await mount();
    host.__TAURI_INTERNALS__!.invoke = async (command, payload) => {
      asked.push({ command, payload });
      if (command === "engine_status") {
        return { state: "serving", mode: "cloud", mailboxId: "mbx-1", credentialState: "absent" };
      }
      if (command === "engine_configure") return { state: "starting", mode: "cloud" };
      if (command === "engine_request") {
        return encode(401, JSON.stringify({
          error: { code: "invalid_credentials", message: "that address and password were not accepted" },
        }), "Unauthorized");
      }
      if (command === "plugin:event|listen") return 99;
      throw new Error(`unexpected command ${command}`);
    };
    await signIn(el, "mila@ohmail.app");
    await click(buttonSaying(el, "Sign in"));

    expect(el.textContent ?? "").toMatch(/were not accepted/);
    expect(commands().filter((c) => c === "engine_configure"), "a wrong password restarted the engine")
      .toHaveLength(0);
  });
});

describe("the browser handoff, across the same refusal", () => {
  it("a handoff started AFTER a refusal configures the door before minting the commitment", async () => {
    refusalsLeft = 1;
    const { el } = await mount();
    await signIn(el, "second@ohmail.app");

    await click(buttonSaying(el, "Sign in with browser"));
    await type(el, "cloud-address", "second@ohmail.app");
    await click(buttonSaying(el, "Open ohmail.app"));

    /* Without this, the commitment would be minted inside the engine that just refused the
       account — and the code claimed against it would be refused for the same reason, forever. The
       configure re-points the door first, so the verifier is held by an engine already mirroring
       the account the code belongs to. */
    const order = commands();
    expect(order.indexOf("engine_configure"), "the handoff did not re-point the door").toBeGreaterThanOrEqual(0);
    expect(order.indexOf("engine_configure")).toBeLessThan(order.indexOf("/cloud/signin/challenge"));
  });

  it("does NOT restart the engine underneath an outstanding handoff", async () => {
    // The regression this could easily have caused. Once a commitment exists, the verifier lives in
    // that engine's memory and a second configure throws it away — and the account then answers a
    // perfectly good code with the sentence it gives an expired one.
    refusalsLeft = 1;
    const { el } = await mount();
    await signIn(el, "second@ohmail.app");

    await click(buttonSaying(el, "Sign in with browser"));
    await type(el, "cloud-address", "second@ohmail.app");
    await click(buttonSaying(el, "Open ohmail.app"));
    const configuresBeforeCode = commands().filter((c) => c === "engine_configure").length;

    await act(async () => { emit("link:code", "handoff-code-9"); });

    expect(
      commands().filter((c) => c === "engine_configure").length,
      "the engine was replaced after the commitment was published",
    ).toBe(configuresBeforeCode);
    const signin = asked
      .filter((a) => a.command === "engine_request" && String(a.payload!.url) === "/cloud/signin")
      .pop()!;
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(signin.payload!.body as number[]))))
      .toEqual({ handoffCode: "handoff-code-9" });
  });
});
