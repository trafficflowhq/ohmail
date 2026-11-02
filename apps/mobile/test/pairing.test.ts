/**
 * THE CONNECTION LAYER: /hello gating, the QR link, the redeem, and the lives of a pairing.
 *
 * Everything here drives the REAL seam (`src/net/pairing.ts` + the BearerManager + `bootEngine`)
 * against a real loopback HTTP server (`helpers/pair-server.ts`) speaking the frozen wires —
 * and that server is PLAIN HTTP on purpose: the desktop-host LAN door is plain http, a probe proved
 * the served browser client cannot use it (three [SecureContext] dependencies), and the ruling's
 * §1b win is that this native client can. The suite asserting a full pair + drain over an
 * `http://` origin, plus the census proving the seam never references the secure-context
 * machinery, is that claim held headlessly; the real-phone LAN row is the live acceptance.
 *
 * The gating discipline (never a dead button): a pairing step exists exactly when the server's
 * `features.pairing` says so — force `nextStep` to always offer pairing and the no-redeem
 * assertions below go red, because the flow would then die mid-ceremony on a route the
 * descriptor said is absent.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Copy } from "../src/copy";
import { refuse, sayRefusal } from "../src/refusal";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mirrorDbName, pairLink, shortPin } from "@ohmail/client-engine";
import type { MobileEngineDeps } from "../src/engine/boot";
import {
  admitOrigin,
  connectProfile,
  connectProfileById,
  mobileDeviceKind,
  negotiate,
  nextStep,
  parsePairLink,
  pairWithServer,
  pendingPairOrigin,
  probePairing,
  revokeProfile,
  stashPairOrigin,
  type HelloAnswer,
  type MobileDeviceKind,
  type PairingEnv,
} from "../src/net/pairing";
import { BearerRegistry } from "../src/net/bearer-registry";
import { ServerProfileStore, type SecureKV } from "../src/state/servers";
import { listen, pairServer, pairThroughConfirm, sqlWorld } from "./helpers/pair-server";

function memoryKV(): SecureKV {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
  };
}

function testEnv(deviceKind?: MobileDeviceKind): { env: PairingEnv; world: ReturnType<typeof sqlWorld> } {
  const world = sqlWorld();
  const deps: MobileEngineDeps = {
    openExecutor: world.open,
    deleteDatabase: world.drop,
    uuid: () => "00000000-0000-4000-8000-000000000000",
  };
  return {
    env: {
      profiles: new ServerProfileStore(memoryKV()),
      engineDeps: deps,
      ...(deviceKind ? { deviceKind } : {}),
    },
    world,
  };
}

/* ── the QR / copy-link parser ──────────────────────────────────────────────────────────────── */

/** A well-formed pin: 32 bytes of base64url, unpadded — 43 characters. */
const PIN = "k5PGuAY8E5LFpWM0zgqW20AuzK_KKxn8dKZsV6QmpWg";

describe("parsePairLink — the `${origin}/pair#${fragment}` shape, both forms", () => {
  it("splits a tailnet https link and a same-network link alike", () => {
    expect(parsePairLink("https://desk.tail1234.ts.net/pair#tok_abc-123")).toEqual({
      origin: "https://desk.tail1234.ts.net",
      token: "tok_abc-123",
      pin: null,
    });
    expect(parsePairLink("http://192.168.1.20:8028/pair#LANtoken")).toEqual({
      origin: "http://192.168.1.20:8028",
      token: "LANtoken",
      pin: null,
    });
    // Normalized: case and the trailing path slash collapse to one origin, one mirror.
    expect(parsePairLink("HTTPS://Desk.Example/pair/#t1")).toEqual({
      origin: "https://desk.example",
      token: "t1",
      pin: null,
    });
  });

  it("reads the PINNED form — the door's key fingerprint beside the token", () => {
    expect(parsePairLink(`https://192.168.1.20:6245/pair#k1.${PIN}.tok-lan`)).toEqual({
      origin: "https://192.168.1.20:6245",
      token: "tok-lan",
      pin: PIN,
    });
  });

  it("REFUSES a malformed pinned fragment rather than falling back to an unpinned pairing", () => {
    // THE POINT OF THIS TEST. Every one of these strings could be read as "a token that happens
    // to start with k1." by a lenient parser, and the result would be a pairing over TLS nobody
    // checked — which is exactly the property the pin exists to provide.
    for (const bad of [
      `https://h.example/pair#k1.${PIN}`,          // no token half
      `https://h.example/pair#k1.${PIN}.`,         // empty token half
      "https://h.example/pair#k1.short.tok",       // fingerprint is not 32 bytes
      `https://h.example/pair#k1.${PIN}+.tok`,     // not base64url
      `https://h.example/pair#k1..tok`,            // no fingerprint at all
    ]) {
      expect(parsePairLink(bad), bad).toBeNull();
    }
  });

  it("REFUSES a version this build has never heard of — by name, not by misreading it", () => {
    // A `k2` fragment handed to an older app must not be redeemed as a token: it would burn a
    // single-use code and report "that pairing code was not accepted", which sends somebody
    // hunting for a problem that is really "this phone needs an update".
    expect(parsePairLink(`https://h.example/pair#k2.${PIN}.tok`)).toBeNull();
    expect(parsePairLink(`https://h.example/pair#k99.${PIN}.tok`)).toBeNull();
    // …while a token that merely LOOKS versioned is still a token: the prefix is `k<digits>`.
    expect(parsePairLink("https://h.example/pair#key1.abc")).toEqual({
      origin: "https://h.example", token: "key1.abc", pin: null,
    });
  });

  it("round-trips what the desktop composes — the composer and the parser are one definition", () => {
    // `pairLink` is what `DesktopDevices.tsx` calls. If these two ever disagreed, the failure
    // would land on somebody's kitchen table with a camera pointed at a screen.
    expect(parsePairLink(pairLink("https://10.0.2.15:6245", "tok-xyz", PIN)))
      .toEqual({ origin: "https://10.0.2.15:6245", token: "tok-xyz", pin: PIN });
    expect(parsePairLink(pairLink("https://desk.tail1234.ts.net", "tok-ts", null)))
      .toEqual({ origin: "https://desk.tail1234.ts.net", token: "tok-ts", pin: null });
  });

  it("REFUSES a query-borne token — the flow-3 regression — and every other malformed shape", () => {
    // The safe shape must not regress by convenience: a token in the query would ride access
    // logs and Referers, so it is refused outright, not parsed leniently.
    expect(parsePairLink("https://h.example/pair?token=abc")).toBeNull();
    expect(parsePairLink("https://h.example/pair?x=1#abc")).toBeNull();
    expect(parsePairLink("https://h.example/pair/abc")).toBeNull(); // token in the path
    expect(parsePairLink("https://h.example/join#abc")).toBeNull(); // not the pair path
    expect(parsePairLink("ftp://h.example/pair#abc")).toBeNull(); // not a redeemable scheme
    expect(parsePairLink("https://h.example/pair#")).toBeNull(); // no token at all
    expect(parsePairLink("https://h.example/pair")).toBeNull();
    expect(parsePairLink("not a link")).toBeNull();
    expect(parsePairLink("")).toBeNull();
  });
});

/* ── /hello negotiation + the picker's gate ─────────────────────────────────────────────────── */

const hello = (over: Partial<HelloAnswer>): HelloAnswer => ({
  flavor: "selfhost",
  pairing: false,
  needsSetup: false,
  apiVersion: "1",
  ...over,
});

describe("nextStep — a pairing step exists exactly when features.pairing says so", () => {
  it("offers the pair step on pairing:true, whatever the flavor", () => {
    expect(nextStep(hello({ pairing: true }))).toEqual({ kind: "pair" });
    expect(nextStep(hello({ pairing: true, flavor: "desktop-host" }))).toEqual({ kind: "pair" });
    expect(nextStep(hello({ pairing: true, flavor: "managed" }))).toEqual({ kind: "pair" });
  });

  it("NEVER offers pairing on pairing:false — the dead-button rule, and an honest deferral", () => {
    // The managed service mounts no redeem today (device pairing mounts as its own change), so
    // the card says sign-in-arrives-later instead of showing a step that would 404 mid-flow.
    expect(nextStep(hello({ flavor: "managed" }))).toEqual({ kind: "managed-signin-later" });
    expect(nextStep(hello({ flavor: "selfhost" }))).toEqual({ kind: "no-pairing", flavor: "selfhost" });
    expect(nextStep(hello({ flavor: "local" }))).toEqual({ kind: "no-pairing", flavor: "local" });
  });
});

describe("negotiate — the /hello probe", () => {
  const scripted = (answer: () => Response | Error) => async () => {
    const out = answer();
    if (out instanceof Error) throw out;
    return out;
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("reads the frozen wire, treating a malformed capability as an absent ceremony", async () => {
    const answer = await negotiate(
      scripted(() =>
        json(200, {
          product: "ohmail", flavor: "selfhost", apiVersion: "3", needsSetup: false,
          features: { sse: true, staging: false, ai: false, pairing: "yes" }, // not `true`
        }),
      ),
      "HTTP://Host.example/",
    );
    expect(answer).toEqual({
      kind: "hello",
      hello: { flavor: "selfhost", pairing: false, needsSetup: false, apiVersion: "3" },
    });
  });

  it("a non-ohmail answer, a refusing server and a dead network are three distinct sentences", async () => {
    expect((await negotiate(scripted(() => json(200, { hello: "world" })), "http://x.example")).kind).toBe("not-ohmail");
    expect((await negotiate(scripted(() => new Response("<html>", { status: 200 })), "http://x.example")).kind).toBe("not-ohmail");
    expect((await negotiate(scripted(() => json(503, { error: "hello_unconfigured" })), "http://x.example")).kind).toBe("unreachable");
    expect((await negotiate(scripted(() => new TypeError("Network request failed")), "http://x.example")).kind).toBe("unreachable");
  });
});

/* ── THE PERSON IN THE MIDDLE: a scan is not a decision ─────────────────────────────────────── */

describe("the confirmation before a pairing code is spent", () => {
  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  THE RED-BEFORE, AND WHERE IT LIVES NOW
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * `pairWithServer(env, { origin, token, pin })` redeemed on the spot, and `app/scan.tsx` called
   * it from the camera's own frame callback. So a QR — a string nobody can read — made whatever
   * answered that address this phone's server, with its key pinned for the life of the pairing,
   * before anybody had seen an address. The desktop's Devices pane has claimed the opposite in
   * every shipped release since the same-network door landed: *"a device pairing over your
   * network shows these characters before it pairs."*
   *
   * That shape is no longer refused — it is UNREPRESENTABLE, and this suite proves it from three
   * directions rather than one:
   *
   *  · the SEAM (below): a probe reaches the wire and spends nothing; the redeem is a second
   *    call that needs the probe's admission. The old one-shot signature does not compile, which
   *    is a stronger statement than any assertion here and is why 31 call sites moved.
   *  · the FACTS: what the confirmation renders is what the door said about itself over the
   *    connection this pairing will use, never what the link claimed.
   *  · the SOURCE (`doors.test.ts`): the only product files that can redeem are the two screens
   *    that render the confirmation.
   */
  it("the PROBE reaches the wire and spends NOTHING — no redeem, no profile, no mirror", async () => {
    const fake = pairServer({ accountId: "acct-1", flavor: "desktop-host", sessionRoute: false });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Welcome");
      fake.mintPairToken("tok-unspent");
      const { env } = testEnv();

      const probed = await probePairing(env, { origin });
      expect(probed.kind).toBe("offers");

      // IT TALKED TO THE SERVER — anti-vacuity. A probe that made no request at all would
      // satisfy every "no redeem" assertion below while proving nothing about the split.
      expect(fake.seen.some((r) => r.url === "/hello")).toBe(true);

      // AND IT SPENT NOTHING. The single-use code is still live, no credential was minted, and
      // the keystore holds no profile — so a person who reads the confirmation and declines is
      // left exactly where they were.
      expect(
        fake.seen.filter((r) => r.url.startsWith("/pair/redeem")),
        "the probe must not touch the redeem — the token is not even passed to it",
      ).toHaveLength(0);
      expect(await env.profiles.list()).toHaveLength(0);

      // THE POSITIVE CONTROL: the ordinary case is admitted. The same token, spent through the
      // admission, pairs — so this is a gate on the CONFIRMATION and not on pairing.
      if (probed.kind !== "offers") return;
      const paired = await pairWithServer(env, { admission: probed.admission, token: "tok-unspent" });
      expect(paired.kind).toBe("paired");
      expect(fake.seen.filter((r) => r.url.startsWith("/pair/redeem"))).toHaveLength(1);
      if (paired.kind === "paired") paired.session.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("the admission names the door from the DOOR's answer, and carries the key for the eye", async () => {
    const fake = pairServer({ accountId: "acct-1", flavor: "selfhost", sessionRoute: true });
    const origin = await listen(fake.server);
    try {
      const { env } = testEnv();
      // A pin rides in the way a scanned same-network link carries one. Loopback is pin-EXEMPT
      // (`originNeedsPin`), so nothing is enforced — and the admission therefore carries NO key,
      // which is the property that keeps an unchecked value off the confirmation screen.
      const pin = "A".repeat(43);
      const probed = await probePairing(env, { origin, pin });
      expect(probed.kind).toBe("offers");
      if (probed.kind !== "offers") return;

      // THE FLAVOR IS THE SERVER'S OWN WORD, read over this connection. A link cannot carry it,
      // which is the whole reason there is no "display name" on that screen: a name in the QR is
      // the attacker's to choose, and it would label a stranger's server on the one screen built
      // to catch that.
      expect(probed.admission.flavor).toBe("selfhost");
      expect(probed.admission.origin).toBe(origin);
      expect(probed.admission.apiBase).toBe(origin);
      expect(
        probed.admission.pin,
        "loopback enforces no pin, so the admission must carry none",
      ).toBeNull();

      // WHAT THE SCREEN DRAWS IS WHAT THE DESKTOP DRAWS — one function, twelve characters, six and
      // six. Asserted on the rule rather than through this admission, because a node run cannot
      // ENFORCE a pin anywhere (loopback is exempt and `canPin()` is false elsewhere); the pinned
      // arm is the device cell, where a real key was drawn and matched byte for byte.
      expect(shortPin(pin)).toBe(`${pin.slice(0, 6)}\u2026${pin.slice(-6)}`);
      expect(shortPin(pin)).toHaveLength(13);
    } finally {
      fake.server.close();
    }
  });

  it("a server that will not pair is refused by the PROBE — the code survives the refusal", async () => {
    const fake = pairServer({ flavor: "selfhost", pairing: false });
    const origin = await listen(fake.server);
    try {
      const { env } = testEnv();
      const probed = await probePairing(env, { origin });
      expect(probed.kind).toBe("refused");
      if (probed.kind !== "refused") return;
      expect(sayRefusal(probed.reason)).toBe(sayRefusal(refuse("pairNoPairing")));
      // The point of probing first: a refusal costs a sentence, not a spent single-use code.
      expect(fake.seen.filter((r) => r.url.startsWith("/pair/redeem"))).toHaveLength(0);
    } finally {
      fake.server.close();
    }
  });

  /**
   * ── A KEY THAT DOES NOT MATCH, THROUGH THE ROUTE THAT REFUSES IT ──────────────────────────
   *
   * `host-pinning.test.ts` holds the unit halves: `isPinFailure` recognises the platform's own
   * handshake wording, and `Copy.pinChanged` says what to do about it. Neither drives the
   * PIPELINE, and a refusal is only as real as the pipeline the route runs — so this drives it
   * three times: a key this phone agreed to, first contact with a code claiming one, and an
   * address with no key at all. Each names a different event, and one arm alone licenses the
   * wrong sentence on the other two.
   *
   * The DOUBLE FAILS THE WAY PRODUCTION FAILS. A pinned handshake that the native registry
   * rejects surfaces to JS as exactly this exception, and nothing else about it is a value we
   * choose — so the fixture is the platform's own string rather than a marker.
   *
   * LOOPBACK carries the pin here on purpose: it is pin-EXEMPT (`originNeedsPin`), which is what
   * lets the value travel into the refusal branch without a native pinning module in a node run.
   * The branch under test is `pin !== null && isPinFailure(detail)`, and that is reached the same
   * way on a real phone.
   */
  const HANDSHAKE = (): TypeError => new TypeError(
    "javax.net.ssl.SSLHandshakeException: java.security.cert.CertPathValidatorException: "
    + "Trust anchor for certification path not found.",
  );

  it("a PAIRED computer's key that no longer matches is refused as a changed key", async () => {
    /* The premise of that sentence is a key this phone AGREED to, so the arm supplies one: a
       stored profile for the origin holding `PIN`. Without the row the same handshake is the
       other event entirely — the arm below. */
    const { env } = testEnv();
    await env.profiles.add({
      origin: "https://127.0.0.1:6245", flavor: "desktop-host", accountId: "acct-1",
      refreshToken: "ref-1", pin: PIN,
    });
    const refused = await probePairing(
      { ...env, fetchImpl: async () => { throw HANDSHAKE(); } },
      { origin: "https://127.0.0.1:6245", pin: PIN },
    );
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") return;
    expect(sayRefusal(refused.reason)).toBe(Copy.pinChanged);
    // THE SENTENCE ITSELF, at the seam that shows it: what happened, what to do, and what it may
    // mean — and never "try again", which is the one thing that makes this worse.
    expect(sayRefusal(refused.reason)).toContain("pair this phone again");
    expect(sayRefusal(refused.reason)).not.toMatch(/try again\b/i);
  });

  it("…and on FIRST CONTACT nothing changed — the code claimed a key that address did not present", async () => {
    /* The same handshake with no stored pairing. `pinChanged` told somebody their own computer
       had been re-keyed and to pair again with a fresh code — over an address they had never
       paired with, which is the instruction that walks them into a substituted door a second
       time. `pairing-confirms-the-origin.test.ts` drives the whole ceremony behind this. */
    const { env } = testEnv();
    const refused = await probePairing(
      { ...env, fetchImpl: async () => { throw HANDSHAKE(); } },
      { origin: "https://127.0.0.1:6245", pin: PIN },
    );
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") return;
    expect(sayRefusal(refused.reason)).toBe(Copy.pairKeyMismatch);
    expect(sayRefusal(refused.reason)).not.toContain("since you paired with it");
  });

  it("…and the SAME handshake on an UNPINNED address is not dressed up as a changed key", async () => {
    // The other arm, and it is what stops the sentence from being a catch-all: an origin with no
    // pin has no key to have changed, so a handshake failure there is the unreachable sentence.
    // One arm alone would license the wrong sentence on every certificate problem the hosted
    // service could ever have.
    //
    // It used to be that sentence WITH THE PLATFORM'S DETAIL, and the detail is gone: the
    // clause after the full stop is now one of three named causes or nothing at all, and a
    // handshake is none of the three. So the assertion below moved from "quotes the exception"
    // to "is the bare sentence and quotes nothing" — the same arm, one leak lighter.
    const handshake = new TypeError(
      "javax.net.ssl.SSLHandshakeException: Chain validation failed",
    );
    const { env } = testEnv();
    const refused = await probePairing(
      { ...env, fetchImpl: async () => { throw handshake; } },
      { origin: "https://selfhost.example" },
    );
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") return;
    expect(sayRefusal(refused.reason)).not.toBe(Copy.pinChanged);
    expect(sayRefusal(refused.reason)).toBe(Copy.pairUnreachable);
    expect(sayRefusal(refused.reason), "the platform's exception reached a person again")
      .not.toContain("Chain validation failed");
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  THE THREE FINDINGS THE SEAM REVIEW RETURNED, each with the sequence it named
   * ══════════════════════════════════════════════════════════════════════════════════════════
   */
  it("REFUSES a pinned code whose address needs no pin — an unenforced key is never shown", async () => {
    /**
     * The sequence: an attacker composes `https://attacker.example/pair#k1.<victim's fingerprint>.
     * <their token>` and serves that name behind a real certificate. `originNeedsPin` is FALSE for
     * a DNS name, correctly — the trust store verifies it — so nothing was installed, and the
     * confirmation rendered that fingerprint under "Its key" beside "the same characters as under
     * Settings → Devices there". The person compares, the characters MATCH, and the screen built
     * to catch this assures them of it.
     *
     * Refused at the transport gate, before a request: there is no honest way to show it and
     * dropping it silently leaves somebody believing they checked a key.
     */
    const admitted = admitOrigin("https://attacker.example", PIN);
    expect(admitted.ok).toBe(false);
    if (admitted.ok) return;
    expect(sayRefusal(admitted.reason)).toBe(Copy.admitPinUnenforceable);

    // THE POSITIVE CONTROL, and it is the case that must keep working: the same named origin with
    // NO pin is admitted, enforcing nothing — the hosted service and a self-host box behind a real
    // certificate, which is most pairings.
    const plain = admitOrigin("https://api.ohmail.app", null);
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(plain.enforcedPin, "a named origin enforces no pin, and must not claim one").toBeNull();
  });

  it("an admission carries only the ENFORCED key, so the screen cannot draw an unchecked one", async () => {
    // Loopback needs no pin either (`originNeedsPin` exempts it), so a probe there must answer
    // `pin: null` — which is what makes the confirmation render its no-key sentence instead of
    // twelve characters nothing verified.
    const fake = pairServer({ accountId: "acct-1", flavor: "desktop-host", sessionRoute: true });
    const origin = await listen(fake.server);
    try {
      const { env } = testEnv();
      const probed = await probePairing(env, { origin });
      expect(probed.kind).toBe("offers");
      if (probed.kind !== "offers") return;
      expect(probed.admission.pin).toBeNull();
    } finally {
      fake.server.close();
    }
  });

  it("a DIFFERENT key for an origin this phone already pairs with is refused, not installed", () => {
    /**
     * The sequence: the phone is paired with a same-network address under key K1. An attacker on
     * that network answers the address and offers a code for it carrying K2. `installPin` REPLACES
     * the registry's entry for a (host, port), so probing rewrote a LIVE pairing's trust before
     * anybody confirmed — and backing out did not restore K1. The next refresh then handed the
     * existing bearer to the attacker's machine over a socket the phone now trusted.
     *
     * A key change is a deliberate re-pair. Asserted on the transport gate, which is where the
     * install happens.
     */
    const K1 = PIN;
    const K2 = `${PIN.slice(0, 42)}${PIN.endsWith("g") ? "h" : "g"}`;
    expect(K1).not.toBe(K2);
    const changed = admitOrigin("https://192.168.1.10:6245", K2, K1);
    expect(changed.ok).toBe(false);
    if (changed.ok) return;
    expect(sayRefusal(changed.reason)).toBe(Copy.pinChanged);

    // THE POSITIVE CONTROL: the SAME key is not a change. A launch re-installs a stored pairing's
    // own pin on every boot, and reading that as a key change would refuse every cold start.
    // (`canPin()` is false under node, so this arm stops at that refusal rather than at the key
    // comparison — which is the point: it is NOT the changed-key sentence.)
    const same = admitOrigin("https://192.168.1.10:6245", K1, K1);
    expect(same.ok).toBe(false);
    if (same.ok) return;
    expect(sayRefusal(same.reason)).not.toBe(Copy.pinChanged);
    expect(sayRefusal(same.reason)).toBe(Copy.admitCannotPin);
  });

  it("shortPin returns a short value WHOLE rather than eliding nothing", () => {
    // The property, not the length: padding a 10-character value with an ellipsis would claim
    // characters were hidden when none were. A fixture shorter than the elision it would make.
    expect(shortPin("abc")).toBe("abc");
    expect(shortPin("0123456789abc")).toBe("0123456789abc");
    expect(shortPin("0123456789abcd")).toBe(`012345\u202689abcd`);
  });
});

/* ── the ceremony, end to end, over PLAIN HTTP ──────────────────────────────────────────────── */

describe("pairing the desktop-host LAN door — plain http, no secure context needed", () => {
  it("redeems, learns the account from the server's own rows, stores the profile, boots, drains", async () => {
    const fake = pairServer({ accountId: "acct-1", flavor: "desktop-host", sessionRoute: false });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Welcome");
      fake.addMessage("m2", "Your invoice");
      fake.mintPairToken("tok-abc");

      const { env, world } = testEnv();
      const outcome = await pairThroughConfirm(env, { origin, token: "tok-abc" });
      expect(outcome.kind).toBe("paired");
      if (outcome.kind !== "paired") return;

      // THE PLAIN-HTTP CLAIM, asserted rather than implied: this whole ceremony — hello,
      // redeem, account resolution, boot — ran against an http:// origin. A browser cannot
      // do this (the three [SecureContext] blockers); this client just did.
      expect(outcome.session.profile.origin.startsWith("http://")).toBe(true);

      // The profile holds what the ceremony learned: flavor from /hello, the account from the
      // door's own rows (no session read exists on desktop-host — the snapshot probe answered).
      expect(outcome.session.profile.flavor).toBe("desktop-host");
      expect(outcome.session.profile.accountId).toBe("acct-1");
      expect(outcome.session.profile.refreshToken).toBe("ref-1");
      expect(fake.seen.some((r) => r.url === "/sync/snapshot?limit=1")).toBe(true);

      // The engine is live over the manager's seams: real mail drains into the named mirror.
      await outcome.session.verifyIdentity();
      await outcome.session.engine.start();
      expect(outcome.session.engine.read().list("message")).toHaveLength(2);
      expect(world.names()).toContain(mirrorDbName(outcome.session.ownerKey));

      // THE TOKEN DISCIPLINE: the pairing token appeared in exactly ONE request — the redeem's
      // body. No URL, no header, no other body ever carried it (flow-3, held by observation).
      const redeems = fake.seen.filter((r) => r.url === "/pair/redeem");
      expect(redeems).toHaveLength(1);
      expect((JSON.parse(redeems[0]!.body) as { token: string }).token).toBe("tok-abc");
      for (const r of fake.seen) {
        expect(r.url).not.toContain("tok-abc");
        expect(r.auth ?? "").not.toContain("tok-abc");
        if (r.url !== "/pair/redeem") expect(r.body).not.toContain("tok-abc");
      }

      outcome.session.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("on a server WITH a session read, the account id is the session's answer", async () => {
    const fake = pairServer({ accountId: "acct-self", flavor: "selfhost", sessionRoute: true });
    const origin = await listen(fake.server);
    try {
      fake.mintPairToken("tok-self");
      fake.addMessage("s1", "Standalone mail");
      const { env } = testEnv();
      const outcome = await pairThroughConfirm(env, { origin, token: "tok-self" });
      expect(outcome.kind).toBe("paired");
      if (outcome.kind !== "paired") return;
      expect(outcome.session.profile.accountId).toBe("acct-self");
      // The session read answered, so the rows were never probed for identity.
      expect(fake.seen.some((r) => r.url === "/auth/session")).toBe(true);
      expect(fake.seen.some((r) => r.url === "/sync/snapshot?limit=1")).toBe(false);
      outcome.session.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("a server whose /hello says pairing:false never sees a redeem — the gate holds before the wire", async () => {
    // THE DEAD-BUTTON MUTATION TARGET: force `nextStep` to always answer "pair" and this flow
    // reaches the redeem on a door that mounts none — the assertions below go red.
    const fake = pairServer({ flavor: "selfhost", pairing: false });
    const origin = await listen(fake.server);
    try {
      fake.mintPairToken("tok-x");
      const { env } = testEnv();
      const outcome = await pairThroughConfirm(env, { origin, token: "tok-x" });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") return;
      expect(sayRefusal(outcome.reason)).toMatch(/does not offer device pairing/);
      expect(fake.seen.some((r) => r.url === "/pair/redeem")).toBe(false);
      expect(await env.profiles.list()).toEqual([]);
    } finally {
      fake.server.close();
    }
  });

  /**
   * A MANAGED-FLAVOR SERVER THAT SAYS IT DOES NOT PAIR — and the sentence no longer promises a
   * release, which is the assertion that changed here and why.
   *
   * This used to require the words *"does not offer device pairing yet"*, whose "yet" was a
   * roadmap claim. It was true when it was written and is not now: measured 2026-09-01, the hosted
   * service answers `features.pairing: true` and its redeem is mounted, so this refusal never
   * renders against the live service at all. The mechanism did exactly what it was built to do —
   * `nextStep` reads the descriptor, so the client started offering the pair step with no edit —
   * and the words around it went on describing a state the server had left.
   *
   * So the assertion holds the two properties that are still true regardless of what the hosted
   * service answers this year: the sentence reports the DESCRIPTOR's answer, and it makes no claim
   * about the future. The `/pair/redeem` assertion is unchanged and is the load-bearing half: a
   * flow that reached a route the descriptor said is absent would show up here.
   */
  it("the managed flavor without pairing is refused on the descriptor's word, with no roadmap", async () => {
    const fake = pairServer({ flavor: "managed", pairing: false });
    const origin = await listen(fake.server);
    try {
      const { env } = testEnv();
      const outcome = await pairThroughConfirm(env, { origin, token: "tok-x" });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") return;
      expect(sayRefusal(outcome.reason)).toMatch(/not offering device pairing/);
      expect(sayRefusal(outcome.reason)).toContain("descriptor");
      expect(sayRefusal(outcome.reason), "no promise about a later update").not.toMatch(/\byet\b|later update/);
      expect(fake.seen.some((r) => r.url === "/pair/redeem")).toBe(false);
    } finally {
      fake.server.close();
    }
  });

  it("a wrong or spent token is a sentence with the remedy; nothing is stored", async () => {
    const fake = pairServer({});
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Mail");
      const { env } = testEnv();
      const outcome = await pairThroughConfirm(env, { origin, token: "tok-never-minted" });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") return;
      expect(sayRefusal(outcome.reason)).toMatch(/mint a fresh one and scan again/);
      expect(await env.profiles.list()).toEqual([]);
    } finally {
      fake.server.close();
    }
  });

  it("a door that can name NO account (no session read, zero rows) refuses out loud", async () => {
    // The honest cold-install edge: the mirror's name, its __owner stamp and the drain guard
    // all need the server's word for the account. A placeholder owner would boot a mirror the
    // first real drain then refuses forever — the absent-config-dangerous-branch trap.
    const fake = pairServer({ sessionRoute: false });
    const origin = await listen(fake.server);
    try {
      fake.mintPairToken("tok-empty");
      const { env } = testEnv();
      const outcome = await pairThroughConfirm(env, { origin, token: "tok-empty" });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") return;
      expect(sayRefusal(outcome.reason)).toMatch(/could not name the account/);
      expect(sayRefusal(outcome.reason)).toMatch(/mint a fresh code/); // the token above is burned — say so
      expect(await env.profiles.list()).toEqual([]);
      // …and the session the redeem minted is ended there, not left live under nobody's control.
      expect(fake.seen.filter((r) => r.url === "/auth/logout").map((r) => r.auth)).toEqual(["Bearer acc-1"]);
      const late = await fetch(`${origin}/auth/refresh`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: "ref-1" }),
      });
      expect(late.status, "the refused pairing's session still renews").toBe(401);
    } finally {
      fake.server.close();
    }
  });
});

/* ── a re-pair names the family it replaces ─────────────────────────────────────────────────── */

describe("a re-pair names the family this phone held there (previousSession)", () => {
  const digest = async (t: string): Promise<string> => createHash("sha256").update(t, "utf8").digest("base64url");
  const redeemsOf = (fake: ReturnType<typeof pairServer>) =>
    fake.seen.filter((r) => r.url === "/pair/redeem").map((r) => JSON.parse(r.body) as Record<string, unknown>);

  it("the redeem carries the digest of the pairing it replaces, on both of an older server's arms", async () => {
    const fake = pairServer({ accountId: "acct-1", flavor: "desktop-host", sessionRoute: true, kindWhitelist: ["web", "macos"] });
    const origin = await listen(fake.server);
    try {
      const { env } = testEnv("mobile-ios");
      env.familyDigest = digest;
      fake.mintPairToken("tok-1");
      const first = await pairThroughConfirm(env, { origin, token: "tok-1" });
      expect(first.kind).toBe("paired");
      if (first.kind === "paired") first.session.store.close();
      const held = (await env.profiles.active())!.refreshToken!;
      fake.mintPairToken("tok-2");
      const again = await pairThroughConfirm(env, { origin, token: "tok-2" });
      if (again.kind === "paired") again.session.store.close();
      const redeems = redeemsOf(fake);
      expect(redeems.slice(0, 2).some((r) => "previousSession" in r), "a first pairing named a family").toBe(false);
      expect(redeems.slice(2)).toEqual([
        { grant: "device-pair", token: "tok-2", kind: "mobile-ios", previousSession: await digest(held) },
        { grant: "device-pair", token: "tok-2", previousSession: await digest(held) },
      ]);
    } finally {
      fake.server.close();
    }
  });

  it("names the only pairing at the origin when another is active, and none when two could be meant", async () => {
    const fake = pairServer({ accountId: "acct-1", flavor: "desktop-host", sessionRoute: true });
    const origin = await listen(fake.server);
    try {
      const pairOnce = async (here: string[]): Promise<Record<string, unknown>> => {
        const { env } = testEnv();
        env.familyDigest = digest;
        for (const [i, refreshToken] of here.entries()) {
          await env.profiles.add({ origin, flavor: "desktop-host", accountId: `acct-${i + 5}`, refreshToken });
        }
        await env.profiles.add({ origin: "http://other.example", flavor: "selfhost", accountId: "acct-9", refreshToken: "ref-other" });
        const token = `tok-${here.length}`;
        fake.mintPairToken(token);
        const outcome = await pairThroughConfirm(env, { origin, token });
        if (outcome.kind === "paired") outcome.session.store.close();
        return redeemsOf(fake).at(-1)!;
      };
      expect((await pairOnce(["ref-only"])).previousSession).toBe(await digest("ref-only"));
      expect(await pairOnce(["ref-a", "ref-b"]), "an ambiguous family was named").not.toHaveProperty("previousSession");
    } finally {
      fake.server.close();
    }
  });

  it("a sign-out still owed to the origin goes before the redeem; one that cannot go is named in it", async () => {
    const fake = pairServer({ accountId: "acct-1", flavor: "desktop-host", sessionRoute: true });
    const origin = await listen(fake.server);
    try {
      let doorDown = true;
      const { env } = testEnv();
      env.familyDigest = digest;
      env.fetchImpl = (url, init) => (doorDown && url.endsWith("/auth/refresh/logout")
        ? Promise.reject(new TypeError("Network request failed")) : fetch(url, init as RequestInit));
      await env.profiles.markPendingSignOut({ origin, pin: null, refreshToken: "ref-owed" });
      fake.mintPairToken("tok-1");
      const first = await pairThroughConfirm(env, { origin, token: "tok-1" });
      if (first.kind === "paired") first.session.store.close();
      expect(redeemsOf(fake).at(-1)!.previousSession).toBe(await digest("ref-owed"));

      doorDown = false;
      await env.profiles.remove((await env.profiles.list())[0]!.id);
      fake.mintPairToken("tok-2");
      const from = fake.seen.length;
      const again = await pairThroughConfirm(env, { origin, token: "tok-2" });
      if (again.kind === "paired") again.session.store.close();
      const order = fake.seen.slice(from).map((r) => r.url).filter((u) => u === "/auth/refresh/logout" || u === "/pair/redeem");
      expect(order).toEqual(["/auth/refresh/logout", "/pair/redeem"]);
      expect(await env.profiles.pendingSignOuts()).toEqual([]);
      expect(redeemsOf(fake).at(-1)).not.toHaveProperty("previousSession");
    } finally {
      fake.server.close();
    }
  });
});

/* ── the device-kind declaration ────────────────────────────────────────────────────────────── */

describe("the redeem declares what this phone is — and degrades to silence on an old server", () => {
  it("mobileDeviceKind maps the two platforms this app ships on", () => {
    expect(mobileDeviceKind("ios")).toBe("mobile-ios");
    expect(mobileDeviceKind("android")).toBe("mobile-android");
    // RN's Platform.OS can also say "windows"/"macos"/"web" in exotic embeddings; this app is
    // shipped for two, and anything else is the Android build system wearing a costume.
    expect(mobileDeviceKind("web")).toBe("mobile-android");
  });

  it("a declared pairing sends `kind` in the ONE redeem body — a current server needs one request", async () => {
    const fake = pairServer({ accountId: "acct-1", flavor: "desktop-host" });
    const origin = await listen(fake.server);
    try {
      fake.mintPairToken("tok-kind");
      fake.addMessage("m1", "hello");
      const { env } = testEnv("mobile-android");
      const outcome = await pairThroughConfirm(env, { origin, token: "tok-kind" });
      expect(outcome.kind).toBe("paired");
      if (outcome.kind !== "paired") return;
      const redeems = fake.seen.filter((r) => r.url === "/pair/redeem");
      expect(redeems).toHaveLength(1);
      expect(JSON.parse(redeems[0]!.body)).toEqual({
        grant: "device-pair", token: "tok-kind", kind: "mobile-android",
      });
      outcome.session.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("an OLDER server that refuses the kind gets ONE retry without it — the token survives, the pairing lands", async () => {
    // The pre-vocabulary whitelist: it refuses `mobile-ios` validation_failed BEFORE the burn,
    // which is what makes the honest retry safe — see the retry comment in `pairWithServer`.
    const fake = pairServer({ accountId: "acct-1", flavor: "desktop-host", kindWhitelist: ["web", "macos"] });
    const origin = await listen(fake.server);
    try {
      fake.mintPairToken("tok-old");
      fake.addMessage("m1", "hello");
      const { env } = testEnv("mobile-ios");
      const outcome = await pairThroughConfirm(env, { origin, token: "tok-old" });
      expect(outcome.kind, outcome.kind === "refused" ? sayRefusal(outcome.reason) : "").toBe("paired");
      if (outcome.kind !== "paired") return;
      const redeems = fake.seen.filter((r) => r.url === "/pair/redeem").map((r) => JSON.parse(r.body));
      expect(redeems).toEqual([
        { grant: "device-pair", token: "tok-old", kind: "mobile-ios" },
        { grant: "device-pair", token: "tok-old" },
      ]);
      outcome.session.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("the OLDEST wire ignores the field — one request, the declaration rides along harmlessly", async () => {
    const fake = pairServer({ accountId: "acct-1", flavor: "desktop-host", kindWhitelist: null });
    const origin = await listen(fake.server);
    try {
      fake.mintPairToken("tok-ancient");
      fake.addMessage("m1", "hello");
      const { env } = testEnv("mobile-android");
      const outcome = await pairThroughConfirm(env, { origin, token: "tok-ancient" });
      expect(outcome.kind).toBe("paired");
      if (outcome.kind !== "paired") return;
      expect(fake.seen.filter((r) => r.url === "/pair/redeem")).toHaveLength(1);
      outcome.session.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("an UNDECLARED env still sends the exact legacy body — no invented kind", async () => {
    const fake = pairServer({ accountId: "acct-1", flavor: "desktop-host" });
    const origin = await listen(fake.server);
    try {
      fake.mintPairToken("tok-plain");
      fake.addMessage("m1", "hello");
      const { env } = testEnv();
      const outcome = await pairThroughConfirm(env, { origin, token: "tok-plain" });
      expect(outcome.kind).toBe("paired");
      if (outcome.kind !== "paired") return;
      const redeems = fake.seen.filter((r) => r.url === "/pair/redeem");
      expect(JSON.parse(redeems[0]!.body)).toEqual({ grant: "device-pair", token: "tok-plain" });
      outcome.session.store.close();
    } finally {
      fake.server.close();
    }
  });
});

/* ── the lives of a stored pairing ──────────────────────────────────────────────────────────── */

describe("the stored profile's lifecycle over the rotation machine", () => {
  it("a cold launch holds no access token — the first 401 buys one through ONE rotation", async () => {
    const fake = pairServer({ flavor: "desktop-host", sessionRoute: false });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Standing mail");
      fake.mintPairToken("tok-1");
      const { env } = testEnv();
      const paired = await pairThroughConfirm(env, { origin, token: "tok-1" });
      expect(paired.kind).toBe("paired");
      if (paired.kind !== "paired") return;
      paired.session.store.close();
      expect(fake.refreshPresentations()).toBe(0); // pairing spent no rotation

      // The app was killed; every access token aged out; the keystore holds the refresh token.
      fake.expireAccess();
      const profile = (await env.profiles.active())!;
      const relaunch = await connectProfile(env, profile);
      expect(relaunch.kind).toBe("connected");
      if (relaunch.kind !== "connected") return;
      // The app's own sequence: the probe first (this door has no session read, so it makes
      // no authenticated request), then the drain — whose 401 recovery performs the rotation.
      await relaunch.session.verifyIdentity();
      await relaunch.session.engine.start();
      expect(relaunch.session.engine.read().list("message")).toHaveLength(1);
      // Single-flighted: however many requests 401'd, the token was presented ONCE.
      expect(fake.refreshPresentations()).toBe(1);
      // …and the rotated refresh token was persisted back into the profile's keystore slot.
      expect((await env.profiles.active())!.refreshToken).toBe("ref-2");
      relaunch.session.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("a desktop revoke kills the next request: the session dies, the credential clears, the row stays", async () => {
    const fake = pairServer({ flavor: "desktop-host", sessionRoute: false });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Mail");
      fake.mintPairToken("tok-1");
      const { env } = testEnv();
      const paired = await pairThroughConfirm(env, { origin, token: "tok-1" });
      expect(paired.kind).toBe("paired");
      if (paired.kind !== "paired") return;
      await paired.session.verifyIdentity();
      await paired.session.engine.start();

      let died = 0;
      paired.session.bearer!.onSessionDead(() => died++);
      fake.revoke(); // the Devices pane's take-back, server-side

      await expect(paired.session.engine.syncOnce()).rejects.toThrow();
      expect(died).toBe(1);
      expect(paired.session.bearer!.paired()).toBe(false);
      // Refusal-only sign-out reached the keystore: the token is gone, but the ROW remains —
      // the picker says "pairing ended, scan again" instead of the server vanishing.
      const rows = await env.profiles.list();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.refreshToken).toBeNull();
      paired.session.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("a mid-rotation kill (lost response) re-pairs with ONE scan — same profile, mirror intact", async () => {
    const fake = pairServer({ flavor: "desktop-host", sessionRoute: false });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Mail from before");
      fake.mintPairToken("tok-1");
      const { env } = testEnv();
      const paired = await pairThroughConfirm(env, { origin, token: "tok-1" });
      expect(paired.kind).toBe("paired");
      if (paired.kind !== "paired") return;
      await paired.session.verifyIdentity();
      await paired.session.engine.start();
      paired.session.store.close();

      // The residual: the server committed a rotation this client never learned about. The
      // stored refresh token is now, correctly, the reuse signal — the family dies on relaunch.
      fake.rotateServerSide();
      const stale = (await env.profiles.active())!;
      const relaunch = await connectProfile(env, stale);
      // The boot itself may succeed (the mirror is local); the first drain hits the judgment.
      if (relaunch.kind === "connected") {
        // This door mounts no session read, so the probe answers unverified without an
        // authenticated request — the FIRST authenticated touch is the drain, whose 401
        // recovery presents the reused token; the server refuses the family; the bearer dies.
        await relaunch.session.verifyIdentity();
        await expect(relaunch.session.engine.start()).rejects.toThrow();
        expect(relaunch.session.bearer!.paired()).toBe(false);
        relaunch.session.store.close();
      }
      expect((await env.profiles.list())[0]!.refreshToken).toBeNull();

      // ONE SCAN: a fresh QR re-pairs into the SAME profile row and the SAME mirror.
      fake.mintPairToken("tok-2");
      const repaired = await pairThroughConfirm(env, { origin, token: "tok-2" });
      expect(repaired.kind).toBe("paired");
      if (repaired.kind !== "paired") return;
      expect(repaired.session.profile.id).toBe(stale.id);
      expect(await env.profiles.list()).toHaveLength(1);
      await repaired.session.verifyIdentity();
      await repaired.session.engine.start();
      expect(repaired.session.engine.read().list("message")).toHaveLength(1);
      repaired.session.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("a profile whose credential is ALREADY GONE is refused before adoption — no wire, no mirror", async () => {
    // The one shape "dies on first wire touch" cannot catch: with `refreshToken: null` the
    // manager has nothing to present, `rotate()` returns false WITHOUT firing the dead
    // signal, and an adopted session would render cached mail behind an endless quiet 401.
    // So `buildSession` refuses a credential-less bearer structurally — the same sentence and
    // `needsRepair` the mid-use death shows — and this is the test that watches it fire.
    const fake = pairServer({ accountId: "acct-self", flavor: "selfhost", sessionRoute: true });
    const origin = await listen(fake.server);
    try {
      fake.mintPairToken("tok-1");
      const { env } = testEnv();
      const paired = await pairThroughConfirm(env, { origin, token: "tok-1" });
      expect(paired.kind).toBe("paired");
      if (paired.kind !== "paired") return;
      paired.session.store.close();

      // The keystore's slot was cleared (a refusal's take-back) and the app relaunches — a NEW
      // process, so a registry of its own over the same keystore and mirrors.
      const profile = (await env.profiles.active())!;
      await env.profiles.clearRefreshToken(profile.id, new Set([profile.refreshToken!]));
      const relaunch = await connectProfile({ ...env, bearers: new BearerRegistry() }, (await env.profiles.active())!);
      expect(relaunch.kind).toBe("refused");
      if (relaunch.kind !== "refused") return;
      expect(relaunch.needsRepair).toBe(true);
      expect(sayRefusal(relaunch.reason)).toMatch(/pairing ended/);
    } finally {
      fake.server.close();
    }
  });

  it("…and IN the process: a slot whose manager died answers the next connect with the same refusal", async () => {
    const fake = pairServer({ flavor: "desktop-host", sessionRoute: false });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Mail");
      fake.mintPairToken("tok-1");
      const { env } = testEnv();
      const paired = await pairThroughConfirm(env, { origin, token: "tok-1" });
      expect(paired.kind).toBe("paired");
      if (paired.kind !== "paired") return;
      await paired.session.verifyIdentity();
      await paired.session.engine.start();
      fake.revoke(); // the Devices pane's take-back: the next request dies
      await expect(paired.session.engine.syncOnce()).rejects.toThrow();
      expect(paired.session.bearer!.paired()).toBe(false);
      paired.session.store.close();

      const again = await connectProfileById(env, paired.session.profile.id);
      expect(again.kind).toBe("refused");
      if (again.kind !== "refused") return;
      expect(again.needsRepair).toBe(true);
      expect(sayRefusal(again.reason)).toMatch(/pairing ended/);
    } finally {
      fake.server.close();
    }
  });

  it("a revoked cold profile boots LOCAL, then dies on its first wire touch — onto a subscribed listener", async () => {
    // The ready-but-dead review finding, restated for boot-from-local. The boot makes no request any more, so a
    // revoked cold profile cannot die INSIDE it — it answers connected over the device's own
    // cached mirror (which is this device's data for this profile, rendered exactly as the
    // no-session-route door has always rendered it in the mid-rotation test above). The death
    // moved to the first wire touch, and the property that mattered — the judgment lands on a
    // SUBSCRIBED dead listener, never before one can exist — now holds by ordering: the
    // connection layer wires `onSessionDead` in `adopt`, and only then starts the deferred
    // identity probe and the first drain. This test drives that exact sequence.
    const fake = pairServer({ accountId: "acct-self", flavor: "selfhost", sessionRoute: true });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Mail");
      fake.mintPairToken("tok-1");
      const { env } = testEnv();
      const paired = await pairThroughConfirm(env, { origin, token: "tok-1" });
      expect(paired.kind).toBe("paired");
      if (paired.kind !== "paired") return;
      paired.session.store.close();

      fake.revoke(); // the desktop's take-back, while the app was closed
      const profile = (await env.profiles.active())!;
      const relaunch = await connectProfile(env, profile);
      // The boot is local: ready, with the cached mirror — no wire was asked yet.
      expect(relaunch.kind).toBe("connected");
      if (relaunch.kind !== "connected") return;
      let died = 0;
      relaunch.session.bearer!.onSessionDead(() => died++);
      // The first wire touch (adopt's own order: probe after the subscription) presents the
      // revoked refresh inside the 401 recovery; the server refuses; the manager dies ONCE.
      const verdict = await relaunch.session.verifyIdentity();
      expect(verdict.kind).toBe("unverified"); // the probe read a 401, never a judgment of the id
      expect(died).toBe(1);
      expect(relaunch.session.bearer!.paired()).toBe(false);
      // The refusal-only sign-out reached the keystore on the way down.
      expect((await env.profiles.active())!.refreshToken).toBeNull();
      relaunch.session.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("a switch presents the STORE's refresh token — a stale in-memory row cannot burn the family", async () => {
    // A review finding: React state (or any held copy) goes stale the moment a rotation lands;
    // presenting a consumed token IS the reuse signal. The by-id connect re-reads the keystore
    // row at the last moment, so two cold connects with a rotation between stay one family.
    const fake = pairServer({ flavor: "desktop-host", sessionRoute: false });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Mail");
      fake.mintPairToken("tok-1");
      const { env } = testEnv();
      const paired = await pairThroughConfirm(env, { origin, token: "tok-1" });
      expect(paired.kind).toBe("paired");
      if (paired.kind !== "paired") return;
      const staleCopy = { ...paired.session.profile }; // what a screen would still be holding
      paired.session.store.close();

      fake.expireAccess();
      const first = await connectProfileById(env, staleCopy.id);
      expect(first.kind).toBe("connected");
      if (first.kind !== "connected") return;
      await first.session.verifyIdentity(); // doorless: no authenticated request yet
      await first.session.engine.start(); // 401 → rotation: ref-1 is consumed, ref-2 persisted
      expect((await env.profiles.active())!.refreshToken).toBe("ref-2");
      expect(staleCopy.refreshToken).toBe("ref-1"); // the held copy is now the reuse signal
      first.session.store.close();

      fake.expireAccess();
      const second = await connectProfileById(env, staleCopy.id); // must read ref-2, never ref-1
      expect(second.kind).toBe("connected");
      if (second.kind !== "connected") return;
      await second.session.verifyIdentity();
      await second.session.engine.start();
      expect(second.session.engine.read().list("message")).toHaveLength(1);
      expect((await env.profiles.active())!.refreshToken).toBe("ref-3"); // alive, rotated again
      second.session.store.close();

      // …and an unknown id is a sentence, not a throw.
      const gone = await connectProfileById(env, "no-such-profile");
      expect(gone.kind).toBe("refused");
    } finally {
      fake.server.close();
    }
  });

  it("a keystore failure AFTER the redeem resolves to a refusal and abandons the minted session", async () => {
    // A review finding: profiles.add rejecting must not escape as a throw (the screens only handle
    // resolved outcomes — a throw strands them on "Pairing…" with the single-use token already
    // burned), and the minted-but-unstorable session is revoked best-effort, not left live.
    const fake = pairServer({ flavor: "desktop-host", sessionRoute: false });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Mail");
      fake.mintPairToken("tok-1");
      const world = sqlWorld();
      const failing = new ServerProfileStore({
        get: async () => null,
        set: async () => {
          throw new Error("keystore refused the write");
        },
        remove: async () => undefined,
      });
      const env: PairingEnv = {
        profiles: failing,
        engineDeps: { openExecutor: world.open, deleteDatabase: world.drop, uuid: () => "00000000-0000-4000-8000-000000000000" },
      };
      const outcome = await pairThroughConfirm(env, { origin, token: "tok-1" });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") return;
      expect(sayRefusal(outcome.reason)).toMatch(/could not store/);
      // The abandon-revocation reached the door, authenticated…
      expect(fake.seen.some((r) => r.url === "/auth/logout" && (r.auth ?? "").startsWith("Bearer "))).toBe(true);
      // …so the minted family is dead: its refresh token buys nothing.
      const res = await fetch(`${origin}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: "ref-1" }),
      });
      expect(res.status).toBe(401);
    } finally {
      fake.server.close();
    }
  });

  it("a re-pair whose row write resolves without storing is refused, and its minted session closed", async () => {
    // MUTATION WATCHED: `add`'s value read-back removed — the re-pair answers `paired` over the
    // previous family's row, which its manager can never write: every renewal is `superseded`,
    // and the next launch reads the pairing as ended while the new family is live on the server.
    const fake = pairServer({ flavor: "desktop-host", sessionRoute: false });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Mail");
      fake.mintPairToken("tok-1");
      const world = sqlWorld();
      const map = new Map<string, string>();
      let dropNextSetOf: string | null = null;
      const kv: SecureKV = {
        get: async (k) => map.get(k) ?? null,
        set: async (k, v) => {
          if (k === dropNextSetOf) { dropNextSetOf = null; return; } // resolved without storing
          map.set(k, v);
        },
        remove: async (k) => void map.delete(k),
      };
      const env: PairingEnv = {
        profiles: new ServerProfileStore(kv),
        engineDeps: { openExecutor: world.open, deleteDatabase: world.drop, uuid: () => "00000000-0000-4000-8000-000000000000" },
        bearers: new BearerRegistry(),
      };
      const first = await pairThroughConfirm(env, { origin, token: "tok-1" });
      expect(first.kind).toBe("paired");
      if (first.kind !== "paired") return;
      first.session.store.close();
      const before = (await env.profiles.list())[0]!;

      fake.mintPairToken("tok-2");
      dropNextSetOf = `ohmail.servers.v1.${before.id}`;
      const again = await pairThroughConfirm(env, { origin, token: "tok-2" });
      expect(again.kind, "a pairing the phone could not store is not a pairing").toBe("refused");
      if (again.kind !== "refused") { again.session.store.close(); return; }
      expect(again.reason.say).toBe("pairNotStoredClosed");
      expect(fake.seen.filter((r) => r.url === "/auth/logout").length, "the minted session was closed").toBe(1);
      expect((await env.profiles.list())[0]!.refreshToken, "the row is the first pairing's, untouched").toBe(before.refreshToken);
    } finally {
      fake.server.close();
    }
  });

  it("forgetting a stored profile revokes its session server-side — the family really ends", async () => {
    const fake = pairServer({ flavor: "desktop-host", sessionRoute: false });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Mail");
      fake.mintPairToken("tok-1");
      const { env } = testEnv();
      const paired = await pairThroughConfirm(env, { origin, token: "tok-1" });
      expect(paired.kind).toBe("paired");
      if (paired.kind !== "paired") return;
      paired.session.store.close();

      // The stored profile holds only a refresh token; the revocation spends it into an
      // access token through the manager's own recovery, then signs out.
      const profile = (await env.profiles.active())!;
      await revokeProfile(env, profile);
      const logouts = fake.seen.filter((r) => r.url === "/auth/logout");
      expect(logouts.length).toBeGreaterThan(0);
      expect(logouts.at(-1)!.auth).toMatch(/^Bearer /);
      // The family is dead server-side: its refresh token buys nothing anymore.
      const res = await fetch(`${origin}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: profile.refreshToken }),
      });
      expect(res.status).toBe(401);
    } finally {
      fake.server.close();
    }
  });
});

/* ── the manual screen's address may not come from outside this process ─────────────────────── */

/**
 * THE PAIRING TOKEN IS A CREDENTIAL, SO NOTHING OUTSIDE THIS APP MAY CHOOSE WHERE IT IS SENT.
 *
 * `app.json` registers `"scheme": "ohmail"`, and the generated Android manifest puts that scheme
 * on a BROWSABLE intent filter over an exported activity — so `ohmail://connect?origin=<host>` is
 * reachable from any web page and any installed app. While `/connect` read its address from a
 * ROUTE PARAMETER, that was an unauthenticated stranger choosing the server a live pairing grant
 * would be POSTed to; `POST /pair/redeem` is `public + anonymous` and answers a bearer pair to
 * whoever presents the raw token, so the grant is worth stealing for the five minutes it lives.
 *
 * The first assertion is the one that matters and it is a SOURCE census rather than a behaviour:
 * the defect is "an external input reaches this screen", which no runtime call can observe. It
 * goes red the moment a route parameter comes back to `connect.tsx`, which is exactly the
 * regression this closes.
 */
describe("the manual pair screen's address is negotiated by this app, never routed in", () => {
  const connectSource = readFileSync(
    fileURLToPath(new URL("../app/connect.tsx", import.meta.url)),
    "utf8",
  );
  const serversSource = readFileSync(
    fileURLToPath(new URL("../app/servers.tsx", import.meta.url)),
    "utf8",
  );
  /**
   * THE DOOR CHOOSER, which is where the handoff lives now.
   *
   * It was in `app/servers.tsx`, whose "Add a server" panel held its own copy of the three doors,
   * its own address field and its own probe. Both entry surfaces render one component now
   * (`src/ui/Doors.tsx`), which is what makes the in-process handoff exist ONCE — and the census
   * follows the code rather than being relaxed. The two SCREENS are still read below, and still
   * forbidden the route-parameter form, because a screen is where the regression would reappear.
   */
  const doorsSource = readFileSync(
    fileURLToPath(new URL("../src/ui/Doors.tsx", import.meta.url)),
    "utf8",
  );
  const welcomeSource = readFileSync(
    fileURLToPath(new URL("../app/welcome.tsx", import.meta.url)),
    "utf8",
  );

  it("connect.tsx reads no route parameter at all", () => {
    for (const forbidden of ["useLocalSearchParams", "useGlobalSearchParams", "useSearchParams"]) {
      expect(connectSource).not.toContain(forbidden);
    }
  });

  it("the picker hands the address over in-process instead of in the route", () => {
    expect(doorsSource).toContain("stashPairOrigin(probe.origin)");
    // The `params:` form is what carried the address into a linkable URL — forbidden in the
    // component that stashes AND in both screens that route to `/connect`, since either could
    // reintroduce it.
    for (const source of [doorsSource, serversSource, welcomeSource]) {
      expect(source).not.toContain('pathname: "/connect"');
    }
    // And no screen may hand `Doors` an origin to stash: the handoff's whole safety is that the
    // value can only ever be one THIS app negotiated in this launch.
    for (const source of [serversSource, welcomeSource]) {
      expect(source).not.toContain("stashPairOrigin");
    }
  });

  it("nothing is offered until this app has negotiated an address", () => {
    // A fresh module holds nothing; the screen therefore opens empty on a deep-link launch.
    expect(typeof pendingPairOrigin()).toBe("string");
  });

  it("a stashed address is normalized and read back", () => {
    stashPairOrigin("HTTPS://Desktop.Tail1234.ts.net/");
    expect(pendingPairOrigin()).toBe("https://desktop.tail1234.ts.net");
  });
});

/* ── the no-secure-context census ───────────────────────────────────────────────────────────── */

describe("the seam never leans on secure-context machinery (the LAN win, structurally)", () => {
  it("no navigator.locks, no isSecureContext, no bare crypto.randomUUID, no document.cookie", () => {
    // the three blockers were the BROWSER client's. This client's whole net seam must stay
    // free of them or the plain-http LAN door silently breaks on a real phone. Comments are
    // stripped: prose ABOUT the machinery is documentation, code REACHING it is the defect.
    const dirs = [
      fileURLToPath(new URL("../src/net", import.meta.url)),
      fileURLToPath(new URL("../src/engine", import.meta.url)),
      fileURLToPath(new URL("../src/state", import.meta.url)),
    ];
    const banned = [/navigator\s*\.\s*locks/, /isSecureContext/, /\bcrypto\.randomUUID\b/, /document\.cookie/];
    const hits: string[] = [];
    for (const dir of dirs) {
      for (const entry of readdirSync(dir)) {
        if (!/\.tsx?$/.test(entry)) continue;
        const body = readFileSync(join(dir, entry), "utf8");
        for (const [i, line] of body.split("\n").entries()) {
          const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "").replace(/\/\*.*$/, "");
          for (const re of banned) {
            if (re.test(code)) hits.push(`${entry}:${i + 1} ${line.trim()}`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
