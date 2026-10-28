/** @vitest-environment jsdom */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sliceOfDeclaration } from "./source-anchor.js";

/** The sign-out door's answer, as each case scripts it. Only `auth` is replaced (see the last describe). */
const mockLogout = vi.fn(async (): Promise<void> => {});
vi.mock("../app/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/api-client")>()),
  auth: { logout: mockLogout },
}));

/**
 * SIGNING OUT HAS TO CLEAR THE MAIL THAT IS STILL ON THIS MACHINE.
 *
 * The sign-out door revokes the session and clears the cookies. It does not touch the
 * browser, and the browser is where the mail is: `IndexedDbMirrorStore` has persisted every
 * message, thread, tag and screener decision that came down `/sync`. A sign-out that leaves
 * that behind leaves a readable copy of the mailbox on a machine the user has just said
 * they are done with — which on a shared or borrowed computer is the entire reason they
 * pressed the button.
 *
 * Account-scoping the mirror closed the cross-account READ. This is the other half.
 *
 * The control now EXISTS — Settings → Account. It was written before the button, so that
 * when the button arrived the only wired path was already correct; the assertions below have
 * therefore been extended from "the helper is right" to "the helper is right AND something
 * reaches it", because a correct helper with no caller is what this file used to describe.
 */

// Repo-root relative, not `import.meta.url`: under jsdom that is not a file URL. The suite runs
// from the repo root.
const HERE = `${process.cwd()}/apps/webapp/test/`;
const APP = `${process.cwd()}/apps/webapp/app`;
const read = (p: string): string => readFileSync(`${HERE}${p}`, "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const abs = `${dir}/${name}`;
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.tsx?$/.test(name)) out.push(abs);
  }
  return out;
}

describe("signOut", () => {
  const src = read("../app/sign-out.ts");

  it("revokes the session AND wipes the local mirror", () => {
    // The door is asked with the caller's predicate, which only the sign-in page's finisher passes.
    expect(src).toMatch(/await auth\.logout\(\{ mayProceed: opts\.mayProceed \}\)/);
    expect(src).toMatch(/await clearAllMirrors\(owner\)/);
    expect(src).toContain('from "@ohmail/client-engine"');
  });

  it("wipes even when the server call failed — the refusal is CAUGHT, never a short circuit", () => {
    // A logout whose network call failed is still a user who asked to be signed out of
    // THIS browser. Refusing to clear local mail because the server was unreachable would
    // be exactly the wrong way round.
    //
    // ── THE SHAPE MOVED, AND THE ASSERTION WAS STRENGTHENED RATHER THAN RELAXED ───────────
    //
    // This used to read the body of a `try { … } finally { … }` and require the wipe to be
    // inside the `finally`. That shape stopped being available the moment `signOut` had to
    // ANSWER something (whether the wipe landed): a `return` inside a `finally` silently
    // swallows the pending exception, which is the same class of quiet loss the rest of this
    // file exists to prevent. So the refusal is caught into a value, and the wipe is
    // unconditional code after it — a stronger property than "inside a finally", because it
    // also forbids an early `return`/`throw` between the two.
    expect(src).toMatch(/catch \(err\) \{[\s\S]*?serverRefused = /);
    // Nothing may leave the function between catching the refusal and running the local half.
    //
    // THE ENDPOINT IS ASSERTED, and that is not ceremony. It was `lastIndexOf("…(owner)")`, an
    // exact call SHAPE — so the day the call grew an option object the lookup returned -1 and
    // `slice(start, -1)` silently widened to the rest of the function. It failed loudly that
    // time, which was luck: a tail with no `return` in it would have passed vacuously over a
    // slice this check was never meant to cover. The prefix matches either shape, and a lookup
    // that finds nothing is now the failure it always should have been.
    const start = src.indexOf("serverRefused = alreadyGone");
    const end = src.lastIndexOf("forgetThisBrowser(owner");
    expect(start, "the refusal assignment moved").toBeGreaterThan(-1);
    expect(end, "the local half's call moved — this check is measuring nothing").toBeGreaterThan(start);
    const between = src.slice(start, end);
    expect(between, "no early exit may stand between the refusal and the wipe")
      .not.toMatch(/\breturn\b|\bthrow\b/);
    // …and the refusal is REPORTED rather than dropped: it rides the result.
    expect(src).toMatch(/serverRefused,?\s*\}/);

    // THE DOOR'S ANSWER IS THE VERDICT: a 204, or a 401 in OUR envelope — the sign-out door saying
    // nothing in this jar names a live session, which is also what the retry after a blocked wipe
    // hears. Any 401 used to count, and `/auth/logout` answers 401 for a replaced access token
    // before it looks at the family. Behaviour below ("the door's answer is the verdict").
    expect(src).toMatch(/const alreadyGone = status === 401 && coded;/);
    expect(src).toMatch(/const coded = \(err as \{ wire\?: \{ coded\?: unknown \} \} \| null\)\?\.wire\?\.coded === true;/);
    // …and ONLY 401. This API answers 403 for refusals that leave the session alive — a step-up
    // gate, a suspension — so accepting it would report a completed sign-out over a credential
    // the next request still authenticates with.
    expect(src, "403 leaves the session live and is not already-gone").not.toMatch(/status === 403/);
    // Structural, not `instanceof`: a caller's test mocks `./api-client` with `{ auth }` alone,
    // so `ApiError` can be undefined at runtime and `x instanceof undefined` throws from inside
    // this catch — skipping the whole local cleanup. Found by watching that happen.
    // COMMENT-STRIPPED: the file explains the very shape it forbids, one line above the check.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code, "instanceof would throw under a partial api-client mock")
      .not.toMatch(/instanceof ApiError/);
    expect(src).toMatch(/serverRefused = alreadyGone \? null :/);
  });

  it("ANSWERS whether the wipe landed — `void` was an unfalsifiable claim", () => {
    // An IndexedDB delete is BLOCKED, not failed, while any other connection holds the
    // database open. `clearAllMirrors` used to resolve on that and `signOut` returned `void`,
    // so "this browser holds no mail" was a sentence nobody could check. The result type is
    // what makes the pane able to tell the truth.
    expect(src).toMatch(/Promise<SignOutResult>/);
    // BOTH halves: nothing left, AND a browser that could actually be asked. An empty list from
    // one that can neither enumerate its databases nor keep a registry proves only that the two
    // names we already knew are gone — see `clearAllMirrors`'s own header.
    expect(src).toMatch(/cleared: local\.remaining\.length === 0 && local\.inventoryComplete/);
    expect(src).toMatch(/inventoryComplete: local\.inventoryComplete/);
    // …and the LOCAL half is one implementation both doors use, so erasure cannot drift from it.
    expect(src).toMatch(/export async function forgetThisBrowser/);
    // Its own sweep reads back: a localStorage removal can refuse, and these prefixes hold mail.
    // Narrowed to one account by the erased-account door; the sign-out arm is the whole sweep.
    expect(src).toMatch(/const durable = sweepFor\(only \? owner! : null, \[/);
    expect(src).toMatch(/if \(owner === null\) return dropLocalStorageKeys\(list\);/);
    expect(src).toMatch(/survivors\.push\(\.\.\.durable\.survivors\)/);
    // …and a jar that could not be WALKED cannot certify a clean browser either. It named no
    // survivors and that was read as "nothing survived", so a browser that refused to enumerate
    // localStorage during a sign-out earned a clean verdict over every draft still in it.
    expect(src).toMatch(/boot\.enumerated && durable\.enumerated/);
  });


  it("is the ONLY caller of auth.logout in the app", () => {
    // A second call site that skipped the wipe would silently re-open the hole, and it
    // would look completely reasonable in review.
    const offenders: string[] = [];
    for (const file of walk(APP)) {
      if (file.endsWith("/sign-out.ts") || file.endsWith("/api-client.ts")) continue;
      const text = readFileSync(file, "utf8");
      if (/\bauth\.logout\s*\(/.test(text)) offenders.push(file.slice(file.indexOf("apps/webapp")));
    }
    expect(offenders, "call `signOut()` from app/sign-out.ts instead").toEqual([]);
  });
});

describe("the sign-out CONTROL is wired", () => {
  const account = readFileSync(`${APP}/(product)/mailbox/AccountSection.tsx`, "utf8");
  /* THE ARMS AND THEIR ORDER LIVE IN ONE READER since the lock screen said them too
     (ACCESS-LOCK-REFUSED-SIGN-OUT-IS-SILENT): the pane asks it once and gates the navigation on
     its answer. The pins below read the reader for the order and the pane for the gate. */
  const reader = readFileSync(`${APP}/sign-out-trouble.ts`, "utf8");

  it("Settings → Account reaches signOut, and does not call auth.logout itself", () => {
    // The helper existed for weeks with zero callers — correct, tested and unreachable. That
    // is the failure this asserts against, and it is the same shape as the refresh route and
    // `flagChanges`: built, verified, never wired.
    // `forgetThisBrowser` rides the same import: the erasure door needs the LOCAL half without
    // the server logout (that door revokes by erasing the account), and both come from the one
    // module so the two cannot drift apart.
    expect(account).toMatch(/import \{ forgetThisBrowser, signOut \} from "\.\.\/\.\.\/sign-out"/);
    expect(account).toMatch(/signOut\(owner\)/);
    expect(account).not.toMatch(/\bauth\.logout\s*\(/);
  });

  it("passes the storage owner, so the right mirror is the one wiped", () => {
    // `clearAllMirrors(undefined)` would be a best-effort sweep rather than this account's
    // database. The account is read from state that was loaded before the call.
    expect(account).toMatch(/doSignOut\(who\.accountId\)/);
  });

  it("leaves the SPA after signing out — the session is gone, the server must re-decide", () => {
    // A router push would keep the signed-in React tree alive on a dead session. This is the
    // same class of mistake as the resume `location.replace` that never re-requested.
    expect(account).toMatch(/window\.location\.assign\("\/"\)/);
  });

  it("SIGN OUT IS NOT INSIDE THE DELETE CARD, and that is the whole of this fix", () => {
    /**
     * Reported from a signed-in walk of the shipped build. The reading order was:
     *
     *   "Delete your account" → "Signed in as x@y. This cannot be undone." → "Sign out" [button]
     *   → the Erased/Kept columns → type-to-confirm
     *
     * So the one REVERSIBLE control on the screen sat directly under the words "This cannot
     * be undone", inside the destructive card, wearing its frame and its language. Separating
     * the CARDS is what fixes it — a rule inside one panel still reads as two parts of one
     * ceremony, which is what it had before and why it was still wrong.
     */
    const signOutCard = account.indexOf('className="acct acct-session"');
    const deleteCard = account.indexOf("<Pane>\n      <h2");
    expect(signOutCard, "the sign-out card must exist").toBeGreaterThan(-1);
    expect(deleteCard, "the delete card must exist").toBeGreaterThan(-1);
    expect(signOutCard, "sign out must come BEFORE the delete card").toBeLessThan(deleteCard);
    // …and the button must live in the first card, not the second.
    expect(account.indexOf("acct-signout-btn")).toBeLessThan(deleteCard);
  });

  it("`This cannot be undone` attaches to DELETION, not to being signed in", () => {
    // The sentence fused two unrelated answers — who you are signed in as, and that deleting
    // is permanent — so the permanence read as a property of the session. Split: the identity
    // line belongs to the card that acts on the session.
    const copy = JSON.parse(read("../messages/en.json")) as Record<string, Record<string, string>>;
    expect(copy.account!.lead).toBe("This cannot be undone.");
    expect(copy.account!.lead).not.toContain("{email}");
    expect(copy.account!.signedInAs).toContain("{email}");
    expect(copy.account!.signedInAs).not.toMatch(/undone/i);
  });

  it("a refused logout does NOT report a completed sign-out", () => {
    // `signOut` catches the server refusal and rides it out on the result, which is right: a
    // logout whose network call failed is still a person who asked to be signed out of this
    // browser, and the wipe must run. It does not license CLAIMING the session ended.
    // `tf_session` is HttpOnly and server-set — nothing this page can do expires it — so a
    // refused logout leaves a live credential the next reachable request authenticates with,
    // while this control's own copy says "Ends this session".
    const body = sliceOfDeclaration(account, "doSignOut");
    expect(reader).toMatch(/if \(outcome\.serverRefused !== null\) return \{ key: "signOutServerRefused"/);
    expect(body).toMatch(/const said = signOutTrouble\(outcome\);/);
    // ── THE REFUSAL NOW LEAVES, FOR THE SIGN-IN PAGE THAT FINISHES IT ─────────────────────
    //
    // It used to stay on the pane and say so, over a mailbox the blocked client could no longer
    // use. The browser is wiped and marked `signed_out_pending`, so `/` never serves it the app or a
    // resume (`session-gate.ts`): it sends it to the sign-in page, which presents the session at the
    // sign-out door behind its form, on the confirm ladder. The pane claims nothing either way.
    const gate = body.indexOf('if (said !== null && said.key !== "signOutServerRefused") {');
    const leave = body.indexOf("window.location.assign");
    expect(gate).toBeGreaterThan(-1);
    expect(leave, "leaving must come after the reader's gate").toBeGreaterThan(gate);
    expect(body.slice(gate, leave)).toMatch(/return;/);
    expect(body.slice(leave), "the press leaves for anything but the front door").toMatch(/window\.location\.assign\("\/"\)/);
    expect(account, "the pane still claims to say the server refused").not.toContain('t("signOutServerRefused"');
    // …and it is finished where the form is, never behind a page with nothing on it: the sign-in
    // page asks the sign-out door under the marker, and so do the sign-up and confirmation pages one
    // link away (one hook, `pending-sign-out.tsx`); the splash never loads the sign-out at all.
    const login = read("../app/(product)/login/LoginScreen.tsx");
    expect(login).toMatch(/if \(readOwnerMarker\(\)\.kind === "signed-out"\) \{\s*void pending\.finish\(/);
    const join = read("../app/(product)/join/JoinScreen.tsx");
    const branch = join.indexOf('if (apiConfigured() && readOwnerMarker().kind === "signed-out") {');
    const finish = join.indexOf("void pending.finish(", branch);
    const back = join.indexOf("return () => { cancelled = true; };", finish);
    expect(branch, "the sign-up page never reads the marker").toBeGreaterThan(-1);
    expect(finish).toBeGreaterThan(branch);
    expect(join.indexOf("void bootstrap();", branch), "the sign-up page reads the session under a pending sign-out")
      .toBeGreaterThan(back);
    expect(back).toBeGreaterThan(finish);
    const verify = read("../app/(product)/verify-email/VerifyEmailScreen.tsx");
    expect(verify).toMatch(/void pending\.finish\(/);
    for (const [page, src] of [["sign-in", login], ["sign-up", join], ["confirmation", verify]] as const) {
      expect(src, `the ${page} page starts a ceremony beside the pending sign-out`).toMatch(/if \(!await pending\.settle\(\)\) return;/);
      expect(src, `the ${page} page does not say how the sign-out ended`).toMatch(/<PendingSignOutSaid pending=\{pending\}/);
    }
    // …and what it ends on is said there, in this pane's words, through the same reader.
    const said = read("../app/(product)/login/pending-sign-out.tsx");
    expect(said).toMatch(/ta\(pending\.said\.key, \{ reason: pending\.said\.reason \}\)/);
    const splash = read("../app/(product)/resume/ResumeScreen.tsx");
    expect(splash).not.toMatch(/import\(["']\.\.\/\.\.\/sign-out["']\)|from ["']\.\.\/\.\.\/sign-out(?:-trouble)?["']/);
    const copy = JSON.parse(read("../messages/en.json")) as Record<string, Record<string, string>>;
    expect(copy.account!.signOutServerRefused).toMatch(/could not be ended/i);
    expect(copy.account!.signOutServerRefused).toMatch(/Devices list/);
  });

  it("…and the two local failures get DIFFERENT sentences, because their remedies differ", () => {
    // A blocked wipe means another tab is holding the database: close it and press again. An
    // unverifiable inventory means nothing is holding anything — this browser simply will not
    // say what it has — and "close your other tabs" would be a false instruction.
    const body = sliceOfDeclaration(account, "doSignOut");
    expect(reader).toMatch(/if \(!outcome\.cleared\) return \{ key: "signOutBlocked" \};/);
    expect(reader).toMatch(/if \(!outcome\.inventoryComplete\) return \{ key: "signOutUnverified" \};/);
    expect(body).toContain("setSignOutUnverified(true)");
    expect(account).toContain('t("signOutUnverified")');
    // ── AND THE ORDER, because one of these is a SUBSET of the other ────────────────────────
    //
    // `cleared` is false whenever the inventory is partial, so checking `!cleared` first made
    // the unverifiable branch UNREACHABLE: every browser that could not say what it holds was
    // told another tab was holding its mail open, and the distinct remedy was dead code. This
    // guard once asserted both `if`s and both strings existed — which is exactly what it did
    // while that was true.
    const unverified = reader.indexOf("!outcome.inventoryComplete");
    const blocked = reader.indexOf("!outcome.cleared");
    expect(unverified, "the narrower case must be tested first").toBeGreaterThan(-1);
    expect(blocked).toBeGreaterThan(unverified);
    // …and it returns, so it cannot fall through into the broader one.
    expect(reader.slice(unverified, blocked)).toMatch(/return \{/);
    const copy = JSON.parse(read("../messages/en.json")) as Record<string, Record<string, string>>;
    expect(copy.account!.signOutUnverified).toMatch(/could not confirm/i);
    expect(copy.account!.signOutUnverified).not.toMatch(/other tabs/i);
    expect(copy.account!.signOutBlocked).toMatch(/other tabs/i);
    // …and the blocked sentence names BOTH causes it is used for. The verdict is a list of
    // NAMES, not of reasons: a survivor is either a tab holding the database open or a browser
    // that refused the delete, and "close your other tabs" alone hands the second case a remedy
    // that cannot work. It ends with the one that always does.
    expect(copy.account!.signOutBlocked).toMatch(/refused to delete it/i);
    expect(copy.account!.signOutBlocked).toMatch(/clear this site's data/i);
  });

  it("an erasure whose local wipe was BLOCKED says so beside its receipt", () => {
    // The worst instance of the class: the account is gone, so there is no ordinary retry flow
    // left to reach the surviving mailbox copy with, and the erasure screen is the last surface
    // the person will ever see for that account. The receipt still shows — refusing to show a
    // completed, irreversible act would be worse — and the sentence sits next to it.
    // The erased door's scope: this account's copy, never another account's in the browser.
    expect(account).toMatch(/const local = await forgetThisBrowser\(owner, \{ only: true \}\)/);
    expect(account).toContain("setEraseMirrorBlocked(unclean)");
    // …and the verdict DEFAULTS to unclean. Initialising it clean made every exception before or
    // during the wipe read as a verified clean browser, on the one screen nobody can come back to.
    expect(account).toMatch(/let unclean = true;/);
    // BOTH halves of the verdict — an empty list from a browser that cannot be asked what it
    // holds proves only that the names we already knew are gone.
    expect(account).toMatch(/local\.remaining\.length > 0 \|\| !local\.inventoryComplete/);
    expect(account).toContain('t("erasedMirrorBlocked")');
    const copy = JSON.parse(read("../messages/en.json")) as Record<string, Record<string, string>>;
    expect(copy.account!.erasedMirrorBlocked).toMatch(/could not be removed/i);
    expect(copy.account!.erasedMirrorBlocked).toMatch(/other tabs/i);
  });

  it("STAYS when the mail is still here — and says which server it is still on", () => {
    const body = sliceOfDeclaration(account, "doSignOut");

    // ── WHAT THIS CASE USED TO ASSERT, AND WHY IT IS NOW WRONG ───────────────────────────
    //
    // It required a `catch` in this callback and the navigation to sit after it, on the rule
    // "no failure path strands the user signed in". That rule read the two halves of a
    // sign-out as one fact, and they are not: the LOCAL wipe and the SERVER revoke fail
    // independently and each has its own consequence. Leaving is correct only when BOTH
    // landed — a blocked wipe leaves mail on a borrowed computer, and a refused logout leaves
    // a live HttpOnly session this page cannot expire. `signOut` no longer throws at all (both
    // failures ride its result), so a `catch` here would be dead code standing in for a
    // property it no longer holds. Its sibling case above pins the server half.
    expect(body).toMatch(/const outcome = await signOut\(owner\)/);
    expect(reader).toMatch(/if \(!outcome\.cleared\) return \{ key: "signOutBlocked" \};/);
    const gate = body.indexOf('if (said !== null && said.key !== "signOutServerRefused") {');
    const leave = body.indexOf("window.location.assign");
    expect(gate, "the wipe verdict must be checked before leaving").toBeGreaterThan(-1);
    expect(leave, "and leaving must come after it").toBeGreaterThan(gate);
    // The blocked arm returns rather than falling through to the navigation…
    expect(body.slice(gate, leave)).toMatch(/return;/);
    // …and it SAYS SO. A stay with no sentence is a frozen button.
    expect(body).toContain("setSignOutBlocked(true)");
    expect(account).toContain('t("signOutBlocked")');
  });
});

/**
 * Every request that leaves while a case runs, none ever answered. Only the cache purge goes out
 * here (the door is the mocked `auth.logout`), and a confirmed sign-out must still resolve.
 */
const sent: Array<{ url: string; init?: RequestInit }> = [];
const purgesSent = (): number => sent.filter((s) => s.url === "/auth/refresh"
  && new Headers(s.init?.headers).get("x-ohmail-clear") === "cache").length;
function holdEveryRequest(): void {
  sent.length = 0;
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    sent.push({ url: String(input), init });
    return new Promise<Response>(() => {});
  }) as unknown as typeof globalThis.fetch;
}

/**
 * THE DOOR'S ANSWER IS THE VERDICT, driven through the real `signOut` with only `auth` replaced.
 * A 204 or OUR 401 ends the session here; everything else — an uncoded 401, a bare `{ status }`
 * double, offline, a 403 — is a refusal: the pending marker, the blocked client, the pane's
 * sentence. The doubles say `coded` out loud, because a 401 without it must read as refused.
 * A confirmed answer asks for the cache clear once (the door's answer no longer carries it); a
 * refused one never does: on an older API the purge is a renewal, and the jar may still be live.
 */
describe("the door's answer is the verdict", () => {
  const ACCOUNT = "11111111-1111-4111-8111-111111111111";

  beforeEach(async () => {
    mockLogout.mockReset();
    holdEveryRequest();
    localStorage.clear();
    // jsdom has no IndexedDB: a factory that holds nothing, so the wipe completes and is not the subject.
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = {
      databases: async () => [],
      deleteDatabase: () => {
        const req = { onsuccess: null } as unknown as IDBOpenDBRequest;
        queueMicrotask(() => (req.onsuccess as unknown as (() => void) | null)?.());
        return req;
      },
    } as unknown as IDBFactory;
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    (await import("../app/api-client")).bindApiOwner(null);
  });

  async function signOutAnswered(answer: "ok" | unknown) {
    if (answer === "ok") mockLogout.mockResolvedValueOnce(undefined);
    else mockLogout.mockRejectedValueOnce(answer);
    document.cookie = `tf_owner=${ACCOUNT}; Path=/`;
    const client = await import("../app/api-client");
    client.bindApiOwner(ACCOUNT);
    const { signOut } = await import("../app/sign-out");
    const before = purgesSent();
    const out = await signOut(ACCOUNT);
    const { readOwnerMarker } = await import("../app/shell/owner-cookie");
    return {
      serverRefused: out.serverRefused, marker: readOwnerMarker().kind,
      binding: client.apiOwnerBinding().kind, verdict: client.apiOwnerVerdict("/mailboxes"),
      purges: purgesSent() - before,
    };
  }

  const ENDED = { serverRefused: null, marker: "absent", binding: "public", verdict: "holds", purges: 1 };
  const REFUSED = {
    serverRefused: expect.any(String), marker: "signed-out", binding: "blocked", verdict: "signed-out", purges: 0,
  };

  it("a 204 ends it", async () => {
    expect(await signOutAnswered("ok")).toEqual(ENDED);
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  it("the tab's late-answer watch notes go with the session, every account's", async () => {
    const { SESSION_WATCH_PREFIX } = await import("../app/session-refresh");
    const notes = (): string[] => Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i)!)
      .filter((k) => k.startsWith(SESSION_WATCH_PREFIX));
    sessionStorage.setItem(`${SESSION_WATCH_PREFIX}${ACCOUNT}`,
      JSON.stringify({ mark: "00000000", name: "w-renewal", at: Date.now(), account: ACCOUNT }));
    sessionStorage.setItem(`${SESSION_WATCH_PREFIX}acct_other`, "{}");
    expect(notes(), "the control: two notes in the tab").toHaveLength(2);
    expect(await signOutAnswered("ok")).toEqual(ENDED);
    expect(notes(), "a late-answer watch note survived the sign-out").toEqual([]);
  });

  it("the splash's sentence left for the other tabs goes with the session", async () => {
    const { SHARED_NOTE_KEY, shareSignedOutNote, takeSharedSignedOutNote } = await import("../app/(product)/resume/signed-out-note");
    shareSignedOutNote("expired");
    expect(takeSharedSignedOutNote(), "the control: the sentence is there to take").toBe("expired");
    expect(await signOutAnswered("ok")).toEqual(ENDED);
    expect(localStorage.getItem(SHARED_NOTE_KEY), "the shared sentence survived the sign-out").toBeNull();
  });

  it("OUR 401 ends it — the door found nothing live to end and cleared the jar", async () => {
    const { ApiError } = await import("../app/api-client");
    expect(await signOutAnswered(new ApiError(401, "unauthorized", "nothing to sign out", undefined, { coded: true })))
      .toEqual(ENDED);
  });

  it("an UNCODED 401 is refused: something in front of us answered, not the door", async () => {
    const { ApiError } = await import("../app/api-client");
    expect(await signOutAnswered(new ApiError(401, "internal", "Unauthorized", undefined, { coded: false })))
      .toEqual(REFUSED);
    expect(await signOutAnswered({ status: 401 }), "a double with no envelope fact").toEqual(REFUSED);
  });

  it("offline is refused, and the marker says a sign-out is pending", async () => {
    const { ApiError, OFFLINE_CODE } = await import("../app/api-client");
    expect(await signOutAnswered(new ApiError(0, OFFLINE_CODE, "We could not reach ohmail."))).toEqual(REFUSED);
    expect(document.cookie).toContain("tf_owner=signed_out_pending");
  });

  it("a 403 is refused — it leaves the session alive", async () => {
    const { ApiError } = await import("../app/api-client");
    expect(await signOutAnswered(new ApiError(403, "csrf_failed", "csrf validation failed", undefined, { coded: true })))
      .toEqual(REFUSED);
  });
});

/**
 * THE SIGN-IN PAGE'S FINISHER passes a predicate: may this call still end the jar it started on? A
 * jar another tab signed in to while the door was out is not its to mark or wipe. A refusal leaves
 * the jar as it was, so a predicate that no longer holds after one means somebody else wrote it; the
 * door's own answer (204, its coded 401) clears the marker itself and is never read as that.
 */
describe("the finisher's predicate", () => {
  const PENDING = "signed_out_pending";
  const OTHER = "acct_signed_in_elsewhere";
  const JOURNAL = "ohmail.screener.intents.";
  const pending = (): boolean => document.cookie.split("; ").includes(`tf_owner=${PENDING}`);

  beforeEach(async () => {
    mockLogout.mockReset();
    holdEveryRequest();
    localStorage.clear();
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = {
      databases: async () => [],
      deleteDatabase: () => {
        const req = { onsuccess: null } as unknown as IDBOpenDBRequest;
        queueMicrotask(() => (req.onsuccess as unknown as (() => void) | null)?.());
        return req;
      },
    } as unknown as IDBFactory;
    document.cookie = `tf_owner=${PENDING}; Path=/`;
    (await import("../app/api-client")).blockApiOwner();
  });

  it("is handed to the door, which asks it inside the cookie lock", async () => {
    mockLogout.mockResolvedValueOnce(undefined);
    const { signOut } = await import("../app/sign-out");
    await signOut(undefined, { mayProceed: pending });
    expect(mockLogout).toHaveBeenCalledWith({ mayProceed: pending });
  });

  it("a refusal over a jar another tab signed in to answers null, and marks and sweeps nothing", async () => {
    const { ApiError, OFFLINE_CODE } = await import("../app/api-client");
    mockLogout.mockImplementationOnce(async () => {
      // The other tab's answer lands while this door is out.
      document.cookie = `tf_owner=${OTHER}; Path=/`;
      localStorage.setItem(`${JOURNAL}${OTHER}`, "[]");
      throw new ApiError(0, OFFLINE_CODE, "We could not reach ohmail.");
    });
    const { signOut } = await import("../app/sign-out");
    expect(await signOut(undefined, { mayProceed: pending }), "a refusal about somebody else's jar was reported").toBeNull();
    expect(document.cookie, "the other tab's session was marked pending").toContain(`tf_owner=${OTHER}`);
    expect(localStorage.getItem(`${JOURNAL}${OTHER}`), "the other tab's stores were swept").toBe("[]");
    expect(purgesSent(), "a purge over the other tab's live jar").toBe(0);
  });

  it("THE CONTROL — the same refusal over the jar it started on is reported, marked and swept as ever", async () => {
    const { ApiError, OFFLINE_CODE } = await import("../app/api-client");
    localStorage.setItem(`${JOURNAL}acct_left`, "[]");
    mockLogout.mockRejectedValueOnce(new ApiError(0, OFFLINE_CODE, "We could not reach ohmail."));
    const { signOut } = await import("../app/sign-out");
    const out = await signOut(undefined, { mayProceed: pending });
    expect(out?.serverRefused).toBe("We could not reach ohmail.");
    expect(pending()).toBe(true);
    expect(localStorage.getItem(`${JOURNAL}acct_left`)).toBeNull();
  });

  it("the door's own clear is never read as a jar that moved: 204 and its coded 401 run the local half", async () => {
    const { ApiError } = await import("../app/api-client");
    const { signOut } = await import("../app/sign-out");
    for (const answer of ["ok", new ApiError(401, "refresh_revoked", "revoked", undefined, { coded: true })] as const) {
      document.cookie = `tf_owner=${PENDING}; Path=/`;
      localStorage.setItem(`${JOURNAL}acct_left`, "[]");
      mockLogout.mockImplementationOnce(async () => {
        // The door's answer clears the jar, `tf_owner` with it.
        document.cookie = "tf_owner=; Path=/; Max-Age=0";
        if (answer !== "ok") throw answer;
      });
      const before = purgesSent();
      const out = await signOut(undefined, { mayProceed: pending });
      expect(out, `${answer === "ok" ? "a 204" : "a coded 401"} was read as a jar that moved`).not.toBeNull();
      expect(out!.serverRefused).toBeNull();
      expect(localStorage.getItem(`${JOURNAL}acct_left`), "the local half did not run").toBeNull();
      expect(purgesSent() - before, "the finished sign-out's cache clear").toBe(1);
    }
  });

  it("WITHOUT a predicate there is no such exit: every press runs its local half", async () => {
    const { ApiError, OFFLINE_CODE } = await import("../app/api-client");
    mockLogout.mockImplementationOnce(async () => {
      document.cookie = `tf_owner=${OTHER}; Path=/`;
      throw new ApiError(0, OFFLINE_CODE, "We could not reach ohmail.");
    });
    const { signOut } = await import("../app/sign-out");
    const out = await signOut();
    expect(out.serverRefused).toBe("We could not reach ohmail.");
    expect(pending(), "a press with no predicate skipped its local half").toBe(true);
  });
});
