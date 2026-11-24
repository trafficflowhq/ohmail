import { describe, expect, it } from "vitest";
import { linesOf } from "../../../src/mailboxes/connect/consents.js";
import {
  connectStep,
  initialState,
  type ConnectEvent,
  type ConnectFacts,
  type ConnectState,
  type Parked,
  type Stepped,
} from "../../../src/mailboxes/connect/model.js";
import { NO_DETAILS } from "../../../src/mailboxes/connect/refusal.js";
import { secretOf } from "../../../src/mailboxes/connect/secret.js";
import { WAYS_SHUT } from "../../../src/mailboxes/connect/sign-in.js";
import { mailboxIdOfAnswer } from "../../../src/mailboxes/connect/subject.js";
import type { Answered, Refusal, RefusalDetails } from "../../../src/mailboxes/connect/types.js";

const ID = mailboxIdOfAnswer("mbx-1")!;
const OTHER = mailboxIdOfAnswer("mbx-2")!;
const ADD: ConnectFacts = { purpose: "add", subject: null, factor: true, ways: WAYS_SHUT, code: false };
const EDIT: ConnectFacts = {
  ...ADD,
  purpose: "edit",
  subject: { id: ID, address: "a@example.org", provider: "imap", signsIn: "password" },
};
const A = "mail-a.home.arpa";
const B = "mail-b.home.arpa";
const PASS = secretOf("zq-MARKER-pass");

const act = (verb: Parked["verb"], sent = { imap: A, smtp: B as string | null }): Parked =>
  Object.freeze({
    verb,
    subject: verb === "edit" ? ID : null,
    mode: verb === "connect" ? "add" : null,
    sent,
    body: Object.freeze({
      address: "a@example.org",
      provider: "imap",
      imap: Object.freeze({ host: A, pass: PASS }),
    }),
  }) as Parked;
const refusal = (code: string | null, details: Partial<RefusalDetails> = {}, status = 422): Refusal => ({
  status,
  code,
  message: "The server's own sentence.",
  details: { ...NO_DETAILS, ...details },
});
const no = (r: Refusal): Answered<never> => ({ ok: false, refusal: r });
const WINDOW_CLOSED = no(refusal("step_up_required", {}, 403));
const noTls = (transport: "imap" | "smtp", plaintext: "offered" | "not_private"): Answered<never> =>
  no(
    refusal("mailbox_probe_failed", {
      reason: "tls",
      transport,
      tls: {
        kind: "tls_unavailable",
        plaintext,
        certHost: null,
        expectedHost: null,
        suggestedHost: null,
        trustVariable: null,
        certificate: null,
      },
    }),
  );
const NO_TLS = noTls("imap", "offered");

/** Walks the form: each event in turn, keeping what it said to send, what it ended with, and each "forget the password". */
function walk(
  facts: ConnectFacts,
  events: readonly (ConnectEvent | ((s: ConnectState) => ConnectEvent))[],
  from?: ConnectState,
) {
  let state = from ?? initialState(null, facts);
  const sends: NonNullable<Stepped["send"]>[] = [];
  const done: NonNullable<Stepped["done"]>[] = [];
  let forgets = 0;
  for (const next of events) {
    const stepped = connectStep(state, typeof next === "function" ? next(state) : next, facts);
    state = stepped.state;
    if (stepped.send !== null) sends.push(stepped.send);
    if (stepped.done !== null) done.push(stepped.done);
    if (stepped.forget) forgets += 1;
  }
  return { state, sends, done, forgets };
}
const press = (a: Parked): ConnectEvent => ({ kind: "press", act: a });
const answered =
  (answer: Answered<unknown>) =>
  (s: ConnectState): ConnectEvent => ({ kind: "answered", seq: s.seq, answer });
const type = (
  field: "address" | "user" | "imapHost" | "smtpHost" | "imapPort" | "smtpPort",
  value: string,
): ConnectEvent => ({ kind: "typed", field, value });
const factor = (answer: "verified" | "cancelled" | "discarded"): ConnectEvent => ({ kind: "factor", answer });
const keyOf = (state: ConnectState): string | null =>
  state.shown === null
    ? null
    : "server" in state.shown.said
      ? "server"
      : `${state.shown.said.ns}.${state.shown.said.key}`;

describe("a press, tried first", () => {
  it("is sent once as it was built, and a connect the server takes ends the form with the wire's own id", () => {
    const connect = act("connect");
    const { state, sends, done, forgets } = walk(ADD, [
      type("address", "a@example.org"),
      press(connect),
      answered({ ok: true, value: { mailboxId: OTHER, address: "a@example.org" } }),
    ]);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.act).toBe(connect);
    expect(sends[0]!.afterFactor).toBe(false);
    expect(done).toEqual([{ kind: "connected", mailboxId: OTHER, address: "a@example.org", created: true }]);
    expect(forgets).toBe(1);
    expect(state.typed.address).toBe("");
    expect(state.gate.at).toBe("idle");
  });

  it("an edit the server takes ends with the mailbox that was asked, whatever else an answer might name", () => {
    const { done, forgets } = walk(EDIT, [press(act("edit")), answered({ ok: true, value: null })]);
    expect(done).toEqual([{ kind: "saved", mailboxId: ID }]);
    expect(forgets).toBe(1);
  });

  it("a passed test keeps what was typed and the password, and its verdict stands until the form changes", () => {
    const ok = { host: A, user: "a@example.org", folders: 4 };
    const tested = walk(ADD, [
      type("address", "a@example.org"),
      press(act("test")),
      answered({ ok: true, value: ok }),
    ]);
    expect(tested.forgets).toBe(0);
    expect(tested.done).toEqual([]);
    expect(tested.state.tested).toEqual(ok);
    expect(tested.state.typed.address).toBe("a@example.org");
    expect(walk(ADD, [type("user", "u")], tested.state).state.tested).toBeNull();
    expect(walk(ADD, [{ kind: "password" }], tested.state).state.tested).toBeNull();
  });

  it("a refusal stands at the press with everything typed, and the password is not forgotten", () => {
    const { state, forgets, done } = walk(ADD, [
      type("address", "a@example.org"),
      press(act("connect")),
      answered(no(refusal("mailbox_probe_failed", { reason: "auth" }))),
    ]);
    expect(keyOf(state)).toBe("mailboxes.probe_auth");
    expect(state.lastReason).toBe("auth");
    expect(state.typed.address).toBe("a@example.org");
    expect(forgets).toBe(0);
    expect(done).toEqual([]);
  });

  it("a test that finishes after the incoming server is edited leaves no verdict", () => {
    const pending = walk(ADD, [
      type("imapHost", A),
      press(act("test")),
      type("imapHost", B),
      press(act("connect")),
    ]);
    expect(pending.sends).toHaveLength(1);
    const { state } = walk(
      ADD,
      [answered({ ok: true, value: { host: A, user: "u", folders: 4 } })],
      pending.state,
    );
    expect(state.typed.imapHost).toBe(B);
    expect(state.tested).toBeNull();
    expect(state.gate.at).toBe("idle");
  });

  it("correcting a field or the password clears a connect refusal", () => {
    const { state } = walk(ADD, [
      press(act("connect")),
      answered(no(refusal("mailbox_probe_failed", { reason: "auth" }))),
    ]);
    expect(keyOf(state)).toBe("mailboxes.probe_auth");
    expect(keyOf(walk(ADD, [type("user", "other")], state).state)).toBeNull();
    expect(keyOf(walk(ADD, [{ kind: "password" }], state).state)).toBeNull();
  });

  it.each(["test", "connect"] as const)(
    "a %s refusal that finishes after an edit leaves no message",
    (verb) => {
      const { state, done, forgets } = walk(ADD, [
        press(act(verb)),
        type("user", "other"),
        answered(no(refusal("mailbox_probe_failed", { reason: "auth" }))),
      ]);
      expect(keyOf(state)).toBeNull();
      expect(state.gate.at).toBe("idle");
      expect(state.typed.user).toBe("other");
      expect(done).toEqual([]);
      expect(forgets).toBe(0);
    },
  );

  it("one press at a time: a second while one is on its way is not taken", () => {
    expect(walk(ADD, [press(act("test")), press(act("connect"))]).sends).toHaveLength(1);
  });

  it("an answer of an older press changes nothing", () => {
    const first = walk(ADD, [press(act("connect")), answered(no(refusal("mailbox_exists")))]);
    const late = walk(
      ADD,
      [press(act("connect")), { kind: "answered", seq: first.state.seq - 1, answer: NO_TLS }],
      first.state,
    );
    expect(late.state.consents).toEqual(first.state.consents);
    expect(late.state.gate.at).toBe("trying");
  });
});

describe("the second factor, asked once", () => {
  it("only on the server's refusal; the verified factor sends the parked press once more, the same value", () => {
    const connect = act("connect");
    const asked = walk(ADD, [press(connect), answered(WINDOW_CLOSED)]);
    expect(asked.state.gate.at).toBe("asking");
    expect(asked.sends).toHaveLength(1);
    const again = walk(ADD, [factor("verified"), factor("verified")], asked.state);
    expect(again.sends).toHaveLength(1);
    expect(again.sends[0]!.act).toBe(connect);
    expect(again.sends[0]!.afterFactor).toBe(true);
  });

  it("a second refusal right after the factor says sign in, and asks nothing", () => {
    const { state, sends } = walk(ADD, [
      press(act("connect")),
      answered(WINDOW_CLOSED),
      factor("verified"),
      answered(WINDOW_CLOSED),
      factor("verified"),
    ]);
    expect(state.gate.at).toBe("idle");
    expect(keyOf(state)).toBe("devices.stepUpExpired");
    expect(sends).toHaveLength(2);
  });

  it("with no dialog to ask, nothing is parked and the refusal says sign in", () => {
    const { state, sends } = walk({ ...ADD, factor: false }, [
      press(act("connect")),
      answered(WINDOW_CLOSED),
      factor("verified"),
    ]);
    expect(state.gate.at).toBe("idle");
    expect(keyOf(state)).toBe("devices.stepUpExpired");
    expect(sends).toHaveLength(1);
  });

  it("Cancel empties the slot and keeps what was typed; a factor after it sends nothing", () => {
    const { state, sends } = walk(ADD, [
      type("address", "a@example.org"),
      press(act("connect")),
      answered(WINDOW_CLOSED),
      factor("cancelled"),
      factor("verified"),
    ]);
    expect(state.gate).toEqual({ at: "idle", nothingRan: false });
    expect(state.typed.address).toBe("a@example.org");
    expect(sends).toHaveLength(1);
  });

  it("a factor thrown away after Cancel says that nothing ran, in the mount's own words", () => {
    const events = [
      press(act("connect")),
      answered(WINDOW_CLOSED),
      factor("cancelled"),
      factor("discarded"),
      factor("verified"),
    ];
    const add = walk(ADD, events);
    expect(add.sends).toHaveLength(1);
    expect(keyOf(add.state)).toBe("mailboxes.cancelledNothingChanged");
    expect(add.state.shown?.calm).toBe(true);
    const join = walk({ ...ADD, purpose: "join" }, events);
    expect(keyOf(join.state)).toBe("devices.stepUpCancelledNothingRan");
    // The join's step said it at the press, as a refusal is said.
    expect(join.state.shown?.calm).toBe(false);
  });

  it("a parked test is re-run as a test: a verified factor never connects", () => {
    const { sends } = walk(ADD, [press(act("test")), answered(WINDOW_CLOSED), factor("verified")]);
    expect(sends.map((send) => send.act.verb)).toEqual(["test", "test"]);
  });

  it.each([
    ["a field", type("imapHost", B)],
    ["the address", type("address", "b@example.org")],
    ["the password", { kind: "password" } as ConnectEvent],
    ["the provider", { kind: "provider", id: "gmail", byHand: true } as ConnectEvent],
    ["a consent", { kind: "tick", consent: "plain", leg: "imap", on: true } as ConnectEvent],
    ["the other way in", { kind: "byPassword" } as ConnectEvent],
  ])("changing %s while the factor is asked withdraws the waiting press", (_what, change) => {
    const { state, sends } = walk(ADD, [
      press(act("connect")),
      answered(WINDOW_CLOSED),
      change,
      factor("verified"),
    ]);
    expect(state.gate.at).toBe("idle");
    expect(sends).toHaveLength(1);
  });
});

describe("a consent follows the server it was given for", () => {
  const sent = { imap: A, smtp: B };
  const offered = () =>
    walk(ADD, [
      { kind: "provider", id: "imap", byHand: true },
      type("imapHost", A),
      type("smtpHost", B),
      press(act("connect", sent)),
      answered(NO_TLS),
    ]);

  it("the refusal of a press opens its line, unticked, and says its sentence", () => {
    const { state } = offered();
    expect(keyOf(state)).toBe("mailboxes.probe_tls_unavailable");
    expect(linesOf(state.consents, sent)).toEqual([{ kind: "plain", legs: "imap", on: false }]);
  });

  it.each([
    ["the host", type("imapHost", B)],
    ["the other host", type("smtpHost", A)],
    ["a port", type("imapPort", "1143")],
    ["the provider", { kind: "provider", id: "gmail", byHand: true } as ConnectEvent],
  ])("changing %s withdraws every line and every tick, and going back asks again", (_what, change) => {
    const ticked = walk(ADD, [{ kind: "tick", consent: "plain", leg: "imap", on: true }], offered().state);
    expect(ticked.state.consents.ticks).toHaveLength(1);
    const changed = walk(ADD, [change, type("imapHost", A), type("smtpHost", B)], ticked.state);
    expect(changed.state.consents).toEqual({ offers: [], ticks: [] });
  });

  it("on an edit a port typed alone withdraws them too: the server is another one", () => {
    const stored = { imap: "stored", smtp: null };
    const ticked = walk(EDIT, [
      press(act("edit", stored)),
      answered(NO_TLS),
      { kind: "tick", consent: "plain", leg: "imap", on: true },
    ]);
    expect(ticked.state.consents.offers).toHaveLength(1);
    expect(ticked.state.consents.ticks).toHaveLength(1);
    for (const field of ["imapPort", "smtpPort"] as const)
      expect(walk(EDIT, [type(field, "1143")], ticked.state).state.consents).toEqual({
        offers: [],
        ticks: [],
      });
  });

  it("an answer that offers for a host the form no longer holds draws no line", () => {
    const { state } = walk(ADD, [
      { kind: "provider", id: "imap", byHand: true },
      type("imapHost", A),
      type("smtpHost", B),
      press(act("connect", sent)),
      type("imapHost", B),
      answered(NO_TLS),
    ]);
    expect(linesOf(state.consents, { imap: B, smtp: B })).toEqual([]);
  });

  it("a refused press that offers nothing leaves no older offer and no tick: no line stays ticked beside a sentence that the server is not private", () => {
    const ticked = walk(ADD, [{ kind: "tick", consent: "plain", leg: "imap", on: true }], offered().state);
    expect(linesOf(ticked.state.consents, sent)).toEqual([{ kind: "plain", legs: "imap", on: true }]);
    const again = walk(
      ADD,
      [press(act("connect", sent)), answered(noTls("imap", "not_private"))],
      ticked.state,
    );
    expect(keyOf(again.state)).toBe("mailboxes.probe_tls_unavailable_public");
    expect(again.state.consents).toEqual({ offers: [], ticks: [] });
    // A refusal about something else offers nothing either: the server's next refusal offers the line again.
    const wrongPassword = walk(
      ADD,
      [press(act("connect", sent)), answered(no(refusal("mailbox_probe_failed", { reason: "auth" })))],
      ticked.state,
    );
    expect(wrongPassword.state.consents).toEqual({ offers: [], ticks: [] });
  });

  it("a refusal that offers for the other server leaves the first one's line and tick; the factor's ask and a passed test clear nothing", () => {
    const ticked = walk(ADD, [{ kind: "tick", consent: "plain", leg: "imap", on: true }], offered().state);
    const both = walk(ADD, [press(act("connect", sent)), answered(noTls("smtp", "offered"))], ticked.state);
    expect(linesOf(both.state.consents, sent)).toEqual([
      { kind: "plain", legs: "imap", on: true },
      { kind: "plain", legs: "smtp", on: false },
    ]);
    const asked = walk(ADD, [press(act("connect", sent)), answered(WINDOW_CLOSED)], ticked.state);
    expect(asked.state.consents).toEqual(ticked.state.consents);
    const tested = walk(
      ADD,
      [press(act("test", sent)), answered({ ok: true, value: { host: A, user: "u", folders: 1 } })],
      ticked.state,
    );
    expect(tested.state.consents).toEqual(ticked.state.consents);
  });

  it("a name the certificate proves is offered as one press; taking it moves the field and retires what was known of the old host", () => {
    const mismatch = no(
      refusal("mailbox_probe_failed", {
        reason: "tls",
        transport: "imap",
        tls: {
          kind: "hostname_mismatch",
          certHost: "mail.hostwerk.example",
          expectedHost: A,
          suggestedHost: "mail.hostwerk.example",
          plaintext: null,
          trustVariable: null,
          certificate: null,
        },
      }),
    );
    const suggested = walk(ADD, [press(act("connect", sent)), answered(mismatch)], offered().state);
    expect(suggested.state.suggestion).toEqual({ leg: "imap", host: "mail.hostwerk.example" });
    expect(suggested.state.typed.imapHost).toBe(A);
    const taken = walk(ADD, [{ kind: "suggestionTaken" }], suggested.state);
    expect(taken.state.typed.imapHost).toBe("mail.hostwerk.example");
    expect(taken.state.suggestion).toBeNull();
    expect(taken.state.shown).toBeNull();
    expect(taken.state.consents).toEqual({ offers: [], ticks: [] });
  });
});

describe("choosing a provider", () => {
  it("a named provider imposes its hosts; the manual entry after it starts empty, and keeps only its own typing", () => {
    const gmail = walk(ADD, [{ kind: "provider", id: "gmail", byHand: true }]);
    expect(gmail.state.typed).toMatchObject({ provider: "gmail", byHand: true, imapHost: "imap.gmail.com" });
    const manual = walk(ADD, [{ kind: "provider", id: "imap", byHand: true }], gmail.state);
    expect(manual.state.typed).toMatchObject({ provider: "imap", imapHost: "", smtpHost: "" });
    const typedHost = walk(
      ADD,
      [type("imapHost", A), { kind: "provider", id: "imap", byHand: true }],
      manual.state,
    );
    expect(typedHost.state.typed.imapHost).toBe(A);
  });

  it("an unreachable host on the manual entry lets the looked-up hosts be offered; taking them fills the fields and nothing else", () => {
    const unreachable = walk(ADD, [
      { kind: "provider", id: "imap", byHand: true },
      type("imapHost", A),
      press(act("connect")),
      answered(no(refusal("mailbox_probe_failed", { reason: "connect" }))),
    ]);
    expect(unreachable.state.offerHosts).toBe(true);
    expect(keyOf(unreachable.state)).toBe("mailboxes.probe_connect_noport");
    const taken = walk(
      ADD,
      [{ kind: "hostsTaken", imap: "imap.lichtgrat.example", smtp: "smtp.lichtgrat.example:2525" }],
      unreachable.state,
    );
    expect(taken.state.typed).toMatchObject({
      imapHost: "imap.lichtgrat.example",
      smtpHost: "smtp.lichtgrat.example:2525",
    });
    expect(taken.state.offerHosts).toBe(false);
    expect(taken.sends).toEqual([]);
  });

  it("a fresh choice offers the provider's sign-in first again", () => {
    const { state } = walk(ADD, [
      { kind: "provider", id: "microsoft", byHand: true },
      { kind: "byPassword" },
      { kind: "provider", id: "microsoft", byHand: true },
    ]);
    expect(state.typed.byPassword).toBe(false);
  });
});

describe("the form's state holds no password", () => {
  it("serialised whole, parked verb included, it gives the seal and never the value", () => {
    const { state } = walk(ADD, [
      type("address", "a@example.org"),
      press(act("connect")),
      answered(WINDOW_CLOSED),
    ]);
    expect(state.gate.at).toBe("asking");
    expect(JSON.stringify(state)).not.toContain("MARKER");
    expect(JSON.stringify(state)).toContain("[secret]");
    expect(Object.isFrozen((state.gate as { act: Parked }).act)).toBe(true);
  });

  it("a refused press drops its frozen body with the answer: the state holds no seal while the refusal stands", () => {
    for (const refused of [
      no(refusal("mailbox_probe_failed", { reason: "auth" })),
      NO_TLS,
      no(refusal("a_code_nobody_words")),
    ]) {
      const { state } = walk(ADD, [
        type("address", "a@example.org"),
        press(act("connect")),
        answered(refused),
      ]);
      expect(state.shown).not.toBeNull();
      expect(state.gate).toEqual({ at: "idle", nothingRan: false });
      expect(JSON.stringify(state)).not.toContain("[secret]");
    }
    // Refused again after the factor, the press is over too, and so is its body.
    const signIn = walk(ADD, [
      press(act("connect")),
      answered(WINDOW_CLOSED),
      factor("verified"),
      answered(WINDOW_CLOSED),
    ]);
    expect(keyOf(signIn.state)).toBe("devices.stepUpExpired");
    expect(JSON.stringify(signIn.state)).not.toContain("[secret]");
  });
});
