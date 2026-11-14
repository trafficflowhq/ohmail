import { describe, expect, it } from "vitest";
import { inputOf } from "../../../src/mailboxes/connect/body.js";
import {
  connectStep,
  initialState,
  type ConnectFacts,
  type Parked,
} from "../../../src/mailboxes/connect/model.js";
import { authHintPreset, providerById } from "../../../src/mailboxes/connect/providers.js";
import {
  NO_DETAILS,
  nothingRanSaid,
  saidOf,
  signInSaid,
  type SaidContext,
} from "../../../src/mailboxes/connect/refusal.js";
import { secretOf } from "../../../src/mailboxes/connect/secret.js";
import { SENDER_NAME_MAX, senderNameOf } from "../../../src/mailboxes/connect/sender-name.js";
import { WAYS_SHUT } from "../../../src/mailboxes/connect/sign-in.js";
import { NAME_REFUSED, standaloneSaid } from "../../../src/mailboxes/connect/standalone-said.js";
import {
  CONNECT_PURPOSES,
  type ConnectTyped,
  type Refusal,
  type RefusalDetails,
} from "../../../src/mailboxes/connect/types.js";
import { MODE_OF } from "../../../src/mailboxes/connect/use-connect-form.js";

/*
 * THE FORM OPENED FOR A PHONE'S OWN MAILBOX (`standalone`): its row in every table by purpose, the name its letters
 * carry, and its refusals, which are said by their code in the phone's own words and never in words that crossed.
 */

const FACTS: ConnectFacts = {
  purpose: "standalone",
  subject: null,
  factor: false,
  ways: WAYS_SHUT,
  code: false,
};
const CTX: SaidContext = {
  purpose: "standalone",
  preset: "imap",
  manual: true,
  ports: false,
  signInArmed: false,
  afterFactor: false,
  factor: false,
};
/** A refusal as the phone's wire answers one: no status, the code native named, no words, the field it is about. */
const refused = (
  code: string | null,
  over: Partial<Refusal> = {},
  details: Partial<RefusalDetails> = {},
): Refusal => ({
  status: 0,
  code,
  message: "",
  details: { ...NO_DETAILS, ...details },
  ...over,
});
const PLACES_EMPTY = { 0: "", 1: "", 2: "", 3: "", 4: "", 5: "" };
const TYPED: ConnectTyped = {
  address: "ada@example.org",
  provider: "imap",
  byHand: true,
  user: "",
  imapHost: "mail.example.org:993",
  smtpHost: "smtp.example.org:587",
  imapPort: "",
  smtpPort: "",
  byPassword: false,
};
const PASS = secretOf("zq-MARKER-pass");
const NO_CLAIM = { imap: {}, smtp: {} } as const;

describe("the purpose in the tables", () => {
  it("is one of the closed list, and a connect of it states the mode of an install's first mailbox", () => {
    expect(CONNECT_PURPOSES).toContain("standalone");
    expect(MODE_OF.standalone).toBe("seed");
  });

  it("has its row where a mount says to sign in again and that nothing ran: the phone's own sentence, never another mount's", () => {
    expect(signInSaid("standalone")).toEqual({ ns: "phoneRefusal", key: "unknown" });
    expect(nothingRanSaid("standalone")).toEqual({ ns: "phoneRefusal", key: "unknown" });
    // The rows that stood are as they stood.
    expect(signInSaid("join")).toEqual({ ns: "join", key: "stepUpExpired" });
    expect(signInSaid("add")).toEqual({ ns: "devices", key: "stepUpExpired" });
    expect(nothingRanSaid("join")).toEqual({ ns: "devices", key: "stepUpCancelledNothingRan" });
    expect(nothingRanSaid("edit")).toEqual({ ns: "mailboxes", key: "cancelledNothingChanged" });
  });
});

describe("a refused open, said", () => {
  it("is the sentence of its code in the phone's own words, every place empty, with the sentence for a code the catalogue lacks", () => {
    expect(saidOf(refused("standaloneSignInRefused"), CTX)).toEqual({
      ns: "phoneRefusal",
      key: "standaloneSignInRefused",
      values: PLACES_EMPTY,
      orElse: "unknown",
    });
    expect(saidOf(refused("standaloneNoPort", {}, { field: "imapPort" }), CTX)).toEqual(
      standaloneSaid(refused("standaloneNoPort")),
    );
  });

  it("names the provider from the provider table where the sentence names one, as the phone itself does", () => {
    const preset = authHintPreset();
    const names = { ...PLACES_EMPTY, 0: preset.label, 1: preset.account ?? preset.label };
    for (const code of [
      "standaloneAuthAppOnly",
      "standaloneAuthInvalid",
      "standaloneAuthWebLogin",
      "standaloneAuthImapDisabled",
    ])
      expect(standaloneSaid(refused(code))).toEqual({
        ns: "phoneRefusal",
        key: code,
        values: names,
        orElse: "unknown",
      });
  });

  it("no answer, and a code that is no plain key of the catalogue, say that this build cannot say why", () => {
    const unknown = { ns: "phoneRefusal", key: "unknown" };
    expect(standaloneSaid(refused(null))).toEqual(unknown);
    for (const code of [
      "",
      "a.b",
      "__proto__",
      "constructor",
      "toString",
      "unknown",
      "Standalone",
      "x".repeat(65),
      "a b",
      "zq-MARKER-pass",
    ])
      expect(standaloneSaid(refused(code)), code).toEqual(unknown);
  });

  it("never says words that crossed: a refusal's own sentence, whatever it holds, is not taken", () => {
    const worded = refused("standaloneRefused", {
      message: "native's own words about zq-MARKER-pass",
      status: 422,
    });
    const said = saidOf(worded, CTX);
    expect(said).toEqual({
      ns: "phoneRefusal",
      key: "standaloneRefused",
      values: PLACES_EMPTY,
      orElse: "unknown",
    });
    expect(JSON.stringify(said)).not.toContain("MARKER");
    // Whatever status a wire of this purpose answered with, the purpose's own table reads it.
    expect(saidOf(refused("step_up_required", { status: 403 }), CTX)).toEqual({
      ns: "phoneRefusal",
      key: "unknown",
    });
    expect(saidOf(refused(null, { status: 401 }), CTX)).toEqual({ ns: "phoneRefusal", key: "unknown" });
  });

  it("is read as ever on the mounts that stood: the same refusal there is the server's sentence, or that the check did not finish", () => {
    const add: SaidContext = { ...CTX, purpose: "add" };
    expect(
      saidOf(refused("standaloneSignInRefused", { message: "The server's own sentence.", status: 422 }), add),
    ).toEqual({
      server: "The server's own sentence.",
    });
    expect(saidOf(refused("standaloneSignInRefused"), add)).toEqual({
      ns: "mailboxes",
      key: "probe_unknown",
    });
  });
});

describe("the name a mailbox's letters carry", () => {
  const manual = providerById("imap");

  it("rides the body as it is stored where one was typed, after everything a body held before", () => {
    const body = inputOf({ ...TYPED, displayName: "  Ada \t Lovelace " }, manual, PASS, NO_CLAIM);
    expect(body.displayName).toBe("Ada Lovelace");
    expect(Object.keys(body)).toEqual(["provider", "address", "imap", "smtp", "displayName"]);
  });

  it("is no key of a body where none was typed: a body of the mounts that stood is what it was", () => {
    const plain = inputOf(TYPED, manual, PASS, NO_CLAIM);
    expect(plain).not.toHaveProperty("displayName");
    expect(Object.keys(plain)).toEqual(["provider", "address", "imap", "smtp"]);
    expect(inputOf({ ...TYPED, displayName: "   " }, manual, PASS, NO_CLAIM)).not.toHaveProperty(
      "displayName",
    );
    // A name that cannot be stored is never cut to fit: the press refuses it before a body is built.
    expect(
      inputOf({ ...TYPED, displayName: "A".repeat(SENDER_NAME_MAX + 1) }, manual, PASS, NO_CLAIM),
    ).not.toHaveProperty("displayName");
  });

  it("the rule moved as it stood: blank is none, spaces collapse, a control character or more than a hundred characters is refused", () => {
    expect(SENDER_NAME_MAX).toBe(100);
    expect(senderNameOf("")).toBeNull();
    expect(senderNameOf("  \n ")).toBeNull();
    expect(senderNameOf("  Ada   Lovelace ")).toBe("Ada Lovelace");
    expect(senderNameOf("Ada\u0007")).toBeUndefined();
    expect(senderNameOf("Ada\u0085Lovelace")).toBeUndefined();
    expect(senderNameOf("é".repeat(100))).toBe("é".repeat(100));
    expect(senderNameOf("é".repeat(101))).toBeUndefined();
    expect(NAME_REFUSED).toEqual({ ns: "phoneRefusal", key: "standaloneNameRefused" });
  });

  it("typed while a press waits on the second factor withdraws that press, and keeps what is known of the servers", () => {
    const facts: ConnectFacts = { ...FACTS, purpose: "add", factor: true };
    const act: Parked = Object.freeze({
      verb: "connect",
      subject: null,
      mode: "add",
      sent: { imap: "mail.example.org:993", smtp: "smtp.example.org:587" },
      body: inputOf(TYPED, manual, PASS, NO_CLAIM),
    });
    let state = connectStep(initialState(TYPED, facts), { kind: "press", act }, facts).state;
    state = connectStep(
      state,
      {
        kind: "answered",
        seq: state.seq,
        answer: { ok: false, refusal: refused("step_up_required", { status: 403 }) },
      },
      facts,
    ).state;
    expect(state.gate.at).toBe("asking");
    const offered = {
      ...state,
      offerHosts: true,
      suggestion: { leg: "imap" as const, host: "mail2.example.org" },
    };

    const named = connectStep(offered, { kind: "typed", field: "displayName", value: "Ada" }, facts).state;
    expect(named.typed.displayName).toBe("Ada");
    expect(named.gate.at).not.toBe("asking");
    expect(named.offerHosts).toBe(true);
    expect(named.suggestion).toEqual({ leg: "imap", host: "mail2.example.org" });
    // A server's name is another matter: what was known of the old one goes, as it did.
    const moved = connectStep(
      offered,
      { kind: "typed", field: "imapHost", value: "other.example.org" },
      facts,
    ).state;
    expect(moved.offerHosts).toBe(false);
    expect(moved.suggestion).toBeNull();
  });
});
