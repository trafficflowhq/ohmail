/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import {
  act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner, scriptRefresh,
  scriptSession, sessionFull, teardownConfirmEnv, tick,
} from "./fixtures/cloud-confirm-shell";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as FileURL } from "node:url";
import { filerKey } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * TWO DEFECTS A REAL USER HIT ON ohmail.app, PINNED.
 *
 * ── the account that could not connect a mailbox ────────────────────────────────────
 *
 * `JoinScreen` was the only caller of `POST /mailboxes` in the whole product. The route is
 * `stepUp`-gated with a FIVE MINUTE window (`packages/services/src/auth/config.ts`), and the
 * step it gates asks the user to go and generate an app password at their provider — which
 * takes longer than that. So: 403 `step_up_required` → JoinScreen's fatal screen → its only
 * exit is "Sign in" → `LoginScreen` sends a completed sign-in to `/` → `/` is the mail
 * client, which had no way to connect a mailbox and no link back to `/join`. The account was
 * then permanently unable to add the mailbox it had just paid for.
 *
 * Returning to `/join` is not the remedy and these tests forbid relying on it:
 * `JoinScreen.bootstrap()` sends anyone with a mailbox to "done" and anyone without one back
 * to the step that just expired. The remedy is that the SHELL can connect a mailbox, running
 * the step-up ceremony on submit — after the slow part is done, so the five minutes are spent
 * on a passkey tap.
 *
 * ── the demo panel a paying customer was reading ────────────────────────────────────
 *
 * The (i) panel was rendered unconditionally, so every signed-in user saw "ohmail — demo"
 * and a paragraph about the demo adapter. Both halves are asserted below: the demo copy must
 * be unreachable when the shell is live, and the live panel must show the facts (i) exists
 * for.
 */
const HERE = fileURLToPath(new FileURL(".", import.meta.url));
const read = (p: string): string => readFileSync(`${HERE}${p}`, "utf8");
const messages = JSON.parse(read("../messages/en.json")) as Record<string, Record<string, string>>;

const WEB = "../app/(product)/mailbox";
const MAIL = "../../../packages/app/src/mail";
const PANE = "../../../packages/app/src/mailboxes/pane";
const ABOUT = "../../../packages/app/src/settings/about/AboutPane.tsx";
const ADDRESS = "mailbox@example.test";
const PASSWORD = "fixture-mailbox-password";
const ROW = {
  id: "mb1",
  provider: "imap",
  address: "existing@example.test",
  displayName: "Existing mailbox",
  status: "connected",
  lastSyncAt: "2026-09-04T12:40:00.000Z",
  createdAt: "2026-09-04T12:40:00.000Z",
};

let mounted = false;
afterEach(async () => {
  if (!mounted) return;
  await teardownConfirmEnv();
  (await import("../app/api-client")).bindApiOwner(null);
  window.history.replaceState(null, "", "/");
  mounted = false;
});

async function mount(url: string, closed = false) {
  installConfirmEnv();
  mounted = true;
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  (await import("../app/api-client")).bindApiOwner(null);
  const writes: unknown[] = [];
  const authWrites: string[] = [];
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/account/access") return Response.json({ metered: false });
    if (path === "/api/mailboxes" && method === "GET") return Response.json({ items: [ROW] });
    if (path === "/api/mailboxes" && method === "POST") {
      writes.push(JSON.parse(String(init?.body)));
      if (closed && writes.length === 1) {
        return Response.json({ error: { code: "step_up_required", message: "Confirm it is you." } }, { status: 403 });
      }
      return Response.json({ ...ROW, id: "mb2", address: ADDRESS });
    }
    if (path.startsWith("/api/auth/") && method === "POST" && !path.startsWith("/api/auth/refresh")) {
      authWrites.push(path);
      if (path === "/api/auth/step-up/totp") return Response.json({ ok: true });
    }
    return fetch(input, init);
  };
  window.history.replaceState(null, "", url);
  const el = await mountCloudShell();
  await tick(3000);
  return { el, view: within(el), writes, authWrites };
}

async function click(button: HTMLElement) {
  await act(async () => { fireEvent.click(button); });
  await tick(250);
}

const type = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } });

async function fillConnect(closed = false) {
  const state = await mount("/mailbox#/settings/mailboxes", closed);
  const { view } = state;
  const copy = messages.onboarding!;
  const pane = within(view.getByRole("region", { name: messages.settings!.mailboxes }));
  expect(pane.getByRole("group", { name: messages.mailboxes!.modeCloud })).toBeTruthy();
  await click(pane.getByRole("button", { name: messages.mailboxes!.connect }));
  type(view.getByLabelText(copy.address!), ADDRESS);
  await click(view.getByRole("button", { name: messages.providerPicker!.otherShort }));
  type(view.getByLabelText(copy.imapHost!), "imap.example.test");
  type(view.getByLabelText(copy.smtpHost!), "smtp.example.test");
  type(view.getByLabelText(copy.password!), PASSWORD);
  return { ...state, submit: () => click(view.getByRole("button", { name: copy.connect })) };
}

const factor = (el: HTMLElement) =>
  within(el).queryByRole("dialog", { name: messages.stepUp!.titleCode!.replace(/\.$/, "") });

describe("a signed-in account can connect a mailbox without leaving the shell", () => {
  it("THE REGRESSION: POST /mailboxes has a caller outside the onboarding wizard", async () => {
    // Settings is the entry even for an account that already has a mailbox.
    const { submit, writes } = await fillConnect();
    await submit();
    expect(writes).toEqual([expect.objectContaining({ address: ADDRESS, provider: "imap" })]);
    expect(window.location.pathname).toBe("/mailbox");
  });

  it("the shell's pane runs the step-up ITSELF rather than sending the user to /login", async () => {
    const { el, submit, writes, authWrites } = await fillConnect(true);
    await submit();
    const dialog = within(factor(el)!);
    const copy = messages.stepUp!;
    type(dialog.getByLabelText(copy.codeLabel!), "123456");
    await click(dialog.getByRole("button", { name: copy.verify }));
    expect(authWrites).toEqual(["/api/auth/step-up/totp"]);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(window.location.pathname).toBe("/mailbox");
  });

  it("the step-up runs AFTER the credentials are typed, not before", async () => {
    const { el, submit, writes } = await fillConnect(true);
    expect(factor(el)).toBeNull();
    expect(writes).toHaveLength(0);
    await submit();
    expect(writes).toHaveLength(1);
    expect(factor(el)).not.toBeNull();
  });

  it("a step-up refusal keeps the typed mailbox form instead of discarding it", async () => {
    const { el, view, submit, writes } = await fillConnect(true);
    await submit();
    await click(within(factor(el)!).getByRole("button", { name: messages.stepUp!.cancel }));
    const copy = messages.onboarding!;
    expect(view.getByLabelText(copy.address!)).toHaveProperty("value", ADDRESS);
    expect(view.getByLabelText(copy.imapHost!)).toHaveProperty("value", "imap.example.test");
    expect(view.getByLabelText(copy.smtpHost!)).toHaveProperty("value", "smtp.example.test");
    expect(view.getByLabelText(copy.password!)).toHaveProperty("value", PASSWORD);
    expect(writes).toHaveLength(1);
  });

  it("the pane reads the REAL mailbox list, not the mirror that is always empty", async () => {
    const entityTypes = read("../../../packages/db/src/change-log.ts");
    const decl = entityTypes.slice(entityTypes.indexOf("export type EntityType"));
    expect(decl.slice(0, decl.indexOf(";"))).not.toMatch(/"mailbox"/);
    expect(read(`${WEB}/mailboxes-wire.ts`)).toMatch(/mailboxApi\.list\(/);

    // The fixture's mirror never contains this row. The account's list endpoint does.
    const { view } = await mount("/mailbox#/settings/mailboxes");
    const pane = within(view.getByRole("region", { name: messages.settings!.mailboxes }));
    expect(pane.getByRole("button", { name: new RegExp(ROW.address.replace(".", "\\.")) })).toBeTruthy();
  });

  it("THE FALLBACK IS DELETED — the pane renders the host node and nothing else", () => {
    // Settings registers a Mailboxes pane only when the host supplies its parts. There is no
    // alternate registration that builds a mailbox list from the mirror.
    const settings = read(`${MAIL}/panes.ts`);
    expect(settings).toMatch(
      /mailboxes:\s*parts\.mailboxes === NONE\s*\? NONE\s*:\s*paneOf\("mailboxes", mailboxesPane\(\{ \.\.\.parts\.mailboxes, mailState: useMailState \}\)\)/,
    );
    const pane = read(`${PANE}/MailboxesPane.tsx`);
    expect(pane).toMatch(/const rows = model\.list\.rows/);
    expect(pane).not.toMatch(/reader\.list|MailboxEntity/);
  });

  it("each pane NAMES ITS MODE — Cloud here, local on the desktop", () => {
    // Both panes name the same hosted mode from the catalogue. The web settings column
    // shows the Mailboxes heading and names the mode on the accessible group.
    //
    // This used to assert the desktop's English LITERAL, which is what the pane was made of: a
    // dozen hardcoded sentences the catalogue could not reach, so a German install read the one
    // surface that says what it is connected to in English. The assertion moved to the key
    // rather than being dropped — the mode still has to be named, and now it can be translated.
    expect(messages.mailboxes!.modeCloud).toBe("Cloud mailboxes");
    expect(messages.mailboxes!.desktopModeLocal).toBe("Local mailboxes on this computer");
    /* AND THE SELF-HOST BUILD IS A THIRD MODE. The browser pane headed itself "Cloud mailboxes"
       whichever build served it, so an operator running their own server was shown a claim about
       a hosted service. The switch is the build arm, not a runtime read, so the managed bundle is
       byte-for-byte what it was; both halves are pinned here because a heading and its key drift
       apart the moment only one of them is asserted. */
    expect(messages.mailboxes!.modeSelfhost).toBe("Mailboxes on this server");
    // Both panes name the mode from the filer table's `heading` row, by the build or the door.
    expect([filerKey("heading", "cloud"), filerKey("heading", "server"), filerKey("heading", "computer")])
      .toEqual(["modeCloud", "modeSelfhost", "desktopModeLocal"]);
    expect(read(`${PANE}/MailboxesPane.tsx`)).toMatch(/aria-label=\{say\(\{ key: filerKey\("heading", filer\) \}\)\}/);
    const desktop = read("../../desktop/src/DesktopMailboxes.tsx");
    expect(desktop).toMatch(/filerSentence\("heading", filer\)/);
    expect(desktop).not.toContain("Local mailboxes on this computer");
    // The confusing "Use a different mailbox" copy is gone from the desktop settings pane.
    expect(read("../../desktop/src/DesktopSettings.tsx")).not.toContain("Use a different mailbox");
  });

  /**
   * ── THE DESKTOP'S HOSTED DOOR: A READ-ONLY LIST AND AN HONEST WAY OUT ────────────────────
   *
   * The complaint this pins: a desktop install signed in to a hosted account could see its
   * mailboxes and change nothing, with nothing on screen saying why or where to go.
   *
   * There is a real reason, and it is the reason seen from the other side. `POST /mailboxes`,
   * `PATCH /mailboxes/:id` and `DELETE /mailboxes/:id` are step-up gated, and the remedy — run
   * the ceremony in the pane — is available to a browser tab and to nothing else: it needs a
   * password field and a passkey ceremony against a real origin. A desktop install holds a
   * bearer whose `last_twofa_at` was stamped once, when its link code was claimed, and no
   * rotation moves that stamp; after the window closes every one of those three routes answers
   * 403 for the life of the install. So the pane offers the browser instead of a control that
   * would refuse.
   */
  it("the desktop's hosted pane says where mailboxes are managed and opens the browser there", async () => {
    const desktop = read("../../desktop/src/DesktopMailboxes.tsx");
    // The list is rendered on BOTH doors — the read is what the pane is for. Since that change a
    // reconnected address folds into one row first, so the render maps the folded list; a removed
    // mailbox's tombstone leaves the local door's list and stays on the hosted one.
    expect(desktop).toMatch(/const listed = cloud \? facts : facts\.filter\(\(m\) => !isRemovedMailbox\(m\)\);/);
    expect(desktop).toMatch(/foldByAddress\(listed\)\.map\(/);
    // The hand-off is gated on the hosted door, so a standalone install (which configures its
    // mailbox on this machine and needs no factor) is not sent anywhere.
    expect(desktop).toMatch(/const cloud = door === "cloud"/);
    expect(desktop).toMatch(/cloud \? \(/);
    // The note and the affordance, from the catalogue.
    expect(desktop).toMatch(/t\("desktopManageOnWeb"\)/);
    expect(desktop).toMatch(/t\("desktopManageOnWebWhy"\)/);
    expect(messages.mailboxes!.desktopManageOnWeb).toMatch(/managed in ohmail on the web/);
    // The way out is the app's OWN named-place mechanism. A URL in this file would be a host
    // name in a bundle that is asserted to carry none, and an address the page could shape.
    expect(desktop).toMatch(/openWeb\("mailboxes"\)/);
    expect(desktop).not.toMatch(/https?:\/\//);

    // And the place resolves: the window's closed set names it, and the shell's table gives it
    // an address that opens the Mailboxes pane rather than merely the Settings view.
    expect(read("../../desktop/src/native.ts")).toMatch(/"mailboxes",/);
    const engine = read("../../desktop/src-tauri/src/engine.rs");
    const target = engine.match(/\("mailboxes", "https:\/\/ohmail\.app(\/mailbox[^"]+)"\)/)?.[1];
    expect(target).toBeDefined();
    const { view } = await mount(target!);
    expect(view.getByRole("region", { name: messages.settings!.mailboxes })).toBeTruthy();
  });

  /**
   * THE LINE BETWEEN WHAT THE DESKTOP MAY CHANGE AND WHAT IT MAY NOT, drawn where the API draws
   * it rather than by taste.
   *
   * `mailboxRoutes` marks four of its writing routes `stepUp` and one not. The one that is not —
   * `POST /mailboxes/:id/resync` — is exactly what the desktop pane offers, and the four that are
   * are exactly what it does not, because a desktop bearer cannot satisfy `withStepUp` after the
   * five-minute window that opened when its link code was claimed. Nothing rotates
   * `last_twofa_at`: `mintRotation` writes tokens, not factors.
   *
   * Asserted from the ROUTE TABLE, so the day a mutation loses or gains its gate this test is
   * what says the desktop pane has to follow.
   */
  it("the desktop offers the mailbox mutation that is NOT step-up gated, and no other", () => {
    const routes = read("../../../packages/api/src/routes/mailboxes.ts");
    // The resync route is a write with no step-up. (Its block ends before the next `pattern`.)
    const resync = routes.slice(routes.indexOf('pattern: "/mailboxes/:id/resync"'));
    expect(resync.slice(0, resync.indexOf("pattern:", 10))).not.toMatch(/stepUp/);
    // …and the three credential-bearing ones all carry it.
    for (const marker of ['method: "POST",\n    pattern: "/mailboxes"', 'method: "PATCH"', 'method: "DELETE"']) {
      const block = routes.slice(routes.indexOf(marker));
      expect(block.slice(0, block.indexOf("handler:")), marker).toMatch(/stepUp: true/);
    }

    const desktop = read("../../desktop/src/DesktopMailboxes.tsx");
    // The one it may make.
    expect(desktop).toMatch(/\/resync`, \{\s*\n?\s*method: "POST",/);

    /* ── AND THE FOUR IT MAY NOT — ASSERTED ON THE ROUTE, NOT ON THE VERB ──────────────────
     *
     * This read `expect(desktop).not.toMatch(/method:\s*"(PATCH|DELETE)"/)`, which was the same
     * rule expressed as "no write verb appears in this file at all". That spelling stopped being
     * the rule the moment a write verb appeared here legitimately: `DELETE /local/mailboxes/:id`
     * is the STANDALONE door's removal, served by the engine on this machine out of its own
     * store, authorised by the per-launch bearer — a different route family with a different
     * authority, and one the account's `withStepUp` has nothing to say about.
     *
     * NOT WEAKENED — narrowed to what it always meant, and the new consumer is named. The claim
     * is that the pane addresses no WRITING ROUTE THE ACCOUNT GATES, so every non-POST call in
     * the file is required to be on a `/local/` path, and the shared table's four gated routes
     * are forbidden by name. A DELETE against `/mailboxes/:id` — the thing this case exists to
     * catch — still reds, and now so does one against `/mailboxes` itself. */
    /* EVERY `bridgeFetch` CALL SITE, not the ones whose shape a regex happened to describe.
     * The first narrowing matched `bridgeFetch(<literal>, { method: "…"` with `method` as the
     * FIRST key, which a variable URL, a reordered init or a bare `fetch(` all walk past — and
     * `expect(gatedVerbs.length).toBeGreaterThan(0)` was then permanently satisfied by the
     * removal itself, so the escape would have been a silent pass rather than the vacuity red
     * the assertion was added for. Parse the call sites, then judge each one. */
    const calls = [...desktop.matchAll(/bridgeFetch\(\s*([^,]+?)\s*,\s*\{([\s\S]{0,220}?)\}\s*\)/g)]
      .map(([, url, init]) => ({
        url: url.trim(),
        method: (/method:\s*"([A-Z]+)"/.exec(init)?.[1]) ?? "GET",
      }));
    // Plus the argument-less reads, which take no init object at all.
    const bare = [...desktop.matchAll(/bridgeFetch\(\s*(`[^`]*`|"[^"]*")\s*\)/g)]
      .map(([, url]) => ({ url: url.trim(), method: "GET" }));
    const sites = [...calls, ...bare];
    expect(sites.length, "no bridge call was recognised at all — the parse, not the pane, moved")
      .toBeGreaterThanOrEqual(4);

    /* THE EXPECTED SET, spelled out rather than counted. A new gated verb lands here red and has
     * to be named, which is what the old `> 0` could not do once one existed — and the PATCH
     * below is that happening: the standalone door can now re-seal a mailbox's password without
     * removing it, so the pane writes the credential back to the engine on this machine. It is
     * the same authority as the DELETE beside it — the per-launch bearer over `/local/`, never
     * the account's step-up — and the rule the two of them are held to is the `/local/` one
     * asserted underneath, not their count. In source order: the re-seal, then the removal. */
    const gated = sites.filter((c) => c.method !== "GET" && c.method !== "POST");
    expect(gated.map((c) => `${c.method} ${c.url}`)).toEqual([
      "PATCH `/local/mailboxes/${encodeURIComponent(m.id)}`",
      "DELETE `/local/mailboxes/${encodeURIComponent(m.id)}`",
    ]);
    for (const c of gated) {
      expect(c.url, `a ${c.method} on a route the account step-up gates`).toMatch(/^`\/local\//);
    }

    // And the shared table's own writing routes, by name, whatever verb reaches for them.
    expect(desktop).not.toMatch(/bridgeFetch\("\/mailboxes",/);
    expect(desktop, "a write against the account's own mailbox route")
      .not.toMatch(/bridgeFetch\(\s*`\/mailboxes\/[^`]*`\s*,\s*\{[\s\S]{0,220}?method:\s*"(PATCH|DELETE)"/);
    /* AND NO SOCKET OF ITS OWN. `bridgeFetch` is the only door this window has; a raw `fetch(`
     * here would leave the route table's reasoning behind entirely. */
    expect(desktop, "this window opened a connection that is not the bridge")
      .not.toMatch(/(^|[^.\w])fetch\(/m);
  });
});

describe("About tells a live account the truth, wherever it is rendered", () => {
  it("THE REGRESSION: the demo body is gated on the mode", () => {
    expect(messages.about!.p1).toMatch(/demo mailbox/i);
    expect(read(`${WEB}/CloudShell.tsx`)).toMatch(/if \(resolvedDemo\) return <DemoShell\b/);
    expect(read("../app/(product)/demo/DemoSettings.tsx")).toMatch(/return <AboutPane demo \/>/);
    expect(read(`${WEB}/pane-parts.tsx`)).toMatch(/about: WebAboutPane/);
    expect(read(`${WEB}/AboutSection.tsx`)).toMatch(/<AboutPane model=\{model\} \/>/);
    const pane = read(ABOUT);
    const demo = pane.slice(pane.indexOf('if ("demo" in props)'), pane.indexOf("const { model }"));
    expect(demo).toMatch(/t\("p1"\)/);
    expect(demo).toMatch(/t\("p2"\)/);
    expect(pane.slice(pane.indexOf("const { model }"))).not.toMatch(/t\("p[12]"\)/);
  });

  it("`not synced yet` is a real state, not rendered as a time", () => {
    // A mailbox connected seconds ago genuinely has not synced — the worker runs on its own
    // cycle. Saying "just now" there would be the same class of lie this panel was fixed for.
    expect(messages.about!.neverSynced).toBeTruthy();
    expect(read(ABOUT))
      .toMatch(/mailboxes\.lastSyncAt \? absolute\(mailboxes\.lastSyncAt\) : null/);
  });

  it("NO AI SLOP, and no developer vocabulary, in any of the new copy", () => {
    // The old p1 shipped "bootstrapped", "optimistic mutation" and "the demo adapter" to a
    // customer. `about.p1`/`p2` are demo-only now and keep their text; everything a LIVE
    // account can read is checked here.
    const live = [
      ...Object.entries(messages.about!).filter(([k]) => !["p1", "p2", "title"].includes(k)),
      ...Object.entries(messages.mailboxes!),
    ].map(([, v]) => v);
    expect(live.length).toBeGreaterThan(20);

    const forbidden = [
      /seamless/i, /effortless/i, /powerful/i, /\bsimply\b/i, /\bjust\b/i, /easily/i,
      /bootstrap/i, /optimistic mutation/i, /adapter/i, /sync engine/i, /fixture/i,
      /don't worry/i, /no need to/i, /rest assured/i, /unlock/i, /supercharge/i,
    ];
    for (const line of live) {
      for (const re of forbidden) {
        expect(line, `slop or implementation vocabulary in ${JSON.stringify(line)}`).not.toMatch(re);
      }
    }
  });

  it("every key the two new surfaces ask for exists", () => {
    // A missing next-intl key throws at render, which for the (i) panel means the dock's
    // info button crashes the shell.
    const used = (src: string, ns: string, call: RegExp): string[] =>
      [...src.matchAll(call)].map((m) => m[1]!)
        .filter((k) => !k.includes("."))
        .map((k) => `${ns}.${k}`);

    const keys = [
      ...used(read(ABOUT), "about", /\bt\("([a-zA-Z_][\w.]*)"/g),
      ...["MailboxesPane", "Lines", "Organizer", "Removal", "RowLines"].flatMap((file) =>
        used(read(`${PANE}/${file}.tsx`), "mailboxes", /\bsay\(\{ key: "([a-zA-Z_][\w.]*)"/g)),
      ...used(read(`${PANE}/Checks.tsx`).split("function Filings")[0]!, "mailboxes", /\bt\("([a-zA-Z_][\w.]*)"/g),
    ];
    expect(keys.length).toBeGreaterThan(15);
    for (const k of keys) {
      const [ns, key] = k.split(".") as [string, string];
      expect(messages[ns], `namespace ${ns}`).toBeTruthy();
      expect(messages[ns]![key], `missing message ${k}`).toBeTruthy();
    }
    // The three status labels are interpolated (`status_${m.status}`), so the loop above
    // cannot see them. They are the values `mailboxes.status` takes in the schema.
    for (const s of ["connected", "connecting", "error", "disabled"]) {
      expect(messages.mailboxes![`status_${s}`], `missing mailboxes.status_${s}`).toBeTruthy();
    }
  });
});
