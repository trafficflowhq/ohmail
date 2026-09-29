/** @vitest-environment jsdom */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { LocalWireError, localPlaintextOffer, useLocalFirstRun } from "../src/local-first-run.js";
import { NO_CONSENT, enterLocalDoor, type LocalDoorFields } from "../src/doors.js";
import type { FirstRunHost } from "../../webapp/app/shell/first-run-host";

/**
 * THE FIRST DOOR'S CONSENT AND ITS REFUSAL, AT THE SEAM. The first-run "On this computer" door
 * offered no consent line (the classifier excluded the seed), dropped the refusal's code and
 * details, and sealed with no consent, so a server with no encryption could not be connected from
 * it at all. Each case drives `enterLocalDoor` through a stand-in shell that answers what the real
 * engine answered (the envelope the engine probe recorded) and reads what the door SENT. No body
 * is printed: every one carries the fixture password.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const REFUSED = {
  error: {
    code: "mailbox_probe_failed",
    message: "That incoming (IMAP) mail server offers no encryption — no TLS and no STARTTLS — so we stopped before sending the password.",
    details: { reason: "tls", transport: "imap", tls: { kind: "tls_unavailable", plaintext: "offered" } },
  },
};

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

interface Seen { configures: Record<string, unknown>[]; seals: Array<{ imap: Record<string, unknown>; smtp?: Record<string, unknown> }> }

/** A shell whose engine serves `mbx-1` for the typed address and answers the seal with `seal`. */
function shell(seal: { status: number; body: unknown }): Seen {
  const seen: Seen = { configures: [], seals: [] };
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      if (command === "engine_configure") {
        seen.configures.push(payload!.config as Record<string, unknown>);
        return { state: "starting", mode: null };
      }
      if (command === "engine_status") {
        return { state: "serving", mode: null, address: "mila@home.arpa", mailboxId: "mbx-1", credentialState: "absent" };
      }
      if (command === "engine_request") {
        const method = String((payload as { method?: unknown }).method ?? "GET");
        if (method === "GET") return encode(200, JSON.stringify({ id: "mbx-1", address: "mila@home.arpa" }));
        const body = JSON.parse(new TextDecoder().decode(Uint8Array.from((payload as { body: number[] }).body)));
        seen.seals.push(body);
        return encode(seal.status, JSON.stringify(seal.body), seal.status === 200 ? "OK" : "Bad Request");
      }
      return null;
    },
  };
  return seen;
}

const FIELDS: LocalDoorFields = {
  providerId: "other", address: "mila@home.arpa", user: "", imapHost: "mail.home.arpa", imapPort: "143",
  smtpHost: "mail.home.arpa", smtpPort: "25", password: "door-fixture",
};
const PRESET = { imap: { host: "mail.home.arpa", port: 143 }, smtp: { host: "mail.home.arpa", port: 25 } };

afterEach(() => { delete host.__TAURI_INTERNALS__; });

describe("the first door's classifier", () => {
  it("offers the incoming line for a seed's refusal, read structurally from any carrier", () => {
    const wire = new LocalWireError(REFUSED.error.message, REFUSED.error.code, REFUSED.error.details);
    expect(localPlaintextOffer(wire)).toBe("imap");
    expect(localPlaintextOffer({ code: REFUSED.error.code, details: REFUSED.error.details })).toBe("imap");
    // The door's name decides nothing: the Settings pane's call still passes one.
    expect(localPlaintextOffer(wire, "seed")).toBe("imap");
    expect(localPlaintextOffer({ code: "mailbox_probe_failed", details: { ...REFUSED.error.details, transport: "smtp" } }))
      .toBe("smtp");
  });

  it("offers nothing where the engine offered nothing", () => {
    const d = REFUSED.error.details;
    expect(localPlaintextOffer({ code: "mailbox_probe_failed", details: { ...d, tls: { kind: "tls_unavailable", plaintext: "not_private" } } })).toBeNull();
    expect(localPlaintextOffer({ code: "mailbox_probe_failed", details: { ...d, tls: { kind: "self_signed" } } })).toBeNull();
    expect(localPlaintextOffer({ code: "same_login", details: d })).toBeNull();
    expect(localPlaintextOffer(null)).toBeNull();
    expect(localPlaintextOffer(new Error("offline"))).toBeNull();
  });
});

describe("the first door's seal and configure", () => {
  it("hands the refusal back with its code and details, beside the sentence", async () => {
    shell({ status: 400, body: REFUSED });
    const result = await enterLocalDoor(FIELDS, PRESET, null);
    expect(result.problem).toBe(REFUSED.error.message);
    expect(result.engineRefusal).toEqual({ code: REFUSED.error.code, details: REFUSED.error.details });
    expect(localPlaintextOffer(result.engineRefusal)).toBe("imap");
  });

  it("carries the consent only on the lines that were ticked, and none by default", async () => {
    const quiet = shell({ status: 400, body: REFUSED });
    await enterLocalDoor(FIELDS, PRESET, null);
    const ticked = shell({ status: 400, body: REFUSED });
    await enterLocalDoor(FIELDS, PRESET, null, { imap: true, smtp: false });
    const flags = (s: Seen) => ({
      imap: s.seals[0]?.imap.allowInsecure === true, smtp: s.seals[0]?.smtp?.allowInsecure === true,
    });
    expect(flags(quiet)).toEqual(NO_CONSENT);
    expect(flags(ticked)).toEqual({ imap: true, smtp: false });
  });

  it("configures pending on an install with no door, and the relaunch after the seal commits it", async () => {
    const seen = shell({ status: 200, body: { id: "mbx-1", address: "mila@home.arpa" } });
    const result = await enterLocalDoor(FIELDS, PRESET, { state: "not_configured", mode: null } as never);
    expect(result.problem).toBeNull();
    expect(seen.configures.map((c) => c.pending ?? null)).toEqual([true, null]);
  });

  it("writes as before over a door that exists (a switch is not a first door)", async () => {
    const seen = shell({ status: 200, body: { id: "mbx-1", address: "mila@home.arpa" } });
    const standing = { state: "serving", mode: "cloud", mailboxId: "c-1", address: "someone@ohmail.app" };
    await enterLocalDoor(FIELDS, PRESET, standing as never);
    expect(seen.configures.map((c) => c.pending ?? null)).toEqual([null, null]);
  });
});

describe("the stage's seed connect", () => {
  let root: Root | null = null;
  afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; });

  it("carries its ticked lines and throws the refusal with the code the stage reads", async () => {
    const seen = shell({ status: 400, body: REFUSED });
    let made: FirstRunHost | undefined;
    const Capture = () => {
      made = useLocalFirstRun({ status: { state: "serving", mode: "local" } as never, ai: null, providerForm: null });
      return null;
    };
    root = createRoot(document.createElement("div"));
    await act(async () => { root!.render(React.createElement(Capture)); });
    const thrown = await made!.connect({
      address: "mila@home.arpa", provider: "other",
      imap: { host: "mail.home.arpa", port: 143, secure: false, pass: "door-fixture", allowInsecure: true },
      smtp: { host: "mail.home.arpa", port: 25, secure: false, pass: "door-fixture" },
    }, "seed").then(() => null, (err: unknown) => err);
    expect(thrown).toBeInstanceOf(LocalWireError);
    expect((thrown as LocalWireError).code).toBe("mailbox_probe_failed");
    expect(made!.plaintextOffer?.(thrown)).toBe("imap");
    expect(seen.seals[0]?.imap.allowInsecure === true, "the stage's tick did not reach the seal").toBe(true);
    expect(seen.seals[0]?.smtp?.allowInsecure === true, "an unticked line carried a consent").toBe(false);
  });
});
