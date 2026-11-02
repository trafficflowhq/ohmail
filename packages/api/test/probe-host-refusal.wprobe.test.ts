import { describe, it, expect } from "vitest";
import { ServiceError, StaticKeyProvider } from "@trafficflow/services/mail";
import type { ApiDeps } from "@trafficflow/api";
import {
  makeImapProbe, makeSmtpProbe, makeProbeHostGuard, type ProbeDialer,
} from "../src/imap-probe.js";
import { probeHostRefusal } from "../src/probe-host-refusal.js";

/**
 * A MISTYPED MAIL SERVER IS ANSWERED IN A SENTENCE.
 *
 * Measured on a self-hosted install: typing a host that does not exist put
 * "u is not a permitted url: host did not resolve" in the Mailboxes pane — the SSRF gate's
 * refusal, correct, wearing the name of the PARAMETER it was handed. A typo'd host is the most
 * likely mistake on that screen and it got the least readable answer.
 *
 * Every class below is driven through the REAL guard and the REAL core reasons, never through a
 * hand-written error: the mapping matches the gate's prose, so a reworded reason has to redden
 * here rather than silently fall through to the generic sentence.
 */

/** A resolver that answers with the addresses it was given; `[]` is "the name is not there". */
const resolves = (...addrs: string[]) => ({ async resolve(): Promise<string[]> { return addrs; } });

const guard = (...addrs: string[]) => makeProbeHostGuard(resolves(...addrs));

/** Refuse through the real guard, then re-say it — the two halves the probe seam runs together. */
async function refusal(
  host: string, addrs: string[], leg: "imap" | "smtp", port?: number,
): Promise<ServiceError> {
  try {
    await guard(...addrs).check(host, port, leg);
  } catch (err) {
    const said = probeHostRefusal(err, leg);
    expect(said, `${host} refused with something that is not a ServiceError`).toBeInstanceOf(ServiceError);
    return said as ServiceError;
  }
  throw new Error(`${host} was not refused at all — this case measures nothing`);
}

/** The five refusal classes `assertPublicHost` can raise, each reached the way a person reaches it. */
const CASES = [
  { name: "an empty host", host: "", addrs: [] as string[] },
  { name: "a host that does not resolve", host: "mail.typo.example", addrs: [] as string[] },
  { name: "a host resolving into a private network", host: "mail.lan.example", addrs: ["10.0.0.5"] },
  { name: "the machine's own name", host: "localhost", addrs: [] as string[] },
  { name: "something that is not a host name at all", host: "mail server", addrs: [] as string[] },
] as const;

describe("the connect form's host refusals are sentences", () => {
  it.each(CASES)("$name is refused in words, and the gate's own string never appears", async (c) => {
    const said = await refusal(c.host, [...c.addrs], "imap");
    expect(said.httpStatus).toBe(400);
    expect(said.message, "the gate's own refusal reached the wire").not.toContain("not a permitted url");
    /* The parameter name is what a person actually saw. Asserted as the leading token, because
       "u" is a letter that appears in every other word on the screen. */
    expect(said.message.split(" ")[0]).not.toBe("u");
    expect(said.message).toMatch(/^[A-Z]/);
    expect(said.message).toMatch(/[.!]$/);
  });

  it("each class says its own thing — five causes, five sentences", async () => {
    const said = await Promise.all(CASES.map((c) => refusal(c.host, [...c.addrs], "imap")));
    const sentences = said.map((s) => s.message);
    expect(new Set(sentences).size, `two classes share words: ${JSON.stringify(sentences)}`).toBe(5);
    /* And each names its own cause rather than a shared shrug. The generic fallback exists for a
       class this table has not met; a case here reaching it would be a hole. */
    expect(sentences.filter((s) => /cannot be used\. Check the host name and try again\./.test(s))).toHaveLength(0);
    expect(sentences.some((s) => /could not be found/.test(s))).toBe(true);
    expect(sentences.some((s) => /private network/.test(s))).toBe(true);
    expect(sentences.some((s) => /^Enter the /.test(s))).toBe(true);
  });

  it("names WHICH of the two servers is at fault", async () => {
    const incoming = await refusal("mail.typo.example", [], "imap");
    const outgoing = await refusal("mail.typo.example", [], "smtp");
    expect(incoming.message).toContain("incoming (IMAP)");
    expect(outgoing.message).toContain("outgoing (SMTP)");
    expect(incoming.message).not.toBe(outgoing.message);
  });

  /**
   * THE PORT CAP IS ALREADY OURS and must pass through untouched — it carries the port the person
   * typed, which the SSRF classes never see. A mapping that rewrote everything would replace it
   * with a sentence that cannot name the port.
   */
  it("the port cap keeps its own sentence, and names the ports that work", async () => {
    const said = await refusal("mail.example.com", ["93.184.216.34"], "imap", 22);
    expect(said.message).toContain("port 22");
    expect(said.message).toContain("143, 993");
    const smtp = await refusal("mail.example.com", ["93.184.216.34"], "smtp", 22);
    expect(smtp.message).toContain("25, 465, 587");
  });

  /**
   * ANTI-VACUITY, and the thing the mapping is FOR: without it these are the strings a person
   * reads. Driving the bare guard proves the sentences above are the mapping's work and not
   * something the gate was already saying.
   */
  it("the unmapped guard really does answer with the parameter name", async () => {
    await expect(guard().check("mail.typo.example", undefined, "imap")).rejects.toMatchObject({
      message: "u is not a permitted url: host did not resolve",
    });
  });
});

/* ── the wiring: the probes, not just the mapper ──────────────────────────────────────────── */

function deps(g: ReturnType<typeof makeProbeHostGuard>): ApiDeps {
  return {
    db: {} as ApiDeps["db"],
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    // The probe keys its slot by the deployment's keyed hash of the address.
    keyProvider: StaticKeyProvider.fromSecret(Buffer.alloc(32, 5)),
    services: {
      imapAdmission: { acquire: async () => true, release: async () => { /* counted elsewhere */ } },
      probeHostGuard: g,
    } as unknown as ApiDeps["services"],
  } as ApiDeps;
}

const neverDials = (): ProbeDialer => ({
  connect: async () => { throw new Error("the guard must have refused before any dial"); },
  close: async () => { /* nothing held */ },
});

describe("both add-time probes answer through the mapping", () => {
  it("the IMAP probe refuses a mistyped host in words", async () => {
    const probe = makeImapProbe(deps(guard()), { adapterFactory: neverDials });
    await expect(probe({
      accountId: "a", address: "someone@example.com",
      imap: { host: "mail.typo.example", user: "someone@example.com", pass: "x" },
    })).rejects.toMatchObject({
      message: "That incoming (IMAP) server address could not be found. Check the host name for a typo.",
    });
  });

  it("the submission probe refuses one in its own words", async () => {
    const probe = makeSmtpProbe(deps(guard("127.0.0.1")), { dial: async () => { throw new Error("no dial"); } });
    await expect(probe({
      accountId: "a", address: "someone@example.com",
      smtp: { host: "mail.lan.example", user: "someone@example.com", pass: "x" },
    })).rejects.toMatchObject({
      message: "That outgoing (SMTP) server address points inside a private network and cannot be used here.",
    });
  });
});

describe("a self-hosted server names the switch its operator can change (R23-03)", () => {
  const selfHost = (...addrs: string[]) => makeProbeHostGuard(resolves(...addrs), { privateSwitch: "TF_PROBE_ALLOW_PRIVATE" });
  const refusedBy = async (g: ReturnType<typeof makeProbeHostGuard>, host: string, leg: "imap" | "smtp"): Promise<string> => {
    const err = await g.check(host, undefined, leg).then(() => null, (e: unknown) => e);
    expect(err, `${host} was not refused`).not.toBeNull();
    return (probeHostRefusal(err, leg) as ServiceError).message;
  };

  it("a mail server on the operator's own network is refused with the switch named", async () => {
    for (const [host, addrs] of [["mail.lan.example", ["192.168.1.20"]], ["mail.home.arpa", []]] as const) {
      const said = await refusedBy(selfHost(...addrs), host, "imap");
      expect(said, host).toContain("TF_PROBE_ALLOW_PRIVATE=1 on the api and the organizer");
    }
  });

  it("a typo is not told about the switch, and Cloud's guard names none", async () => {
    expect(await refusedBy(selfHost(), "mail.typo.example", "imap")).not.toContain("TF_PROBE_ALLOW_PRIVATE");
    expect(await refusedBy(guard("192.168.1.20"), "mail.lan.example", "smtp")).not.toContain("TF_PROBE_ALLOW_PRIVATE");
  });
});
