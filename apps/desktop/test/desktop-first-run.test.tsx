/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

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

function installShell(): void {
  shellHost.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
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
    expect(call).toMatchObject({ method: "POST", url: "/mailboxes/probe" });
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
