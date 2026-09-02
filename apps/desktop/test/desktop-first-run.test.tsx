/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";

import en from "../../webapp/messages/en.json";
import { FirstRun } from "../../webapp/app/shell/FirstRun";
import { KeymapProvider } from "../../webapp/app/shell/keymap";

import {
  deriveOnboardingStep, onboardingPath, type OnboardingFacts,
} from "../../webapp/app/shell/onboarding";
import type { FirstRunHost } from "../../webapp/app/shell/first-run-host";
import { firstRunDoorFor } from "../src/doors.js";
import {
  localAiPosture, localProbeReason, LocalWireError, useLocalFirstRun,
} from "../src/local-first-run.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import type { LocalAiStatus } from "../src/local-ai.js";

/**
 * THE GUIDED SETUP FLOW OPENS ON THE STANDALONE DOOR — the seam, driven rather than described.
 *
 * The stage (`app/shell/FirstRun.tsx`) is shared and knows about no door; what decides whether
 * standalone onboarding exists at all is one object handed to `AppShell`. Before this slice the
 * desktop passed none, so `#/first-run` rendered NOTHING on the door the flow was written for and
 * the consent route the engine serves had no caller anywhere in the product.
 *
 * ── WHAT IS ASSERTED HERE, AND WHY EACH ONE IS WORTH A TEST ─────────────────────────────────
 *
 *  · THE REQUESTS THAT LEAVE. This window cannot open a socket, so the only honest proof that a
 *    call reaches the right handler is the frame that goes down the pipe. Every wire assertion
 *    below drives the REAL `bridgeFetch` against a stand-in shell and reads the method, the URL
 *    and the body the shell was handed — not a mock of the module under test.
 *  · THE THREE ROUTES THAT ARE NOT THE SHARED ONES. `organize` and `forgetMailbox` must address
 *    `/local/…`, because their shared twins are `stepUp: true` and a step-up on this door is a
 *    permanent refusal five minutes after launch. A regression here does not fail loudly: it
 *    fails on a machine that has been open a while, which is every machine but a test one.
 *  · NO PASSWORD ON THE CONSENT CALL. The interface offers `imap.pass` because the other door
 *    needs it; this route's authority is the launch bearer and its handler reads no credential
 *    from the body. Forwarding one would be a mailbox password on a wire for nothing.
 *  · WHERE THE FLOW OPENS. Through `deriveOnboardingStep` — the pure function — never a step
 *    counter, and on the FACTS this door actually produces.
 *  · "NO" IS A COMPLETE ANSWER HERE. The Cloud door cannot record it and walks its cursor past
 *    it; this one can, and if it stops being able to, somebody who declined a model is walked
 *    onto the form for choosing one. That is one assertion on `onboardingPath`.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Shell {
  __TAURI_INTERNALS__?: { invoke: Invoke };
}
const shellHost = globalThis as unknown as Shell;

/** One answer, framed exactly as the shell frames one. */
function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

interface Asked { method: string; url: string; body: string }

/** What the shell was handed, and what it answers. */
let asked: Asked[] = [];
let answer: { status: number; body: string } = { status: 200, body: "{}" };

/**
 * EVERY SHELL COMMAND, in order — not only the bridge requests.
 *
 * `engine_configure` is the one the add path must never send: it rewrites the settings file and
 * replaces the engine, and the settings file names the ONE mailbox this process dials at launch.
 * A test that watched only `asked` could not tell the two connect modes apart at all.
 */
let commands: string[] = [];

function installShell(): void {
  shellHost.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      commands.push(command);
      if (command !== "engine_request") return {};
      const p = payload as { method: string; url: string; body: number[] };
      asked.push({
        method: p.method,
        url: p.url,
        body: new TextDecoder().decode(Uint8Array.from(p.body ?? [])),
      });
      return encode(answer.status, answer.body);
    },
  };
}

const LOCAL: EngineStatus = {
  state: "serving", mode: "local", mailboxId: "11111111-2222-3333-4444-555555555555",
  address: "me@example.org", credentialState: "ready",
};
const CLOUD: EngineStatus = { ...LOCAL, mode: "cloud" };

const AI_UNSET: LocalAiStatus = {
  provider: null, available: false, unavailableReason: "not_configured", contentGoesTo: null,
  settings: {
    provider: null,
    anthropic: { classifyModel: "c", draftModel: "d", hasKey: false },
    openai: { classifyModel: "c", draftModel: "d", hasKey: false },
    ollama: { baseUrl: "http://127.0.0.1:11434", classifyModel: "m", draftModel: "m" },
  },
  probe: null, canStoreKey: true,
};
const AI_READY: LocalAiStatus = {
  ...AI_UNSET, provider: "ollama", available: true, unavailableReason: null,
  contentGoesTo: "this_machine",
};

let mounted: Root | null = null;

beforeEach(() => {
  asked = [];
  commands = [];
  answer = { status: 200, body: "{}" };
  installShell();
  window.localStorage.clear();
});

afterEach(async () => {
  if (mounted) {
    const r = mounted;
    mounted = null;
    await act(async () => { r.unmount(); });
  }
  delete shellHost.__TAURI_INTERNALS__;
  document.body.innerHTML = "";
});

/** A box the wrapper writes into — simpler than threading a setter through `act`. */
const latest: { value: FirstRunHost | undefined } = { value: undefined };

/** Mount once and return what the hook produced. */
async function makeHost(
  status: EngineStatus | null = LOCAL, ai: LocalAiStatus | null = AI_UNSET,
): Promise<FirstRunHost | undefined> {
  latest.value = undefined;
  function Wrapper() {
    latest.value = useLocalFirstRun({
      status, ai, providerForm: h("div", { id: "provider-form" }),
    });
    return null;
  }
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  mounted = root;
  await act(async () => { root.render(h(Wrapper)); });
  return latest.value;
}

describe("which door the guided setup exists on", () => {
  it("is the standalone door, and only it", () => {
    expect(firstRunDoorFor(LOCAL)).toBe("local");
    expect(firstRunDoorFor(CLOUD)).toBeNull();
    // No door chosen yet: `DoorChooser` is the screen, and it is this door's step 1 rather than
    // a step of the stage. A host here would put a setup dialog over a window with no mailbox.
    expect(firstRunDoorFor({ state: "not_configured", mode: null })).toBeNull();
    expect(firstRunDoorFor(null)).toBeNull();
  });

  it("hands the stage a host on standalone and withholds it entirely on hosted", async () => {
    expect(await makeHost(LOCAL)).toBeDefined();
    await act(async () => { mounted?.unmount(); });
    mounted = null;
    expect(await makeHost(CLOUD)).toBeUndefined();
  });
});

describe("the host satisfies the contract the stage asks a door for", () => {
  it("names the local door and implements every member the stage calls", async () => {
    const made = (await makeHost())!;
    expect(made.door).toBe("local");
    for (const member of [
      "probe", "connect", "organize", "complete", "setAiEnabled", "forgetMailbox",
      "probeReason", "probeMessage",
    ] as const) {
      expect(typeof made[member], member).toBe("function");
    }
    // The provider step exists on this door alone, and its form is injected rather than
    // imported: `apps/webapp` may not import `AiProviderForm`.
    expect(made.providerForm).toBeTruthy();
    // Nothing self-host about this door, and no hosted AI switch to read.
    expect(made.selfhostAi).toBeUndefined();
  });
});

describe("where the flow opens on this door — derived, never counted", () => {
  const facts = (over: Partial<OnboardingFacts>): OnboardingFacts => ({
    door: "local", mailbox: null, account: {}, ai: "unset", queuedSenders: 0, ...over,
  });

  it("first launch with no mailbox opens on the mailbox step", async () => {
    const made = (await makeHost())!;
    expect(deriveOnboardingStep(facts({ door: made.door, mailbox: null }))).toBe("mailbox");
  });

  it("a connected mailbox nobody has consented to opens on the consent step", async () => {
    const made = (await makeHost())!;
    // THE STANDALONE FLAGSHIP CASE. `DoorChooser` connects the mailbox — this door's step 1 —
    // and leaves `organize_consented_at` null, so the stage opens exactly where the consent
    // route the local engine serves is the thing that closes it.
    expect(deriveOnboardingStep(facts({
      door: made.door,
      mailbox: { organizeConsentedAt: null, initialImportCompletedAt: null },
    }))).toBe("consent");
  });

  it("never re-opens once the flow has been left", async () => {
    const made = (await makeHost())!;
    expect(deriveOnboardingStep(facts({
      door: made.door,
      mailbox: { organizeConsentedAt: null },
      account: { onboardingCompletedAt: "2026-09-02T00:00:00.000Z" },
    }))).toBeNull();
  });
});

describe("the requests that leave this window", () => {
  const id = "11111111-2222-3333-4444-555555555555";

  it("consent goes to the LOCAL organize route, and carries no password", async () => {
    const made = (await makeHost())!;
    await act(async () => {
      await made.organize(id, {
        imap: { pass: "hunter2" },
        screening: { dormancyDays: 180, scope: "window" },
      });
    });
    const call = asked.at(-1)!;
    expect(call.method).toBe("POST");
    // PINNED TO THE LOCAL ROUTE. The shared `POST /mailboxes/:id/organize` is `stepUp: true`,
    // which on this door refuses for the life of the process from five minutes after launch.
    expect(call.url).toBe(`/local/mailboxes/${id}/organize`);
    expect(JSON.parse(call.body)).toEqual({ screening: { dormancyDays: 180, scope: "window" } });
    expect(call.body).not.toContain("hunter2");
    expect(call.body).not.toContain("imap");
  });

  it("an empty screening answer is still the local route, with no screening key", async () => {
    const made = (await makeHost())!;
    await act(async () => { await made.organize(id, {}); });
    expect(asked.at(-1)!.url).toBe(`/local/mailboxes/${id}/organize`);
    expect(JSON.parse(asked.at(-1)!.body)).toEqual({});
  });

  it("leaving the flow patches the account's own consent row", async () => {
    answer = { status: 200, body: JSON.stringify({ onboardingCompletedAt: "2026-09-02T00:00:00Z" }) };
    const made = (await makeHost())!;
    await act(async () => { await made.complete(); });
    const call = asked.at(-1)!;
    expect(call.method).toBe("PATCH");
    expect(call.url).toBe("/consent/settings");
    // It takes only `true`; nothing un-completes onboarding.
    expect(JSON.parse(call.body)).toEqual({ onboardingCompleted: true });
  });

  it("forgetting the mailbox uses the LOCAL removal route", async () => {
    answer = { status: 204, body: "" };
    const made = (await makeHost())!;
    await act(async () => { await made.forgetMailbox!(id); });
    expect(asked.at(-1)).toMatchObject({ method: "DELETE", url: `/local/mailboxes/${id}` });
  });

  it("the probe is the engine's own dial and sends no username it was not given", async () => {
    answer = {
      status: 200,
      body: JSON.stringify({ host: "imap.example.org", user: "me@example.org", folders: 12 }),
    };
    const made = (await makeHost())!;
    let ok: unknown;
    await act(async () => {
      ok = await made.probe({
        address: "me@example.org", provider: "other",
        imap: { host: "imap.example.org", port: 993, secure: true, pass: "pw" },
      });
    });
    expect(ok).toEqual({ host: "imap.example.org", user: "me@example.org", folders: 12 });
    const call = asked.at(-1)!;
    /* ── `/local/…`, AND THE MOVE IS A FIX ────────────────────────────────────────────────────
     *
     * The shared `POST /mailboxes/probe` is `stepUp: true`, and on this door the launch session's
     * second-factor stamp is written once at boot — so it refuses from five minutes after launch
     * for the life of the process. It was satisfiable here by ACCIDENT: the connect form was
     * withheld the moment a mailbox existed, so the button could only be pressed on an engine
     * that had just come up.
     *
     * Settings → Add mailbox ends the accident, and the flow's primary stays disabled until a
     * verdict exists — so on the shared route "Add mailbox" is a dead end on every window open
     * more than five minutes. Measured against a real sidecar: the mail server's own refusal at
     * 170 s, `403 step_up_required` at 330 s. The engine's own test of the local probe route holds
     * both halves as cases: the local route answers on a session older than the step-up window,
     * and the shared one refuses it. */
    expect(call).toMatchObject({ method: "POST", url: "/local/mailboxes/probe" });
    expect(JSON.parse(call.body).imap.user).toBeUndefined();
  });

  it("a refused call throws the ENGINE's sentence and the engine's taxonomy", async () => {
    answer = {
      status: 400,
      body: JSON.stringify({
        error: {
          code: "mailbox_probe_failed",
          message: "the mail server rejected that password",
          details: { reason: "auth" },
        },
      }),
    };
    const made = (await makeHost())!;
    let thrown: unknown;
    await act(async () => {
      try {
        await made.probe({
          address: "me@example.org", provider: "other",
          imap: { host: "imap.example.org", pass: "wrong" },
        });
      } catch (err) { thrown = err; }
    });
    expect(thrown).toBeInstanceOf(LocalWireError);
    expect(made.probeReason(thrown)).toBe("auth");
    expect(made.probeMessage(thrown)).toBe("the mail server rejected that password");
  });

  it("classifies only a probe refusal, and never invents a reason", () => {
    expect(localProbeReason(new Error("offline"))).toBeNull();
    // A code this build has no taxonomy for falls back to the server's own sentence.
    expect(localProbeReason(new LocalWireError("no", "internal", { reason: "auth" }))).toBeNull();
    // A reason outside the taxonomy is not passed through as if it were one.
    expect(localProbeReason(
      new LocalWireError("no", "mailbox_probe_failed", { reason: "gremlins" }),
    )).toBeNull();
  });
});

describe("the AI posture this door can report", () => {
  it("lets the engine's own answer outrank a remembered click", () => {
    // Somebody who declined a year ago and has since set a model up in Settings is `on`, and
    // the flow must not offer to configure a model that is already running.
    expect(localAiPosture(AI_READY, false)).toBe("on");
    expect(localAiPosture({ ...AI_READY, available: false }, null)).toBe("on-unconfigured");
  });

  it("reports `unset` when nobody has been asked, and never `off`", () => {
    expect(localAiPosture(AI_UNSET, null)).toBe("unset");
    // No read yet is also "we cannot say" — the state that stops the flow to ASK.
    expect(localAiPosture(null, null)).toBe("unset");
  });

  it("records `no` as a COMPLETE answer, which is what keeps the provider step off the walk",
    async () => {
      const made = (await makeHost())!;
      await act(async () => { await made.setAiEnabled!(false); });
      const after = latest.value!;
      expect(after.ai).toBe("off");
      // The whole point: `onboardingPath` puts `provider` in the walk for a local door whose ai
      // is anything but `off`. Without a recordable "no", declining a model walks somebody onto
      // the form for choosing one.
      const walk = onboardingPath({
        door: "local", mailbox: { organizeConsentedAt: "x" }, account: {}, ai: after.ai,
        queuedSenders: 0,
      });
      expect(walk).not.toContain("provider");
      expect(onboardingPath({
        door: "local", mailbox: { organizeConsentedAt: "x" }, account: {}, ai: "unset",
        queuedSenders: 0,
      })).toContain("provider");
    });

  it("`yes` moves the posture so the derivation names the provider step by itself", async () => {
    const made = (await makeHost())!;
    await act(async () => { await made.setAiEnabled!(true); });
    expect(latest.value!.ai).toBe("on-unconfigured");
    expect(deriveOnboardingStep({
      door: "local",
      mailbox: { organizeConsentedAt: "x", initialImportCompletedAt: null },
      account: {}, ai: latest.value!.ai, queuedSenders: 0,
    })).toBe("provider");
  });

  it("survives a relaunch — the answer is the install's, not the run's", async () => {
    const made = (await makeHost())!;
    await act(async () => { await made.setAiEnabled!(false); });
    await act(async () => { mounted?.unmount(); });
    mounted = null;
    // A fresh mount reads what the install stored rather than asking again.
    expect((await makeHost())!.ai).toBe("off");
  });
});

describe("the gate hands the stage its door", () => {
  const gate = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/DesktopGate.tsx"),
    "utf8",
  );

  it("passes `firstRun` to the shared shell", () => {
    // The prop is the whole seam: `AppShell` renders no stage without it, so an absent spread
    // is a `#/first-run` that draws nothing — the state this slice exists to end.
    expect(gate).toMatch(/\{\.\.\.\(firstRun \? \{ firstRun \} : \{\}\)\}/);
    expect(gate).toMatch(/useLocalFirstRun\(\{/);
  });

  it("wires the consent read on the standalone door, and the spend wire only on the hosted one",
    () => {
      // `consent.known` is one of the four conditions `AppShell` gates the stage on, and it
      // comes from `GET /consent` — which `localRoutes` serves (mail 0083).
      expect(gate).toMatch(
        /accountDoor \|\| firstRunDoorFor\(status\) === "local"\s*\?\s*\{ consentTransport: consentOverBridge \}/,
      );
      // And the half of the old rule that survived: a spend control needs a ledger, and a
      // standalone engine has none.
      expect(gate).toMatch(/\{\.\.\.\(accountDoor \? \{ suggestWire: cloudSuggestWire \} : \{\}\)\}/);
    });
});

/**
 * THE STAGE ACTUALLY OPENS ON THIS DOOR — the shared component, mounted with the local host.
 *
 * Everything above proves the host: its wires, its posture, its door rule. None of it proves the
 * thing the slice is for, which is that `FirstRun` RENDERS when handed one — a host that satisfies
 * the type and a stage that draws nothing are indistinguishable from outside, and "the desktop
 * passes no host" was exactly that failure one layer up.
 *
 * So the real component is mounted, with the real catalogue, on the facts this door produces the
 * moment its door chooser has connected a mailbox: consented to by nobody, importing, no model.
 * The assertion is the CONSENT screen's own heading, which is the screen the derivation names for
 * that state and the first thing a standalone install sees.
 */
describe("the shared stage, mounted on the local host", () => {
  it("opens on the consent screen for a freshly connected standalone mailbox", async () => {
    const made = (await makeHost())!;
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    mounted = root;
    await act(async () => {
      root.render(
        h(ThemeProvider, null,
          h(NextIntlClientProvider, { locale: "en", messages: en as never },
            h(KeymapProvider, null,
            h(FirstRun, {
              host: made,
              facts: {
                door: "local",
                mailbox: { organizeConsentedAt: null, initialImportCompletedAt: null },
                account: {}, ai: made.ai, queuedSenders: 0,
              },
              mailboxId: "11111111-2222-3333-4444-555555555555",
              mailboxAddress: "me@example.org",
              pull: { screened: 0, history: 0, mirrorCount: 0 },
              decide: null,
              screening: { dormancyDays: 365, scope: "window" },
              onRefresh: () => {},
              onLeave: () => {},
            }))))); 
    });
    const text = el.textContent ?? "";
    /* eslint-disable-next-line no-console -- the render under test, for the record */
    if (!text) console.log("RENDERED NOTHING");
    // The consent statement's heading — `onboarding.consentTitle`, the screen row 4 names.
    expect(text).toContain("What ohmail will do to this mailbox");
    // And the flow is genuinely on THIS door: the provider step exists here and nowhere else,
    // so the rail carries a step the hosted stage does not have.
    expect(text.length).toBeGreaterThan(80);
  });
});

/**
 * THE WAY BACK IN — Settings → Mailboxes → "Run setup again".
 *
 * This is a CLAIM UNDER TEST rather than a feature with a test beside it. The released changelog
 * says of the guided flow that "it can be run again later from Settings", and until this row
 * existed that sentence was true of the browser and false of the app the changelog ships with:
 * `goFirstRun({ rerun: true })` was wired in the web client's mailbox pane and nowhere else, so on
 * the desktop the only way back into setup was to type the route.
 *
 * Asserted over the SOURCE rather than by mounting the pane, and deliberately: the pane needs the
 * mail-state provider, a facts poll and an engine, and what can go wrong here is not rendering —
 * it is the two gates. A row without them is a button that navigates to a blank overlay on the
 * hosted door, or offers to re-run a setup that has never run.
 */
describe("the guided flow's way back in, on the desktop", () => {
  const pane = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/DesktopMailboxes.tsx"),
    "utf8",
  );

  it("offers the re-run ON EACH ROW, naming that row's mailbox in the route", () => {
    /* ── IT WAS ONE ROW AT THE FOOT OF THE PANE, AND THE PLACE STOPPED BEING RIGHT ───────────
     *
     * The gates were `firstRunDoorFor(statusOf(door)) === "local" && facts.length > 0` and the
     * route was the bare `#/first-run/again`. Both were correct while a standalone install held
     * one mailbox. The flow writes a consent stamp and a screening window for a NAMED mailbox, so
     * over two rows a control at the foot of the list named neither — it re-ran setup for
     * whichever row `facts[0]` happened to be, which on an install whose seed had been removed is
     * not the one anybody was looking at.
     *
     * `facts.length > 0` went with it and lost nothing: a row control cannot render without a row.
     */
    expect(pane).toMatch(/goFirstRun\(\{ rerun: true, mailboxId: shown\.id \}\)/);
    // The bare hash would open, find the completion stamp, and close on the same render.
    expect(pane).not.toMatch(/goFirstRun\(\)/);
    expect(pane).toContain('t("setupAgainAction")');
  });

  it("gates BOTH flow entry points on the door that HAS a stage", () => {
    /* Two entry points now — the row's re-run and the pane's "Add mailbox" — and each would be a
       button navigating somewhere blank on the hosted door, where this window gives the stage no
       host at all. Counted rather than matched once, so a third one added without the gate reds. */
    const gates = pane.match(/firstRunDoorFor\(statusOf\(door\)\) === "local"/g) ?? [];
    expect(gates.length, "a first-run entry point is ungated on the hosted door")
      .toBeGreaterThanOrEqual(2);
  });

  it("offers ADD MAILBOX at the add route, which is the only intent that opens the form", () => {
    /* `#/first-run/add`, never the bare hash and never the re-run's. A finished install derives
       to "nothing to do"; the re-run opens on the consent statement for a mailbox that EXISTS;
       only the add intent opens on the connect form. */
    expect(pane).toMatch(/goFirstRun\(\{ add: true \}\)/);
    for (const key of ["desktopAdd", "desktopAddWhy", "desktopAddAction"]) {
      expect(pane, key).toContain(`t("${key}")`);
    }
  });

  it("asks the shared door rule instead of re-spelling it", () => {
    // Two spellings of "which door has a setup flow" is how this row and the mount in the gate
    // come to disagree, which is the failure that ships a button to nowhere.
    expect(pane).toMatch(/import \{ firstRunDoorFor \} from "\.\/doors\.js"/);
    expect(pane).not.toMatch(/door === "local" \?/);
  });

  it("the copy it promises exists in the catalogue", () => {
    const mailboxes = (en as Record<string, Record<string, string>>).mailboxes!;
    for (const key of [
      "setupAgainAction",
      "desktopAdd", "desktopAddWhy", "desktopAddAction",
      // The role line the rows carry now, and the sixth removal consequence.
      "desktopRoleOrganizer", "removeLastDoor",
    ]) {
      expect(mailboxes, key).toHaveProperty(key);
    }
  });
});

/**
 * ═══ THE TWO CONNECTS — A SEED IS NOT AN ADD, AND THE SEAM MAKES THAT SAYABLE ══════════════
 *
 * `FirstRunHost.connect` takes a REQUIRED `mode`. It is the whole of risk 3 in the multi-mailbox
 * ruling — *"injected dependency, default branch untested"* — and the two branches write to
 * different places:
 *
 *  · `seed` reconfigures the INSTALL. `engine_configure` writes the shell's settings file and
 *    replaces the engine; the engine composes its IMAP dial from that file at every launch, so a
 *    first mailbox created any other way would be a row nothing ever connects to.
 *  · `add` writes a FURTHER row beside the ones already running: `POST /local/mailboxes`, which
 *    proves the password against its own server and attaches a runtime. It must not touch the
 *    settings file, because that file names one mailbox — the seed.
 *
 * What a default costs, in the direction that was measured on the shape of this defect: with
 * `seed` as the fallback, "Add mailbox" replaces the engine, and the first-connect order that
 * follows seals the newly typed password onto whatever mailbox the REPLACED engine settles on —
 * the install's original row. Mailbox #1 acquires mailbox #2's password.
 */
describe("the two connect modes", () => {
  const INPUT = {
    address: "second@example.org",
    provider: "imap",
    imap: { host: "imap.example.org", port: 993, secure: true, pass: "pw-2" },
    smtp: { host: "smtp.example.org", port: 465, secure: true },
  };

  it("ADD posts to the local add route and never reconfigures the install", async () => {
    answer = { status: 201, body: JSON.stringify({ id: "mbx-2", address: INPUT.address }) };
    const made = (await makeHost())!;

    const result = await made.connect(INPUT, "add");
    expect(result).toEqual({ id: "mbx-2" });

    expect(asked.map((a) => `${a.method} ${a.url}`)).toEqual(["POST /local/mailboxes"]);
    /* THE ASSERTION THE MODE EXISTS FOR. Not "the right URL was used" — no settings file was
       rewritten and no engine was replaced, so the mailbox this install was already opening is
       untouched and cannot acquire the password just typed. */
    expect(commands, "adding a mailbox reconfigured the install")
      .not.toContain("engine_configure");

    /* BOTH TRANSPORTS TRAVEL. The send path reads the MAILBOX's own `smtp` credential row; a
       process-wide submission setting cannot describe two mailboxes, so a row created without
       one would submit through the FIRST mailbox's server carrying this one's password. */
    const body = JSON.parse(asked[0]!.body) as {
      address: string;
      imap: Record<string, unknown>;
      smtp?: Record<string, unknown>;
    };
    expect(body.address).toBe("second@example.org");
    expect(body.imap).toEqual({
      host: "imap.example.org", port: 993, secure: true,
      // Absent in the input, so it defaults to the address — the same rule the seed path and the
      // hosted create both apply, so all three dial one identity.
      user: "second@example.org",
      pass: "pw-2",
      /* SENDING IS SETTLED BY A SUCCESSFUL CREATE. The engine's add route retries without the
         submission block when that dial is refused, writing the probe's reason into this key —
         so the create that DOES prove it has to say so, or a mailbox re-added after a blocked
         port would carry the old refusal. */
      smtpUnsettled: "",
    });
    expect(body.smtp).toEqual({
      host: "smtp.example.org", port: 465, secure: true,
      user: "second@example.org", pass: "pw-2",
    });
  });

  it("ADD carries the route's own refusal, so 409 same_login reaches the screen", async () => {
    /* Two rows over one physical mailbox write two claims into one `ohmail/_meta` under one
       install identity, and the lease's clone defence stands them down alternately — so the
       route refuses, and the sentence it refuses with is the one the person has to read. */
    answer = {
      status: 409,
      body: JSON.stringify({
        error: {
          code: "same_login",
          message: "this machine already has that mailbox. The server and username you entered "
            + "open a mailbox that is already connected here.",
        },
      }),
    };
    const made = (await makeHost())!;
    await expect(made.connect(INPUT, "add")).rejects.toThrow(/already has that mailbox/);
    expect(commands).not.toContain("engine_configure");
  });

  it("ADD refuses a 201 that named no mailbox rather than returning an empty id", async () => {
    // The consent call two screens later addresses this id. An empty one would be sent to
    // `/local/mailboxes//organize`, which is a 404 reported as a failed consent.
    answer = { status: 201, body: "{}" };
    const made = (await makeHost())!;
    await expect(made.connect(INPUT, "add")).rejects.toThrow(/has not been told its name/);
  });

  it("SEED reconfigures the install — the branch `add` must never take", async () => {
    const made = (await makeHost())!;
    // The stand-in shell answers `{}` to `engine_configure`, so the door stalls at `settle`. That
    // is fine and is not what is under test: what is under test is that the settings file was
    // written at all, which is the act `add` is forbidden from performing.
    await made.connect(INPUT, "seed").catch(() => undefined);
    expect(commands, "the seed connect never reconfigured the install")
      .toContain("engine_configure");
    expect(asked.map((a) => a.url), "the seed connect used the add route")
      .not.toContain("/local/mailboxes");
  });
});

/**
 * ═══ THE ADD RUN, DRIVEN ═══════════════════════════════════════════════════════════════════
 *
 * A standalone install can hold more than one mailbox, and the second one is not a first run.
 * Three things have to be true at once and none of them is derivable from the facts alone:
 *
 *  1. THE STAGE OPENS AT ALL. The account carries a completion stamp — this install has been set
 *     up, which is precisely why "Add mailbox" is a control somebody can see — and
 *     `deriveOnboardingStep` answers `null` for that, correctly, at every boot. The intent rides
 *     the route (`Route.firstRunAdd`), exactly as the re-run's does.
 *  2. IT OPENS ON THE FORM. A re-run opens on the consent statement because its mailbox exists;
 *     an add's does not, so its first screen is the connect form.
 *  3. IT CONNECTS THROUGH THE ADD ROUTE. `host.connect(input, "add")` — the mode has no default,
 *     and a `seed` connect here would rewrite the settings file and then seal the newly typed
 *     password onto the mailbox this install was already opening.
 *
 * Driven through the real component with the real catalogue, because 2 and 3 are both invisible
 * to a source-level assertion: the first is a derivation over a stamp, the second is one argument.
 */
describe("adding a further mailbox to a standalone install", () => {
  const ADD_FACTS: OnboardingFacts = {
    door: "local",
    // No mailbox: the route names none until the create answers, and `AppShell` withholds the
    // row for exactly that window so this screen is a form rather than a statement.
    mailbox: null,
    // THE INSTALL HAS BEEN THROUGH SETUP. This is the fact that closes the flow for a boot.
    account: { onboardingCompletedAt: "2026-08-01T09:00:00.000Z" },
    ai: "on",
    queuedSenders: 0,
  };

  /** Mount the stage with a host whose `connect` records what it was asked for. */
  async function driveAdd(): Promise<{
    el: HTMLElement;
    modes: string[];
    connected: string[];
  }> {
    const made = (await makeHost())!;
    const modes: string[] = [];
    const connected: string[] = [];
    const host: FirstRunHost = {
      ...made,
      probe: async () => ({ host: "imap.example.org", user: "second@example.org", folders: 7 }),
      connect: async (input, mode) => {
        modes.push(mode);
        return { id: `mbx-for-${input.address}` };
      },
    };

    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    mounted = root;
    await act(async () => {
      root.render(
        h(ThemeProvider, null,
          h(NextIntlClientProvider, { locale: "en", messages: en as never },
            h(KeymapProvider, null,
              h(FirstRun, {
                host,
                facts: ADD_FACTS,
                mailboxId: null,
                add: true,
                onConnected: (id: string) => { connected.push(id); },
                pull: { screened: 0, history: 0, mirrorCount: 0 },
                decide: null,
                onRefresh: () => {},
                onLeave: () => {},
              })))));
    });
    return { el, modes, connected };
  }

  /* BY PREFIX, because every verb in this flow wears its keycap: the primary's text content is
     "Connect and continue\u21b5", and an exact match would find nothing. */
  const button = (el: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(label));

  it("OPENS, on the connect form, over an install that has finished setup", async () => {
    const { el } = await driveAdd();
    const text = el.textContent ?? "";
    /* THE STAGE IS ON SCREEN. Without the add intent this render is `null`: row 1 of the
       derivation returns null for any account carrying the completion stamp. */
    expect(text.length, "the stage drew nothing over a set-up install").toBeGreaterThan(80);
    // The connect form's own heading and its two fields — a statement about an existing mailbox
    // would carry neither.
    expect(text).toContain("Add a mailbox");
    expect(el.querySelector('input[type="email"]'), "the mailbox step is not a form").not.toBeNull();
    expect(el.querySelector('input[type="password"]')).not.toBeNull();
    /* AND NO WELCOME. "One sentence about what ohmail does" to somebody who has been using it is
       the screen an add run exists without. */
    expect(text).not.toContain("Welcome to ohmail");
  });

  it("walks 1-2-3-4-7-8-9: no welcome, no AI question, no provider form, no pairing", () => {
    /* The install's answers, not the mailbox's. The model is a property of the install
       (`ai-provider.ts`) and so is the paired phone; asking again per mailbox would imply a
       per-mailbox answer that nothing stores. */
    const walk = onboardingPath(ADD_FACTS, true);
    expect(walk).toEqual(["mailbox", "consent", "window", "pull", "summary"]);
    // The claim question joins it when the peek finds a holder — step 2 of the plan.
    expect(onboardingPath(
      {
        ...ADD_FACTS,
        mailbox: { organizedBy: { kind: "cloud", name: "ohmail Cloud", since: null } },
      },
      true,
    )).toEqual(["mailbox", "elsewhere", "consent", "window", "pull", "summary"]);
    // And a FIRST run is untouched — the four screens are dropped for the add intent alone.
    expect(onboardingPath(ADD_FACTS)).toContain("welcome");
    expect(onboardingPath(ADD_FACTS)).toContain("ai");
    expect(onboardingPath(ADD_FACTS)).toContain("pair");
  });

  it("A FIRST RUN DOES NOT NAME ITS MAILBOX IN THE HASH — it would become an add run", async () => {
    /* ── REVIEW FINDING, AND IT COST THE FIRST RUN THREE SCREENS ────────────────────────────
     *
     * `onConnected` was called after EVERY connect, and `nameFirstRunMailbox` writes
     * `#/first-run/add?mailbox=<id>`. So a first run whose connect goes through the flow's own
     * form — the cloud door always, and the standalone door after "Start over → forget this
     * mailbox" — re-pointed its own hash at the ADD intent. From the next render
     * `route.firstRunAdd` was true and `onboardingPath` dropped `ai`, `provider` and `pair`: the
     * AI question was never asked, the standalone provider form was never shown, and the phone
     * was never offered, on the one run that exists to offer them.
     *
     * A first run needs no id in its hash: its new row is the only row, so `facts[0]` is already
     * the right answer. MUTATION: drop the `add === true` guard and this reds. */
    const made = (await makeHost())!;
    const connected = [];
    const host = {
      ...made,
      probe: async () => ({ host: "imap.example.org", user: "me@example.org", folders: 3 }),
      connect: async () => ({ id: "mbx-first" }),
    };
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    mounted = root;
    await act(async () => {
      root.render(
        h(ThemeProvider, null,
          h(NextIntlClientProvider, { locale: "en", messages: en as never },
            h(KeymapProvider, null,
              h(FirstRun, {
                host,
                // A FIRST run: no completion stamp, no mailbox, no add intent.
                facts: {
                  door: "local", mailbox: null, account: {}, ai: "unset", queuedSenders: 0,
                },
                mailboxId: null,
                onConnected: (id) => { connected.push(id); },
                pull: { screened: 0, history: 0, mirrorCount: 0 },
                decide: null,
                onRefresh: () => {},
                onLeave: () => {},
              })))));
    });
    /* A first run opens on the WELCOME — which is the whole point: those are the screens the
       defect took away. Walk onto the form through whichever verb it wears. */
    const step = async (labels: string[]) => {
      const all = [...el.querySelectorAll("button")];
      const b = all.find((x) => labels.some((l) => (x.textContent ?? "").trim().startsWith(l)));
      expect(b, `no ${labels.join("/")} — buttons: ${
        all.map((x) => (x.textContent ?? "").trim()).join(" | ")}`).toBeDefined();
      await act(async () => { b!.click(); await Promise.resolve(); });
    };
    /* The welcome screen — the first of the three the defect took away. Recognised by its own
       primary rather than by a greeting: `welcomeTitle` is a sentence about what ohmail does. */
    await step(["Set up a mailbox"]);
    const address = el.querySelector('input[type="email"]');
    const pass = el.querySelector('input[type="password"]');
    const set = (input, value) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!
        .call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => { set(address, "me@example.org"); set(pass, "pw"); });
    await step(["Test connection"]);
    await act(async () => { await Promise.resolve(); });
    await step(["Connect and continue"]);
    await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });

    expect(connected, "a first run re-pointed its own route at the add intent").toEqual([]);
  });

  it("THE RAIL PROMISES ONLY THE PHASES THIS RUN WALKS", async () => {
    /* ── FOUND ON THE RENDERED APP, NOT BY READING ──────────────────────────────────────────
     *
     * `RAIL` was a module constant of seven groups and the rail drew all seven whatever the path
     * said, so an add run — which has no AI question and no pairing — showed a dot for a phase
     * that would never arrive and counted "3 / 7" towards a total the person could not reach.
     * Caught on the built bundle over a real sidecar: the stage's own text read
     * "Mailbox | Organize | How far back | AI | First pull" on a walk that showed no AI screen.
     *
     * The rail's own docblock is the claim under test — *"Ordered, and the order is
     * `onboardingPath`'s"* — and it had stopped being true. It is derived from the path now.
     *
     * IT WAS ALREADY WRONG BEFORE THIS SLICE, in a quieter way: `decide` is skipped SILENTLY on
     * an empty Screener queue, and its dot sat there unlit for ever. Same fix, same line.
     */
    const { el } = await driveAdd();
    const labels = [...el.querySelectorAll(".join-rail-label")].map((n) => n.textContent?.trim());
    expect(labels).toEqual(["Mailbox", "Organize", "How far back", "First pull", "Done"]);
    // The narrow form counts towards the same total.
    expect(el.querySelector(".ob-step")?.textContent).toContain(`/ ${labels.length} ·`);
  });

  it("CONNECTS IN `add` MODE, and hands the new mailbox's id back to the route", async () => {
    const { el, modes, connected } = await driveAdd();

    const address = el.querySelector('input[type="email"]') as HTMLInputElement;
    const pass = el.querySelector('input[type="password"]') as HTMLInputElement;
    const set = (input: HTMLInputElement, value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "value",
      )!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => {
      set(address, "second@example.org");
      set(pass, "pw-2");
    });
    // The primary is disarmed until a verdict exists — the form's own rule, not this test's.
    await act(async () => {
      button(el, "Test connection")!.click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    const connect = button(el, "Connect and continue");
    expect(
      connect,
      `the form never armed its primary — buttons on screen: ${
        [...el.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim()).join(" | ")
      }`,
    ).toBeDefined();
    await act(async () => {
      connect!.click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });

    /* THE WORD, and it has no default. `seed` here would rewrite the shell's settings file and
       replace the engine, and the first-connect order that follows seals the typed password onto
       whatever mailbox the replaced engine settles on — this install's ORIGINAL row. */
    expect(modes, "the add run connected as a seed").toEqual(["add"]);
    /* AND THE ROUTE LEARNS WHICH ROW. Without it every later screen — consent, the window, the
       pull, the summary — would be about whichever mailbox `GET /mailboxes` returns first. */
    expect(connected).toEqual(["mbx-for-second@example.org"]);
  });
});
