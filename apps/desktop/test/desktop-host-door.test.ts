import { afterEach, describe, expect, it } from "vitest";

import {
  DOOR_COPY,
} from "../src/door-copy.js";
import {
  HOST_REFUSAL_KINDS,
  accountDoorFor,
  awayDoorFor,
  consentDoorFor,
  desktopDeviceKind,
  enterHostDoor,
  firstRunDoorFor,
  flavorOf,
  hostDoorFor,
  hostLabelOf,
  hostLinkProblem,
  hostViaOf,
  isDesktopHost,
  profileImportDoorFor,
  proveHostLink,
  suggestDoorFor,
} from "../src/doors.js";
import { sentenceForKind, shortPin } from "../src/DoorChooser.js";
import { readFileSync } from "node:fs";
import type { EngineStatus } from "../src/bridge-fetch.js";
import { parsePairLink } from "@ohmail/client-engine";

/**
 * ═══ A PAIRED DESKTOP IS NOT A HOSTED ACCOUNT ══════════════════════════════════════════════
 *
 * `mode` answers "local or not", which was the whole question while there was one thing behind a
 * cloud door. There are three now, and eleven places in this window wrote a sentence or opened a
 * pane on that one bit: "the organizing happens on our servers", "your hosted account",
 * Subscription, Security, Account, a price quote against a ledger, a door out to ohmail.app.
 * Every one of them is false on a desktop paired to another computer of the person's own, and
 * four are panes about an account that does not exist.
 *
 * So this file drives the SEAM and the rules that read it, as a table, rather than asserting on a
 * render. The three cases that matter are on every row: a hosted account (unchanged), a paired
 * desktop (the new answers), and an engine that says NOTHING — which must behave exactly as the
 * shipped build does, because the paired door cannot exist in an engine old enough to omit the
 * field, so an absent flavor is never concealing one.
 */

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host { __TAURI_INTERNALS__?: { invoke: Invoke } }
const host = globalThis as Host;

function encode(status: number, body = "", statusText = "OK"): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText, h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

/**
 * WHAT THE SHELL ACTUALLY RECEIVES. `bridgeFetch` runs every body through `bodyBytes`, so the
 * command's `body` is a number array and not the JSON string the caller composed. Decoding it
 * here rather than asserting on a string is what makes these cases about the REQUEST that leaves
 * the window instead of about a convenience shape a test invented.
 */
function sentBody(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  const bytes = (payload as { body?: number[] } | undefined)?.body ?? [];
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as Record<string, unknown>;
}

const status = (over: Partial<EngineStatus> = {}): EngineStatus => ({
  state: "serving",
  mode: "cloud",
  address: "mila@example.com",
  mailboxId: "mbx-1",
  ...over,
});

/** A hosted account: cloud mode, no flavor — every shipped install until the field exists. */
const NO_FLAVOR = status();
/** A hosted account that DOES name itself. */
const MANAGED = status({ flavor: "managed" });
/** The new door. */
const PAIRED = status({ flavor: "desktop-host", baseUrl: "https://192.168.1.24:8443" });
const PAIRED_TS = status({ flavor: "desktop-host", baseUrl: "https://kestrel.tail9c2.ts.net" });
const LOCAL = status({ mode: "local", flavor: null });

afterEach(() => {
  delete host.__TAURI_INTERNALS__;
});

describe("flavorOf — the one seam, and `unknown` is a state rather than a default", () => {
  it("names each door", () => {
    expect(flavorOf(LOCAL)).toBe("local");
    expect(flavorOf(MANAGED)).toBe("managed");
    expect(flavorOf(status({ flavor: "selfhost" }))).toBe("selfhost");
    expect(flavorOf(PAIRED)).toBe("desktop-host");
  });

  /* THE ASSERTION THE WHOLE SEAM EXISTS FOR. An engine that predates the field is not a hosted
     account and not a paired desktop — it is a shell that has not been asked. Reading it as
     either is the failure this names: as `desktop-host` it would strip four panes from every
     shipped Cloud install; as `managed` the field could never say anything a surface did not
     already assume. */
  it("an engine that says nothing is `unknown`, never a door", () => {
    expect(flavorOf(NO_FLAVOR)).toBe("unknown");
    expect(flavorOf(status({ flavor: null }))).toBe("unknown");
    expect(flavorOf(null)).toBe("unknown");
    expect(flavorOf(status({ mode: null }))).toBe("unknown");
  });

  /* A FOURTH FLAVOR FROM A NEWER ENGINE lands in `unknown` rather than travelling on as a string
     nothing recognises. The desktop's own update flow makes "the engine is newer than this
     window" an ordinary state, not a hypothetical. */
  it("a flavor this build has never heard of is `unknown`", () => {
    expect(flavorOf(status({ flavor: "relay" as never }))).toBe("unknown");
  });

  it("isDesktopHost is the positive test, so `unknown` can never pass for it", () => {
    expect(isDesktopHost(PAIRED)).toBe(true);
    expect(isDesktopHost(NO_FLAVOR)).toBe(false);
    expect(isDesktopHost(MANAGED)).toBe(false);
    expect(isDesktopHost(LOCAL)).toBe(false);
    expect(isDesktopHost(null)).toBe(false);
  });
});

describe("the door rules, over the seam", () => {
  /**
   * ONE TABLE, THREE COLUMNS: what a hosted account gets, what a paired desktop gets, and what an
   * engine that said nothing gets. The third column is the regression guard — every one of these
   * must equal the second column of the hosted row, or a shipped install lost a pane.
   */
  it("the account family is withheld on the paired door and unchanged everywhere else", () => {
    expect(accountDoorFor(MANAGED, "live")).toBe("cloud");
    expect(accountDoorFor(NO_FLAVOR, "live")).toBe("cloud");
    /* Subscription, Security, Account and the Screener's spend quote all read this one answer, so
       `null` closes four panes and a price quote together — an account that does not exist. */
    expect(accountDoorFor(PAIRED, "live")).toBeNull();
    expect(accountDoorFor(LOCAL, "live")).toBeNull();
  });

  it("the suggest control is withheld rather than priced against a ledger that does not exist", () => {
    expect(suggestDoorFor(MANAGED, "live")).toBe("cloud");
    expect(suggestDoorFor(NO_FLAVOR, "live")).toBe("cloud");
    expect(suggestDoorFor(LOCAL, "live")).toBe("local");
    /* NEVER `"cloud"`: that ladder quotes a price. A host has no ledger and no watermark. */
    expect(suggestDoorFor(PAIRED, "live")).toBeNull();
  });

  it("the away responder gains a third arm — the wire works, the promise names the other machine", () => {
    expect(awayDoorFor(MANAGED, "live")).toBe("cloud");
    expect(awayDoorFor(NO_FLAVOR, "live")).toBe("cloud");
    expect(awayDoorFor(LOCAL, "live")).toBe("local");
    expect(awayDoorFor(PAIRED, "live")).toBe("host");
    /* Signed out, every read would be refused — the same rule the other two arms follow. */
    expect(awayDoorFor(PAIRED, "out")).toBeNull();
    expect(awayDoorFor(PAIRED, "unknown")).toBeNull();
  });

  /* THE HOLE THE PAIR OF CONDITIONS LEFT. `accountDoorFor` says no and `firstRunDoorFor` says no,
     so with two conditions and no rule the paired door got NO consent transport at all — no
     screening window, nothing on screen saying why — on a door where the host serves the row. */
  it("the consent row reaches the paired door, in the standalone shape", () => {
    expect(consentDoorFor(MANAGED, "live")).toBe("cloud");
    expect(consentDoorFor(NO_FLAVOR, "live")).toBe("cloud");
    expect(consentDoorFor(LOCAL, "live")).toBe("standalone");
    /* STANDALONE, because the far side IS one: a host mounts no folder verb, so the transport
       declares that flag unstorable and the shell withholds the pane instead of drawing a switch
       that snaps back. */
    expect(consentDoorFor(PAIRED, "live")).toBe("standalone");
    expect(consentDoorFor(PAIRED, "out")).toBeNull();
  });

  it("the profile-import card takes the cloud shape — the question belongs to the mailbox", () => {
    expect(profileImportDoorFor(PAIRED, "live")).toBe("cloud");
    expect(profileImportDoorFor(PAIRED, "out")).toBeNull();
  });

  it("host mode and the guided setup stay standalone-only", () => {
    expect(hostDoorFor(PAIRED)).toBeNull();
    expect(firstRunDoorFor(PAIRED)).toBeNull();
    expect(hostDoorFor(LOCAL)).toBe("local");
  });
});

describe("what to call the other computer, and which network it is on", () => {
  it("a tailnet name shortens to the machine's own label; an address does not", () => {
    expect(hostLabelOf("https://kestrel.tail9c2.ts.net")).toBe("kestrel");
    expect(hostLabelOf("https://kestrel.tail9c2.ts.net/anything")).toBe("kestrel");
    expect(hostLabelOf("https://192.168.1.24:8443")).toBe("192.168.1.24");
    expect(hostLabelOf("https://Ohmail.Example.COM")).toBe("ohmail.example.com");
  });

  /* NEVER A GUESS AND NEVER AN EMPTY STRING: every sentence interpolates this, and
     "Can't reach ." is worse than not saying it. */
  it("no origin is null", () => {
    expect(hostLabelOf(null)).toBeNull();
    expect(hostLabelOf(undefined)).toBeNull();
    expect(hostLabelOf("")).toBeNull();
    expect(hostLabelOf("not a url")).toBeNull();
  });

  it("an IP literal is the same-network door; a name is Tailscale", () => {
    expect(hostViaOf("https://192.168.1.24:8443")).toBe("lan");
    expect(hostViaOf("https://[fd7a::1]:8443")).toBe("lan");
    expect(hostViaOf("https://kestrel.tail9c2.ts.net")).toBe("ts");
    expect(hostViaOf(null)).toBeNull();
  });
});

describe("the link, refused in the window before anything is dialled", () => {
  const PIN = "A".repeat(43);
  const TOKEN = "tok_abcdefghijklmnop";

  it("a well-formed pinned link passes and carries what the card renders", () => {
    const step = hostLinkProblem(`https://192.168.1.24:8443/pair#k1.${PIN}.${TOKEN}`);
    expect(step.refusal).toBeNull();
    expect(step.link?.token).toBe(TOKEN);
    expect(step.link?.pin).toBe(PIN);
    expect(step.host).toBe("192.168.1.24");
    expect(step.via).toBe("lan");
  });

  it("an unpinned Tailscale link passes — the trust store is what checked it", () => {
    const step = hostLinkProblem(`https://kestrel.tail9c2.ts.net/pair#${TOKEN}`);
    expect(step.refusal).toBeNull();
    expect(step.link?.pin).toBeNull();
    expect(step.via).toBe("ts");
  });

  it("nothing pasted asks for the link rather than describing its shape", () => {
    expect(hostLinkProblem("   ").refusal).toBe("missing");
  });

  /* ONE SENTENCE FOR EVERY REJECTED SHAPE, naming what is wanted. Somebody who pasted the wrong
     thing has not made five different mistakes. */
  it("anything that is not a pairing link gets the shape sentence", () => {
    for (const text of [
      "https://192.168.1.24/pair?token=abc",
      "https://192.168.1.24/join#tok",
      "ftp://192.168.1.24/pair#tok",
      "https://192.168.1.24/pair#",
      `https://192.168.1.24/pair#k2.${PIN}.${TOKEN}`,
      "hello",
    ]) {
      expect(hostLinkProblem(text).refusal, text).toBe("shape");
    }
  });

  /* THE TWO REFUSALS THAT COST NO CONNECTION. Both are facts about the link, so dialling first
     would mean opening the connection this app has already decided not to use. */
  it("a cleartext link is refused without dialling", () => {
    const step = hostLinkProblem(`http://192.168.1.24:8443/pair#k1.${PIN}.${TOKEN}`);
    expect(step.refusal).toBe("cleartext");
    expect(step.link).toBeNull();
  });

  it("an address with no key is refused without dialling", () => {
    const step = hostLinkProblem(`https://192.168.1.24:8443/pair#${TOKEN}`);
    expect(step.refusal).toBe("no_pin");
    expect(step.link).toBeNull();
  });
});

describe("the engine's refusals become sentences a German install can read", () => {
  it("every kind the engine can name has one", () => {
    for (const kind of HOST_REFUSAL_KINDS) {
      expect(sentenceForKind(kind, "kestrel"), kind).toBeTruthy();
    }
  });

  it("so do the window's own three", () => {
    for (const kind of ["missing", "shape", "cleartext", "no_pin"] as const) {
      expect(sentenceForKind(kind, "kestrel"), kind).toBeTruthy();
    }
  });

  /* AN UNRECOGNISED KIND COMPOSES NO KEY. The measured failure elsewhere in this window was a
     code this build had never heard of building a catalogue key that does not exist and throwing
     inside a render; `null` here is what sends the caller to the engine's own words instead. */
  it("a kind this build has never heard of answers null rather than inventing a key", () => {
    expect(sentenceForKind("something_new", "kestrel")).toBeNull();
    expect(sentenceForKind("", "kestrel")).toBeNull();
  });

  it("the three that name the machine put it in the sentence", () => {
    expect(sentenceForKind("not_ohmail", "kestrel")).toContain("kestrel");
    expect(sentenceForKind("unreachable", "kestrel")).toContain("kestrel");
    expect(sentenceForKind("selfhost", "kestrel")).toContain("kestrel");
  });

  /**
   * THE SEAM ITSELF. `doors.ts` is in the SERVED host client's import graph and `desktopDoor` is
   * window-only, so a catalogue read there ships the whole namespace to a phone loading that
   * client — where these surfaces would draw raw dotted keys. The decision module answers kinds;
   * the window-only card owns the words. `desktop-messages.test.ts` is the graph-level pin; this
   * is the shape-level one, so a reviewer reading either file finds the rule.
   */
  it("the decision module hands back a kind and never a sentence", () => {
    const src = readFileSync(
      new URL("../src/doors.ts", import.meta.url),
      "utf8",
    );
    /* THE IMPORT, not the word: the paragraph in `doors.ts` explaining this rule names
       `DOOR_COPY`, and an assertion that cannot tell a doc comment from a dependency is one that
       fires on the documentation of the very thing it is guarding. What ships the namespace is
       the module edge. */
    expect(
      /import\s[^;]*\bDOOR_COPY\b[^;]*from/.test(src),
      "doors.ts imports the window-only catalogue — it is in the served client's graph",
    ).toBe(false);
    /* POSITIVE CONTROL: the pattern DOES catch the edge it exists to catch, so a green above is
       evidence rather than a regex that matches nothing. */
    expect(/import\s[^;]*\bDOOR_COPY\b[^;]*from/.test('import { DOOR_COPY } from "./door-copy.js";'))
      .toBe(true);
  });
});

describe("the twelve characters a person actually compares", () => {
  it("first six, last six, and never a wrapped middle", () => {
    expect(shortPin("abcdef0123456789XYZ")).toBe("abcdef…789XYZ");
  });

  /* A VALUE SHORTER THAN THE ELISION comes back whole rather than padded with an ellipsis that
     hides nothing. */
  it("a short value is returned whole", () => {
    expect(shortPin("abcdef")).toBe("abcdef");
    expect(shortPin("a".repeat(13))).toBe("a".repeat(13));
  });
});

describe("what this install calls itself on the other computer's Devices list", () => {
  /* REQUIRED at the redeem. The server defaults an absent kind to "web", so without it a paired
     laptop appears on the host's Devices pane as a browser session — beside a Remove button
     somebody is meant to use to tell their machines apart. */
  it("names the platform the build was made for, never the translated word", () => {
    expect(desktopDeviceKind("darwin")).toBe("desktop-mac");
    expect(desktopDeviceKind("win32")).toBe("desktop-windows");
    expect(desktopDeviceKind("linux")).toBe("desktop-linux");
    expect(desktopDeviceKind("freebsd")).toBe("desktop-linux");
  });
});

describe("the two engine steps", () => {
  const PIN = "B".repeat(43);
  const link = parsePairLink(`https://192.168.1.24:8443/pair#k1.${PIN}.tok_xyz`)!;

  function shell(answers: (url: string) => Uint8Array, onConfigure?: (cfg: unknown) => void) {
    const asked: { command: string; payload?: Record<string, unknown> }[] = [];
    host.__TAURI_INTERNALS__ = {
      invoke: async (command, payload) => {
        asked.push({ command, payload });
        if (command === "engine_configure") {
          onConfigure?.((payload as { config?: unknown } | undefined)?.config);
          return { state: "starting", mode: "cloud" };
        }
        if (command === "engine_status") {
          return { state: "serving", mode: "cloud", flavor: "desktop-host", mailboxId: "m1" };
        }
        if (command === "engine_request") {
          return answers((payload as { url?: string } | undefined)?.url ?? "");
        }
        throw new Error(`unexpected ${command}`);
      },
    };
    return asked;
  }

  it("the probe hands over the origin and the key, and NEVER the token", async () => {
    const asked = shell(() => encode(200, '{"ok":true}'));
    expect(await proveHostLink(link)).toBeNull();
    const probe = asked.find((a) => (a.payload as { url?: string })?.url === "/cloud/probe");
    expect(probe, "the probe was not made").toBeTruthy();
    const body = sentBody(probe!.payload);
    expect(body.origin).toBe("https://192.168.1.24:8443");
    expect(body.hostPin).toBe(PIN);
    expect(body.flavor).toBe("desktop-host");
    /* THE CREDENTIAL IS SPENT ONCE, at the redeem. A probe carrying it would spend it on a step
       the person has not agreed to yet. */
    expect(Object.keys(body)).not.toContain("token");
    expect(JSON.stringify(body)).not.toContain("tok_xyz");
  });

  it("NOTHING IS CONFIGURED BY THE PROBE — a wrong link costs no mirror", async () => {
    const asked = shell(() => encode(200, '{"ok":true}'));
    await proveHostLink(link);
    expect(asked.map((a) => a.command)).not.toContain("engine_configure");
  });

  it("an engine refusal with a kind reads in the reader's language", async () => {
    shell(() => encode(409, '{"error":{"message":"pin mismatch","details":{"kind":"pin_mismatch"}}}', "Conflict"));
    const refusal = (await proveHostLink(link))!;
    expect(refusal.kind).toBe("pin_mismatch");
    /* AND THE CARD TURNS IT INTO THE TRANSLATED SENTENCE — the two halves of the seam, driven
       together, so neither can be correct while the pair is broken. */
    expect(sentenceForKind(refusal.kind!, "kestrel")).toBe(DOOR_COPY.hostRefusePinChanged);
  });

  it("an unknown kind falls back to the engine's own sentence", async () => {
    shell(() => encode(409, '{"error":{"message":"the door was bolted","details":{"kind":"bolted"}}}', "Conflict"));
    const refusal = (await proveHostLink(link))!;
    expect(sentenceForKind(refusal.kind!, "kestrel")).toBeNull();
    expect(refusal.message).toBe("the door was bolted");
  });

  it("the door configures with the origin and the pin, and redeems over the bridge", async () => {
    let config: unknown = null;
    const asked = shell(() => encode(200, '{"ok":true}'), (cfg) => { config = cfg; });
    const result = await enterHostDoor(link);
    expect(result.problem).toBeNull();
    expect(config).toEqual({
      mode: "cloud",
      flavor: "desktop-host",
      cloudUrl: "https://192.168.1.24:8443",
      hostPin: PIN,
    });
    /* THE TOKEN IS NOT AN ARGUMENT TO A SHELL COMMAND — the rule every door in this window
       follows. It goes down the bridge, addressed to the engine, which seals what it buys. */
    expect(JSON.stringify(config)).not.toContain("tok_xyz");
    const redeem = asked.find((a) => (a.payload as { url?: string })?.url === "/cloud/pair-redeem");
    expect(redeem, "the redeem was not made").toBeTruthy();
    const body = sentBody(redeem!.payload);
    expect(body.token).toBe("tok_xyz");
    expect(body.kind).toMatch(/^desktop-/);
  });

  it("the configure runs BEFORE the redeem — a token is spent once", async () => {
    const asked = shell(() => encode(200, '{"ok":true}'));
    await enterHostDoor(link);
    const configureAt = asked.findIndex((a) => a.command === "engine_configure");
    const redeemAt = asked.findIndex(
      (a) => (a.payload as { url?: string })?.url === "/cloud/pair-redeem",
    );
    expect(configureAt).toBeGreaterThanOrEqual(0);
    expect(redeemAt).toBeGreaterThan(configureAt);
  });

  it("a spent link is reported as a spent link", async () => {
    shell((url) =>
      url === "/cloud/pair-redeem"
        ? encode(410, '{"error":{"message":"gone","details":{"kind":"pairing_invalid"}}}', "Gone")
        : encode(200, '{"ok":true}'));
    const result = await enterHostDoor(link);
    expect(result.refusal?.kind).toBe("pairing_invalid");
    expect(sentenceForKind(result.refusal!.kind!, "kestrel")).toBe(DOOR_COPY.hostRefuseSpent);
  });
});
