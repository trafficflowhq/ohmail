import { beforeAll, describe, expect, it } from "vitest";
import { probeCopyKey, refusalAuthHint, refusalTransport } from "@ohmail/app-logic/doors/local-server-host";
import { certificateOfferOf as shippedCertificateOffer } from "@ohmail/app-logic/mailboxes/connect/consents";
import { providerById } from "@ohmail/app-logic/mailboxes/connect/providers";
import {
  certificateOfferOf, gateOf, noPortProbeSentence, plaintextOfferOf, probeReasonOf, probeTlsOf, refusalOf, saidOf,
  type SaidContext,
} from "@ohmail/app-logic/mailboxes/connect/refusal";
import { CONNECT_STATES, contextOfState } from "../../../packages/app-logic/test/mailboxes/connect/refusal-states.js";
import type { Refusal } from "@ohmail/app-logic/mailboxes/connect/types";
import { ApiError, messageOf } from "../app/api-client";
import { gatedRefusal } from "../app/(product)/mailbox/gated-refusal";
import { activeTranslator, setActiveCatalog } from "../app/shell/locale";
import {
  noPortProbeSentence as shippedNoPort, plaintextOfferOf as shippedPlaintextOffer, probeReasonOf as shippedReason,
  probeTlsOf as shippedTls,
} from "../app/shell/probe-refusal";
import { refusalCopy } from "../app/shell/server-refusal";
import messages from "../messages/en.json";

/**
 * THE ONE TABLE SAYS WHAT THE SHIPPED CLASSIFIERS SAY, on the same answers of the server, while those classifiers
 * stand. Each state of a refused connect is thrown as the server client throws it and read both ways: by the shipped
 * readers over the thrown error, and by the new reader and table over the refusal it becomes.
 */
/** A state's refusal, as the server's envelope carried it. */
function thrownOf(refusal: Refusal): ApiError {
  const { tls, ...flat } = refusal.details;
  const details: Record<string, unknown> = Object.fromEntries(Object.entries(flat).filter(([, v]) => v !== null && v !== false));
  if (tls !== null) {
    const { certificate, ...rest } = tls;
    details.tls = {
      ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null)),
      ...(certificate === null ? {} : { certificate: { sha256: certificate } }),
    };
  }
  return new ApiError(refusal.status, refusal.code ?? "internal", refusal.message || "The server's own sentence.", details);
}
const ROWS = CONNECT_STATES.filter((state) => state.refusal !== null && state.own === null).map((state) => ({
  id: state.id, context: contextOfState(state), thrown: thrownOf(state.refusal!),
}));
const english = (ns: string, key: string, values?: Record<string, unknown>): string => activeTranslator(ns)!(key, values);

/**
 * THE JOIN'S STEP AS THE PRODUCT SAID A REFUSAL, under the catalogue the product's layout makes active (`LocaleShell`):
 * the step's own words where it had them (its `mailboxSentence`, before the step left: the no-port sentence, a refused
 * password, the check's three reasons), else the wizard's runner's `messageOf`.
 */
function shippedJoin(thrown: ApiError, preset: string): string {
  const noPort = shippedNoPort(thrown, providerById(preset).manual === true);
  if (noPort) return english("mailboxes", noPort.key, { field: noPort.field });
  const reason = shippedReason(thrown);
  if (reason === "auth")
    return english("mailboxes", probeCopyKey(reason, false, refusalTransport(thrown), refusalAuthHint(thrown), preset));
  if (reason === "storage" || reason === "sync" || reason === "unknown") return english("mailboxes", `probe_${reason}`);
  return messageOf(thrown);
}
const joinContext = (preset: string): SaidContext => ({
  purpose: "join", preset, manual: providerById(preset).manual === true, ports: false, signInArmed: false, afterFactor: false, factor: true,
});
/**
 * Every state a refusal makes, met on the join. A refusal by a server on this computer is not one of them: only the
 * desktop's own door dials such a server (its engine), and the web's server, which the join asks, never says one.
 */
const JOIN_ROWS = CONNECT_STATES.filter((state) => state.refusal !== null && state.own === null && !state.refusal.details.localServer)
  .map((state) => ({ id: state.id, preset: state.preset, thrown: thrownOf(state.refusal!) }));

beforeAll(() => setActiveCatalog("en", messages as never));

describe("the refusal table against the shipped classifiers", () => {
  it("covers every state a refusal makes", () => {
    expect(ROWS.length).toBe(50);
  });

  it.each(ROWS)("$id reads the same reason, certificate detail and offers", ({ thrown }) => {
    const read = refusalOf(thrown);
    expect(probeReasonOf(read)).toBe(shippedReason(thrown));
    const tls = probeTlsOf(read);
    const was = shippedTls(thrown);
    expect(tls === null ? null : { kind: tls.kind, transport: tls.transport }).toEqual(was === null ? null : { kind: was.kind, transport: was.transport });
    expect(tls?.suggestedHost ?? undefined).toBe(was?.suggestedHost);
    expect(plaintextOfferOf(read)).toBe(shippedPlaintextOffer(thrown));
    expect(certificateOfferOf(read)).toEqual(shippedCertificateOffer(thrown));
    for (const hostFields of [true, false]) expect(noPortProbeSentence(read, hostFields)).toEqual(shippedNoPort(thrown, hostFields));
    expect(noPortProbeSentence(read, true, "generic")).toEqual(shippedNoPort(thrown, true, "generic"));
  });

  it.each(ROWS)("$id says the sentence the shipped forms said", ({ context, thrown }) => {
    const said = saidOf(refusalOf(thrown), context);
    const now = "server" in said ? said.server : english(said.ns, said.key, said.values);
    // A form with no port field said the no-port sentence first; every form then said the server refusal's own copy.
    const noPort = context.ports ? null : shippedNoPort(thrown, context.manual);
    const shipped = noPort ? english("mailboxes", noPort.key, { field: noPort.field }) : refusalCopy(thrown, { presetId: context.preset });
    expect(now).toBe(shipped);
  });

  it("meets every one of them on the join but a server on this computer's", () => {
    expect(JOIN_ROWS.length).toBe(48);
  });

  it.each(JOIN_ROWS)("$id on the join says what the join's step said in the product", ({ preset, thrown }) => {
    const said = saidOf(refusalOf(thrown), joinContext(preset));
    const now = "server" in said ? said.server : english(said.ns, said.key, said.values);
    expect(now).toBe(shippedJoin(thrown, preset));
  });

  it("a certificate kind a newer server sends is named all the same, as the shipped readers took it, and said as they said it", () => {
    const thrown = new ApiError(400, "mailbox_probe_failed", "The server's own sentence.", {
      reason: "tls", transport: "imap", tls: { kind: "revoked_by_its_authority" },
    });
    const read = refusalOf(thrown);
    for (const hostFields of [true, false]) expect(noPortProbeSentence(read, hostFields)).toEqual(shippedNoPort(thrown, hostFields));
    const said = saidOf(read, joinContext("imap"));
    expect("server" in said ? said.server : english(said.ns, said.key, said.values)).toBe(shippedJoin(thrown, "imap"));
  });

  it("the gate reads a closed window, a dead session and an unfinished enrolment as the shipped one did", () => {
    const cases = [
      new ApiError(403, "step_up_required", "x"), new ApiError(401, "unauthorized", "x"), new ApiError(403, "enrollment_incomplete", "x"),
      new ApiError(403, "forbidden", "x"), new ApiError(422, "mailbox_probe_failed", "x", { reason: "auth" }), new ApiError(400, "step_up_required", "x"),
    ];
    const word = { factor: "factor", "sign-in": "signIn", other: "other" } as const;
    for (const thrown of cases) expect(gateOf(refusalOf(thrown))).toBe(word[gatedRefusal(thrown, false)]);
  });
});
