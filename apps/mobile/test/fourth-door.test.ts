/**
 * ═══ THE FOURTH DOOR'S THREE SCREENS, DRIVEN ══════════════════════════════════════════════════
 *
 * The limitations screen, the credential form and the Settings row, asserted through the functions
 * that DECIDE — which sentence the platform shows, whether Connect is offered, what the server
 * fields hold, which label the claim chip wears, where focus goes.
 *
 * ── WHY NOT A RENDER TEST, WHICH IS THE OBVIOUS SHAPE ─────────────────────────────────────────
 *
 * There is no React Native renderer in this workspace: `react-test-renderer` and
 * `@testing-library/react-native` are absent from the store, which `test/unsaved-changes.test.ts`
 * and `test/locale.test.ts` both record against their own subjects. So a case that mounted a screen
 * would not be a stricter test, it would be no test. The screens' decisions therefore live in
 * `src/ui/standalone-form.ts` and are driven here directly, and what a RENDER would have added — is
 * the decision actually wired to the markup — is asserted by reading the route: the deck key, the
 * step order, the `aria-expanded` state and the focus target each have a case below that fails if
 * the file stops using them.
 *
 * ── AND THE PASSWORD IS HELD TO NEVER BEING LOGGED ────────────────────────────────────────────
 *
 * Not by grepping for `console` — by composing a mailbox with a password nobody else in the test
 * holds and asserting no diagnostic, no refusal argument and no composed config outside `imap.auth`
 * carries it. A grep would pass over a `log(fields)` one indirection away.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import { DEFAULT_DORMANCY_DAYS } from "@ohmail/client-engine";
import { DECKS } from "../src/copy";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { refuse } from "../src/refusal";
import {
  forgetPhoneEngine,
  phoneEngineStart,
  registerPhoneEngine,
} from "../src/engine/engine-artifact";
import {
  PHONE_CLAIM_NAME,
  imapConfigFor,
  openStandaloneMailbox,
  reopenStandaloneMailbox,
  standaloneAvailable,
  type StartPhoneEngine,
  type StartPhoneEngineFromSealed,
} from "../src/engine/standalone-door";
import {
  EMPTY_STANDALONE,
  claimChipLabel,
  claimFrom,
  claimHere,
  claimNoteLine,
  focusTargetFor,
  holderKind,
  limitationLines,
  mayConnect,
  mayStartHere,
  mayStopHere,
  platformRuleLine,
  pressSaidLine,
  refusalNamesServerFields,
  setImapPort,
  type HolderKind,
  setImapTls,
  setTyped,
  withAddress,
  type PhoneClaim,
  type StandaloneFields,
} from "../src/ui/standalone-form";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE = readFileSync(join(APP, "app/standalone.tsx"), "utf8");
const SETTINGS = readFileSync(join(APP, "app/settings.tsx"), "utf8");

beforeEach(() => {
  resetLocaleRegisterForTests();
  setActiveLocale("en");
  forgetPhoneEngine();
});

/* ── screen 1 — the limitations ─────────────────────────────────────────────────────────────── */

describe("screen 1: the limitations, before any password field", () => {
  it("shows three lines, in the ruled order, in both languages", () => {
    for (const locale of ["en", "de"] as const) {
      setActiveLocale(locale);
      const lines = limitationLines("android");
      expect(lines, locale).toHaveLength(4);
      expect(lines[0], locale).toBe(DECKS[locale].phoneStandaloneL1Android);
      expect(lines[1], locale).toBe(DECKS[locale].phoneStandaloneL2);
      expect(lines[2], locale).toBe(DECKS[locale].phoneStandaloneL3);
      // What agreeing does to mail already there, in the product's own window.
      expect(lines[3], locale).toBe(DECKS[locale].phoneStandaloneL4);
      expect(lines[3], locale).toContain(String(DEFAULT_DORMANCY_DAYS));
      for (const line of lines) expect(line.trim().length, locale).toBeGreaterThan(0);
    }
  });

  it("forks on platform, and ONLY on the first line", () => {
    setActiveLocale("en");
    const ios = limitationLines("ios");
    const android = limitationLines("android");
    expect(ios[0]).not.toBe(android[0]);
    // The other two are the same everywhere — one fork on this whole door, as ruled.
    expect(ios.slice(1)).toEqual(android.slice(1));
  });

  /**
   * THE iOS SENTENCE IS THE DEFAULT, and that is the hard stop written as a case.
   *
   * A platform this app has not met must not be told something keeps organizing behind a
   * notification it may have no way to show. `harmony` is not Android, so it gets the sentence
   * that promises nothing — and the Android sentence is reachable only by being Android.
   */
  it("promises the background to Android and to nothing else", () => {
    setActiveLocale("en");
    expect(platformRuleLine("android")).toBe(DECKS.en.phoneStandaloneL1Android);
    for (const other of ["ios", "harmony", "web", "windows", ""]) {
      expect(platformRuleLine(other), other).toBe(DECKS.en.phoneStandaloneL1Ios);
    }
  });

  it("puts focus on the heading, because the step is a read", () => {
    expect(focusTargetFor("limits")).toBe("title");
    expect(ROUTE, "the heading is not the a11y header").toContain('accessibilityRole="header"');
    expect(ROUTE).toContain("Copy.phoneStandaloneTitle");
  });

  it("offers Continue and a way back out, and nothing else", () => {
    expect(ROUTE).toContain("Copy.phoneStandaloneGo");
    expect(ROUTE).toContain("Copy.phoneStandaloneBack");
    /* The confirm is the SOLID one and the exit is quiet — a chooser whose two buttons weigh the
       same is a chooser that has not made a recommendation. Read as whole elements, because the
       attribute order inside a JSX tag is not a property worth pinning. */
    const element = (key: string): string => {
      const at = ROUTE.indexOf(key);
      expect(at, `${key} is not rendered`).toBeGreaterThan(-1);
      const open = ROUTE.lastIndexOf("<Button", at);
      return ROUTE.slice(open, ROUTE.indexOf("/>", at) + 2);
    };
    expect(element("Copy.phoneStandaloneGo")).toContain('variant="solid"');
    expect(element("Copy.phoneStandaloneBack")).toContain('variant="quiet"');
  });

  /**
   * THE STEP ORDER, read off the route: the form is behind a step the limitations advance to.
   *
   * A presence check would pass over a screen that rendered the form first and the limits below
   * it. This is the render-order property `no-host-census` §5 also holds, from its own side.
   */
  it("cannot show the form first", () => {
    expect(ROUTE).toContain('useState<StandaloneStep>("limits")');
    expect(ROUTE.indexOf("limitationLines(")).toBeLessThan(ROUTE.indexOf("secret"));
  });
});

/* ── screen 2 — the credentials ─────────────────────────────────────────────────────────────── */

describe("screen 2: the credential form", () => {
  it("offers Connect exactly when the address and the password are both there", () => {
    expect(mayConnect(EMPTY_STANDALONE)).toBe(false);
    const addressed = withAddress(EMPTY_STANDALONE, "reader@example.com");
    expect(mayConnect(addressed), "an address alone is not enough").toBe(false);
    expect(mayConnect({ ...EMPTY_STANDALONE, password: "x" }), "a password alone is not enough")
      .toBe(false);
    expect(mayConnect({ ...addressed, password: "x" })).toBe(true);
    // Whitespace is not an address — a control that presses on a space bar is a dead control.
    expect(mayConnect({ ...EMPTY_STANDALONE, address: "   ", password: "x" })).toBe(false);
  });

  it("does NOT make the hosts a condition — the refusal names them instead", () => {
    const ready = { ...withAddress(EMPTY_STANDALONE, "me@nowhere.invalid"), password: "x" };
    expect(ready.imapHost, "an unrecognised domain has no host to offer").toBe("");
    // The button presses; the engine's own sentence says what is missing.
    expect(mayConnect(ready)).toBe(true);
  });

  it("pre-fills the server fields from the address, and the ports even with no host", () => {
    const known = withAddress(EMPTY_STANDALONE, personalAt("fixture.lena", "gmx.net"));
    expect(known.imapHost.length, "a recognised domain offers a host").toBeGreaterThan(0);
    expect(known.imapPort).toBe("993");
    expect(known.smtpPort).toBe("587");
    const unknown = withAddress(EMPTY_STANDALONE, "someone@her-own-domain.invalid");
    expect(unknown.imapHost, "an empty host is the absence of a value").toBe("");
    expect(unknown.smtpHost).toBe("");
    expect(unknown.imapPort, "the ports are offered anyway").toBe("993");
  });

  /**
   * THE PROVENANCE RULE — a value this app put there never survives into another server's attempt,
   * and a value the PERSON typed is never overwritten by a guess.
   *
   * Both directions, because each one alone is a defect: without the first, changing the address
   * leaves the old provider's host under the new one's password (the leak `hostsFor` records);
   * without the second, correcting your own host and then fixing a typo in your address silently
   * throws the correction away.
   */
  it("re-guesses over its own values and never over the person's", () => {
    const first = withAddress(EMPTY_STANDALONE, personalAt("fixture.ben", "gmx.net"));
    const guessed = first.imapHost;
    expect(guessed.length).toBeGreaterThan(0);
    // A guess is replaced by the next guess — never carried into a different provider's attempt.
    const moved = withAddress(first, "a@her-own-domain.invalid");
    expect(moved.imapHost, "a preset host survived into another server's attempt").toBe("");

    // The person's own typing survives every later guess.
    const mine = setTyped(first, "imapHost", "mail.mine.invalid");
    expect(withAddress(mine, personalAt("fixture.ben", "gmx.net")).imapHost).toBe("mail.mine.invalid");
    expect(withAddress(mine, "a@her-own-domain.invalid").imapHost).toBe("mail.mine.invalid");
  });

  /**
   * THE PORT AND THE SWITCH ARE ONE VALUE, watched in both directions.
   *
   * `enterLocalDoor` derives `secure` from the PORT, so a switch holding its own flag would be a
   * control the engine never reads — and what it would mean is a person turning TLS "on" and the
   * socket opening in the clear anyway.
   */
  it("moves the TLS switch with the port and the port with the switch", () => {
    const base = withAddress(EMPTY_STANDALONE, personalAt("fixture.ben", "gmx.net"));
    expect(base.imapTls, "993 is implicit TLS").toBe(true);
    expect(setImapPort(base, "143").imapTls).toBe(false);
    expect(setImapPort(base, "993").imapTls).toBe(true);
    expect(setImapTls(base, false).imapPort).toBe("143");
    expect(setImapTls(base, true).imapPort).toBe("993");
    // And the derivation the engine makes agrees with the switch, which is the whole point.
    expect(imapConfigFor(setImapTls(base, false)).secure).toBe(false);
    expect(imapConfigFor(setImapTls(base, true)).secure).toBe(true);
  });

  it("puts focus on the first field, because the step is work", () => {
    expect(focusTargetFor("credentials")).toBe("address");
    expect(ROUTE, "the address field takes no ref to focus").toContain("inputRef={address}");
  });

  it("carries the autofill hints both platforms read", () => {
    for (const hint of ['autoComplete: "username"', 'autoComplete: "current-password"',
                        'textContentType: "username"', 'textContentType: "password"']) {
      expect(ROUTE, `the form does not set ${hint}`).toContain(hint);
    }
    expect(ROUTE, "the address field is not an email keyboard")
      .toContain('keyboardType: "email-address"');
  });

  it("offers a labelled reveal toggle, and masks by default", () => {
    expect(ROUTE).toContain("Copy.phoneStandaloneShowPassword");
    expect(ROUTE).toContain("Copy.phoneStandaloneHidePassword");
    const field = readFileSync(join(APP, "src/ui/Field.tsx"), "utf8");
    // Masked unless explicitly revealed — `revealed !== true` rather than `!revealed`, so an
    // absent prop masks rather than revealing.
    expect(field).toContain("secret === true && revealed !== true");
  });

  it("states the disclosure's expanded state, in both positions", () => {
    expect(ROUTE).toContain("accessibilityState={{ expanded: advanced }}");
    expect(ROUTE).toContain("Copy.phoneStandaloneAdvanced");
    // It is a button, not a row: a disclosure a reader cannot identify is a disclosure nobody opens.
    const at = ROUTE.indexOf("accessibilityState={{ expanded: advanced }}");
    expect(ROUTE.slice(at - 120, at)).toContain('accessibilityRole="button"');
  });

  it("says the server sentences verbatim, in both languages", () => {
    // Byte-equal to the web catalogue — the probe's own words, not a phone rewrite.
    const en = DECKS.en.probeTlsHostnameSuggest("a.invalid", "b.invalid", "c.invalid", "IMAP");
    expect(en).toContain("It answers to c.invalid — use that as the IMAP host.");
    const de = DECKS.de.probeTlsHostnameSuggest("a.invalid", "b.invalid", "c.invalid", "IMAP");
    expect(de).toContain("Er antwortet auf c.invalid — nimm das als IMAP-Server.");
    expect(DECKS.en.probeTlsHostname("a.invalid", "b.invalid", "IMAP"))
      .toContain("Check the IMAP host with your provider.");
  });
});

/* ── where a refusal is SHOWN, which is a decision and not a layout ────────────────────────── */

describe("a refusal is shown where it names something", () => {
  /**
   * The form wears a refusal on the incoming-server field while the server disclosure is open. Two
   * of the door's refusals name that field; the rest do not, and pinning "your password was
   * rejected" under "Incoming server (IMAP)" tells somebody the one thing that is not wrong.
   *
   * The route's two conditions are read out of the SOURCE below, because this workspace has no
   * React Native renderer — so the decision lives in a plain module and the route is asserted to
   * be asking it in both places rather than only in one.
   */
  it("only the refusals that NAME the server fields may wear that field's error", () => {
    expect(refusalNamesServerFields(refuse("standaloneNoHost"))).toBe(true);
    expect(refusalNamesServerFields(refuse("standaloneNoPort"))).toBe(true);
    // A refused certificate is the server's; its host name is the field a mismatch is fixed in.
    expect(refusalNamesServerFields(refuse("standaloneCertificateRefused"))).toBe(true);
    expect(refusalNamesServerFields(refuse("standaloneSignInRefused"))).toBe(false);
    expect(refusalNamesServerFields(refuse("standaloneNoEncryption"))).toBe(false);
    expect(refusalNamesServerFields(refuse("standaloneNoEngine"))).toBe(false);
    expect(refusalNamesServerFields(refuse("standaloneRefused", "anything"))).toBe(false);
  });

  it("the route asks it on BOTH sites — the field's error and the line beside the verb", () => {
    // Anti-vacuity: the two conditions have to be there at all for the assertion to mean anything.
    expect(ROUTE).toContain("if (phase.k === \"failed\" && failedOn === field) return { error: sayRefusal(phase.reason) };");
    for (const f of ["imapHost", "imapPort", "smtpHost", "smtpPort"]) expect(ROUTE).toContain(`{...wears("${f}")}`);
    expect(ROUTE).toContain("!(advanced && refusalNamesServerFields(phase.reason))");
  });
});

/* ── the door itself, and the password ──────────────────────────────────────────────────────── */

/** A form filled the way a person would fill it, with a password nothing else in this file holds. */
const SECRET = "fourth-door-password";
/** The address that form signs in as: a fixture at a provider whose servers are known. */
const ADDRESS = personalAt("fixture.tobias", "gmx.net");
function filled(): StandaloneFields {
  return { ...withAddress(EMPTY_STANDALONE, ADDRESS), password: SECRET };
}

describe("opening the mailbox", () => {
  it("has no door at all until an engine is registered", () => {
    expect(phoneEngineStart()).toBeNull();
    expect(standaloneAvailable({ startEngine: null })).toBe(false);
    const start: StartPhoneEngine = async () => {
      throw new Error("not called");
    };
    registerPhoneEngine(start);
    expect(standaloneAvailable({ startEngine: phoneEngineStart() })).toBe(true);
  });

  /**
   * A SECOND ENGINE CANNOT REPLACE THE LIVE ONE — two engines in one process are two organizers.
   *
   * Enforced by construction rather than by an exception, because a throw inside `src/engine/`
   * would be an English sentence that `faultDetail` quotes verbatim into a translated refusal
   * (`test/refusal.test.ts` holds that rule). So the first registration wins, the call SAYS whether
   * it is the live one, and what is registered is asserted afterwards — a returned `false` with the
   * engine quietly swapped would be the defect this case exists for.
   */
  it("keeps the first engine and refuses to be replaced", () => {
    const a: StartPhoneEngine = async () => {
      throw new Error("a");
    };
    const b: StartPhoneEngine = async () => {
      throw new Error("b");
    };
    expect(registerPhoneEngine(a), "the first registration did not take").toBe(true);
    expect(registerPhoneEngine(a), "re-registering the same engine is not a conflict").toBe(true);
    expect(registerPhoneEngine(b), "a second engine was accepted").toBe(false);
    expect(phoneEngineStart(), "the live engine was replaced").toBe(a);
  });

  it("refuses with a sentence, never silently, when there is no engine", async () => {
    const out = await openStandaloneMailbox(filled(), {
      startEngine: null,
      platform: async () => ({ kind: "ready" as const, exec: {}, keks: {} }),
      machineName: () => "This phone",
      installId: async () => "install-1",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason.say).toBe("standaloneNoEngine");
  });

  it("refuses by naming the missing host rather than by a control that will not press", async () => {
    const noHost = { ...withAddress(EMPTY_STANDALONE, "a@her-own-domain.invalid"), password: SECRET };
    const out = await openStandaloneMailbox(noHost, {
      startEngine: async () => {
        throw new Error("the engine was asked with no host");
      },
      platform: async () => ({ kind: "ready" as const, exec: {}, keks: {} }),
      machineName: () => "This phone",
      installId: async () => "install-1",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason.say).toBe("standaloneNoHost");
  });

  /**
   * THE PASSWORD GOES TO ONE PLACE AND IS IN NO OTHER — composed, not grepped.
   *
   * The engine is handed a real config and everything else the door produced is searched for the
   * secret: the diagnostic it would log, the refusal it would raise, and the config outside
   * `imap.auth`. A `console` grep would pass over a `log(fields)` one indirection away; this does
   * not, because it reads what the door actually built.
   */
  it("puts the password in imap.auth and nowhere else", async () => {
    let seen: Parameters<StartPhoneEngine>[0] | null = null;
    const out = await openStandaloneMailbox(filled(), {
      startEngine: async (deps) => {
        seen = deps;
        throw new Error("stopped after composing");
      },
      platform: async () => ({ kind: "ready" as const, exec: {}, keks: { 1: "a".repeat(64) } }),
      machineName: () => "This phone",
      installId: async () => "install-1",
    });
    expect(seen, "the engine was never composed").not.toBeNull();
    const deps = seen as unknown as Parameters<StartPhoneEngine>[0];
    expect(deps.imap.auth.pass, "the engine did not get the password").toBe(SECRET);

    // Everything the door built, minus the one field that is meant to carry it.
    const elsewhere = { ...deps, imap: { ...deps.imap, auth: { user: deps.imap.auth.user } } };
    expect(JSON.stringify(elsewhere), "the password is somewhere it should not be")
      .not.toContain(SECRET);

    // And the refusal that followed carries the engine's message, not the credentials.
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason.say).toBe("standaloneRefused");
      expect(JSON.stringify(out.reason), "the refusal carries the password").not.toContain(SECRET);
    }
  });

  it("hands the engine the login, the name and the install id it was given", async () => {
    let seen: Parameters<StartPhoneEngine>[0] | null = null;
    await openStandaloneMailbox(filled(), {
      startEngine: async (deps) => {
        seen = deps;
        throw new Error("stopped after composing");
      },
      platform: async () => ({ kind: "ready" as const, exec: {}, keks: {} }),
      machineName: () => "This phone",
      installId: async () => "install-7",
    });
    const deps = seen as unknown as Parameters<StartPhoneEngine>[0];
    expect(deps.imap.auth.user, "the login is the address").toBe(ADDRESS);
    expect(deps.address).toBe(ADDRESS);
    expect(deps.installId, "a claim stamped with a second id reads as somebody else's")
      .toBe("install-7");
    expect(deps.machineName.length).toBeGreaterThan(0);
    expect("buildCommit" in deps, "no build was named, so none is handed on").toBe(false);
  });

  it("hands the engine this build's commit, the label a later build reads a write-off again by", async () => {
    let seen: Parameters<StartPhoneEngine>[0] | null = null;
    await openStandaloneMailbox(filled(), {
      startEngine: async (deps) => {
        seen = deps;
        throw new Error("stopped after composing");
      },
      platform: async () => ({ kind: "ready" as const, exec: {}, keks: {} }),
      machineName: () => "This phone",
      installId: async () => "install-7",
      buildCommit: "0123456789abcdef0123456789abcdef01234567",
    });
    expect((seen as unknown as Parameters<StartPhoneEngine>[0]).buildCommit).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  it("the relaunch hands the engine the same commit", async () => {
    let seen: Parameters<StartPhoneEngineFromSealed>[0] | null = null;
    await reopenStandaloneMailbox({
      startFromSealed: async (deps) => { seen = deps; return { kind: "no-credential" }; },
      platform: async () => ({ kind: "ready" as const, exec: {}, keks: {} }),
      machineName: () => "This phone",
      installId: async () => "install-7",
      buildCommit: "0123456789abcdef0123456789abcdef01234567",
    });
    expect((seen as unknown as Parameters<StartPhoneEngineFromSealed>[0]).buildCommit).toBe("0123456789abcdef0123456789abcdef01234567");
  });
});

/* ── screen 3 — Settings → This phone ───────────────────────────────────────────────────────── */

describe("screen 3: the Settings row", () => {

  it("says nothing at all before a read — not a guess", () => {
    const claim = claimFrom({ known: false, role: "organizer", serverHolds: true, organizer: null });
    expect(claim.k).toBe("unknown");
    expect(claimChipLabel(claim), "an unread claim wears a chip").toBeNull();
    expect(mayStopHere(claim)).toBe(false);
  });

  it("wears the desktop's five labels byte for byte, plus the phone's own two", () => {
    const cases: ReadonlyArray<[PhoneClaim, keyof typeof DECKS.en]> = [
      [{ k: "ours", stopping: false, releasePending: false }, "phoneStateOrganizing"],
      [{ k: "ours", stopping: true, releasePending: false }, "phoneStateStopping"],
      [{ k: "free", starting: false }, "phoneStateNotOrganized"],
      [{ k: "free", starting: true }, "phoneStateStarting"],
      [{ k: "handedBack" }, "phoneStateHandedBack"],
      [{ k: "theirsUnnamed", kind: "unknown" }, "phoneStateReaderLegacy"],
      [{ k: "pairedServer" }, "phoneStatePairedServer"],
    ];
    for (const locale of ["en", "de"] as const) {
      setActiveLocale(locale);
      for (const [claim, key] of cases) {
        expect(claimChipLabel(claim), `${locale}/${key}`).toBe(DECKS[locale][key]);
      }
      expect(claimChipLabel({ k: "theirs", name: "Studio Mac", kind: "local" }))
        .toBe(DECKS[locale].phoneStateReader("Studio Mac"));
    }
    /* EIGHT DISTINCT LABELS, so no two states wear one word. Five are the desktop's; the other
       three are the phone's own — `Starting`, which a computer has no state for (its press lands
       on an idle mailbox, and only a phone can have one queued behind a stop), `Handed back`,
       which only a platform that gives the mailbox up on the way out can be in, and the paired
       server's, which is the only door where the install that answers the roster is not this
       one. It shared "Nothing organizes this mailbox" with the free state, which is how a false
       sentence rode a passing distinctness count. */
    setActiveLocale("en");
    const all = [...cases.map(([c]) => claimChipLabel(c)),
                 claimChipLabel({ k: "theirs", name: "Studio Mac", kind: "local" })];
    expect(new Set(all).size).toBe(8);
  });

  it("derives the claim from the read, and names every holder as another install", () => {
    expect(claimFrom({ known: true, role: "reader", serverHolds: false, organizer: null }).k).toBe("free");
    expect(claimFrom({ known: true, role: "reader", serverHolds: false, organizer: { name: "Studio Mac", stopped: false } }))
      .toEqual({ k: "theirs", name: "Studio Mac", kind: "unknown" });
    /* AND THE KIND TRAVELS, which the sentence under the chip reads. A read that named no kind
       answers `unknown` — the same word a claim this build cannot rank earns, and it has its own
       sentence rather than borrowing a phone's. */
    expect(claimFrom({ known: true, role: "reader", serverHolds: false, organizer: { name: "A phone", stopped: false, kind: "mobile" } }))
      .toEqual({ k: "theirs", name: "A phone", kind: "mobile" });
  });

  /**
   * ══ THE SERVER THIS PHONE IS PAIRED WITH ORGANIZES IT ════════════════════════════════
   *
   * Measured on a device at 0.19.6 against the live hosted API: both mailboxes on a Cloud-paired
   * account answer `organizerRole: "organizer"`, `organizedBy: null`, `organizedByThisInstall:
   * false`, and Settings said **"Nothing organizes this mailbox"** about each of them — a false
   * state about the product's core function, on the normal configuration, on the screen a worried
   * person opens. The cause was a reduction: `PhoneMailbox` carried `organizedBy` and no role, and
   * `organizedBy === null` is the DTO's answer for BOTH "the answering install organizes it" and
   * "nobody ever has", so the panel could not tell them apart and guessed the worse one.
   *
   * The row below is the recorded shape, field for field. `free` is now reachable only where the
   * server calls itself a reader AND names nobody.
   */
  it("says the paired server organizes it, on the shape the live API answered", () => {
    const live = { known: true, role: "organizer" as const, serverHolds: false, organizer: null };
    expect(claimFrom(live)).toEqual({ k: "pairedServer" });
    setActiveLocale("en");
    expect(claimChipLabel(claimFrom(live)), "the phone still says nothing organizes a Cloud mailbox")
      .not.toBe(DECKS.en.phoneStateNotOrganized);
    expect(claimChipLabel(claimFrom(live))).toBe(DECKS.en.phoneStatePairedServer);
    /* AND NO VERB EITHER WAY: this app holds no engine to start and no claim to hand back. */
    expect(mayStartHere(claimFrom(live))).toBe(false);
    expect(mayStopHere(claimFrom(live))).toBe(false);
    /* THE POSITIVE CONTROL, AND IT IS THE ARM THIS FIX MUST NOT EAT — a server that calls itself
       a reader and names nobody is genuinely unorganized, and still says so. */
    expect(claimFrom({ known: true, role: "reader", serverHolds: false, organizer: null }))
      .toEqual({ k: "free", starting: false });
    expect(claimChipLabel({ k: "free", starting: false })).toBe(DECKS.en.phoneStateNotOrganized);
  });

  /**
   * The role is the discriminator and `organizedByThisInstall` only ever ADMITS beside it: on the
   * live service the boolean reads FALSE while the role reads `organizer`, so a rule that required
   * it would have left the defect exactly where it was. Driven both ways, and the second arm is
   * the one a deployment that DOES set an install id reaches.
   */
  it("admits the paired arm from either of the server's two answers, and needs neither twice", () => {
    expect(claimFrom({ known: true, role: "organizer", serverHolds: false, organizer: null }).k)
      .toBe("pairedServer");
    expect(claimFrom({ known: true, role: "reader", serverHolds: true, organizer: null }).k)
      .toBe("pairedServer");
  });

  /**
   * A HOLDER ON AN ORGANIZER ROW IS THAT SAME SERVER'S OWN CLAIM, never a foreign install: the
   * role is read FIRST for that reason. Called `theirs`, the paired server would be narrated as
   * somebody else's machine and the reader sentence would be false about the one install that is
   * certainly not reading.
   */
  it("never calls the answering server another install", () => {
    expect(claimFrom({
      known: true, role: "organizer", serverHolds: true,
      organizer: { name: "ohmail Cloud", stopped: false, kind: "cloud" },
    }).k).toBe("pairedServer");
  });

  /**
   * AND A SERVER THAT NAMED NO ROLE GETS NO CHIP. Absent is neither answer — a deployment older
   * than the column — and this panel already renders silence for "not read yet". Guessing `free`
   * there is the same false sentence arriving by the older door; guessing the paired arm would
   * claim organizing for a mailbox nothing may be organizing.
   */
  it("says nothing where the server named no role", () => {
    const claim = claimFrom({ known: true, role: null, serverHolds: false, organizer: null });
    expect(claim.k).toBe("unknown");
    expect(claimChipLabel(claim)).toBeNull();
    /* A NAMED HOLDER STILL SPEAKS on such a server — the role is missing, the holder is not. */
    expect(claimFrom({
      known: true, role: null, serverHolds: false,
      organizer: { name: "Studio Mac", stopped: false, kind: "local" },
    })).toEqual({ k: "theirs", name: "Studio Mac", kind: "local" });
  });

  /**
   * The note under the chip follows the claim, and the PLATFORM RULE is false here: "it organizes
   * while its notification is shown" describes this phone, and the server that answered organizes
   * whether or not ohmail is open. `claimNoteLine`'s `default` arm hands out that rule, so a new
   * claim added without its own case would have inherited the false sentence silently.
   */
  it("does not put this phone's platform rule under the paired server's chip", () => {
    for (const os of ["android", "ios"]) {
      expect(claimNoteLine({ k: "pairedServer" }, os), os)
        .not.toBe(platformRuleLine(os));
    }
    for (const locale of ["en", "de"] as const) {
      setActiveLocale(locale);
      expect(claimNoteLine({ k: "pairedServer" }, "android"), locale)
        .toBe(DECKS[locale].phoneStatePairedServerWhy);
    }
    setActiveLocale("en");
  });

  /**
   * ══ A PAIRED ROSTER NAMES NO CLAIM OF OURS — the name comparison, removed ═══════════════════
   *
   * This arm read `ours` where the roster's holder matched the string every ohmail phone writes
   * into its claim (`PHONE_CLAIM_NAME`), so a SECOND phone organizing the mailbox read as this
   * one: the chip said "Organizing", the hand-back was offered over a claim this app does not
   * hold, and pressing it asked the paired server to give up a claim it has not got.
   *
   * A paired phone runs no IMAP client and writes no claim, so the comparison's answer is a
   * constant. The two arms below are the pair: the OTHER phone's claim, named exactly as this
   * install names itself, and a claim with a kind of `mobile` — neither is ours, neither wears
   * "Organizing", and neither offers a verb.
   */
  it("never reads another phone's claim as this one's, however it is named", () => {
    for (const kind of [undefined, "mobile"]) {
      const claim = claimFrom({
        known: true,
        role: "reader",
        serverHolds: false,
        organizer: { name: PHONE_CLAIM_NAME, stopped: false, ...(kind === undefined ? {} : { kind }) },
      });
      expect(claim, `kind=${String(kind)}`)
        .toEqual({ k: "theirs", name: PHONE_CLAIM_NAME, kind: kind === "mobile" ? "mobile" : "unknown" });
      expect(mayStopHere(claim), "a hand-back was offered over a claim this app does not hold")
        .toBe(false);
      expect(mayStartHere(claim), "a start was offered over a mailbox another install organizes")
        .toBe(false);
      setActiveLocale("en");
      expect(claimChipLabel(claim)).toBe(DECKS.en.phoneStateReader(PHONE_CLAIM_NAME));
    }
    /* THE CONTROL — a roster that names NOBODY is free, which is the one state this arm may
       still put a Start verb under (and it does not, on a paired row: `starting` is never set
       there and the panel withholds the verb off the card's own key). */
    expect(claimFrom({ known: true, role: "reader", serverHolds: false, organizer: null })).toEqual({ k: "free", starting: false });
  });

  /**
   * ══ THE FOUR KINDS, READ OFF EITHER DOOR'S SPELLING BY ONE READER ══════════════════════════
   *
   * The standalone door hands the engine's stand-down reason (`organized_elsewhere:mobile`); the
   * paired door hands the roster's bare word (`mobile`). Two readers would let the two arms of one
   * panel put different sentences on the same fact, which is the defect this row is about.
   */
  it("narrows the holder's kind from both doors' spellings", () => {
    const four: readonly HolderKind[] = ["local", "cloud", "mobile", "unknown"];
    for (const kind of four) {
      expect(holderKind(kind), `the bare word ${kind}`).toBe(kind);
      expect(holderKind(`organized_elsewhere:${kind}`), `the reason for ${kind}`).toBe(kind);
    }
    /* ANYTHING ELSE IS `unknown`, which is an answer: a claim written by a build this one cannot
       rank. Including nothing at all — a read that did not carry the field. */
    for (const said of [null, undefined, "", "desktop", "organized_elsewhere:desktop", "mobile:x"]) {
      expect(holderKind(said), JSON.stringify(said)).toBe("unknown");
    }
    /* AND THE CASE IS NOT LOAD-BEARING — the wire's own word is lower case, and a build that
       shouted it must not lose the sentence. */
    expect(holderKind("Organized_Elsewhere:MOBILE")).toBe("mobile");
  });

  /**
   * ══ THE DOOR'S OWN CLAIM, AND WHY IT ASKS NOBODY'S NAME ════════════════════════════════════
   *
   * `claimFrom` recognises our own claim by name. Every ohmail phone writes the SAME display name
   * into its claim, so on the ordinary two-phone case the name test answers `ours` for the other
   * phone's claim: the panel would wear "Organizing" and offer a hand-back over a mailbox this
   * phone organizes nothing of — a worse false state than the one being fixed. The engine's
   * `organizing` is this install's verdict on its own claim, which is what the name test was
   * standing in for, so `claimHere` reads that and compares nothing.
   */
  it("reads the door's own state, and never mistakes another phone's claim for ours", () => {
    const ourName = { name: "ohmail on a phone", standDownReason: "organized_elsewhere:mobile", holderState: "held" as const };
    /* THE CASE THE NAME TEST GETS WRONG: the holder is named exactly as we name ourselves, and
       the engine has said we are NOT organizing. */
    expect(claimHere({ organizing: false, releaseRequestedAt: null, heldBy: ourName }))
      .toEqual({ k: "theirs", name: "ohmail on a phone", kind: "mobile" });
    expect(mayStopHere(claimHere({ organizing: false, releaseRequestedAt: null, heldBy: ourName })),
      "a hand-back is offered over a claim this phone does not hold").toBe(false);
    /* THE CONTROL — the same name, and the engine says we ARE organizing. */
    expect(claimHere({ organizing: true, releaseRequestedAt: null, heldBy: null })).toEqual({ k: "ours", stopping: false, releasePending: false });
    expect(mayStopHere(claimHere({ organizing: true, releaseRequestedAt: null, heldBy: null }))).toBe(true);
  });

  it("answers the door's three states, and says nothing before the first cycle", () => {
    /* `null` is "the engine has not said yet": no chip and no sentence a second after the door
       opened, rather than "nothing organizes this mailbox". */
    expect(claimHere({ organizing: null, releaseRequestedAt: null, heldBy: null })).toEqual({ k: "unknown" });
    expect(claimHere({ organizing: false, releaseRequestedAt: null, heldBy: null })).toEqual({ k: "free", starting: false });
    expect(claimHere({ organizing: true, releaseRequestedAt: null, heldBy: null }, "stopping"))
      .toEqual({ k: "ours", stopping: true, releasePending: false });
    /* A HOLDER THE CLAIM DID NOT NAME is `theirsUnnamed` and NOT `free` — the relaunch arm, where
       the engine reassembles the stand-down from its own row and the row remembers no holder. */
    expect(claimHere({ organizing: false, releaseRequestedAt: null, heldBy: { name: "", standDownReason: "organized_elsewhere:local", holderState: null } }))
      .toEqual({ k: "theirsUnnamed", kind: "local" });
  });

  it("STOPPING RESOLVES to not-organizing the moment the service reports down", () => {
    /**
     * ══ CONTROL 4 (the chip's own half) ════════════════════════════════════════════════════
     *
     * Measured on a device: after the hand-back the chip read `Stopping` for ≥ 2 min 30 s with the
     * claim already gone from `ohmail/_meta` and zero bytes on the wire; it settled the instant
     * Settings was left and re-entered. Two things were wrong and only one of them was the
     * subscription: the press is the newest word only while the engine still says this install
     * organizes the mailbox, and once it says otherwise the ROW is the word.
     *
     * So `stopAsked` may never outrank the engine's own answer. Both arms here, because a
     * `stopping` that never resolved and a `stopping` that never showed are both wrong.
     */
    /* THE PRESS LANDED and the engine still holds the claim — "Stopping", and no second stop. */
    const stopping = claimHere({ organizing: true, releaseRequestedAt: null, heldBy: null }, "stopping");
    expect(stopping).toEqual({ k: "ours", stopping: true, releasePending: false });
    expect(claimChipLabel(stopping)).toBe(DECKS.en.phoneStateStopping);
    expect(mayStopHere(stopping), "a second stop was offered for one already asked for").toBe(false);
    expect(mayStartHere(stopping), "a start was offered over a claim this phone still holds").toBe(false);

    /* THE SERVICE REPORTS DOWN — the engine says this install organizes nothing and nobody else
       holds it. The press is spent, and the panel says the true thing with the way back on it. */
    const settled = claimHere({ organizing: false, releaseRequestedAt: null, heldBy: null }, "stopping");
    expect(settled, "`Stopping` outlived the stop it was about").toEqual({ k: "free", starting: false });
    expect(claimChipLabel(settled)).toBe(DECKS.en.phoneStateNotOrganized);
    expect(mayStartHere(settled), "a remembered stop left no way back").toBe(true);
    expect(mayStopHere(settled)).toBe(false);
  });

  /**
   * ══ AND THE SAME RULE IN THE OTHER DIRECTION — `Starting` resolves when the engine says it has ══
   *
   * The twin of the case above, and the arm device run 3 met second: a start pressed after a stop
   * left the panel saying `Stopping` over a phone that was filing mail. Both transitions are the
   * instruction modifying the engine's answer, never replacing it.
   */
  it("STARTING RESOLVES to organizing the moment the engine says it holds the claim", () => {
    const starting = claimHere({ organizing: false, releaseRequestedAt: null, heldBy: null }, "starting");
    expect(starting).toEqual({ k: "free", starting: true });
    expect(claimChipLabel(starting)).toBe(DECKS.en.phoneStateStarting);
    expect(mayStartHere(starting), "a second start was offered for one already asked for").toBe(false);
    expect(mayStopHere(starting), "a stop was offered over a mailbox nothing organizes").toBe(false);

    const settled = claimHere({ organizing: true, releaseRequestedAt: null, heldBy: null }, "starting");
    expect(settled, "`Starting` outlived the start it was about").toEqual({ k: "ours", stopping: false, releasePending: false });
    expect(claimChipLabel(settled)).toBe(DECKS.en.phoneStateOrganizing);
    expect(mayStopHere(settled), "a settled start left no way out").toBe(true);
  });

  /**
   * A FOREIGN HOLDER OUTRANKS BOTH TRANSITIONS. `starting` and `stopping` are words about what THIS
   * install asked for; a mailbox another machine is renewing a claim on is not this install's to
   * describe, and a chip reading `Starting` over it would promise a takeover this build has not got.
   */
  it("says who holds the mailbox, whatever this phone was asked to do", () => {
    const held = {
      organizing: false, releaseRequestedAt: null,
      heldBy: { name: "Studio Mac", standDownReason: "organized_elsewhere:local", holderState: "held" as const },
    };
    for (const instruction of ["idle", "starting", "stopping", "running"] as const) {
      expect(claimHere(held, instruction), instruction)
        .toEqual({ k: "theirs", name: "Studio Mac", kind: "local" });
    }
  });

  /**
   * ══ HANDED BACK — THE TRANSITIONAL STATE, WHICH THE PANEL HAD NO WORD FOR ═══════════════════
   *
   * On the way out this install releases its claim so somebody's laptop can have the mailbox
   * while the phone is asleep, and takes it again on the way back in. Between the two the engine
   * reports exactly what a mailbox nobody ever claimed reports — not organizing, no holder — so
   * the panel said `Nothing organizes this mailbox` and offered a start for something the next
   * foreground does by itself. The one fact only this install holds is that the release was ours,
   * and `organizerHandedBack()` is where it lives.
   */
  it("says the mailbox was handed back, in both languages, with no verb to press", () => {
    const free = { organizing: false, heldBy: null, releaseRequestedAt: null };
    const back = claimHere(free, "idle", true);
    expect(back).toEqual({ k: "handedBack" });
    for (const locale of ["en", "de"] as const) {
      setActiveLocale(locale);
      expect(claimChipLabel(back), locale).toBe(DECKS[locale].phoneStateHandedBack);
      /* AND THE SENTENCE, which is the half that says what it means for the person: their other
         machine can take the mailbox right now. The platform rule is not said here — it describes
         a notification this state deliberately does not have. */
      expect(claimNoteLine(back, "ios"), locale).toBe(DECKS[locale].phoneStateHandedBackWhy);
      expect(claimNoteLine(back, "android"), locale).toBe(DECKS[locale].phoneStateHandedBackWhy);
    }
    setActiveLocale("en");
    /* NEITHER VERB. There is nothing to stop, and the start is about to happen without a press. */
    expect(mayStopHere(back)).toBe(false);
    expect(mayStartHere(back)).toBe(false);
  });

  it("ABSENT otherwise — the flag may only ever refine the free arm", () => {
    /* Without this the chip is satisfied by a panel that renders it always. Each arm below is a
       state where "Handed back" would be the false sentence: a mailbox nothing has released, one
       this install still organizes, one another machine took while the phone was away, and a
       start a person is waiting on. */
    const free = { organizing: false, heldBy: null, releaseRequestedAt: null };
    expect(claimHere(free, "idle", false)).toEqual({ k: "free", starting: false });
    expect(claimHere({ organizing: true, heldBy: null, releaseRequestedAt: null }, "idle", true))
      .toEqual({ k: "ours", stopping: false, releasePending: false });
    expect(claimHere({ organizing: null, heldBy: null, releaseRequestedAt: null }, "idle", true)).toEqual({ k: "unknown" });
    const held = {
      organizing: false, releaseRequestedAt: null,
      heldBy: { name: "Studio Mac", standDownReason: "organized_elsewhere:local", holderState: "held" as const },
    };
    expect(claimHere(held, "idle", true), "a hand-back outranked the machine that took the mailbox")
      .toEqual({ k: "theirs", name: "Studio Mac", kind: "local" });
    expect(claimHere(free, "starting", true), "a stale hand-back replaced the press being waited on")
      .toEqual({ k: "free", starting: true });
  });

  it("offers the way back in ONE state, and each exclusion is a sentence it would make false", () => {
    /* `free` and nothing else. `unknown` has not been read; `ours` already organizes; the two
       foreign arms would promise a takeover this build does not have — the door refuses a live
       foreign claim 409, so the press would do nothing and say it had. */
    expect(mayStartHere({ k: "free", starting: false })).toBe(true);
    expect(mayStartHere({ k: "free", starting: true }),
      "a second start was offered while one was already being carried out").toBe(false);
    expect(mayStartHere({ k: "unknown" })).toBe(false);
    expect(mayStartHere({ k: "ours", stopping: false, releasePending: false })).toBe(false);
    expect(mayStartHere({ k: "theirs", name: "a laptop", kind: "local" })).toBe(false);
    expect(mayStartHere({ k: "theirsUnnamed", kind: "local" })).toBe(false);
  });

  /**
   * ══ AND THE SENTENCE UNDER THE CHIP, WHICH IS THE ROW ITSELF ═══════════════════════════════
   *
   * PHONE-STAND-DOWN-IS-NOT-SAID. The panel rendered the platform rule in every state — "It
   * organizes while its notification is shown" — which is false over a mailbox another machine
   * holds, and it was the only sentence a standing-down phone got beside a chip naming nobody.
   */
  it("says who organizes the mailbox when it is not this phone, in both languages", () => {
    for (const locale of ["en", "de"] as const) {
      setActiveLocale(locale);
      const deck = DECKS[locale];
      expect(claimNoteLine({ k: "theirs", name: "Studio Mac", kind: "local" }, "android"),
        `${locale}/local`).toBe(deck.phoneStateReaderWhy("Studio Mac"));
      expect(claimNoteLine({ k: "theirs", name: "ohmail Cloud", kind: "cloud" }, "android"),
        `${locale}/cloud`).toBe(deck.phoneStateReaderWhy("ohmail Cloud"));
      /* A PHONE HOLDER HAS ITS OWN SENTENCE: it organizes only while ohmail is open on it, which
         is the one kind that changes what somebody should expect of their mail. */
      expect(claimNoteLine({ k: "theirs", name: "the other phone", kind: "mobile" }, "android"),
        `${locale}/mobile`).toBe(deck.phoneStateReaderWhyPhone("the other phone"));
      expect(claimNoteLine({ k: "theirsUnnamed", kind: "unknown" }, "android"),
        `${locale}/unnamed`).toBe(deck.phoneStateReaderWhyUnnamed);
      expect(claimNoteLine({ k: "theirsUnnamed", kind: "mobile" }, "android"),
        `${locale}/unnamed-mobile`).toBe(deck.phoneStateReaderWhyUnnamedPhone);
      /* AND THE HOLDER'S NAME IS IN IT — the whole point of the row. */
      expect(claimNoteLine({ k: "theirs", name: "Studio Mac", kind: "local" }, "android"))
        .toContain("Studio Mac");
    }
    setActiveLocale("en");
    /* FIVE DISTINCT SENTENCES over the five foreign states, so no two wear one wording — the
       shape of the defect was two states sharing a sentence. */
    const said = [
      claimNoteLine({ k: "theirs", name: "Studio Mac", kind: "local" }, "android"),
      claimNoteLine({ k: "theirs", name: "Studio Mac", kind: "mobile" }, "android"),
      claimNoteLine({ k: "theirsUnnamed", kind: "local" }, "android"),
      claimNoteLine({ k: "theirsUnnamed", kind: "mobile" }, "android"),
      claimNoteLine({ k: "ours", stopping: false, releasePending: false }, "android"),
    ];
    expect(new Set(said).size, "two states share one sentence").toBe(5);
    /* AND NO SENTENCE OFFERS A TAKEOVER — there is no such press in this panel, and promising one
       would be a claim the screen makes false. */
    for (const line of said) expect(line!.toLowerCase()).not.toContain("take");
  });

  /**
   * THE PLATFORM RULE IS A STATEMENT ABOUT THE BUILD, so it is said only where this phone
   * organizes — and RE-DERIVED here rather than relaxed.
   *
   * It used to be said in three states. In the free one it reads "It organizes while its
   * notification is shown. Dismiss the notification to stop." under the words "Nothing organizes
   * this mailbox", beside a verb that says "Start organizing here" — an instruction about a
   * notification that is not there, measured on a device. The invariant is unchanged: every note
   * the panel shows is true of the state it is under, and a state with nothing true to say says
   * nothing.
   */
  it("says the platform rule only where this phone organizes, on every platform", () => {
    setActiveLocale("en");
    for (const os of ["android", "ios", "web"]) {
      for (const claim of [{ k: "ours", stopping: false, releasePending: false } as const, { k: "ours", stopping: true, releasePending: false } as const]) {
        expect(claimNoteLine(claim, os), `${os}/${claim.k}`).toBe(platformRuleLine(os));
      }
      for (const claim of [{ k: "free", starting: false } as const, { k: "free", starting: true } as const,
                           { k: "unknown" } as const]) {
        expect(claimNoteLine(claim, os), `${os}/${claim.k} promised a notification it is not showing`)
          .toBeNull();
      }
    }
  });

  /**
   * AND NOT OVER A DECLINE (FIX-026 row 94). Under "Notifications are off" or battery saver this
   * phone organizes only while it is open, so "It organizes while its notification is shown" stood
   * over the sentence that contradicts it; the decline's own sentence is the card's statement.
   */
  it("says no platform rule over a decline, and keeps the stop's own sentence", () => {
    setActiveLocale("en");
    const ours = { k: "ours", stopping: false, releasePending: false } as const;
    expect(claimNoteLine(ours, "android", { declined: false }), "control: the rule stands with no decline")
      .toBe(platformRuleLine("android"));
    expect(claimNoteLine(ours, "android", { declined: true }), "the rule line stood over the decline").toBeNull();
    expect(claimNoteLine({ ...ours, releasePending: true }, "android", { declined: true }))
      .toBe(DECKS.en.phoneStateStopPendingWhy);
    expect(claimNoteLine({ k: "theirs", name: "Studio Mac", kind: "local" }, "android", { declined: true }))
      .toBe(claimNoteLine({ k: "theirs", name: "Studio Mac", kind: "local" }, "android"));
    /* The card's records, over the door in this process only — both declines, one helper. */
    expect(SETTINGS).toContain("key === HERE_CARD && (organizerRestrictedSaid() || organizerNotificationsOffSaid())");
  });

  /**
   * A STOP THIS APP ASKED FOR IS THE NEWEST WORD until the row carries it.
   *
   * The desktop's `stopQueued` rule exists because the press showed no trace anywhere: a whole
   * session of retries with the row reading "files this mailbox" throughout. Both clocks produce
   * "Stopping" here — the press, and the row's own `stopped`.
   */
  it("stops saying Organizing the moment the press lands", () => {
    /* ON THE DOOR IN THIS PROCESS, which is the only card that can say `ours` at all. The paired
       arm had its own copy of this rule and the copy was the defect: it decided "ours" by the
       display name. Here the instruction is the press and the engine's own answer settles it. */
    expect(claimHere({ organizing: true, releaseRequestedAt: null, heldBy: null }, "stopping"))
      .toEqual({ k: "ours", stopping: true, releasePending: false });
    setActiveLocale("en");
    expect(claimChipLabel(claimHere({ organizing: true, releaseRequestedAt: null, heldBy: null }, "stopping")))
      .toBe(DECKS.en.phoneStateStopping);
  });

  it("offers the hand-back only over a claim of ours, and not twice", () => {
    expect(mayStopHere({ k: "ours", stopping: false, releasePending: false })).toBe(true);
    // Asked for already: a second press queues a second request for a thing already happening.
    expect(mayStopHere({ k: "ours", stopping: true, releasePending: false })).toBe(false);
    for (const claim of [
      { k: "free", starting: false } as const,
      { k: "unknown" } as const,
      { k: "theirs", name: "Studio Mac", kind: "local" } as const,
      { k: "theirsUnnamed", kind: "unknown" } as const,
    ]) {
      expect(mayStopHere(claim), claim.k).toBe(false);
    }
  });

  /**
   * RE-DERIVED, AND THE OLD PIN SAYS WHY. It held `platformRuleLine(Platform.OS)` in the panel,
   * and rendering that in EVERY state was the defect: over a mailbox another machine holds, "It
   * organizes while its notification is shown" is false. The invariant is unchanged — the panel
   * names the mailbox, the state, what this phone does about it, and the verb — and the note is
   * now the decision that answers the platform rule for the three states it is true of, which the
   * case above drives on both platforms.
   */
  /**
   * ══ THE NOTES ABOUT THIS PHONE'S ENGINE, ON THIS PHONE'S CARD ONLY ══════════════════
   *
   * "Notifications are off — organizing runs only while the app is open." rendered under EVERY
   * card, gated on the system record alone. On a Cloud-paired roster that is a second false
   * sentence directly beneath the first (the chip): the paired server organizes whether or not
   * this app is open and whatever this phone's notification permission is. Its neighbour
   * `organizerRestricted` ("It organizes while the app is open, and hands the mailbox back when
   * you leave") is the same sentence about battery saver and was fixed with it — a fix that lands
   * on one of a pair ships the other.
   *
   * Asserted over the source because `@testing-library/react-native` is deliberately absent from
   * this store (`test/unsaved-changes.test.ts` pins that), so no test here mounts a screen. The
   * needle is the whole condition, and the two cases below establish what `HERE_CARD` means: the
   * cards are EITHER the one `standaloneHere()` answers for, under that key, OR the paired
   * roster's rows under their mailbox ids — so `row.key === HERE_CARD` is "the door in this
   * process" and can be nothing else.
   */
  it("says the app-is-open notes only on the card this phone's own engine holds", () => {
    for (const said of ["organizerNotificationsOffSaid()", "organizerRestrictedSaid()"]) {
      expect(SETTINGS, `${said} is rendered over a paired row, where its sentence is false`)
        .toContain(`{${said} && row.key === HERE_CARD ? (`);
    }
    /* WHAT THE KEY MEANS — the two card sources, so the gate above cannot be green on a constant
       that names something else. */
    expect(SETTINGS).toContain("key: HERE_CARD,");
    expect(SETTINGS).toContain("claim: claimHere(here, organizerInstruction(), organizerHandedBack()),");
    expect(SETTINGS).toContain("w.mailboxes.rows.map((row) => ({");
    expect(SETTINGS).toContain("key: row.id,");
  });

  /**
   * AND THE ROLE REACHES THE PANEL. The claim is composed in the screen, so the read it is built
   * from is where the defect lived: a composition that passes only the holder can answer nothing but
   * `free` for a mailbox the answering server organizes, whatever `claimFrom` is taught.
   */
  it("hands the panel's paired read the server's own role", () => {
    expect(SETTINGS).toContain("role: row.organizerRole,");
    expect(SETTINGS).toContain("serverHolds: row.organizedByThisInstall,");
  });

  it("names the mailbox, the state, what this phone does about it, and the verb", () => {
    for (const piece of ["row.address", "claimChipLabel(", "claimNoteLine(claim, Platform.OS, { declined: declinedHere(row.key) })",
                         "Copy.settingsStopHere"]) {
      expect(SETTINGS, `the panel does not render ${piece}`).toContain(piece);
    }
    expect(SETTINGS, "the platform rule is rendered over every state again")
      .not.toContain("platformRuleLine(Platform.OS)");
  });

  /**
   * THE DANGER IS ON THE CONFIRM AND NOWHERE ELSE — the spec's rule, read off the file.
   *
   * The verb in the panel is `quiet`; the consequence and the confirm are in the sheet, which is
   * this app's own destructive idiom (`FoldersGroup`'s delete). A `solid` or accented verb in the
   * panel would make the press look like the recommendation.
   */
  it("keeps the danger style on the confirm", () => {
    const verb = SETTINGS.indexOf("label={Copy.settingsStopHere}");
    expect(verb, "the panel does not render the verb").toBeGreaterThan(-1);
    const element = SETTINGS.slice(SETTINGS.lastIndexOf("<Button", verb), verb + 300);
    expect(element, "the panel's verb is not the quiet one").toContain('variant="quiet"');
    expect(element, "the panel's verb wears the accent fill").not.toContain('variant="solid"');
    expect(SETTINGS, "the consequence is not stated before the confirm")
      .toContain("Copy.settingsStopHereWhat");
    expect(SETTINGS).toContain("Copy.settingsStopHereConfirm");
    expect(SETTINGS, "there is no way out of the confirm").toContain("Copy.settingsStopHereCancel");
  });

  /**
   * RENDERS ONLY WHERE AN ENGINE IS REGISTERED — and over the DOOR, not over a read that landed.
   *
   * This pinned `!w.mailboxes.known` as the second gate, and that gate was the defect: the roster
   * read behind it has three outcomes — never asked, asked and refused, answered empty — which all
   * arrive as one `false`, so the panel was dark for three reasons and said nothing about any. Read
   * on a device across three release builds with an engine running behind it.
   *
   * The engine answers for itself now (`organizer-session.ts#standaloneHere`), so the pin moves
   * with the classification: the build gate stays, the read gate is replaced by the door, and the
   * PAIRED arm's roster source is asserted still to be there — a fix that took the roster away from
   * the door it still serves would be half-applied.
   */
  it("renders at all only where an engine is registered, and asks the DOOR rather than a read", () => {
    expect(SETTINGS).toContain("standaloneAvailable({ startEngine: phoneEngineStart() })");
    expect(SETTINGS, "the panel still gates on a roster read landing").not.toContain("!w.mailboxes.known");
    expect(SETTINGS, "the panel does not ask the door").toContain("const here = standaloneHereFor({ standalone: w.standalone })");
    expect(SETTINGS, "the paired arm lost its roster").toContain("w.mailboxes.rows.map((row) => ({");
  });

  /**
   * ══ A PRESS'S SENTENCE MAY NOT OUTLIVE THE STATE IT DESCRIBES ══════════════════════════════
   *
   * Device run 6, rc4-2. A stop the mail server could not confirm left *"This phone could not hand
   * that mailbox back, so it is still organizing it"* beside the chip — true, while the claim was
   * still ours. The standing request was then honoured on the next round with no second press, and
   * for two reads 17 s apart the panel carried the NEW chip over the OLD sentence: `Nothing
   * organizes this mailbox`, that sentence under it, and `Start organizing here` offered.
   *
   * It was a `useState` boolean that only another press ever cleared. It is a DERIVATION now — the
   * press records what it answered, the claim decides whether that is still true, and the panel
   * reads the pair at every render. BOTH VERBS, because the start half is the same latch in the
   * other direction: "could not start … nothing changed" standing over a phone that is organizing.
   */
  it("drops a press's sentence the moment the claim moves past it, both verbs", () => {
    setActiveLocale("en");
    const oursNow = { k: "ours", stopping: false, releasePending: false } as const;
    const free = { k: "free", starting: false } as const;
    const handedBack = { k: "handedBack" } as const;
    const theirs = { k: "theirs", name: "Studio Mac", kind: "local" } as const;

    /* A REFUSED STOP WHILE THE CLAIM IS STILL OURS — the state the sentence is about, and the
       reading the device got right. */
    expect(pressSaidLine("stopRefused", oursNow)).toBe(DECKS.en.settingsStopHereFailed);
    /* AND THE MOMENT THE RELEASE LANDS. Each of these is a state in which the sentence's own words
       — "so it is still organizing it" — are false. */
    for (const claim of [free, handedBack, theirs]) {
      expect(pressSaidLine("stopRefused", claim), `${claim.k} kept a stop refusal already honoured`)
        .toBeNull();
    }

    /* THE OTHER DIRECTION. "Nothing changed" is false once this phone holds the claim. */
    expect(pressSaidLine("startRefused", free)).toBe(DECKS.en.settingsStartHereFailed);
    expect(pressSaidLine("startUnreadable", free)).toBe(DECKS.en.settingsStartHereUnreadable);
    for (const said of ["startRefused", "startUnreadable"] as const) {
      expect(pressSaidLine(said, oursNow), `${said} outlived the start it was about`).toBeNull();
    }

    /* NOT-READ-YET IS NOT A CONTRADICTION. `unknown` is "the engine has not said", so dropping the
       answer to a press somebody has just made would take the sentence away at the one moment it
       is owed. */
    expect(pressSaidLine("stopRefused", { k: "unknown" })).toBe(DECKS.en.settingsStopHereFailed);
    expect(pressSaidLine("startRefused", { k: "unknown" })).toBe(DECKS.en.settingsStartHereFailed);

    /* AND NOTHING SAID IS NOTHING RENDERED. */
    expect(pressSaidLine(null, oursNow)).toBeNull();
  });

  it("renders that sentence through the derivation and keeps no latch of its own", () => {
    /* The screen half. The panel held two booleans and rendered each on its own, which is where
       the stale sentence came from: nothing but another press could clear either. One record, one
       reader, and the reader is the claim the rest of the row is already drawn from. */
    expect(SETTINGS, "the panel does not render the press sentence through its derivation")
      .toContain("pressSaidLine(said, claim)");
    expect(SETTINGS, "the panel still renders a bare stop latch").not.toContain("stopFailed &&");
    expect(SETTINGS, "the panel still keeps a second press latch").not.toContain("setStartRefusal(");
  });
});
