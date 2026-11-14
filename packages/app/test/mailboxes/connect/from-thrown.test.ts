import { describe, expect, it, vi } from "vitest";
import type { FirstRunMailboxInput } from "@ohmail/app-logic/doors/first-run-host";
import { gateOf, probeReasonOf } from "@ohmail/app-logic/mailboxes/connect/refusal";
import { secretOf } from "@ohmail/app-logic/mailboxes/connect/secret";
import type { ConnectInput } from "@ohmail/app-logic/mailboxes/connect/types";
import { NONE } from "../../../src/host/index.js";
import { connectWireOver, type ThrowingFirstRun } from "../../../src/mailboxes/connect/from-thrown.js";

/**
 * THE CONNECT FORM'S WIRE OVER THROWING FIRST-RUN VERBS (the desktop's local door). It never rejects; a refusal keeps
 * what the engine said field by field; the password reaches the old verb only in its `pass` fields; the mode is the
 * caller's; an id is the answer's own and a path-breaking one is none.
 */
const MARKER = ["m4rk", "er-", "PASS"].join("");
const input = (over: Partial<ConnectInput> = {}): ConnectInput => ({
  address: "me@lichtgrat.example",
  provider: "other",
  imap: { host: "mail.lichtgrat.example", port: 993, pass: secretOf(MARKER) },
  smtp: { host: "mail.lichtgrat.example", pass: secretOf(MARKER) },
  ...over,
});
/** What the local engine throws when it refuses: an error with its sentence, its code and its details, no status. */
const engineRefusal = (code: string | null, details: unknown, said = "the engine's own sentence") =>
  Object.assign(new Error(said), { name: "EngineError", code, details });
const door = (over: Partial<ThrowingFirstRun> = {}): ThrowingFirstRun => ({
  probe: vi.fn(async () => ({ host: "mail.lichtgrat.example", user: "me@lichtgrat.example", folders: 4 })),
  connect: vi.fn(async () => ({ id: "mbx_1" })),
  ...over,
});

describe("connectWireOver", () => {
  it("never rejects: a fault on the way is no answer, and its own text is never taken", async () => {
    const wire = connectWireOver(
      door({
        probe: async () => {
          throw new TypeError("socket hang up near the password");
        },
        connect: async () => {
          throw "a string thrown";
        },
      }),
    );
    const probed = await wire.probe(input());
    const made = await wire.connect(input(), "seed");
    expect(probed).toEqual({
      ok: false,
      refusal: expect.objectContaining({ status: 0, code: null, message: "" }),
    });
    expect(made).toEqual({
      ok: false,
      refusal: expect.objectContaining({ status: 0, code: null, message: "" }),
    });
  });

  it("an engine's refusal keeps its code, its sentence and its typed details, and is the press's own", async () => {
    const thrown = engineRefusal("mailbox_probe_failed", {
      reason: "auth",
      transport: "imap",
      localServer: true,
      whole: { echo: MARKER },
    });
    const wire = connectWireOver(
      door({
        probe: async () => {
          throw thrown;
        },
      }),
    );
    const answer = await wire.probe(input());
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.refusal.code).toBe("mailbox_probe_failed");
    expect(answer.refusal.message).toBe("the engine's own sentence");
    expect(probeReasonOf(answer.refusal)).toBe("auth");
    expect(answer.refusal.details.localServer).toBe(true);
    expect(answer.refusal.details.transport).toBe("imap");
    expect(gateOf(answer.refusal)).toBe("other");
    expect(JSON.stringify(answer)).not.toContain(MARKER);
  });

  it("a sentence that repeats the password is not taken, asked whole before it is cut: an echo across the 600th character", async () => {
    const refuses = async (): Promise<never> => {
      throw engineRefusal("a_code_nobody_words", {}, `${"a".repeat(590)} ${MARKER} was refused`);
    };
    const wire = connectWireOver(door({ probe: refuses, connect: refuses }));
    const answers = [await wire.probe(input()), await wire.connect(input(), "seed")];
    // Each reading: is a part of the password in what the form is answered? Never.
    expect(answers.map((answer) => JSON.stringify(answer).includes(MARKER.slice(0, 8)))).toEqual([
      false,
      false,
    ]);
    expect(answers.map((answer) => answer.ok)).toEqual([false, false]);
  });

  it("an answer with a status is read as the server's: the second factor's refusal asks the factor", async () => {
    const wire = connectWireOver(
      door({
        connect: async () => {
          throw { status: 403, code: "step_up_required", message: "Confirm it is you.", details: {} };
        },
      }),
    );
    const answer = await wire.connect(input(), "add");
    expect(answer.ok || gateOf(answer.refusal)).toBe("factor");
  });

  it("the password reaches the old verb in its pass fields alone, and each server carries only what the form put", async () => {
    const probe = vi.fn(async (_: FirstRunMailboxInput) => ({ host: "h", user: "u", folders: null }));
    const wire = connectWireOver(door({ probe }));
    await wire.probe(
      input({
        imap: { host: "mail.lichtgrat.example", allowInsecure: true, pass: secretOf(MARKER) },
        smtp: { host: "smtp.lichtgrat.example", port: 587 },
      }),
    );
    const sent = probe.mock.calls[0]![0];
    expect(sent).toEqual({
      address: "me@lichtgrat.example",
      provider: "other",
      imap: { host: "mail.lichtgrat.example", allowInsecure: true, pass: MARKER },
      smtp: { host: "smtp.lichtgrat.example", port: 587 },
    });
    const { imap, ...rest } = sent;
    const { pass, ...server } = imap;
    expect(pass).toBe(MARKER);
    expect(JSON.stringify({ rest, server })).not.toContain(MARKER);
  });

  it("the mode is the caller's, as stated, both ways", async () => {
    const connect = vi.fn(async () => ({ id: "mbx_2" }));
    const wire = connectWireOver(door({ connect }));
    await wire.connect(input(), "add");
    await wire.connect(input(), "seed");
    expect(connect.mock.calls.map((c) => (c as unknown[])[1])).toEqual(["add", "seed"]);
  });

  it("the id is the answer's own; an id a path would change, or none, is no connect", async () => {
    const answers = ["mbx_7", "../mbx_7", "mbx/7", "", null, 7];
    const got = [];
    for (const id of answers) {
      const wire = connectWireOver(door({ connect: async () => ({ id }) as { id: string } }));
      got.push(await wire.connect(input(), "seed"));
    }
    expect(got[0]).toEqual({ ok: true, value: { mailboxId: "mbx_7", address: null } });
    for (const refused of got.slice(1))
      expect(refused).toEqual({ ok: false, refusal: expect.objectContaining({ status: 0 }) });
  });

  it("a test's answer carries the proven rung's fields and no other", async () => {
    const wire = connectWireOver(
      door({
        probe: async () =>
          ({
            host: "imap.lichtgrat.example",
            user: "me",
            folders: 3,
            sending: { state: "not_configured" },
            extra: 1,
          }) as never,
      }),
    );
    expect(await wire.probe(input())).toEqual({
      ok: true,
      value: { host: "imap.lichtgrat.example", user: "me", folders: 3, sending: { state: "not_configured" } },
    });
  });

  it("the lookup sends the domain alone and fails as no guess; with no lookup there is none", async () => {
    const discover = vi.fn(async (_: { domain: string }) => {
      throw new Error("down");
    });
    const wire = connectWireOver(door({ discover, localServerWait: true }));
    expect(wire.discover).not.toBe(NONE);
    if (wire.discover === NONE) return;
    await expect(wire.discover("lichtgrat.example", new AbortController().signal)).resolves.toBeNull();
    expect(discover.mock.calls[0]![0]).toEqual({ domain: "lichtgrat.example" });
    expect(wire.localServerWait).toBe(true);
    const plain = connectWireOver(door());
    expect(plain.discover).toBe(NONE);
    expect(plain.localServerWait).toBe(false);
  });

  it("offers no edit and no provider's sign-in: the first run's verbs have neither", () => {
    const wire = connectWireOver(door());
    expect(wire.edit).toBe(NONE);
    expect(wire.signIn).toBe(NONE);
  });
});
