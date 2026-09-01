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
/* THE ENGINE'S OWN RULE, imported rather than restated — see `Dial.authenticated`. A relative
   import across app boundaries, as this file already makes to `apps/webapp`: the module has no
   imports of its own, and both directories are published to the mirror together. */
import { credentialIsForeign, credentialIsForeignSmtp } from "../../sidecar/src/credential-host.js";

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
 *  · drop `smtpHost` from the seal body, so the credential records only the incoming server →
 *    FOUR cases here go red plus TWO in `desktop-doors.test.ts`, and the one that names the
 *    consequence is "an outgoing server that moved alone still RECEIVES, and would not send"
 *    (`expected true to be false`): with nothing recorded there is nothing to compare, and the
 *    install would offer the password to a submission server nobody named.
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
  /**
   * The password the store held for this boot — what `resolveLogin()` READS, before it decides
   * whether the boot may have it.
   *
   * Deliberately NOT gated on the boot contract below, and this is the one thing in this model
   * that must not be tidied. {@link leaks} is the guard for the door's ORDERING, and its whole
   * content is "a secret sealed for one server was present at a boot configured for another".
   * Recording `null` here whenever the contract would refuse would make `leaks()` structurally
   * incapable of returning anything — the ordering guard would go green by construction, and the
   * mutation that reddens it today (forcing `reconfiguresLocalDoor` to false) would stop working.
   * The contract is a BACKSTOP for the ordering, never a licence to hand the secret over.
   */
  pass: string | null;
  /** The host that password was sealed against, or null when nothing is sealed. */
  sealedFor: string | null;
  /**
   * Whether this boot would actually AUTHENTICATE — the boot contract's answer.
   *
   * `resolveLogin()` withholds a password whose stored `meta.host` disagrees with the host the
   * engine was configured for, so a boot in that state serves its mirror and dials nothing on
   * either transport (`apps/sidecar/src/credential-host.ts`, which the engine's own suite exercises
   * end to end against a real engine on a real mirror).
   *
   * The rule is applied through the ENGINE'S OWN predicate, imported rather than restated. Two
   * programs have to agree on this comparison and they cannot share a package — `apps/desktop`
   * declares no `@trafficflow/*` dependency because its manifest is published and every entry in
   * it must resolve for a stranger — so it travels as an import-free file. That is what makes this
   * a model of the engine instead of a second opinion about it: deleting the comparison from the
   * engine reddens this file too.
   */
  authenticated: boolean;
}

/** The whole install, as the facts that decide whether it works. */
interface Install {
  /** The shell's settings file — what the NEXT engine is configured with. */
  settingsHost: string;
  /**
   * …and the OUTGOING server in that same file, which is the half that can move on its own.
   *
   * A mailbox has two servers and the settings carry both, so a change that touches only this one
   * leaves `settingsHost` agreeing with the credential and the incoming comparison satisfied. That
   * is why it is modelled separately rather than folded into the host above: they are two facts,
   * and the whole defect is that they move independently.
   */
  settingsSmtpHost: string;
  settingsAddress: string;
  /**
   * The engine's sealed credential row, or null when there is none for this mailbox.
   *
   * `smtpHost` is the outgoing server the password was SAVED FOR — recorded by the seal, never
   * dialled by it. One password covers both transports, so what the person authorized is a PAIR,
   * and this is the only place that pair is written down.
   */
  sealed: { host: string; pass: string; smtpHost: string } | null;
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
    // The working install's two servers AGREE with the pair its credential was saved for. Every
    // defect in this file is a way of pulling those apart.
    settingsSmtpHost: OLD_HOST,
    settingsAddress: ADDRESS,
    sealed: { host: OLD_HOST, pass: OLD_PASS, smtpHost: OLD_HOST },
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
        const config = payload!.config as {
          imap: { host: string }; smtp?: { host: string }; address: string;
        };
        install.settingsHost = config.imap.host;
        // Absent when the form and the preset name no outgoing server — the engine then has none
        // configured, which is a state with nothing to disagree about rather than a mismatch.
        install.settingsSmtpHost = config.smtp?.host ?? "";
        if (config.address.trim().toLowerCase() !== install.settingsAddress.trim().toLowerCase()) {
          /* `ensureLocalWorld` looks the mailbox up by `lower(address)` and INSERTS when it finds
             none. A different address is therefore a different row — with no credential on it. */
          install.settingsAddress = config.address;
          install.mailboxId = `mbx-${++minted}`;
          install.sealed = null;
        }
        // THE BOOT. This is the moment a password meets a server — or, under the boot contract,
        // the moment it is withheld from one.
        install.dials.push({
          host: install.settingsHost,
          pass: install.sealed?.pass ?? null,
          sealedFor: install.sealed?.host ?? null,
          authenticated:
            install.sealed !== null &&
            !credentialIsForeign({ host: install.sealed.host }, install.settingsHost),
        });
        return { state: "starting", mode: "local" };
      }

      if (command === "engine_status") {
        return {
          state: "serving",
          mode: "local",
          address: install.settingsAddress,
          mailboxId: install.mailboxId,
          /* What the engine reports, through the engine's own rule. `foreign-host` is a real
             answer here and not a theoretical one: it is exactly the state an install is left in
             when the process dies between the seal and the configure below. */
          credentialState:
            install.sealed === null
              ? "absent"
              : credentialIsForeign({ host: install.sealed.host }, install.settingsHost)
                ? "foreign-host"
                : "ready",
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
        ) as { imap: { host: string; pass: string; smtpHost?: string } };
        /* The service dials the MERGED PATCH and stores the pair it proved. Seal what was
           dialled — never what the running engine happens to be configured for.

           The OUTGOING host is stored from the body too, and it is stored WITHOUT being dialled:
           nothing proves a submission server here, so what the row records is the pair the person
           named. A body that says nothing about it records nothing, which is what every credential
           sealed before this existed looks like. */
        install.sealed = {
          host: body.imap.host,
          pass: body.imap.pass,
          smtpHost: body.imap.smtpHost ?? "",
        };
        return encode(200, '{"ok":true}');
      }

      throw new Error(`unexpected command ${command}`);
    },
  };
  return install;
}

/**
 * Every boot at which a secret sealed for one server was present, configured for another.
 *
 * THE ORDERING GUARD, and it is deliberately NOT gated on the boot contract — see `Dial.pass`. A
 * mismatch reaching a boot at all is the door's defect; whether the engine then declines to send
 * it is a separate, later fact, measured by {@link authenticated}. Folding the two together would
 * make this function unable to return anything and quietly retire the guard.
 */
function leaks(install: Install): Array<{ host: string; sealedFor: string | null }> {
  return install.dials
    .filter((d) => d.pass !== null && d.sealedFor !== d.host)
    .map(({ host: h2, sealedFor }) => ({ host: h2, sealedFor }));
}

/** Every boot that would actually log in, and to where. The boot contract's half of the record. */
function authenticated(install: Install): Array<{ host: string; sealedFor: string | null }> {
  return install.dials
    .filter((d) => d.authenticated)
    .map(({ host: h2, sealedFor }) => ({ host: h2, sealedFor }));
}

/**
 * WOULD A SEND FROM THIS INSTALL OFFER THE PASSWORD TO ITS CONFIGURED OUTGOING SERVER?
 *
 * The other half of the same contract, and its scope is narrower on purpose: this decides one
 * SEND, not the launch. A mailbox whose outgoing server moved still receives, so the engine
 * compares this only where a submission transport is about to be opened — which is why
 * {@link Dial.authenticated} above is unaffected by it and this is a separate reading.
 *
 * Through the engine's own predicate, imported rather than restated, for the reason the incoming
 * arm gives: deleting the comparison from the engine has to redden this file too.
 */
function wouldSend(install: Install): boolean {
  return (
    install.sealed !== null &&
    !credentialIsForeign({ host: install.sealed.host }, install.settingsHost) &&
    !credentialIsForeignSmtp({ smtpHost: install.sealed.smtpHost }, install.settingsSmtpHost)
  );
}

/**
 * THE NEXT TIME THE APP IS OPENED.
 *
 * Not `engine_configure` — a relaunch changes nothing and asks for nothing. The shell reads the
 * settings file it already has and starts an engine against it, which is a BOOT in every sense
 * this model cares about: a configured host meets whatever the store holds. This is the only way
 * to observe the state a crash leaves behind, because the process that would have told somebody
 * about it is the one that died.
 */
function relaunch(install: Install): void {
  install.dials.push({
    host: install.settingsHost,
    pass: install.sealed?.pass ?? null,
    sealedFor: install.sealed?.host ?? null,
    authenticated:
      install.sealed !== null &&
      !credentialIsForeign({ host: install.sealed.host }, install.settingsHost),
  });
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
    expect(install.dials).toEqual([
      { host: NEW_HOST, pass: NEW_PASS, sealedFor: NEW_HOST, authenticated: true },
    ]);

    // The seal came FIRST: nothing about this install had changed when the password was offered.
    const commands = order(install);
    expect(commands.indexOf("engine_request")).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf("engine_request")).toBeLessThan(commands.indexOf("engine_configure"));

    /* The password was offered to the NEW host and only to it — the old one is never dialled
       again — and the body states BOTH servers, which is what gives the engine a pair to compare
       a later change against. */
    expect(patchBodies(install)).toEqual([
      {
        imap: {
          host: NEW_HOST, port: 993, secure: true, user: ADDRESS, pass: NEW_PASS,
          smtpHost: NEW_HOST,
        },
      },
    ]);

    // And the settings and the credential end up naming ONE PAIR of servers, on both transports.
    expect({
      settings: [install.settingsHost, install.settingsSmtpHost],
      credential: [install.sealed?.host, install.sealed?.smtpHost],
    }).toEqual({
      settings: [NEW_HOST, NEW_HOST],
      credential: [NEW_HOST, NEW_HOST],
    });
    // …so the install can send. The case below is the same install with only that half pulled apart.
    expect(wouldSend(install)).toBe(true);
  });

  /**
   * THE OUTGOING SERVER MOVES ON ITS OWN, and the incoming comparison has nothing to say about it.
   *
   * This is the state a change that touches only the submission server leaves — a settings file
   * edited by hand, or a process that dies inside the write that was meant to move both. The
   * incoming host still agrees with the credential, so the launch is `ready` and the mailbox keeps
   * receiving; what is wrong is that a send would offer the password to a server nobody named.
   *
   * MODELLED RATHER THAN ENTERED THROUGH THE DOOR, and that is the point: no door produces this.
   * The door states both servers in one body, so the pair it seals always matches the pair it
   * configures. This state arrives from outside the door, which is exactly why the ENGINE has to be
   * the thing that refuses it — and the engine's own suite drives that refusal end to end against a
   * real engine on a real mirror.
   */
  it("an outgoing server that moved alone still RECEIVES, and would not send", async () => {
    const install = runningInstall();
    await enter();
    expect(wouldSend(install)).toBe(true);

    install.settingsSmtpHost = "smtp.somewhere-nobody-named.example";

    // The launch is untouched — one boot, authenticated, no leak. Refusing here would stop mail
    // arriving to fence a send.
    relaunch(install);
    expect(leaks(install)).toEqual([]);
    expect(authenticated(install)).toHaveLength(2);
    // …and the send is the one thing that stops.
    expect(wouldSend(install)).toBe(false);

    /* AND IT IS RE-RESOLVABLE WITH NOTHING RE-ENTERED. The credential was never rewritten or
       deleted — pointing the outgoing server back at the one the password was saved for restores
       sending. A refusal whose recovery required the password again would be a worse answer than
       the defect, because it would send somebody to type a secret into the wrong server. */
    install.settingsSmtpHost = NEW_HOST;
    expect(wouldSend(install)).toBe(true);
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
    expect(install.sealed).toEqual({ host: NEW_HOST, pass: NEW_PASS, smtpHost: NEW_HOST });
    expect(install.settingsHost).toBe(OLD_HOST);
    expect(install.dials).toEqual([]);
  });

  /**
   * ── THE OTHER HALF OF THAT WINDOW: THE CRASH, WHICH HAS NOBODY TO TELL ──────────────────────
   *
   * The case above covers the interruption a person is told about. A process that dies inside
   * `engine_configure` leaves the identical state and tells no one, so the only thing standing
   * between it and a leak is the engine's own refusal on the NEXT launch.
   *
   * This is the desktop end of the boot contract, and it is written as two facts that must BOTH
   * hold, because either alone would be misleading:
   *
   *  · `leaks()` is NOT empty. The ordering could not prevent this one — the mismatch is what the
   *    crash created — and a version of this test that showed no leak would be quietly claiming
   *    the door had solved a case it cannot reach.
   *  · `authenticated()` IS empty. Nothing logged in anyway. That is the contract, and it is the
   *    difference between a window that is narrow and a window that is closed.
   *
   * Then the recovery, which is the acceptance's other clause: re-opening the door from this state
   * must finish the move rather than deepen it. It takes the FIRST-CONNECT order — `foreign-host`
   * is not `ready`, so `reconfiguresLocalDoor` is false — and that order is SAFE here rather than
   * merely tolerated, for a reason worth stating: configuring first boots an engine against the
   * new host holding a credential already sealed for the new host, so there is no mismatch for
   * that boot to have. The contract and the ordering agree instead of one covering for the other.
   */
  it("a crash in that window dials nothing on the next launch, and re-opening the door finishes it", async () => {
    const install = runningInstall();
    const standing = await standingEngine();
    const inner = host.__TAURI_INTERNALS__!.invoke;
    let dead = true;
    host.__TAURI_INTERNALS__!.invoke = async (command, payload) => {
      if (command === "engine_configure" && dead) {
        install.asked.push({ command, payload });
        // The process does not return from here. Nothing is written and nobody is told.
        throw new Error("the settings file could not be written");
      }
      return inner(command, payload);
    };
    await enterLocalDoor(fields(), providerById("imap"), standing);

    /* THE STATE A CRASH LEAVES: the credential names the new server, the settings still name the
       old one. The mirror image of the divergence the reordering ended. BOTH servers diverge here,
       because the settings write that would have moved either of them is the one that died. */
    expect(install.sealed).toEqual({ host: NEW_HOST, pass: NEW_PASS, smtpHost: NEW_HOST });
    expect(install.settingsHost).toBe(OLD_HOST);
    expect(install.settingsSmtpHost).toBe(OLD_HOST);
    // So a send fired into this window is refused too, on its own comparison — the door is a modal
    // over the whole app, but a scheduled send fires on the engine's own timer.
    expect(wouldSend(install)).toBe(false);

    // The next time the app is opened.
    relaunch(install);

    /* Both halves. The ordering did NOT prevent this — that is the honest half — and the engine
       refused to act on it anyway, which is the half that makes the window survivable. Against an
       engine without the boot contract, `authenticated()` is
       `[{ host: OLD_HOST, sealedFor: NEW_HOST }]`: the previous server, offered the new server's
       password. */
    expect(leaks(install)).toEqual([{ host: OLD_HOST, sealedFor: NEW_HOST }]);
    expect(authenticated(install)).toEqual([]);

    /* And what the person sees when they open Settings — the engine's word for it, which the
       window renders as its own sentence (`desktop-native.test.ts`) rather than as "nothing is
       wrong" or "re-enter your password". */
    const stuck = await standingEngine();
    expect(stuck?.credentialState).toBe("foreign-host");

    // ── THE RECOVERY ────────────────────────────────────────────────────────────────────────
    dead = false;
    const before = install.dials.length;
    const result = await enterLocalDoor(fields(), providerById("imap"), stuck);
    expect(result.problem).toBeNull();

    // Settings and credential name ONE pair again, and it is the one that was asked for.
    expect(install.settingsHost).toBe(NEW_HOST);
    expect(install.settingsSmtpHost).toBe(NEW_HOST);
    expect(install.sealed).toEqual({ host: NEW_HOST, pass: NEW_PASS, smtpHost: NEW_HOST });
    expect(wouldSend(install)).toBe(true);
    // Every boot the recovery made logged in, and to the right server. No new mismatch was created
    // on the way out of the old one.
    const recoveryBoots = install.dials.slice(before);
    expect(recoveryBoots.length).toBeGreaterThan(0);
    expect(recoveryBoots.every((d) => d.authenticated && d.host === NEW_HOST)).toBe(true);
    expect(leaks({ ...install, dials: recoveryBoots })).toEqual([]);
    // Still the same mailbox — the address never moved, so nothing was minted and nothing orphaned.
    expect(install.mailboxId).toBe("mbx-1");
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
      { host: NEW_HOST, pass: null, sealedFor: null, authenticated: false },
      // …and the relaunch after the seal carries the password proved against that same host.
      { host: NEW_HOST, pass: NEW_PASS, sealedFor: NEW_HOST, authenticated: true },
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
    /* THE BOOT CONTRACT'S STATE, and it belongs on the FALSE side deliberately rather than by
       falling through the `=== "ready"` test unexamined.

       An install here has a credential sealed for one server and settings naming another, so the
       engine is refusing to dial (`apps/sidecar/src/credential-host.ts`). The first-connect order
       is the right one and — unusually — it is SAFE rather than merely tolerated: configuring
       first boots an engine against the host the door was given, and the contract withholds the
       password from that boot unless the two now agree. The end-to-end case above walks it.

       This line is also the guard on the clause itself. Widening the condition to
       `credentialState !== "absent"` — the plausible "any credential is worth sealing over"
       simplification — reddens exactly here. */
    expect(reconfiguresLocalDoor({ ...serving, credentialState: "foreign-host" }, ADDRESS)).toBe(false);
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
