/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import en from "../../webapp/messages/en.json";
import { providerById } from "../../webapp/app/shell/providers.js";
import {
  EMPTY_LOCAL,
  enterLocalDoor,
  reconfiguresLocalDoor,
  standingEngine,
  type LocalDoorFields,
} from "../src/doors.js";
import type { EngineStatus } from "../src/bridge-fetch.js";

/**
 * ═══ CHANGING THE SERVER OF A MAILBOX THAT IS ALREADY CONNECTED ════════════════════════════════
 *
 * Two defects, one order, and both were named in a published release note before they were fixed —
 * so this file is what makes that note true rather than merely honest.
 *
 * The local door does two things that cannot be done at once: it asks the SHELL to write the
 * settings and restart the engine behind them (`engine_configure`), and it asks the ENGINE to
 * prove and seal the mailbox password (`PATCH /mailboxes/:id`). Configure-first is correct on a
 * FIRST connect — there is no mailbox row to address a password to and no stored secret to leak.
 * On a RE-configure it is wrong on both arms of the same step:
 *
 *  · THE SUCCESS ARM. The replacement engine boots with the NEW host and the password sealed for
 *    the OLD one. `resolveLogin()` has no opinion about which host a secret was sealed for, so the
 *    adapter authenticates to the new server with the previous server's password before the door
 *    has even asked for the new one.
 *  · THE FAILURE ARM. The password is refused; the settings file already names the new host and
 *    the credential correctly still names the old one. Nothing rolls back, so the next launch
 *    configures the new host with the old password and a mailbox that worked this morning is
 *    offline.
 *
 * ── WHAT THIS FILE MODELS, AND WHY IT MODELS RATHER THAN STUBS ──────────────────────────────
 *
 * A stub that recorded commands could show the ORDER changed. It could not show that the order is
 * what stops a secret reaching a server, because the leak does not happen in this process — it
 * happens inside an engine that boots later, out of a credential row and a settings file. So the
 * fake shell here is a small model of the install rather than a recorder, and every rule in it is
 * read out of the real code:
 *
 *  · `engine_configure` REPLACES the engine, so each one is a BOOT. What that boot would dial with
 *    is recorded — the configured host, and whatever password is sealed at that moment
 *    (`apps/sidecar/src/engine.ts`'s `resolveLogin()`, which reads the store and hands the result
 *    to the adapter built once at boot).
 *  · A boot whose ADDRESS changed mints a FRESH mailbox row with no credential
 *    (`ensureLocalWorld`, `apps/sidecar/src/identity.ts` — the lookup is by `lower(address)` and it
 *    INSERTS when it finds none), so the model empties the sealed credential there. That is what
 *    makes an address change safe on the first-connect order, and it is the case the design brief
 *    left open.
 *  · `PATCH /mailboxes/:id` seals the pair it DIALLED, and it dials what the BODY says rather than
 *    what the running engine is configured for (the mailbox service's `probedImapMeta`, over its
 *    `mergedTransportMeta`). That is the whole reason sealing can come first, and the service holds
 *    the stored-meta-pairs-with-the-dialled-host invariant on its own account: it rebuilds the same
 *    merge under the mailbox row's lock and refuses with a 409 rather than store a combination no
 *    probe ever tried.
 *
 * With that model, "the old password is never dialled against the new host" is an assertion about
 * recorded boots — {@link leaks} — instead of an assertion about call order that a reader has to
 * trust means something.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────
 *
 * Run 2026-09-01, each mutation applied alone and the tree restored after it. What is written here
 * is what the run PRINTED, not what it was expected to print — one prediction in an earlier draft
 * of this list was wrong (see the second entry) and the list was corrected to the measurement.
 *
 *  · `reconfiguresLocalDoor` forced to `false` — which is exactly the unconditional configure-first
 *    order this replaces → SIX of the seven cases red, and the two that name the defects say what
 *    it is: the success arm fails with `[{ host: "imap.new-server.example", sealedFor:
 *    "imap.old-server.example" }]` where it expects `[]` — a boot authenticating to the new server
 *    with the previous server's secret — and the failure arm fails with `expected
 *    [ 'engine_configure' ] to have a length of +0 but got 1`, the shell committing the new
 *    settings over a credential that was refused. `desktop-doors.test.ts` stays fully green, which
 *    is the other half of the claim: the first connect is untouched.
 *  · drop `credentialState === "ready"` → only "is a reconfigure only when there is a sealed
 *    credential" goes red. It does NOT redden `desktop-doors.test.ts`, and the reason is worth
 *    knowing: those cases call `enterLocalDoor` with two arguments, so `standing` defaults to null
 *    and no branch condition can fire for them at all. The clause is guarded by the unit case and
 *    by nothing else.
 *  · drop the address clause → "an address change is a different mailbox" goes red (the door seals
 *    onto a mailbox id the replacement engine never serves), and the unit case with it.
 *  · drop `mode === "local"` → "is a reconfigure only when there is a sealed credential" goes red
 *    on its hosted-install assertion.
 *  · stop passing `standingEngine()` in `DoorChooser` → the wiring case goes red, because the door
 *    takes the first-connect order over a running install.
 *  · report the interrupted handoff with the bare shell error (`sentence(err)`) instead of
 *    `handoffInterrupted(err)` → "says the password was stored when the settings write fails" goes
 *    red. Added in the second round, after review of the first raised the window it covers.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const ADDRESS = "mila@example.com";
const OTHER_ADDRESS = "mila@somewhere-else.example";
const OLD_HOST = "imap.old-server.example";
const NEW_HOST = "imap.new-server.example";
const OLD_PASS = "the-secret-for-the-old-server";
const NEW_PASS = "the-secret-for-the-new-server";

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

/** One engine BOOT: the host it was configured with, and the credential it would resolve. */
interface Dial {
  host: string;
  pass: string | null;
  /** The host that password was sealed against, or null when nothing is sealed. */
  sealedFor: string | null;
}

/** The whole install, as the four facts that decide whether it works. */
interface Install {
  /** The shell's settings file — what the NEXT engine is configured with. */
  settingsHost: string;
  settingsAddress: string;
  /** The engine's sealed credential row, or null when there is none for this mailbox. */
  sealed: { host: string; pass: string } | null;
  /** The row `ensureLocalWorld` finds or mints for `settingsAddress`. */
  mailboxId: string;
  dials: Dial[];
  asked: Asked[];
  /** What the credential PATCH answers. Replace to drive the failure arm. */
  patch: { status: number; body: string; statusText: string };
}

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

/**
 * A MAILBOX THAT IS ALREADY WORKING: the engine serves it, and the password for its CURRENT server
 * is sealed. This is the state both defects need, and the one a fresh install is not in.
 */
function runningInstall(): Install {
  const install: Install = {
    settingsHost: OLD_HOST,
    settingsAddress: ADDRESS,
    sealed: { host: OLD_HOST, pass: OLD_PASS },
    mailboxId: "mbx-1",
    dials: [],
    asked: [],
    patch: { status: 200, body: '{"ok":true}', statusText: "OK" },
  };
  let minted = 1;
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      install.asked.push({ command, payload });

      if (command === "engine_configure") {
        const config = payload!.config as { imap: { host: string }; address: string };
        install.settingsHost = config.imap.host;
        if (config.address.trim().toLowerCase() !== install.settingsAddress.trim().toLowerCase()) {
          /* `ensureLocalWorld` looks the mailbox up by `lower(address)` and INSERTS when it finds
             none. A different address is therefore a different row — with no credential on it. */
          install.settingsAddress = config.address;
          install.mailboxId = `mbx-${++minted}`;
          install.sealed = null;
        }
        // THE BOOT. This is the moment a password meets a server.
        install.dials.push({
          host: install.settingsHost,
          pass: install.sealed?.pass ?? null,
          sealedFor: install.sealed?.host ?? null,
        });
        return { state: "starting", mode: "local" };
      }

      if (command === "engine_status") {
        return {
          state: "serving",
          mode: "local",
          address: install.settingsAddress,
          mailboxId: install.mailboxId,
          credentialState: install.sealed ? "ready" : "absent",
        } satisfies EngineStatus;
      }

      if (command === "engine_request") {
        const url = String(payload!.url ?? "");
        if (url !== `/mailboxes/${install.mailboxId}`) {
          return encode(404, '{"error":{"code":"not_found","message":"no such mailbox"}}', "Not Found");
        }
        if (install.patch.status !== 200) {
          return encode(install.patch.status, install.patch.body, install.patch.statusText);
        }
        const body = JSON.parse(
          new TextDecoder().decode(Uint8Array.from(payload!.body as number[])),
        ) as { imap: { host: string; pass: string } };
        /* The service dials the MERGED PATCH and stores the pair it proved. Seal what was
           dialled — never what the running engine happens to be configured for. */
        install.sealed = { host: body.imap.host, pass: body.imap.pass };
        return encode(200, '{"ok":true}');
      }

      throw new Error(`unexpected command ${command}`);
    },
  };
  return install;
}

/** Every boot that would authenticate to one server with a secret sealed for another. */
function leaks(install: Install): Array<{ host: string; sealedFor: string | null }> {
  return install.dials
    .filter((d) => d.pass !== null && d.sealedFor !== d.host)
    .map(({ host: h2, sealedFor }) => ({ host: h2, sealedFor }));
}

/** The four facts that say whether the install still works, as one comparable value. */
function state(install: Install): Record<string, unknown> {
  return {
    settingsHost: install.settingsHost,
    settingsAddress: install.settingsAddress,
    sealed: install.sealed,
    mailboxId: install.mailboxId,
    boots: install.dials.length,
  };
}

const order = (install: Install): string[] => install.asked.map((a) => a.command);

const patchBodies = (install: Install): Array<{ imap: Record<string, unknown> }> =>
  install.asked
    .filter((a) => a.command === "engine_request")
    .map(
      (a) =>
        JSON.parse(new TextDecoder().decode(Uint8Array.from(a.payload!.body as number[]))) as {
          imap: Record<string, unknown>;
        },
    );

/** The form, filled for a manual (own-server) mailbox. */
function fields(over: Partial<LocalDoorFields> = {}): LocalDoorFields {
  return {
    ...EMPTY_LOCAL,
    providerId: "imap",
    address: ADDRESS,
    password: NEW_PASS,
    imapHost: NEW_HOST,
    imapPort: "993",
    smtpHost: NEW_HOST,
    smtpPort: "587",
    ...over,
  };
}

/** The door, entered the way `DoorChooser` enters it — the standing engine read at the submit. */
const enter = async (over: Partial<LocalDoorFields> = {}) =>
  enterLocalDoor(fields(over), providerById("imap"), await standingEngine());

afterEach(() => {
  delete host.__TAURI_INTERNALS__;
});

describe("reconfiguring a mailbox that is already connected", () => {
  it("REPRODUCTION: never dials the new server with the password sealed for the old one", async () => {
    const install = runningInstall();

    const result = await enter();
    expect(result.problem).toBeNull();

    /* THE ASSERTION THE WHOLE FILE IS FOR. Not "the calls were in this order" — no engine that
       booted in this attempt would have authenticated with a secret proved against a different
       server. Against the configure-first order this is
       `[{ host: NEW_HOST, sealedFor: OLD_HOST }]`. */
    expect(leaks(install)).toEqual([]);

    /* And positively: the one boot dialled the new host with the new password, which had already
       been proved against that host before the engine was replaced. */
    expect(install.dials).toEqual([{ host: NEW_HOST, pass: NEW_PASS, sealedFor: NEW_HOST }]);

    // The seal came FIRST: nothing about this install had changed when the password was offered.
    const commands = order(install);
    expect(commands.indexOf("engine_request")).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf("engine_request")).toBeLessThan(commands.indexOf("engine_configure"));

    // The password was offered to the NEW host and only to it — the old one is never dialled again.
    expect(patchBodies(install)).toEqual([
      { imap: { host: NEW_HOST, port: 993, secure: true, user: ADDRESS, pass: NEW_PASS } },
    ]);

    // And the settings and the credential end up naming ONE host.
    expect({ settings: install.settingsHost, credential: install.sealed?.host }).toEqual({
      settings: NEW_HOST,
      credential: NEW_HOST,
    });
  });

  it("replaces the engine ONCE, because the credential was in the store before it booted", async () => {
    const install = runningInstall();
    await enter();
    /* The first-connect order needs a second configure: it seals into an engine that booted with
       no password, and an adapter built at boot cannot pick one up. Sealing first removes the
       reason — so this path costs one restart, not two. */
    expect(order(install).filter((c) => c === "engine_configure")).toHaveLength(1);
  });

  it("REPRODUCTION: a refused password leaves the install exactly as it was found", async () => {
    const install = runningInstall();
    install.patch = {
      status: 401,
      statusText: "Unauthorized",
      body: JSON.stringify({
        error: { code: "imap_auth", message: "the mail server refused that password" },
      }),
    };
    const before = state(install);

    const result = await enter();

    // The mail server's own words, not a category.
    expect(result.problem).toBe("the mail server refused that password");
    // THE SHELL WAS NEVER ASKED TO COMMIT ANYTHING.
    expect(order(install).filter((c) => c === "engine_configure")).toHaveLength(0);
    // Settings, credential, mailbox row, boots — all as they were.
    expect(state(install)).toEqual(before);
    /* Which is to say: the two things that must agree still name ONE host, so the next launch
       connects the mailbox that was working rather than dialling a new server with an old secret. */
    expect({ settings: install.settingsHost, credential: install.sealed?.host }).toEqual({
      settings: OLD_HOST,
      credential: OLD_HOST,
    });
    // The door still reports the engine that is serving, so the window does not fall to a notice.
    expect(result.status?.state).toBe("serving");
  });

  /**
   * THE WINDOW THIS ORDERING OPENS, AND THE HALF OF IT THAT CAN BE SPOKEN TO.
   *
   * Between the seal and the configure, the credential names the new server and the settings still
   * name the old one — the mirror image of the divergence the ordering exists to end. If the
   * configure fails there, the shell's own error ("the settings file could not be written") is true
   * and hides the half that matters, and somebody who reads it and quits has been told nothing
   * about the state their install is in: the next launch would offer the new password to the old
   * server.
   *
   * The state itself closes only in the engine, by refusing a password whose stored host disagrees
   * with the configured one. What closes HERE is the not-telling.
   */
  it("says the password was stored when the settings write fails, not just the shell's error", async () => {
    const install = runningInstall();
    const standing = await standingEngine();
    const inner = host.__TAURI_INTERNALS__!.invoke;
    host.__TAURI_INTERNALS__!.invoke = async (command, payload) => {
      if (command === "engine_configure") {
        install.asked.push({ command, payload });
        throw new Error("the settings file could not be written");
      }
      return inner(command, payload);
    };

    const result = await enterLocalDoor(fields(), providerById("imap"), standing);

    // The shell's own words survive — they are the only thing that says WHY.
    expect(result.problem).toContain("the settings file could not be written");
    // …and the part the shell cannot know: what moved, what did not, and what to do.
    expect(result.problem).toContain("password was stored");
    expect(result.problem).toContain("still set up for the previous server");
    expect(result.problem).toContain("Open this door again");

    /* And the state the sentence describes is the state the install is really in — the assertion
       that keeps the copy honest if the ordering ever changes underneath it. */
    expect(install.sealed).toEqual({ host: NEW_HOST, pass: NEW_PASS });
    expect(install.settingsHost).toBe(OLD_HOST);
    expect(install.dials).toEqual([]);
  });

  it("says so and changes nothing when the engine cannot be reached at all", async () => {
    const install = runningInstall();
    const standing = await standingEngine();
    const before = state(install);
    host.__TAURI_INTERNALS__!.invoke = async (command, payload) => {
      install.asked.push({ command, payload });
      throw new Error("the mail engine is not answering");
    };

    const result = await enterLocalDoor(fields(), providerById("imap"), standing);
    expect(result.problem).toBe("the mail engine is not answering");
    expect(order(install).filter((c) => c === "engine_configure")).toHaveLength(0);
    expect(state(install)).toEqual(before);
  });

  /**
   * THE CASE THE DESIGN LEFT OPEN, answered by reading `ensureLocalWorld` rather than assuming.
   *
   * `PATCH /mailboxes/:id` cannot change an address, and the mailbox is looked up by `lower(address)`
   * — so a changed address means the replacement engine mints a DIFFERENT row. Sealing onto the
   * standing id would put the new server's credential on a row that still names the old address and
   * that nothing will read. The first-connect order is right there, and it is safe rather than
   * merely tolerated: the new row carries no credential, so the boot resolves `absent` and dials
   * with nothing at all.
   */
  it("an address change is a different mailbox: the first-connect order, and no secret to leak", async () => {
    const install = runningInstall();

    const result = await enter({ address: OTHER_ADDRESS });
    expect(result.problem).toBeNull();

    expect(leaks(install)).toEqual([]);
    expect(install.dials).toEqual([
      // The engine that mints the new mailbox has nothing sealed for it — nothing is dialled.
      { host: NEW_HOST, pass: null, sealedFor: null },
      // …and the relaunch after the seal carries the password proved against that same host.
      { host: NEW_HOST, pass: NEW_PASS, sealedFor: NEW_HOST },
    ]);
    // Two configures, and the password was sealed onto the NEW row between them.
    const commands = order(install);
    expect(commands.filter((c) => c === "engine_configure")).toHaveLength(2);
    expect(commands.indexOf("engine_request")).toBeGreaterThan(commands.indexOf("engine_configure"));
    expect(install.mailboxId).toBe("mbx-2");
    expect(patchBodies(install)).toHaveLength(1);
  });
});

describe("which order a local-door submit takes", () => {
  const serving: EngineStatus = {
    state: "serving",
    mode: "local",
    address: ADDRESS,
    mailboxId: "mbx-1",
    credentialState: "ready",
  };

  it("is a reconfigure only when there is a sealed credential on THIS mailbox to be leaked", () => {
    expect(reconfiguresLocalDoor(serving, ADDRESS)).toBe(true);
    // Case is not identity: `ensureLocalWorld` matches on `lower(address)`, so neither does this.
    expect(reconfiguresLocalDoor(serving, "  MILA@Example.com ")).toBe(true);

    // Nothing standing at all — the first connect, and the default when a caller passes nothing.
    expect(reconfiguresLocalDoor(null, ADDRESS)).toBe(false);
    expect(reconfiguresLocalDoor(undefined, ADDRESS)).toBe(false);
    // Nothing sealed ⇒ nothing to leak and nothing to diverge. The order that works is the old one.
    expect(reconfiguresLocalDoor({ ...serving, credentialState: "absent" }, ADDRESS)).toBe(false);
    // The keystore will not open the row: the boot dials nothing, and the password is being re-entered.
    expect(reconfiguresLocalDoor({ ...serving, credentialState: "unreadable" }, ADDRESS)).toBe(false);
    expect(reconfiguresLocalDoor({ ...serving, credentialState: "unknown" }, ADDRESS)).toBe(false);
    // A HOSTED install: choosing this door is a door switch, and its mailbox row is a mirror.
    expect(reconfiguresLocalDoor({ ...serving, mode: "cloud" }, ADDRESS)).toBe(false);
    // No engine to prove a credential through, or no row to address one to.
    for (const state of ["starting", "restarting", "stopped", "failed", "not_configured"] as const) {
      expect(reconfiguresLocalDoor({ ...serving, state }, ADDRESS), state).toBe(false);
    }
    const { mailboxId: _drop, ...noId } = serving;
    expect(reconfiguresLocalDoor(noId, ADDRESS)).toBe(false);
    expect(reconfiguresLocalDoor({ ...serving, mailboxId: "" }, ADDRESS)).toBe(false);
    // A different address is a different mailbox row — see the case above.
    expect(reconfiguresLocalDoor(serving, OTHER_ADDRESS)).toBe(false);
    // "The shell did not say" is never "they agree".
    const { address: _noAddress, ...anonymous } = serving;
    expect(reconfiguresLocalDoor(anonymous, ADDRESS)).toBe(false);
  });
});

describe("the door chooser's local form", () => {
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
          NextIntlClientProvider,
          { locale: "en", messages: en as never, timeZone: "Europe/Zurich" },
          h(DoorChooser, { start: "local", onEntered: () => {} }),
        ),
      );
    });
    return mount;
  };

  const type = async (el: HTMLElement, id: string, value: string): Promise<void> => {
    const input = el.querySelector<HTMLInputElement>(`#${id}`);
    if (!input) throw new Error(`no field #${id} on screen`);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  const press = async (el: HTMLElement, label: string): Promise<void> => {
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
    await act(async () => {
      found.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  /**
   * THE WIRING, END TO END THROUGH THE COMPONENT — the guard that the standing engine is actually
   * read and passed. `enterLocalDoor` defaults it to null so that the meaning of the two-argument
   * call is unchanged, which is exactly what makes a missing argument silent: the door would take
   * the first-connect order over a running install and the defect would be back with every unit
   * test still green. This is the case that fails instead.
   */
  it("reads the standing engine at the submit, so a reconfigure seals before it commits", async () => {
    const install = runningInstall();
    const el = await render();

    await press(el, "Any other IMAP mailbox");
    await type(el, "door-address", ADDRESS);
    await type(el, "door-password", NEW_PASS);
    await type(el, "door-imap-host", NEW_HOST);
    await type(el, "door-imap-port", "993");
    await type(el, "door-smtp-host", NEW_HOST);
    await type(el, "door-smtp-port", "587");
    await press(el, "Open this mailbox");

    const commands = order(install);
    expect(commands, "the door never reached the engine").toContain("engine_request");
    expect(commands.indexOf("engine_request")).toBeLessThan(commands.indexOf("engine_configure"));
    expect(leaks(install)).toEqual([]);
  });
});
