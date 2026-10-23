import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { filerKey } from "../app/shell/mail-state";

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
const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (p: string): string => readFileSync(`${HERE}${p}`, "utf8");
const messages = JSON.parse(read("../messages/en.json")) as Record<string, Record<string, string>>;

describe("a signed-in account can connect a mailbox without leaving the shell", () => {
  it("THE REGRESSION: POST /mailboxes has a caller outside the onboarding wizard", () => {
    // The single fact whose absence caused the outage. If this is ever true only of
    // JoinScreen again, the dead end is back.
    const callers = ["../app/(product)/join/JoinScreen.tsx", "../app/(product)/mailbox/MailboxSection.tsx"]
      .filter((p) => /mailboxApi\.create\(|mailboxes\.create\(/.test(read(p)));
    expect(callers).toHaveLength(2);
  });

  it("the shell's pane runs the step-up ITSELF rather than sending the user to /login", () => {
    const src = read("../app/(product)/mailbox/MailboxSection.tsx");
    // The inline factor prompt, on the session the browser holds — never a second sign-in, which
    // was one more web session per confirmation (`confirm-is-step-up.test.tsx` drives it).
    expect(src).toMatch(/import \{ StepUpPrompt \} from "\.\/StepUpPrompt"/);
    expect(src).toMatch(/<StepUpPrompt\b/);
    expect(src).not.toMatch(/auth\.login\(/);
    // And it must NOT punt to the wizard: `bootstrap()` would bounce the user straight back.
    expect(src).not.toMatch(/href="\/join"/);
    expect(src).not.toMatch(/"\/login"/);
  });

  it("the step-up runs AFTER the credentials are typed, not before", () => {
    // The whole point. Asking for the second factor first would spend the five minutes on
    // the trip to the provider — which is the bug, rebuilt. The form submits the write itself;
    // only its refusal for a closed window enters `stepup`, through `park`.
    const src = read("../app/(product)/mailbox/MailboxSection.tsx");
    expect(src.search(/type Stage =[^\n]*"stepup"/)).toBeGreaterThanOrEqual(0);
    expect([...src.matchAll(/setStage\("stepup"\)/g)], "one door into the prompt").toHaveLength(1);
    const park = src.slice(src.indexOf("const park ="), src.indexOf("const fail ="));
    expect(park).toMatch(/setStage\("stepup"\)/);
    expect(src).toMatch(/if \(microsoftOauth\) \{ startOutlook\(\); return; \}\s*void connect\(\);/);
  });

  it("a step-up refusal keeps the typed mailbox form instead of discarding it", () => {
    const src = read("../app/(product)/mailbox/MailboxSection.tsx");
    // The refused write is parked and the refusal said; nothing in either resets `typed`.
    const window = src.slice(src.indexOf("const park ="), src.indexOf("const connect ="));
    expect(window).toMatch(/gatedRefusal\(/);
    expect(window).not.toMatch(/setTyped/);
  });

  it("the pane reads the REAL mailbox list, not the mirror that is always empty", () => {
    // `"mailbox"` is not an `EntityType` in the change log, so `/sync` never emits one and
    // the shared pane's list is empty for every live account. Asserted at the source: if
    // `"mailbox"` is ever added there, this test should be revisited, not deleted.
    const entityTypes = read("../../../packages/db/src/change-log.ts");
    const decl = entityTypes.slice(entityTypes.indexOf("export type EntityType"));
    expect(decl.slice(0, decl.indexOf(";"))).not.toMatch(/"mailbox"/);
    /**
     * ── THE CALL, NOT ITS ARGUMENT LIST ──────────────────────────────────────────────────
     *
     * This read `/mailboxApi\.list\(\)/` — the empty parentheses included — and went red the
     * day the pane started asking for message counts (`list({ counts: true })` on open). The
     * empty-argument spelling was never the invariant: what this case is about is WHERE the
     * list comes from, and passing an option to the same API client does not move it.
     *
     * So the regex is retargeted at the call rather than widened into a substring match, and
     * the half that was implicit before is now written down: the pane must NOT read the sync
     * mirror. That is the actual defect this test was created for — the mirror's mailbox list
     * returned `[]` for every live account — and asserting its absence is a stronger statement
     * than the one that was here, not a weaker one.
     *
     * THE NEGATIVE IS TAKEN OVER CODE ONLY, and that is not a technicality. The pane's own
     * header explains the defect by NAMING the mirror call it replaced, so a match over the
     * raw file fails on the paragraph that documents the fix — a guard that forbids describing
     * the bug it exists to prevent. Comments are stripped first, which is also what makes the
     * assertion mean what it says: this is about what the pane RUNS.
     */
    const pane = read("../app/(product)/mailbox/MailboxSection.tsx");
    const code = pane.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(code, "the pane no longer calls the API's mailbox list").toMatch(/mailboxApi\.list\(/);
    expect(code, "the pane is reading the sync mirror again — it is empty for every live account")
      .not.toMatch(/reader\.list|MailboxEntity/);
  });

  it("the Cloud client injects the pane and Desktop does not get one", () => {
    // The GPL/standalone seam: `scripts/publish-desktop.mjs` DENYs `(product)`, so the
    // shared view must keep working with the prop absent.
    // The pane leads the Settings → Mailboxes node; the self-check sits beside it, a second consumer.
    expect(read("../app/(product)/mailbox/CloudShell.tsx"))
      .toMatch(/mailboxSection=\{<><MailboxSection subscriptionPane=\{manageOffered\} \/><MailboxFilings api=\{filingsApi\} \/><MailboxSelfCheck check=\{mailboxApi\.selfCheck\} \/><\/>\}/);
    // Withheld in demo mode, like `accountSection` — `?demo=1` has no session to post with.
    expect(read("../app/shell/AppShell.tsx")).toMatch(/mailboxSection=\{demo \? undefined : mailboxSection\}/);
  });

  it("THE FALLBACK IS DELETED — the pane renders the host node and nothing else", () => {
    // The mirror fallback (`mailboxSection ?? (…reader.list("mailbox")…)`) drew an entity type
    // `/sync` never emits, so it was empty for every real account — built, tested, unreachable.
    // Deleted, not layered over: restoring it (a `??` fallback, or a `mailboxes.map(` list) turns
    // this red. The pane is now the host node verbatim, and the nav entry is gated on it.
    const settings = read("../app/views/SettingsView.tsx");
    expect(settings).not.toMatch(/mailboxSection \?\?/);
    expect(settings).not.toMatch(/mailboxes\.map\(/);
    expect(settings).toMatch(/shown === "mailboxes" \? mailboxSection : null/);
    // The tab list lives in `settings-panes.ts` since that change; the view answers from node presence —
    // the host's mailbox node, or the declined settings rows a host hands in while one stands
    // (HOST-CLIENT-DECLINED-SETTINGS-HAS-NO-ROW). Both are nodes; neither is a mirror read.
    expect(settings).toMatch(/mailboxes: Boolean\(mailboxSection\) \|\| Boolean\(savedSettingsSection\),/);
    // And the prop it used to fall back on is gone from the component's inputs entirely.
    expect(settings).not.toMatch(/\n\s*mailboxes: MailboxEntity\[\];/);
  });

  it("each pane NAMES ITS MODE — Cloud here, local on the desktop", () => {
    // One mode per install, never both in parallel (the project's design notes: per-install, not
    // per-mailbox). Both panes head themselves from the catalogue and from the SAME key on the
    // hosted door — `mailboxes.modeCloud` — so a desktop install on that door and a browser tab
    // cannot end up calling the same thing by two names. The desktop's local heading is its own
    // key because the state has no counterpart on a hosted account.
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
    // Both panes take the heading from the filer table's `heading` row, by the build or the door.
    expect([filerKey("heading", "cloud"), filerKey("heading", "server"), filerKey("heading", "computer")])
      .toEqual(["modeCloud", "modeSelfhost", "desktopModeLocal"]);
    expect(read("../app/(product)/mailbox/MailboxSection.tsx")).toMatch(/t\(filerKey\("heading", filer\)\)/);
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
  it("the desktop's hosted pane says where mailboxes are managed and opens the browser there", () => {
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
    expect(read("../../desktop/src-tauri/src/engine.rs")).toContain(
      '("mailboxes", "https://ohmail.app/mailbox?settings=mailboxes#/settings")',
    );
    // …and that query is the one `SettingsView` reads at mount.
    expect(read("../app/views/SettingsView.tsx")).toMatch(/\.get\("settings"\)/);
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
  const shell = read("../app/shell/AppShell.tsx");

  it("THE REGRESSION: the demo body is gated on the mode", () => {
    // The original defect: the panel rendered `about.p1`/`p2` unconditionally, so every
    // signed-in customer read a description of a fixture mailbox as a statement about
    // their own. The panel is a Settings pane now (see below) and the gate travels with
    // it — a live account gets the INJECTED body and can never reach this copy.
    expect(messages.about!.p1).toMatch(/demo mailbox/i);
    expect(shell).toMatch(/aboutSection=\{\s*demo \? \(/);
    expect(shell).toMatch(/\{t\("about\.p1"\)\}/);
    // …and the live arm is the injected node, never the demo copy.
    expect(shell).toMatch(/\) : \(\s*aboutSection\s*\)/);
  });

  it("the (i) affordance is gone from the dock, and About is a Settings pane", () => {
    // Owner-reported: the floating (i) button was an overlay over the mail holding three
    // facts that are settings. The dock keeps only the two controls that ACT on what is on
    // screen; the facts moved to Settings → About ohmail, which is where they can be found
    // and linked to. This is the guard that the button does not come back.
    expect(shell).not.toMatch(/icon="info"/);
    expect(shell).not.toMatch(/aboutOpen/);
    expect(messages.dock!.about).toBeUndefined();
    // The pane exists, is conditional on the injected node, and is named. The tab list lives in
    // `settings-panes.ts` since that change; the view answers from node presence, the list carries the name.
    const settings = read("../app/views/SettingsView.tsx");
    expect(settings).toMatch(/about: Boolean\(aboutSection\),/);
    const panes = read("../app/views/settings-panes.ts");
    expect(panes).toMatch(/w\.about \? \[\["about", t\("about"\)\]/);
    expect(settings).toMatch(/shown === "about" \? aboutSection : null/);
    expect(messages.settings!.about).toBe("About ohmail");
  });

  it("the live body is the injected one, and it reports mailbox + sync + build", () => {
    const src = read("../app/(product)/mailbox/AboutSection.tsx");
    expect(src).toMatch(/mailboxApi\.list\(\)/);
    expect(src).toMatch(/lastSyncAt/);
    expect(src).toMatch(/NEXT_PUBLIC_BUILD/);
    expect(read("../app/(product)/mailbox/CloudShell.tsx")).toMatch(/aboutSection=\{<AboutSection \/>\}/);
  });

  it("`not synced yet` is a real state, not rendered as a time", () => {
    // A mailbox connected seconds ago genuinely has not synced — the worker runs on its own
    // cycle. Saying "just now" there would be the same class of lie this panel was fixed for.
    expect(messages.about!.neverSynced).toBeTruthy();
    expect(read("../app/(product)/mailbox/AboutSection.tsx"))
      .toMatch(/first\.lastSyncAt \? absolute\(first\.lastSyncAt\) : null/);
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
    const used = (src: string, ns: string): string[] =>
      [...src.matchAll(/\bt\("([a-zA-Z_][\w.]*)"/g)].map((m) => m[1]!)
        .filter((k) => !k.includes("."))
        .map((k) => `${ns}.${k}`);

    const keys = [
      ...used(read("../app/(product)/mailbox/AboutSection.tsx"), "about"),
      ...used(read("../app/(product)/mailbox/MailboxSection.tsx"), "mailboxes"),
    ];
    expect(keys.length).toBeGreaterThan(15);
    for (const k of keys) {
      const [ns, key] = k.split(".") as [string, string];
      expect(messages[ns], `namespace ${ns}`).toBeTruthy();
      expect(messages[ns]![key], `missing message ${k}`).toBeTruthy();
    }
    // The three status labels are interpolated (`status_${m.status}`), so the loop above
    // cannot see them. They are the values `mailboxes.status` takes in the schema.
    for (const s of ["connected", "error", "disabled"]) {
      expect(messages.mailboxes![`status_${s}`], `missing mailboxes.status_${s}`).toBeTruthy();
    }
  });
});
