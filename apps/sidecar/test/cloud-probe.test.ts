import { describe, expect, it } from "vitest";
import { fixturePassword } from "../../../test/support/fixture-credentials.js";
import { describeProbeFailure, probeCloudDoor, probeCloudServer } from "../src/cloud-engine.js";
import {
  apiBaseFor, baseIsForeign, normalizeBase, normalizeOrigin, OPERATOR_CA_FILE,
} from "../src/cloud-origin.js";

/**
 * THE SELF-HOSTED DOOR'S PROBE — every branch is a SENTENCE somebody reads at the exact moment
 * they are least able to guess what went wrong, so every branch is driven here.
 *
 * The refusals are the point of the route. A door that only said "could not connect" would send an
 * operator to look at their firewall when what is wrong is that their server issues its own
 * certificates, or that they typed the address of their router. Each case below pins the ONE fact
 * that makes its sentence actionable, and every one of them pins that the ADDRESS THAT WAS TRIED
 * appears in the message — the single thing that turns a support thread into a fixed typo.
 */

const BASE = "https://ohmail.example.com/api";
const TARGET = `${BASE}/hello`;

/** An error shaped the way `fetch` raises one: a wrapper whose `cause` carries the real code. */
const thrown = (code: string): unknown =>
  Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });

const body = async (res: Response): Promise<any> => await res.json();

describe("describeProbeFailure", () => {
  it("names a PRIVATE CA for what it is, and points at the file that fixes it", () => {
    const [message, kind] = describeProbeFailure(thrown("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"), TARGET);
    expect(kind).toBe("tls_trust");
    expect(message).toContain(TARGET);
    // The whole value of this branch: the operator is told WHAT this looks like from here and
    // WHERE to put the certificate. A generic "could not connect" is what it replaced.
    expect(message).toContain("issues its own certificates");
    expect(message).toContain(OPERATOR_CA_FILE);
    /* AND IT SAYS OUT LOUD THAT IT WILL NOT SKIP VERIFICATION, which is the claim being pinned —
       nothing in this app can turn certificate checking off, and a sentence that left that open
       invites somebody to go looking for the switch. The forbidden list is OFFERS, phrased as they
       would actually appear; a bare word-blacklist would forbid this sentence's own refusal. */
    expect(message).toMatch(/will not skip|does not skip|never skips/i);
    expect(message).not.toMatch(
      /connect anyway|continue anyway|proceed anyway|trust it anyway|ignore (this|the certificate)|disable (certificate )?(verification|checking)|allow insecure/i,
    );
  });

  it("classifies every code Node raises for an untrusted chain the same way", () => {
    for (const code of [
      "UNABLE_TO_GET_ISSUER_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "CERT_UNTRUSTED",
    ]) {
      expect(describeProbeFailure(thrown(code), TARGET)[1]).toBe("tls_trust");
    }
  });

  it("tells a WRONG-NAME certificate from an untrusted one — different fix, different sentence", () => {
    const [message, kind] = describeProbeFailure(thrown("ERR_TLS_CERT_ALTNAME_INVALID"), TARGET);
    expect(kind).toBe("tls_name");
    expect(message).toContain("different name");
    // Installing a CA would not help here, so the CA file is deliberately NOT named.
    expect(message).not.toContain(OPERATOR_CA_FILE);
  });

  it("tells an expired certificate from both of those", () => {
    expect(describeProbeFailure(thrown("CERT_HAS_EXPIRED"), TARGET)[1]).toBe("tls_validity");
    expect(describeProbeFailure(thrown("CERT_NOT_YET_VALID"), TARGET)[1]).toBe("tls_validity");
  });

  it("says the NAME does not resolve rather than blaming the server", () => {
    const [message, kind] = describeProbeFailure(thrown("ENOTFOUND"), TARGET);
    expect(kind).toBe("dns");
    expect(message).toContain(TARGET);
  });

  it("tells a refused port from a timeout", () => {
    expect(describeProbeFailure(thrown("ECONNREFUSED"), TARGET)[1]).toBe("refused");
    expect(describeProbeFailure(thrown("UND_ERR_CONNECT_TIMEOUT"), TARGET)[1]).toBe("timeout");
    // `AbortSignal.timeout` rejects with a DOMException whose NAME, not code, says what happened.
    expect(describeProbeFailure(Object.assign(new Error("aborted"), { name: "TimeoutError" }), TARGET)[1])
      .toBe("timeout");
  });

  /**
   * THE SHAPE `fetch` ACTUALLY THROWS, measured against the running self-host stack with its CA
   * withheld: `TypeError(fetch failed)` wrapping the real error. A classifier that read only the
   * outer error would call every failure "unreachable".
   */
  it("reads the code off the CAUSE, because fetch never throws the real error", () => {
    const wrapped = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("unable to get local issuer certificate"), {
        code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      }),
    });
    expect(describeProbeFailure(wrapped, TARGET)[1]).toBe("tls_trust");
  });

  /**
   * AND THROUGH AN `AggregateError`, which is what undici reports for a host that resolves to more
   * than one address — every dual-stack server, so most of them. It has no `code` and no `cause`;
   * a walker that followed only `cause` would report "unreachable" for a certificate problem it
   * was holding. Found while running the door against a real stack.
   */
  it("reads the code out of an AggregateError — a dual-stack host is the normal case", () => {
    const aggregate = new AggregateError(
      [
        Object.assign(new Error("connect ECONNREFUSED ::1:8443"), { code: "ECONNREFUSED" }),
        Object.assign(new Error("unable to get local issuer certificate"), {
          code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        }),
      ],
      "all attempts failed",
    );
    const wrapped = Object.assign(new TypeError("fetch failed"), { cause: aggregate });
    // The FIRST attempt's answer — the one the connection would have used.
    expect(describeProbeFailure(wrapped, TARGET)[1]).toBe("refused");
    // …and the certificate problem is found when it is the one that was tried.
    const tlsOnly = Object.assign(new TypeError("fetch failed"), {
      cause: new AggregateError([aggregate.errors[1]], "all attempts failed"),
    });
    expect(describeProbeFailure(tlsOnly, TARGET)[1]).toBe("tls_trust");
  });

  it("survives a cycle in the cause chain rather than spinning", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(describeProbeFailure(a, TARGET)[1]).toBe("unreachable");
  });

  it("falls back without pretending to know, and still names what was tried", () => {
    const [message, kind] = describeProbeFailure(new Error("something odd"), TARGET);
    expect(kind).toBe("unreachable");
    expect(message).toContain(TARGET);
    expect(message).toContain("something odd");
  });
});

describe("probeCloudServer", () => {
  const hello = (payload: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(payload), {
      status: 200, headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  it("accepts an ohmail server and reports what it said about itself", async () => {
    const res = await probeCloudServer(BASE, hello({
      product: "ohmail", flavor: "selfhost", needsSetup: false, auth: { password: true, totp: true },
    }));
    expect(res.status).toBe(200);
    const out = await body(res);
    expect(out.ok).toBe(true);
    expect(out.flavor).toBe("selfhost");
    expect(out.target).toBe(TARGET);
  });

  it("asks `/hello` on the CONFIGURED base and nothing else", async () => {
    const seen: string[] = [];
    await probeCloudServer(BASE, (async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ product: "ohmail" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);
    expect(seen).toEqual([TARGET]);
  });

  it("REFUSES a server that answers but is not ohmail — the address is wrong, not the password", async () => {
    // What a router's admin page, a NAS, a parked domain and a default nginx all look like.
    const res = await probeCloudServer(BASE, hello({ status: "ok", service: "something-else" }));
    expect(res.status).toBe(502);
    const out = await body(res);
    expect(out.error.code).toBe("cloud_probe_failed");
    expect(out.error.details.kind).toBe("not_ohmail");
    expect(out.error.message).toContain(TARGET);
  });

  /**
   * ── TWO ANSWERS THAT ARE AN OHMAIL SERVER AND STILL NOT ONE TO SIGN IN TO ───────────────────
   *
   * Both were reaching the password form, because every 2xx read as success and the greeting's own
   * fields were rendered and then ignored. Raised by review.
   */
  it("REFUSES a server that has not been set up — there are no accounts to sign in to", async () => {
    const res = await probeCloudServer(BASE, hello({
      product: "ohmail", flavor: "selfhost", needsSetup: true,
    }));
    const out = await body(res);
    expect(out.error.details.kind).toBe("needs_setup");
    // And it names the page that fixes it — the ORIGIN, not the API path the probe used.
    expect(out.error.message).toContain("https://ohmail.example.com");
    expect(out.error.message).not.toContain("/api/hello");
  });

  it("REFUSES the HOSTED service on this door, and names the door that is for it", async () => {
    const res = await probeCloudServer(BASE, hello({
      product: "ohmail", flavor: "managed", needsSetup: false,
    }));
    const out = await body(res);
    expect(out.error.details.kind).toBe("managed");
    expect(out.error.message).toContain("ohmail Cloud");
  });

  it("REFUSES a 200 that is not JSON at all", async () => {
    const res = await probeCloudServer(BASE, (async () =>
      new Response("<html>hello</html>", { status: 200 })) as unknown as typeof fetch);
    expect((await body(res)).error.details.kind).toBe("not_ohmail");
  });

  it("REFUSES a non-2xx and names the status it got", async () => {
    const res = await probeCloudServer(BASE, (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch);
    const out = await body(res);
    expect(out.error.details.kind).toBe("status");
    expect(out.error.message).toContain("404");
    expect(out.error.message).toContain(TARGET);
  });

  /**
   * ── A FRAGMENT IN THE BASE IS NOT COSMETIC: IT MOVES THE REQUEST ────────────────────────────
   *
   * Every URL this process composes is `base + path`. A base carrying `#` makes the path part of a
   * fragment, which is never sent — `http://127.0.0.1:9000#/` + `/hello` goes out as `GET /` at
   * that address, and so does every other route the engine composes. The window can choose the
   * configured base (`engine_configure` is one of its commands), so this is reachable rather than
   * theoretical; raised by review of this slice.
   *
   * `createCloudSidecar` re-composes the base from its parsed parts before anything uses it, so a
   * fragment cannot survive to a request. This case pins the property at the parser, which is where
   * it is decided.
   */
  it("a fragment, a query or userinfo is REFUSED rather than dropped", () => {
    // REFUSED, and the distinction matters twice. Dropping would make two DIFFERENT bases compare
    // EQUAL — `https://gateway/api` and `https://gateway/api?upstream=b` are plausibly two backends
    // behind one gateway — which is the comparison that lets a sealed session survive a move
    // between them. And a dropped component is a value the caller believed it had configured.
    expect(normalizeBase("http://127.0.0.1:9000#/")).toBeNull();
    expect(normalizeBase("https://ohmail.example.com/api#/")).toBeNull();
    expect(normalizeBase("https://ohmail.example.com/api?x=1")).toBeNull();
    expect(normalizeBase(`https://someone:${fixturePassword("cloud-probe")}@ohmail.example.com/api`)).toBeNull();
    // So the two gateway spellings are NOT the same server, and neither is usable as a base.
    expect(baseIsForeign("https://gateway/api", "https://gateway/api?upstream=b")).toBe(false);
    expect(normalizeBase("https://gateway/api?upstream=b")).toBeNull();
  });

  it("carries a thrown transport failure through the classifier", async () => {
    const res = await probeCloudServer(BASE, (async () => {
      throw thrown("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
    }) as unknown as typeof fetch);
    const out = await body(res);
    expect(out.error.details.kind).toBe("tls_trust");
    expect(out.error.message).toContain(OPERATOR_CA_FILE);
  });
});

/**
 * THE ADDRESS A PERSON TYPES, AND THE BASE IT BECOMES.
 *
 * `<origin>/api` is not a convenience: measured on both deployments, `https://ohmail.test/sync`
 * answers `404 text/html` from the Next app while `https://ohmail.test/api/sync` answers `401` from
 * the API — and the hosted service canonicalizes one leading `/api` off itself, so the same
 * suffix works there too. A door that used the bare origin would sign in and then sync nothing.
 */
describe("normalizeOrigin", () => {
  it("adds https to a bare host — the only value it ever invents, and never a downgrade", () => {
    expect(normalizeOrigin("ohmail.example.com")).toBe("https://ohmail.example.com");
    expect(normalizeOrigin("  OHMAIL.Example.com  ")).toBe("https://ohmail.example.com");
  });

  it("keeps an explicit scheme and an explicit non-default port", () => {
    expect(normalizeOrigin("http://localhost")).toBe("http://localhost");
    expect(normalizeOrigin("https://ohmail.example.com:8443")).toBe("https://ohmail.example.com:8443");
    // A default port spelled out is the same origin, and the platform's own parser says so.
    expect(normalizeOrigin("https://ohmail.example.com:443")).toBe("https://ohmail.example.com");
  });

  /**
   * ── CLEARTEXT IS LOOPBACK-ONLY, AND THIS CASE IS WHY THE DOOR'S PROMISE IS TRUE ─────────────
   *
   * `http://` skips TLS entirely: no certificate, no server authentication. The address step tells
   * somebody that ohmail verifies certificates and has no way to skip that, and while cleartext was
   * accepted for any hostname that sentence was false — an on-path peer answers the probe with
   * `{"product":"ohmail"}`, the door advances, and the account password and the authenticator code
   * are posted to whoever is listening. Raised by review of this slice.
   */
  it("REFUSES cleartext off loopback — the door's own promise depends on it", () => {
    expect(normalizeOrigin("http://ohmail.example.com")).toBeNull();
    // A LAN address is NOT loopback. Every other machine on that network can reach it, which is
    // exactly where an on-path peer would be.
    expect(normalizeOrigin("http://192.168.1.20")).toBeNull();
    expect(normalizeOrigin("http://10.0.0.5:8080")).toBeNull();
    expect(normalizeOrigin("http://mail.lan")).toBeNull();
    // …and https on those is fine, because then there is a certificate to verify.
    expect(normalizeOrigin("https://mail.lan")).toBe("https://mail.lan");
  });

  it("ACCEPTS cleartext on loopback, which the self-host stack documents and supports", () => {
    expect(normalizeOrigin("http://localhost")).toBe("http://localhost");
    expect(normalizeOrigin("http://localhost:8080")).toBe("http://localhost:8080");
    expect(normalizeOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeOrigin("http://127.1.2.3")).toBe("http://127.1.2.3");
    expect(normalizeOrigin("http://[::1]:8080")).toBe("http://[::1]:8080");
    // `*.localhost` is loopback by the URL standard's own definition.
    expect(normalizeOrigin("http://ohmail.localhost")).toBe("http://ohmail.localhost");
  });

  it("REFUSES a path rather than guessing which half was meant", () => {
    // `https://…/api` composed with apiBaseFor would be `/api/api`, which 404s after the API
    // canonicalizes one `/api` off. The stack's own OHMAIL_ORIGIN is scheme + host and nothing else.
    expect(normalizeOrigin("https://ohmail.example.com/api")).toBeNull();
    expect(normalizeOrigin("https://ohmail.example.com/mail/")).toBeNull();
  });

  it("REFUSES embedded credentials — a password must never reach a settings file this way", () => {
    expect(normalizeOrigin(`https://someone:${fixturePassword("cloud-probe")}@ohmail.example.com`)).toBeNull();
  });

  it("REFUSES a query, a fragment, a foreign scheme and an empty value", () => {
    expect(normalizeOrigin("https://ohmail.example.com?x=1")).toBeNull();
    expect(normalizeOrigin("https://ohmail.example.com#x")).toBeNull();
    expect(normalizeOrigin("ftp://ohmail.example.com")).toBeNull();
    expect(normalizeOrigin("file:///etc/passwd")).toBeNull();
    expect(normalizeOrigin("   ")).toBeNull();
  });

  it("derives the API base the same way for both deployment shapes", () => {
    expect(apiBaseFor("https://ohmail.example.com")).toBe("https://ohmail.example.com/api");
    expect(apiBaseFor("https://ohmail.example.com/")).toBe("https://ohmail.example.com/api");
    // A FLAVOR THAT IS NOT THE FOURTH DOOR CHANGES NOTHING, absent included. Every caller that
    // predates the desktop-host door means exactly what it always meant.
    expect(apiBaseFor("https://ohmail.example.com", null)).toBe("https://ohmail.example.com/api");
    expect(apiBaseFor("https://ohmail.example.com", "selfhost")).toBe("https://ohmail.example.com/api");
    expect(apiBaseFor("https://ohmail.example.com", "managed")).toBe("https://ohmail.example.com/api");
    expect(apiBaseFor("https://ohmail.example.com", "local")).toBe("https://ohmail.example.com/api");
  });
});

describe("baseIsForeign", () => {
  it("is TRUE only on a positive disagreement", () => {
    expect(baseIsForeign("https://api.ohmail.app", "https://ohmail.example.com/api")).toBe(true);
  });

  it("is FALSE when either side cannot be compared — the one-sided default", () => {
    // An install written before the server joined the record. Wiping it would throw away a
    // working mailbox to close a case it cannot be in.
    expect(baseIsForeign(null, "https://api.ohmail.app")).toBe(false);
    expect(baseIsForeign("https://api.ohmail.app", null)).toBe(false);
    expect(baseIsForeign("not a url", "https://api.ohmail.app")).toBe(false);
  });

  it("is FALSE across the spellings the URL standard calls the same", () => {
    expect(baseIsForeign("https://ohmail.example.com/api", "https://OHMAIL.example.com:443/api/")).toBe(false);
    expect(normalizeBase("https://ohmail.example.com:443/api/")).toBe("https://ohmail.example.com/api");
  });

  it("is TRUE across a scheme change — http and https are not the same server to talk to", () => {
    expect(baseIsForeign("https://ohmail.example.com/api", "http://ohmail.example.com/api")).toBe(true);
  });
});

/**
 * THE FOURTH DOOR — a desktop opening a mailbox another desktop is holding.
 *
 * A desktop host serves its API at the ROOT: one process, one route table mounted at `/`, no web
 * app beside it to disambiguate from. Composing `<origin>/api` for it asks a router that has never
 * heard of `/api`, which answers 404 — and the door then reported "that is not an ohmail server"
 * about a machine that was running one. That was every part of the client working and three
 * characters composed in the wrong place, so the case is driven here from both ends: the
 * derivation, and the discovery that supplies its input.
 */
describe("apiBaseFor — the desktop-host flavor", () => {
  it("leaves the origin alone, because the API is the root there", () => {
    expect(apiBaseFor("https://desk.tail1234.ts.net", "desktop-host")).toBe("https://desk.tail1234.ts.net");
    expect(apiBaseFor("https://192.168.1.20:6245/", "desktop-host")).toBe("https://192.168.1.20:6245");
  });
});

describe("probeCloudDoor — root first, then /api", () => {
  const ORIGIN = "https://desk.example";
  const greeting = (flavor: string): Response =>
    new Response(JSON.stringify({ product: "ohmail", flavor, needsSetup: false, auth: {} }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  /** What a self-host stack's ROOT actually serves: Caddy hands `/hello` to the web container. */
  const nextPage = (): Response => new Response("<!doctype html><title>404</title>", { status: 404 });

  const driver = (answer: (url: string) => Response | Error): { tried: string[]; impl: typeof fetch } => {
    const tried: string[] = [];
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      tried.push(url);
      const out = answer(url);
      if (out instanceof Error) throw out;
      return out;
    }) as unknown as typeof fetch;
    return { tried, impl };
  };

  it("finds a desktop host at the ROOT and reports the base that answered", async () => {
    const { tried, impl } = driver((url) =>
      url === `${ORIGIN}/hello` ? greeting("desktop-host") : new Response(null, { status: 404 }));

    const res = await probeCloudDoor(ORIGIN, impl);

    expect(res.ok).toBe(true);
    const b = await body(res);
    expect(b.flavor).toBe("desktop-host");
    // THE BASE IS THE ORIGIN, and it comes back from the probe rather than being recomposed by a
    // window that has no way to know which of the two shapes answered.
    expect(b.base).toBe(ORIGIN);
    // AND `/api` WAS NEVER DIALLED — the root answered, so there is nothing to fall back to.
    expect(tried).toEqual([`${ORIGIN}/hello`]);
  });

  it("falls back to /api when the root is a web app, which is what a self-host stack looks like", async () => {
    const { tried, impl } = driver((url) =>
      url === `${ORIGIN}/api/hello` ? greeting("selfhost") : nextPage());

    const res = await probeCloudDoor(ORIGIN, impl);

    expect(res.ok).toBe(true);
    const b = await body(res);
    expect(b.flavor).toBe("selfhost");
    expect(b.base).toBe(`${ORIGIN}/api`);
    // BOTH, IN ORDER. The root is tried first and its 404 is what licenses the second dial.
    expect(tried).toEqual([`${ORIGIN}/hello`, `${ORIGIN}/api/hello`]);
  });

  it("does NOT dial twice for a machine that is not there", async () => {
    const { tried, impl } = driver(() =>
      Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) }) as unknown as Error);

    const res = await probeCloudDoor(ORIGIN, impl);

    expect(res.ok).toBe(false);
    // A TRANSPORT FAILURE IS A FACT ABOUT THE ADDRESS. Repeating it at a longer path produces the
    // same failure and a worse sentence — one that names `…/api/hello` and sends somebody looking
    // for a path that was never the problem.
    expect(tried).toEqual([`${ORIGIN}/hello`]);
    expect((await body(res)).error.details.target).toBe(`${ORIGIN}/hello`);
  });

  it("does NOT dial twice for an ohmail server it has already identified and refused", async () => {
    const { tried, impl } = driver(() => greeting("managed"));

    const res = await probeCloudDoor(ORIGIN, impl);

    expect(res.ok).toBe(false);
    expect((await body(res)).error.details.kind).toBe("managed");
    // Dialling it again cannot change what it is.
    expect(tried).toEqual([`${ORIGIN}/hello`]);
  });

  it("refuses a desktop that is NOT offering itself, and says where to turn that on", async () => {
    const { impl } = driver(() => greeting("local"));

    const res = await probeCloudDoor(ORIGIN, impl);

    expect(res.ok).toBe(false);
    const b = await body(res);
    expect(b.error.details.kind).toBe("local");
    // The two desktop surfaces differ by this field alone, and the sentence is the difference
    // between "turn it on over there" and an error about a pairing code three screens later.
    expect(b.error.message).toContain("Settings → Devices");
    expect(b.error.message).toContain(`${ORIGIN}/hello`);
  });

  it("reports the /api attempt when neither answered as ohmail", async () => {
    const { tried, impl } = driver(() => nextPage());

    const res = await probeCloudDoor(ORIGIN, impl);

    expect(res.ok).toBe(false);
    expect(tried).toEqual([`${ORIGIN}/hello`, `${ORIGIN}/api/hello`]);
    // The SECOND attempt's sentence, because the second is the one that could have worked for the
    // server shape this fallback exists for.
    expect((await body(res)).error.details.target).toBe(`${ORIGIN}/api/hello`);
  });

  it("does not consume the refusal body it hands back", async () => {
    /* THE CASE WHERE THE ORIGINAL IS RETURNED, which is the only case this can be about. When the
       root's refusal is final the classifier has just read that very response and then hands it to
       the window — so it must read a CLONE. Reading the original gives the window a 502 with
       nothing in it, which renders as the engine having failed rather than as the server having
       answered, and sends somebody to look at the wrong machine.

       A fall-through case cannot measure this: there the response handed back is the SECOND
       probe's, freshly made, and it reads fine however the first one was consumed. The first
       spelling of this test used exactly that case and was green with the clone removed. */
    const { impl } = driver(() => greeting("managed"));

    const res = await probeCloudDoor(ORIGIN, impl);

    expect(res.ok).toBe(false);
    const b = await body(res);
    expect(b.error.message, "the refusal arrived with its body already read").toContain("hosted ohmail service");
    expect(b.error.details.kind).toBe("managed");
  });
});
