/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import en from "../../webapp/messages/en.json";
import { CLOUD_URL } from "../src/doors.js";
import { selfHostBase, selfHostProblem } from "../src/self-host.js";
/* THE ENGINE'S OWN RULE, imported rather than restated — `desktop-door-reconfigure.test.tsx` does
   the same with `credentialIsForeign` and for the same reason. Two programs have to agree on this
   comparison and cannot share a package, so it travels as an import-free file; deleting the
   comparison from the engine reddens this file too, which is what makes the model below a model of
   the engine rather than a second opinion about it. */
import { baseIsForeign } from "../../sidecar/src/cloud-origin.js";

/**
 * ═══ THE THREE DOORS, AND THE ONE THAT IS NEW ══════════════════════════════════════════════════
 *
 * A fresh install asks one question — which machine organizes this mailbox? — and there are three
 * answers: this computer, a server the person runs, or ours. The first and third existed. The
 * second is the hosted door with its server address made a variable (`self-host.ts`), and this file
 * is what holds the three claims that change makes.
 *
 * ── 1. THE COPY IS THE PRODUCT'S CLAIM, SO THE COPY IS UNDER TEST ─────────────────────────────
 *
 * Two sentences on this screen are load-bearing rather than decorative, and both are checked
 * against the fact that makes them true rather than merely present:
 *
 *  · **"Nothing is sent anywhere."** on the local door. The window cannot dial at all — the CSP is
 *    `connect-src 'none'` and `offline-guard.ts` replaces every browser API that could leave the
 *    process — and the local door's engine reaches no hosted client in its import graph
 *    (`cloud-engine-census.test.ts` holds that end). What this file adds is the near end: picking
 *    the local door composes a configuration that names NO server of ours, so the sentence is
 *    checked against the payload the door actually sends.
 *  · **The travel sentence**, beneath all three. It says rules and settings live in the mailbox and
 *    that the mailbox is the master — the product's own invariant, and the reason moving between
 *    these doors is not a migration.
 *
 * ── 2. A SELF-HOSTED ADDRESS CAN BE WRONG, WHICH THE HOSTED CONSTANT NEVER COULD ──────────────
 *
 * So the door PROVES the server before it asks for a password, and every refusal names the address
 * that was dialled. The cases below drive a typo, a machine that answers but is not ohmail, and a
 * certificate from an authority this computer does not trust — the last being what a correctly
 * configured private stack looks like from here, not a misconfiguration.
 *
 * ── 3. A CREDENTIAL IS A FACT ABOUT ONE SERVER ────────────────────────────────────────────────
 *
 * The boot contract, in its cloud spelling. A session sealed by one server must never be offered to
 * another, and the mirror bootstrapped against one must never be read under a session from another.
 * The model below implements that the way the engine does — `enforceMirrorOwner`'s discard, driven
 * by the engine's own `baseIsForeign` — so `foreignSessionOffers()` can be an assertion about
 * recorded boots rather than an assertion about call order.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ────────────────────────────────────────────
 *
 * Run 2026-09-01, each applied alone and the tree restored after it. What is written here is what
 * the run PRINTED.
 *
 *  · `selfHostBase` returning the bare origin instead of `apiBaseFor(origin)` → "configures the
 *    engine for <origin>/api" red, and the end-to-end case red — which is the whole reason that
 *    derivation is not a detail: the bare origin reaches the web app, which answers 404 HTML.
 *  · dropping the probe from `configureSelfHostDoor` → all three refusal cases red; the door
 *    walks straight past a server that is not there and asks for a password.
 *  · dropping `|| serverChanged` from `enforceMirrorOwner` (the engine, not this file) →
 *    "never offers one server's session to another" red with a recorded offer of the hosted
 *    session to the operator's machine. The engine's own mirror-owner suite reds with it too.
 *  · deleting the travel sentence, or "Nothing is sent anywhere" → the copy cases red.
 *  · letting the address field stay editable after the probe → "locks the server once it has
 *    answered" red.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const OPERATOR_ORIGIN = "https://ohmail.example.com";
const OPERATOR_BASE = `${OPERATOR_ORIGIN}/api`;
const ADDRESS = "mila@example.com";

/** One engine BOOT in cloud mode: the base it was configured with, and the session it would hold. */
interface Boot {
  base: string;
  /** The sealed session present at this boot, and the server that minted it — or null. */
  session: { mintedBy: string; token: string } | null;
}

/** The whole install, as the facts that decide whose mail it holds and whose token it sends. */
interface Install {
  /** The shell's settings file — the base the NEXT engine is configured with. */
  settingsBase: string;
  settingsAddress: string;
  /** `cloud-tokens.seal`, and who minted what is in it. */
  sealed: { mintedBy: string; token: string } | null;
  /** The mirror's recorded owner: the address, and the server it was bootstrapped against. */
  marker: { address: string; base: string | null } | null;
  boots: Boot[];
  asked: Array<{ command: string; payload?: Record<string, unknown> }>;
  /** What `POST /cloud/probe` answers. Replace to drive a refusal. */
  probe: { status: number; body: string };
  /** What `POST /cloud/signin` answers. */
  signin: { status: number; body: string };
}

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

function encode(status: number, body = "", statusText = "OK"): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText, h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

const OK_PROBE = {
  status: 200,
  body: JSON.stringify({ ok: true, target: `${OPERATOR_BASE}/hello`, flavor: "selfhost" }),
};

/**
 * An install, optionally one already mirroring the HOSTED service with a session sealed by it.
 *
 * That second state is the one the server contract is about: everything below it is what happens
 * when somebody moves such an install to a machine they run.
 */
function install(mirroring?: { base: string; address: string }): Install {
  const it: Install = {
    settingsBase: mirroring?.base ?? "",
    settingsAddress: mirroring?.address ?? "",
    sealed: mirroring ? { mintedBy: mirroring.base, token: "session-minted-by-" + mirroring.base } : null,
    marker: mirroring ? { address: mirroring.address, base: mirroring.base } : null,
    boots: [],
    asked: [],
    probe: OK_PROBE,
    signin: { status: 200, body: '{"status":"signed_in"}' },
  };

  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      it.asked.push({ command, payload });

      if (command === "engine_configure") {
        const config = payload!.config as { mode: string; cloudUrl?: string; address?: string };
        if (config.mode !== "cloud") {
          /* The LOCAL door. Recorded so the "nothing is sent anywhere" case can assert on the
             payload rather than on the sentence alone: a local configuration names an IMAP host
             and carries no server of ours at all. */
          it.settingsBase = "";
          it.boots.push({ base: "", session: null });
          return { state: "starting", mode: "local" };
        }
        it.settingsBase = config.cloudUrl ?? "";
        it.settingsAddress = config.address ?? "";

        /* ── `enforceMirrorOwner`, AS THE ENGINE RUNS IT ───────────────────────────────────
           Before the database is opened: a change of address OR of server discards the mirror,
           the cursor AND the sealed session together. The server comparison is the engine's own
           predicate, imported — that is what makes this a model and not a restatement. */
        const addressChanged =
          it.marker !== null &&
          it.marker.address.trim().toLowerCase() !== it.settingsAddress.trim().toLowerCase();
        const serverChanged = baseIsForeign(it.marker?.base ?? null, it.settingsBase);
        if (it.marker !== null && (addressChanged || serverChanged)) it.sealed = null;
        it.marker = { address: it.settingsAddress, base: it.settingsBase };

        // THE BOOT: a configured server meets whatever session the store still holds.
        it.boots.push({ base: it.settingsBase, session: it.sealed });
        return { state: "starting", mode: "cloud" };
      }

      if (command === "engine_status") {
        return {
          state: "serving",
          mode: it.settingsBase === "" ? "local" : "cloud",
          address: it.settingsAddress,
          mailboxId: "mbx-1",
          credentialState: it.sealed === null ? "absent" : "ready",
        };
      }

      if (command === "engine_request") {
        const url = String(payload!.url ?? "");
        if (url === "/cloud/probe") return encode(it.probe.status, it.probe.body);
        if (url === "/cloud/signin") {
          if (it.signin.status === 200) {
            it.sealed = { mintedBy: it.settingsBase, token: "session-minted-by-" + it.settingsBase };
          }
          return encode(it.signin.status, it.signin.body);
        }
        return encode(404, '{"error":{"code":"not_found","message":"no such route"}}', "Not Found");
      }

      throw new Error(`unexpected command ${command}`);
    },
  };
  return it;
}

/**
 * Every boot at which a session minted by one server was present, configured for another.
 *
 * The server contract's guard, and the cloud spelling of `desktop-door-reconfigure.test.tsx`'s
 * `leaks()`. An offer reaching a boot at all is the defect: the engine's very first authed request
 * puts that bearer in an `Authorization` header addressed to the configured base.
 */
function foreignSessionOffers(it: Install): Array<{ base: string; mintedBy: string }> {
  return it.boots
    .filter((b) => b.session !== null && b.base !== "" && b.session.mintedBy !== b.base)
    .map((b) => ({ base: b.base, mintedBy: b.session!.mintedBy }));
}

const configuredBases = (it: Install): string[] =>
  it.asked
    .filter((a) => a.command === "engine_configure")
    .map((a) => String((a.payload!.config as { cloudUrl?: string }).cloudUrl ?? ""));

const requestedUrls = (it: Install): string[] =>
  it.asked.filter((a) => a.command === "engine_request").map((a) => String(a.payload!.url ?? ""));

afterEach(() => {
  delete host.__TAURI_INTERNALS__;
});

describe("the door chooser", () => {
  let root: Root | null = null;
  let mount: HTMLElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    mount?.remove();
    root = null;
    mount = null;
  });

  const render = async (start: "doors" | "local" | "server" | "cloud" = "doors"): Promise<HTMLElement> => {
    const { DoorChooser } = await import("../src/DoorChooser.js");
    mount = document.createElement("div");
    document.body.append(mount);
    root = createRoot(mount);
    await act(async () => {
      root!.render(
        h(
          NextIntlClientProvider,
          { locale: "en", messages: en as never, timeZone: "Europe/Zurich" },
          h(DoorChooser, { start, onEntered: () => {} }),
        ),
      );
    });
    return mount;
  };

  const type = async (el: HTMLElement, id: string, value: string): Promise<void> => {
    const input = el.querySelector<HTMLInputElement>(`#${id}`);
    if (!input) throw new Error(`no field #${id} on screen`);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  const press = async (el: HTMLElement, label: string): Promise<void> => {
    const found = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label));
    if (!found) {
      throw new Error(
        `no button saying "${label}" — found: ${
          [...el.querySelectorAll("button")].map((b) => b.textContent).join(" | ")
        }`,
      );
    }
    await act(async () => {
      found.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  const tiles = (el: HTMLElement): HTMLButtonElement[] =>
    [...el.querySelectorAll<HTMLButtonElement>(".door-tile")];

  /* ── THE THREE DOORS, IN THE OWNER'S ORDER AND WORDS ──────────────────────────────────── */

  it("offers exactly three doors, nearest machine first", async () => {
    const el = await render();
    const names = tiles(el).map((t) => t.querySelector(".door-name")!.textContent);
    expect(names).toHaveLength(3);
    // The order is the argument: what a person can verify themselves, first.
    expect(names[0]).toMatch(/^On this /);
    expect(names[1]).toBe("Your own server");
    expect(names[2]).toBe("ohmail Cloud");
  });

  it("says what each door does with the mail, and names the self-hosted one for what it is", async () => {
    const el = await render();
    const [local, server, cloud] = tiles(el).map((t) => t.querySelector(".door-say")!.textContent!);
    expect(local).toContain("Your own IMAP mailbox, organized right here.");
    expect(server).toContain("Self-hosted ohmail Cloud.");
    expect(server).toContain("A server you run does the organizing; this app keeps a copy.");
    expect(cloud).toContain("Our hosted service does the organizing; this app keeps a copy.");
  });

  /**
   * THE CLAIM, AND THE FACT UNDER IT.
   *
   * The sentence is the easy half. The half that makes it true is that choosing this door composes
   * a configuration naming the user's own mail server and NOTHING of ours — so a change that made
   * the local door talk to a hosted service reddens this case, rather than leaving a sentence
   * standing over a payload that had quietly stopped matching it.
   */
  it("CLAIM: 'Nothing is sent anywhere' on the local door, and the configuration says so", async () => {
    const el = await render();
    expect(tiles(el)[0]!.textContent).toContain("Nothing is sent anywhere.");

    const it = install();
    await press(el, "On this");
    await press(el, "Any other IMAP mailbox");
    await type(el, "door-address", ADDRESS);
    await type(el, "door-password", "a-mailbox-password");
    await type(el, "door-imap-host", "imap.example.com");
    await press(el, "Open this mailbox");

    const configs = it.asked
      .filter((a) => a.command === "engine_configure")
      .map((a) => a.payload!.config as Record<string, unknown>);
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
      expect(config.mode).toBe("local");
      // No hosted base of any kind — not ours, not an operator's.
      expect(config).not.toHaveProperty("cloudUrl");
      expect(JSON.stringify(config)).not.toContain(CLOUD_URL);
    }
  });

  it("CLAIM: the travel sentence sits beneath all three, and says the mailbox is the master", async () => {
    const el = await render();
    const travel = el.querySelector(".door-travel")!.textContent!;
    expect(travel).toContain("Move between these anytime.");
    // The two facts the sentence rests on: the profile travels in the mailbox, and the mailbox wins.
    expect(travel).toContain("live in your own mailbox and travel with you");
    expect(travel).toContain("the mailbox is always the master");
    // Beneath the tiles, not inside one of them — it is true of all three.
    expect(el.querySelector(".door-grid")!.contains(el.querySelector(".door-travel"))).toBe(false);
  });

  /**
   * THE SAME CLAIM ON BOTH SURFACES, AND NEITHER OVER-CLAIMING.
   *
   * The landing page makes this promise too, at more length and with a precision the chooser's one
   * sentence cannot carry: `leave.note` enumerates what travels — screened senders, rules,
   * notification choices, the away reply, tag names — and names what does NOT, which is triage
   * piles, Resurface timers and learned patterns. That list is the profile payload's own shape
   * (`OrganizerProfilePayload`: screener, rules, notifyRules, awayResponder, tagNames), so the
   * landing's version is checkable against code.
   *
   * The chooser's sentence has to stay TRUE OF THAT, which is why it says "rules and settings" and
   * not "everything". This case is the join: it fails if the chooser is widened into a claim the
   * profile does not carry, and it fails if the landing's promise is edited away underneath it —
   * two surfaces drifting apart being exactly how one of them ends up lying.
   */
  it("CLAIM: the chooser's travel sentence agrees with the landing's, and claims no more", async () => {
    const el = await render();
    const travel = el.querySelector(".door-travel")!.textContent!;
    const landing = (en as unknown as { leave: { sub: string; note: string } }).leave;

    // The landing still makes the promise this sentence is the short form of.
    expect(landing.sub).toContain("rules and screened senders");
    expect(landing.sub).toContain("source of truth");
    // …and still names the part that does NOT travel, which is what keeps the short form honest.
    expect(landing.note).toContain("stay with the install they were made on");

    // The chooser therefore says "rules and settings" — never "everything", and never a promise
    // about the state the landing explicitly excludes.
    expect(travel).toContain("Your rules and settings");
    expect(travel).not.toMatch(/everything|all your settings|nothing is lost/i);
  });

  /* ── THE SERVER-ADDRESS ARM ───────────────────────────────────────────────────────────── */

  it("asks for the server's address before anything else, and never for a password there", async () => {
    const el = await render();
    await press(el, "Your own server");
    expect(el.querySelector("#server-origin")).not.toBeNull();
    // The password fields do not exist yet. Nothing has been typed that could be sent anywhere.
    expect(el.querySelector("#server-password")).toBeNull();
    expect(el.querySelector("#server-totp")).toBeNull();
  });

  it("configures the engine for <origin>/api — the base that reaches the API on both deployments", async () => {
    const it = install();
    const el = await render("server");
    await type(el, "server-origin", OPERATOR_ORIGIN);
    await type(el, "server-address", ADDRESS);
    await press(el, "Continue");

    // NOT the bare origin: on a self-host stack that reaches the web app, which answers 404 HTML,
    // and the install would sign in and then sync nothing for ever.
    expect(configuredBases(it)).toEqual([OPERATOR_BASE]);
    expect(requestedUrls(it)).toContain("/cloud/probe");
  });

  it("shows the sign-in only once the server has answered, and locks the address then", async () => {
    const it = install();
    const el = await render("server");
    await type(el, "server-origin", OPERATOR_ORIGIN);
    await type(el, "server-address", ADDRESS);
    await press(el, "Continue");

    expect(el.querySelector("#server-password")).not.toBeNull();
    // LOCKED. The engine is configured for this base and the sign-in below goes to it; an editable
    // field would let somebody prove one server and sign in believing they had reached another.
    expect(el.querySelector<HTMLInputElement>("#server-origin")!.readOnly).toBe(true);
    expect(el.textContent).toContain(`Reached ${OPERATOR_BASE}`);
    expect(it.probe).toBe(OK_PROBE);
  });

  it("REFUSES a typo before it configures anything, and names the shape it wants", async () => {
    const it = install();
    const el = await render("server");
    await type(el, "server-origin", "not a server address");
    await type(el, "server-address", ADDRESS);
    await press(el, "Continue");

    expect(el.querySelector(".join-error")!.textContent).toContain("does not look like a server address");
    // Nothing was configured — a rejected address costs the install nothing.
    expect(it.asked.filter((a) => a.command === "engine_configure")).toHaveLength(0);
    expect(el.querySelector("#server-password")).toBeNull();
  });

  /**
   * THE FIELD MUST NOT BE CONSTRAINT-VALIDATED, and this case exists because it was.
   *
   * With `type="url"` the browser refuses the submit and shows its own bubble instead of the
   * sentence above — on precisely the inputs that sentence was written for — and it also rejects a
   * bare host, which this door deliberately accepts and completes to `https://`. Both halves are
   * asserted here rather than left to the case above, which would only ever have failed to reach
   * an assertion rather than said why.
   */
  it("lets this door's own sentences speak — the address fields are not browser-validated", async () => {
    const it = install();
    const el = await render("server");
    const origin = el.querySelector<HTMLInputElement>("#server-origin")!;
    expect(origin.type).not.toBe("url");
    expect(origin.checkValidity()).toBe(true);

    // A BARE HOST reaches the door and is completed, rather than being refused by the browser.
    await type(el, "server-origin", "ohmail.example.com");
    await type(el, "server-address", ADDRESS);
    await press(el, "Continue");
    expect(configuredBases(it)).toEqual([OPERATOR_BASE]);
  });

  it("carries the engine's own refusal through whole — a private CA is named as one", async () => {
    const it = install();
    // What a correctly configured private stack looks like from a Node process: its certificate is
    // signed by an authority nobody outside that network has heard of. Not a misconfiguration.
    it.probe = {
      status: 502,
      body: JSON.stringify({
        error: {
          code: "cloud_probe_failed",
          message:
            `${OPERATOR_BASE}/hello answered, but its certificate is signed by an authority this ` +
            "computer does not trust — put your server's root certificate in a file named " +
            "cloud-ca.pem in this app's data folder and open ohmail again.",
          details: { kind: "tls_trust", target: `${OPERATOR_BASE}/hello` },
        },
      }),
    };
    const el = await render("server");
    await type(el, "server-origin", OPERATOR_ORIGIN);
    await type(el, "server-address", ADDRESS);
    await press(el, "Continue");

    const shown = el.querySelector(".join-error")!.textContent!;
    // The address that was actually dialled, and the remedy — not "could not connect".
    expect(shown).toContain(`${OPERATOR_BASE}/hello`);
    expect(shown).toContain("cloud-ca.pem");
    // And it does NOT walk on to ask for a password.
    expect(el.querySelector("#server-password")).toBeNull();
  });

  it("says a server that answers but is not ohmail is the wrong ADDRESS, not the wrong password", async () => {
    const it = install();
    it.probe = {
      status: 502,
      body: JSON.stringify({
        error: {
          code: "cloud_probe_failed",
          message: `Something answered at ${OPERATOR_BASE}/hello, but it is not an ohmail server.`,
          details: { kind: "not_ohmail", target: `${OPERATOR_BASE}/hello` },
        },
      }),
    };
    const el = await render("server");
    await type(el, "server-origin", OPERATOR_ORIGIN);
    await type(el, "server-address", ADDRESS);
    await press(el, "Continue");

    expect(el.querySelector(".join-error")!.textContent).toContain("not an ohmail server");
    expect(el.querySelector("#server-password")).toBeNull();
  });

  /* ── THE SERVER CONTRACT ──────────────────────────────────────────────────────────────── */

  /**
   * THE CASE THE THIRD DOOR CREATED.
   *
   * An install mirroring the hosted service, moved to a server the person runs, at the SAME
   * address — which is an ordinary thing to do and the only case where the two accounts are spelled
   * identically. Before the server joined the mirror-owner record, the marker matched, the mirror
   * survived, and the sealed session survived with it: the next request would have put our
   * service's bearer in an `Authorization` header addressed to somebody else's machine.
   */
  it("never offers one server's session to another when the door is re-pointed", async () => {
    const it = install({ base: CLOUD_URL, address: ADDRESS });
    expect(it.sealed?.mintedBy).toBe(CLOUD_URL);

    const el = await render("server");
    await type(el, "server-origin", OPERATOR_ORIGIN);
    await type(el, "server-address", ADDRESS);
    await press(el, "Continue");

    // The hosted session is gone before the operator's server is dialled for anything.
    expect(foreignSessionOffers(it)).toEqual([]);
    expect(it.sealed).toBeNull();
  });

  it("signs in against the server that was proved, and the session it seals belongs to that server", async () => {
    const it = install();
    const el = await render("server");
    await type(el, "server-origin", OPERATOR_ORIGIN);
    await type(el, "server-address", ADDRESS);
    await press(el, "Continue");
    await type(el, "server-password", "the-account-password");
    await type(el, "server-totp", "123456");
    await press(el, "Sign in");

    expect(requestedUrls(it)).toContain("/cloud/signin");
    expect(it.sealed).toEqual({ mintedBy: OPERATOR_BASE, token: `session-minted-by-${OPERATOR_BASE}` });
    // One configure for the whole door: the address step's. The sign-in never restarts the engine,
    // which is what would discard a mirror that has just been bootstrapped.
    expect(configuredBases(it)).toEqual([OPERATOR_BASE]);
    expect(foreignSessionOffers(it)).toEqual([]);
  });
});

/**
 * The address parse, driven directly. The door's sentences come from here, and every refusal is a
 * shape somebody could plausibly paste in.
 */
describe("the server address a person types", () => {
  it("accepts an origin and derives the API base", () => {
    expect(selfHostProblem(OPERATOR_ORIGIN)).toBeNull();
    expect(selfHostBase(OPERATOR_ORIGIN)).toBe(OPERATOR_BASE);
    expect(selfHostBase("ohmail.example.com")).toBe(OPERATOR_BASE);
    expect(selfHostBase("http://localhost:8080")).toBe("http://localhost:8080/api");
  });

  it("refuses a missing address separately from an unusable one", () => {
    expect(selfHostProblem("")).toBe("Your server's address is missing.");
    expect(selfHostProblem("   ")).toBe("Your server's address is missing.");
  });

  it("refuses the shapes a paste produces, with one sentence naming what is wanted", () => {
    for (const bad of [
      "https://ohmail.example.com/api",
      "https://ohmail.example.com/mail",
      "https://someone:hunter2@ohmail.example.com",
      "ftp://ohmail.example.com",
      "https://ohmail.example.com?next=/",
    ]) {
      expect(selfHostProblem(bad), bad).toContain("does not look like a server address");
      expect(selfHostBase(bad), bad).toBeNull();
    }
  });
});
