import { describe, expect, it } from "vitest";
import { NONE, type PaneCalls } from "../../../src/mailboxes/pane/calls.js";
import { NO_VERBS, verbsOf, type PaneVerbs, type VerbFacts } from "../../../src/mailboxes/pane/verbs.js";

const answers = () => Promise.resolve({ ok: true as const, value: null });

/** A wire that offers every verb. */
const ALL: PaneCalls = {
  list: () => Promise.resolve({ ok: true, value: [] }),
  allowance: () => Promise.resolve({ ok: true, value: { emailVerified: true, access: null } }),
  resync: answers,
  remove: answers,
  erase: () => Promise.reject(new Error("not called")),
  organizer: () => Promise.reject(new Error("not called")),
  organizeHere: () => Promise.reject(new Error("not called")),
  stopOrganizing: () => Promise.reject(new Error("not called")),
  dismissForwardingNotice: () => Promise.reject(new Error("not called")),
  selfCheck: answers,
  filings: {
    read: answers,
    retry: () => Promise.reject(new Error("no")),
    leave: () => Promise.reject(new Error("no")),
  },
  out: () => undefined,
};
const CONNECT = { edit: () => answers(), signIn: { ways: answers } };

const facts = (over: Partial<VerbFacts> = {}): VerbFacts => ({
  capability: "here",
  wire: ALL,
  connect: CONNECT,
  stage: true,
  ...over,
});
const drawn = (v: PaneVerbs): string[] =>
  Object.entries(v)
    .filter(([, on]) => on)
    .map(([name]) => name)
    .sort();

describe("what each answer of the capability draws (a withheld verb is absent, never disabled)", () => {
  it("here: every verb the wires hand, and no way out", () => {
    expect(drawn(verbsOf(facts()))).toEqual(
      [
        "check",
        "connect",
        "dismissQuiet",
        "edit",
        "erase",
        "filings",
        "listed",
        "organize",
        "peek",
        "reconnect",
        "remove",
        "resync",
        "setupAgain",
        "stop",
      ].sort(),
    );
  });

  it("resyncAndOut: the re-sync and the way out the host hands, nothing that edits, removes or connects", () => {
    const v = verbsOf(facts({ capability: "resyncAndOut" }));
    expect(drawn(v)).toEqual(["listed", "out", "resync"]);
    expect(drawn(verbsOf(facts({ capability: "resyncAndOut", wire: { ...ALL, out: NONE } })))).toEqual([
      "listed",
      "resync",
    ]);
  });

  it("resyncOnly: the re-sync alone", () => {
    expect(drawn(verbsOf(facts({ capability: "resyncOnly" })))).toEqual(["listed", "resync"]);
  });

  it("none, or no wire: the pane is not listed and draws nothing", () => {
    expect(verbsOf(facts({ capability: "none" }))).toEqual(NO_VERBS);
    expect(verbsOf(facts({ wire: NONE }))).toEqual(NO_VERBS);
    expect(drawn(NO_VERBS)).toEqual([]);
  });
});

describe("a member a shell cannot offer is not drawn, whatever the capability says", () => {
  it.each([
    ["remove", { remove: NONE }, ["remove", "erase"]],
    ["erase", { erase: NONE }, ["erase"]],
    ["organizer", { organizer: NONE }, ["peek"]],
    ["organizeHere", { organizeHere: NONE }, ["organize"]],
    ["stopOrganizing", { stopOrganizing: NONE }, ["stop"]],
    ["dismissForwardingNotice", { dismissForwardingNotice: NONE }, ["dismissQuiet"]],
    ["selfCheck", { selfCheck: NONE }, ["check"]],
    ["filings", { filings: NONE }, ["filings"]],
  ] as const)("%s at none withholds its verb alone", (_, over, gone) => {
    const v = verbsOf(facts({ wire: { ...ALL, ...over } }));
    const all = drawn(verbsOf(facts()));
    expect(drawn(v)).toEqual(all.filter((name) => !(gone as readonly string[]).includes(name)));
  });

  it("no connect wire: no connect, no edit, no reconnect, even under `here`", () => {
    const v = verbsOf(facts({ connect: NONE }));
    expect(v.connect).toBe(false);
    expect(v.edit).toBe(false);
    expect(v.reconnect).toBe(false);
    expect(v.resync).toBe(true);
  });

  it("an edit the connect wire cannot store, and a sign-in it cannot run, are withheld one by one", () => {
    expect(verbsOf(facts({ connect: { ...CONNECT, edit: NONE } })).edit).toBe(false);
    expect(verbsOf(facts({ connect: { ...CONNECT, edit: NONE } })).reconnect).toBe(true);
    expect(verbsOf(facts({ connect: { ...CONNECT, signIn: NONE } })).reconnect).toBe(false);
    expect(verbsOf(facts({ connect: { ...CONNECT, signIn: NONE } })).edit).toBe(true);
  });

  it("no first-run stage: no connect and no run again, since the press would lead nowhere", () => {
    const v = verbsOf(facts({ stage: false }));
    expect(v.connect).toBe(false);
    expect(v.setupAgain).toBe(false);
    expect(v.edit).toBe(true);
  });
});
