/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NO_DETAILS } from "@ohmail/app-logic/mailboxes/connect/refusal";
import { secretOf } from "@ohmail/app-logic/mailboxes/connect/secret";
import type { ConnectInput, ConnectPatch, MailboxId } from "@ohmail/app-logic/mailboxes/connect/types";
import { NONE } from "@ohmail/app/host";

/**
 * THE WEB'S CONNECT WIRE over the server client. It never rejects; a server's error becomes a refusal field by field;
 * each call reaches the route and sends the body the shipped forms sent; a password is opened only where the body is
 * written, and is in nothing else the wire hands on.
 */
const MARKER = "zq-MARKER-pass-7Kd";
type Sent = { route: string; body: unknown; id?: string };
let mockSent: Sent[] = [];
let mockThrow: unknown = null;
let mockAnswer: unknown = null;
let mockAvailability: unknown = { available: true, device: true };

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  const call = (route: string) => async (...args: unknown[]) => {
    mockSent.push(route === "update" ? { route, id: args[0] as string, body: args[1] } : { route, body: args[0] });
    if (mockThrow !== null) throw mockThrow;
    return mockAnswer;
  };
  return {
    ...actual,
    apiConfigured: () => true,
    mailboxes: {
      ...actual.mailboxes,
      probe: call("probe"),
      create: call("create"),
      update: call("update"),
      discover: call("discover"),
      oauthAvailability: async () => {
        if (mockThrow !== null) throw mockThrow;
        return mockAvailability;
      },
    },
  };
});

const PASS = secretOf(MARKER);
const INPUT: ConnectInput = {
  provider: "imap",
  address: "me@lichtgrat.example",
  imap: { host: "mail.lichtgrat.example", port: 1143, user: "me@lichtgrat.example", pass: PASS, allowInsecure: true },
  smtp: { host: "smtp.lichtgrat.example", user: "me@lichtgrat.example", pass: PASS },
};
const PATCH: ConnectPatch = { imap: { pass: PASS, host: "new.example" }, smtp: { pass: PASS, port: 2525 } };
const ID = "0d3a8f1e-52c4-4c0e-9a7b-1f2e3d4c5b6a" as MailboxId;

async function wire() {
  const { ApiError } = await import("../app/api-client");
  const { webConnectWire } = await import("../app/(product)/mailbox/connect-wire");
  const made = webConnectWire({ owner: () => "acct-1", returned: "page", leave: () => undefined });
  if (made.edit === NONE || made.discover === NONE || made.signIn === NONE) throw new Error("the web's wire has all three");
  return { ApiError, wire: made, edit: made.edit, discover: made.discover, signIn: made.signIn };
}

beforeEach(() => {
  mockSent = [];
  mockThrow = null;
  mockAnswer = null;
  mockAvailability = { available: true, device: true };
});

describe("each call reaches its route with the body the shipped forms sent", () => {
  it("a connect posts the mailbox as typed, the password opened in both servers, and answers the server's own id", async () => {
    mockAnswer = { id: ID, address: "me@lichtgrat.example", provider: "imap" };
    const { wire: w } = await wire();
    expect(await w.connect(INPUT, "seed")).toEqual({ ok: true, value: { mailboxId: ID, address: "me@lichtgrat.example" } });
    expect(mockSent).toEqual([{
      route: "create",
      body: {
        provider: "imap", address: "me@lichtgrat.example",
        imap: { host: "mail.lichtgrat.example", port: 1143, user: "me@lichtgrat.example", pass: MARKER, allowInsecure: true },
        smtp: { host: "smtp.lichtgrat.example", user: "me@lichtgrat.example", pass: MARKER },
      },
    }]);
    expect(JSON.stringify(mockSent[0]!.body)).toBe(
      '{"provider":"imap","address":"me@lichtgrat.example",'
      + `"imap":{"host":"mail.lichtgrat.example","port":1143,"user":"me@lichtgrat.example","pass":"${MARKER}","allowInsecure":true},`
      + `"smtp":{"host":"smtp.lichtgrat.example","user":"me@lichtgrat.example","pass":"${MARKER}"}}`,
    );
  });

  it("both modes are the one route here: the mode is taken and changes nothing of the body", async () => {
    mockAnswer = { id: ID, address: "me@lichtgrat.example" };
    const { wire: w } = await wire();
    await w.connect(INPUT, "seed");
    await w.connect(INPUT, "add");
    expect(mockSent[0]).toEqual(mockSent[1]);
  });

  it("a test posts what the connect dials, the outgoing server without its password, and no provider", async () => {
    mockAnswer = { ok: true, host: "mail.lichtgrat.example", user: "me@lichtgrat.example", folders: 9, sending: { state: "ok", host: "smtp.lichtgrat.example" } };
    const { wire: w } = await wire();
    expect(await w.probe(INPUT)).toEqual({
      ok: true,
      value: { host: "mail.lichtgrat.example", user: "me@lichtgrat.example", folders: 9, sending: { state: "ok", host: "smtp.lichtgrat.example" } },
    });
    expect(mockSent).toEqual([{
      route: "probe",
      body: {
        address: "me@lichtgrat.example",
        imap: { host: "mail.lichtgrat.example", port: 1143, user: "me@lichtgrat.example", pass: MARKER, allowInsecure: true },
        smtp: { host: "smtp.lichtgrat.example", user: "me@lichtgrat.example" },
      },
    }]);
  });

  it("an edit patches the mailbox that was asked, and answers nothing that names another", async () => {
    mockAnswer = { id: "another-mailbox", address: "other@example.org" };
    const { edit } = await wire();
    expect(await edit(ID, PATCH)).toEqual({ ok: true, value: null });
    expect(mockSent).toEqual([{ route: "update", id: ID, body: { imap: { pass: MARKER, host: "new.example" }, smtp: { pass: MARKER, port: 2525 } } }]);
  });

  it("an edit of the password alone sends no outgoing block", async () => {
    mockAnswer = {};
    const { edit } = await wire();
    await edit(ID, { imap: { pass: PASS } });
    expect(mockSent[0]!.body).toEqual({ imap: { pass: MARKER } });
  });

  it("the lookup is asked about the domain alone", async () => {
    mockAnswer = { preset: null };
    const { discover } = await wire();
    await discover("lichtgrat.example", new AbortController().signal);
    expect(mockSent).toEqual([{ route: "discover", body: { domain: "lichtgrat.example" } }]);
  });
});

describe("it never rejects, and a refusal is read field by field", () => {
  it("a server's refusal is the status, the code, the server's sentence and the typed fields, and nothing else of the answer", async () => {
    const { ApiError, wire: w, edit } = await wire();
    mockThrow = new ApiError(422, "mailbox_probe_failed", "That mail server refused the password.", {
      reason: "auth", transport: "imap", authHint: "invalid", echoed: { imap: { pass: MARKER } }, pass: MARKER,
    });
    const expected = {
      ok: false,
      refusal: {
        status: 422, code: "mailbox_probe_failed", message: "That mail server refused the password.",
        details: { ...NO_DETAILS, reason: "auth", transport: "imap", authHint: "invalid" },
      },
    };
    for (const answer of [await w.connect(INPUT, "add"), await w.probe(INPUT), await edit(ID, PATCH)]) {
      expect(answer).toEqual(expected);
      expect(JSON.stringify(answer)).not.toContain("MARKER");
    }
  });

  it("a sentence that repeats the password is not taken, asked whole before it is cut: an echo across the 600th character, and a long password echoed", async () => {
    const { ApiError, wire: w, edit } = await wire();
    const long = `Qz${"k9".repeat(5000)}`;
    const sealed = secretOf(long);
    const LONG: ConnectInput = { ...INPUT, imap: { ...INPUT.imap, pass: sealed }, smtp: { ...INPUT.smtp!, pass: sealed } };
    const readings: boolean[] = [];
    mockThrow = new ApiError(409, "a_code_nobody_words", `${"a".repeat(590)} ${MARKER} was refused`, {});
    for (const answer of [await w.connect(INPUT, "add"), await w.probe(INPUT), await edit(ID, PATCH)])
      readings.push(JSON.stringify(answer).includes(MARKER.slice(0, 8)));
    mockThrow = new ApiError(409, "a_code_nobody_words", `The login with ${long} was refused.`, {});
    for (const answer of [await w.connect(LONG, "add"), await w.probe(LONG), await edit(ID, { imap: { pass: sealed } })])
      readings.push(JSON.stringify(answer).includes(long.slice(0, 64)));
    // Each reading: is a part of the password in what the form is answered? Never.
    expect(readings).toEqual([false, false, false, false, false, false]);
  });

  it("anything else a call can throw is no answer: its text is never taken", async () => {
    const { wire: w, edit, discover } = await wire();
    for (const fault of [new TypeError(`fetch failed for ${MARKER}`), `a string with ${MARKER}`, null, { message: MARKER }]) {
      mockThrow = fault ?? undefined;
      if (fault === null) mockThrow = { toString: () => MARKER };
      const answers = [await w.connect(INPUT, "seed"), await w.probe(INPUT), await edit(ID, PATCH)];
      for (const answer of answers) expect(answer).toEqual({ ok: false, refusal: { status: 0, code: null, message: "", details: NO_DETAILS } });
      await expect(discover("lichtgrat.example", new AbortController().signal)).resolves.toBeNull();
    }
  });

  it("this client's own refusal keeps its own sentence: offline, or a browser that holds another account now", async () => {
    const { ApiError, wire: w } = await wire();
    mockThrow = new ApiError(0, "owner_mismatch", "This window is signed in to a different account than this browser now holds.");
    expect(await w.connect(INPUT, "seed")).toEqual({
      ok: false,
      refusal: { status: 0, code: "owner_mismatch", message: "This window is signed in to a different account than this browser now holds.", details: NO_DETAILS },
    });
  });

  it("another tab holding the session's lock is this client's own refusal, in the reader's words as every surface says it", async () => {
    const { setActiveCatalog } = await import("../app/shell/locale");
    const { SessionBusyError } = await import("../app/session-refresh");
    const de = (await import("../messages/de.json")).default;
    const { wire: w } = await wire();
    mockThrow = new SessionBusyError();
    setActiveCatalog("de", de as never);
    try {
      expect(await w.connect(INPUT, "seed")).toEqual({
        ok: false,
        refusal: { status: 0, code: "session_busy", message: de.session.sessionBusy, details: NO_DETAILS },
      });
    } finally {
      setActiveCatalog("en", null);
    }
  });

  it("an answer that names no usable id is no answer", async () => {
    const { wire: w } = await wire();
    for (const id of ["../other", "", 7, undefined]) {
      mockAnswer = { id, address: "me@lichtgrat.example" };
      expect((await w.connect(INPUT, "seed")).ok).toBe(false);
    }
  });
});

describe("a mailbox id never reaches a path unless it is one", () => {
  it.each(["../mailboxes", "a/b", "a?erase=1", "a#b", "%2e%2e", "", "a b"])("refuses %s before any request", async (word) => {
    mockAnswer = {};
    const { edit } = await wire();
    expect((await edit(word as MailboxId, PATCH)).ok).toBe(false);
    expect(mockSent).toEqual([]);
  });
});

describe("which sign-in this server runs", () => {
  it("is what the server said, and only an explicit yes opens a door", async () => {
    const { signIn } = await wire();
    expect(await signIn.ways()).toEqual({ microsoft: { redirect: true, device: true } });
    mockAvailability = { available: "yes", device: 1 };
    expect(await signIn.ways()).toEqual({ microsoft: { redirect: false, device: false } });
    mockAvailability = { available: true };
    expect(await signIn.ways()).toEqual({ microsoft: { redirect: true, device: false } });
  });

  it("unread or unreadable is shut", async () => {
    const { signIn } = await wire();
    mockThrow = new TypeError("no network");
    expect(await signIn.ways()).toEqual({ microsoft: { redirect: false, device: false } });
  });

  it("runs no sign-in by code from this wire yet: the Mailboxes pane holds that ceremony until it is replaced", async () => {
    const { signIn } = await wire();
    expect(signIn.code).toBe(NONE);
  });
});

describe("a page with a ceremony of its own hears what a connect answered, and the form is answered as ever", () => {
  async function heard() {
    const { ApiError } = await import("../app/api-client");
    const { webConnectWire } = await import("../app/(product)/mailbox/connect-wire");
    const told: unknown[] = [];
    const made = webConnectWire({
      owner: () => "acct-1",
      returned: "page",
      leave: () => undefined,
      heard: {
        connected: (row) => void told.push(["connected", row]),
        refused: (thrown, press) => void told.push(["refused", thrown, press]),
      },
    });
    return { ApiError, wire: made, told };
  }

  it("is handed the created row as the server gave it; the form gets the id and the address", async () => {
    mockAnswer = { id: ID, address: "me@lichtgrat.example", provider: "imap", organizeConsentedAt: null };
    const { wire: w, told } = await heard();
    expect(await w.connect(INPUT, "seed")).toEqual({ ok: true, value: { mailboxId: ID, address: "me@lichtgrat.example" } });
    expect(told).toEqual([["connected", mockAnswer]]);
  });

  it("is handed what a refused connect threw, and whether this same press was sent before", async () => {
    const { ApiError, wire: w, told } = await heard();
    mockThrow = new ApiError(403, "step_up_required", "recent 2FA re-assertion required");
    expect((await w.connect(INPUT, "seed")).ok).toBe(false);
    expect((await w.connect(INPUT, "seed")).ok).toBe(false);
    // Another press is another value, though it holds the same words.
    expect((await w.connect({ ...INPUT }, "seed")).ok).toBe(false);
    expect(told).toEqual([
      ["refused", mockThrow, { resent: false }],
      ["refused", mockThrow, { resent: true }],
      ["refused", mockThrow, { resent: false }],
    ]);
  });

  it("is told of no row whose id is none", async () => {
    mockAnswer = { id: "../sessions", address: "me@lichtgrat.example" };
    const { wire: w, told } = await heard();
    expect((await w.connect(INPUT, "seed")).ok).toBe(false);
    expect(told).toEqual([]);
  });

  it("nothing of the request reaches it: a fault that holds the body is handed as nothing, an answer that repeats the password as its status and code alone", async () => {
    const { ApiError, wire: w, told } = await heard();
    mockThrow = Object.assign(new Error(`the transport's own fault, holding ${MARKER}`), { body: INPUT });
    await w.connect(INPUT, "seed");
    expect(told).toEqual([["refused", null, { resent: false }]]);
    told.length = 0;
    mockThrow = new ApiError(402, "payment_required", `No plan for the mailbox whose password is ${MARKER}.`, { echoed: MARKER });
    await w.connect({ ...INPUT }, "seed");
    const [, handed] = told[0] as [string, InstanceType<typeof ApiError>, unknown];
    expect([handed.status, handed.code, handed.message, handed.details]).toEqual([402, "payment_required", "", undefined]);
    expect(JSON.stringify(told)).not.toContain(MARKER);
    expect(told.map((t) => String((t as unknown[])[1]))).toEqual([expect.not.stringContaining(MARKER)]);
  });

  it("an answer whose details alone repeat the password is handed as its status and code alone, whatever the password holds: a quote, a backslash, a line break", async () => {
    const { ApiError, wire: w, told } = await heard();
    const odd = 'zq-"MARKER"\\pass\n7Kd';
    mockThrow = new ApiError(402, "payment_required", "No plan for this mailbox.", { echoed: { deep: [7, odd] } });
    await w.connect({ ...INPUT, imap: { ...INPUT.imap, pass: secretOf(odd) } }, "seed");
    const [, handed] = told[0] as [string, InstanceType<typeof ApiError>, unknown];
    expect([handed.status, handed.code, handed.message, handed.details]).toEqual([402, "payment_required", "", undefined]);
    // An answer that repeats nothing is handed as it was read.
    told.length = 0;
    mockThrow = new ApiError(402, "payment_required", "No plan for this mailbox.", { reason: "payment_required" });
    await w.connect({ ...INPUT, imap: { ...INPUT.imap, pass: secretOf(odd) } }, "seed");
    expect(told).toEqual([["refused", mockThrow, { resent: false }]]);
  });

  it("a listener's own fault is never the connect's answer", async () => {
    const { webConnectWire } = await import("../app/(product)/mailbox/connect-wire");
    const faulty = webConnectWire({
      owner: () => "acct-1",
      returned: "page",
      leave: () => undefined,
      heard: {
        connected: () => {
          throw new Error("a listener's fault");
        },
        refused: () => {
          throw new Error("a listener's fault");
        },
      },
    });
    mockAnswer = { id: ID, address: "me@lichtgrat.example" };
    expect(await faulty.connect(INPUT, "seed")).toEqual({ ok: true, value: { mailboxId: ID, address: "me@lichtgrat.example" } });
    const { ApiError } = await import("../app/api-client");
    mockThrow = new ApiError(422, "mailbox_probe_failed", "The server's own sentence.", { reason: "auth", transport: "imap" });
    const answer = await faulty.connect(INPUT, "seed");
    expect(answer.ok).toBe(false);
    expect(!answer.ok && answer.refusal.code).toBe("mailbox_probe_failed");
  });
});

