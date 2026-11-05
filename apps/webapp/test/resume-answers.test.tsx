/** @vitest-environment jsdom */
/** @vitest-environment-options {"url": "https://mail.example/"} */
/**
 * THE SPLASH READS THE REFRESH DOOR'S ANSWER. The report — "Please
 * sign in again", then a full 2FA sign-in over a live 90-day cookie — was two defects here: a refresh
 * that FAULTED (503 `db_busy`, jar untouched) was answered with `/login` as if the server had
 * cleared the jar, and the loop guard fired after a MINT whenever the edge refused the browser again.
 * Now a mint reloads, the door's refusals go to `/login` at once with their sentence, and a fault
 * retries here and ends on "could not be reached" with Try again and no Sign in. Every needle is
 * RENDERED catalogue text, never a source string.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { resumeOnceKey } from "../app/(product)/resume/ResumeScreen.js";
import { REVOKE_OWED_PREFIX, shareSignedOutNote } from "../app/(product)/resume/signed-out-note.js";
import { SESSION_MINTED_KEY } from "../app/session-refresh.js";
import { fixturePassword } from "../../../test/support/fixture-credentials.js";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
process.env.NEXT_PUBLIC_API_BASE = "/api";

// One router, as Next's: a new one each render re-ran /login's session check on every keystroke.
const router = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const ONCE_KEY = resumeOnceKey("acct_A");
const NOTE_KEY = "ohmail.signed-out-reason";
const R = messages.resume;

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const db503 = (): Response =>
  json({ error: { code: "db_busy", retryable: true, message: "busy" } }, 503, { "retry-after": "5" });
const refused = (code: string) => (): Response => json({ error: { code, message: "refused" } }, 401);
/** The refusal as the server sends it: `clearSessionCookies()` takes `tf_owner` with the rest of the jar. */
const refusedClearing = (code: string) => (): Response => {
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  return refused(code)();
};
/** A reuse sweep's own refusal: the code every client ends on, and `details.cause` saying why. */
const reuseSwept = (cause: string, clearing: boolean) => (): Response => {
  if (clearing) document.cookie = "tf_owner=; Path=/; Max-Age=0";
  return json({ error: { code: "refresh_revoked", message: "refresh token reuse detected", details: { cause } } }, 401);
};
const platform401 = (): Response => new Response("<html>401</html>", { status: 401, headers: { "content-type": "text/html" } });
const minted = (): Response => new Response(null, { status: 204 });

let script: Array<() => Response> = [];
/** Presentations of the refresh token; the cache purge after a refusal is counted apart. */
let refreshes = 0;
let purges = 0;
let purgeAnswer: () => Promise<Response> = async () => new Response(null, { status: 202 });
let reloads = 0;
let replaced: string[] = [];
let priorFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(async () => {
  // A coded 401 arms the death latch and its heal schedule; neither may leak into the next case.
  (await import("../app/shell/session-truth.js")).resetSessionTruthForTests();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-09-23T08:00:00.000Z"));
  // Full jitter pinned at its top: every wait is the schedule's whole number, so a retry that
  // came before the server's Retry-After cannot hide inside the jitter.
  vi.spyOn(Math, "random").mockReturnValue(1);
  script = [minted];
  refreshes = 0;
  purges = 0;
  purgeAnswer = async () => new Response(null, { status: 202 });
  reloads = 0;
  replaced = [];
  sessionStorage.clear();
  localStorage.clear();
  document.cookie = "tf_owner=acct_A; Path=/";
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href: "https://mail.example/", origin: "https://mail.example", protocol: "https:", hash: "",
      reload: () => { reloads += 1; },
      replace: (u: string) => { replaced.push(u); },
    },
  });
  priorFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/auth/refresh") && new Headers(init?.headers).has("x-ohmail-clear")) {
      purges += 1;
      return purgeAnswer();
    }
    if (url.includes("/auth/refresh")) {
      refreshes += 1;
      return script[Math.min(refreshes, script.length) - 1]!();
    }
    if (url.includes("/api/auth/session")) return json({ error: { code: "unauthorized", message: "no" } }, 401);
    return json({}, 200);
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  await unmount();
  (await import("../app/revoked-door.js")).resetRevokedDoorForTests();
  globalThis.fetch = priorFetch;
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  document.cookie = "tf_signed_out=; Path=/; Max-Age=0";
  sessionStorage.clear();
  localStorage.clear();
  Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, "locks");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}

async function flush(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
}

/** Advance in steps, each its own `act`, so a rung armed mid-advance is not skipped. */
async function tick(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 250) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(250, left)); });
    await flush();
  }
}

async function mountResume(owner: string | null = "acct_A"): Promise<HTMLElement> {
  const { ResumeScreen } = await import("../app/(product)/resume/ResumeScreen.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", children: h(ResumeScreen, { initialOwner: owner }),
    }));
  });
  await flush();
  await wipesEnded([await import("../app/revoked-door.js")]);
  return host;
}

/** A revoke's wipe of this browser's copy is real I/O, and the splash leaves after it. */
async function wipesEnded(doors: Array<{ revokedWipeSettled: () => Promise<void> }>): Promise<void> {
  await act(async () => { await Promise.all(doors.map((d) => d.revokedWipeSettled())); });
  await flush();
}

async function mountLogin(): Promise<HTMLElement> {
  const { LoginScreen } = await import("../app/(product)/login/LoginScreen.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(LoginScreen) }));
  });
  await flush();
  return host;
}

const text = (el: HTMLElement): string => el.textContent ?? "";
const buttons = (el: HTMLElement, label: string): number =>
  [...el.querySelectorAll("a, button")].filter((b) => (b.textContent ?? "").trim() === label).length;
const stamp = (answer: string, reloadsSoFar = 0): void =>
  sessionStorage.setItem(ONCE_KEY, JSON.stringify({ at: Date.now(), answer, reloads: reloadsSoFar }));

describe("(b) a fault at the refresh is retried in place — the jar is never given up", () => {
  it("503 then 204: waits the server's Retry-After, retries, reloads; /login is never visited", async () => {
    script = [db503, minted];
    const el = await mountResume();
    expect(refreshes).toBe(1);
    await tick(4_750);
    expect(refreshes, "the retry came before the server's Retry-After").toBe(1);
    await tick(500);
    expect(refreshes, "the fault was not retried").toBe(2);
    expect(reloads, "a mint after a retry did not reload").toBe(1);
    expect(replaced, "a fault sent a signed-in browser to the sign-in form").toEqual([]);
    expect(text(el)).not.toContain(R.failedTitle);
  });

  it("an UNCODED 401 is a platform, not the server's verdict — retried like a fault", async () => {
    script = [platform401, minted];
    await mountResume();
    await tick(1_000);
    expect(refreshes).toBe(2);
    expect(replaced).toEqual([]);
    expect(reloads).toBe(1);
  });
});

describe("(c) a fault that does not clear ends on 'could not be reached' — Try again, no Sign in", () => {
  it("four 503s: the busy card, then Try again reaches the mailbox", async () => {
    script = [db503];
    const el = await mountResume();
    await tick(30_000);
    expect(refreshes, "the ladder is four asks, no more and no fewer").toBe(4);
    expect(text(el)).toContain(R.busyTitle);
    expect(text(el)).toContain(R.busyBody);
    expect(buttons(el, R.tryAgain), "the busy card has no Try again").toBe(1);
    expect(buttons(el, R.signIn), "the busy card offers a sign-in over a live jar").toBe(0);
    expect(text(el)).not.toContain(R.failedTitle);
    expect(replaced).toEqual([]);
    expect(reloads).toBe(0);

    script = [minted];
    const again = [...el.querySelectorAll("button")].find((b) => b.textContent === R.tryAgain)!;
    await act(async () => { again.click(); });
    await flush();
    expect(refreshes).toBe(5);
    expect(reloads, "Try again did not resume").toBe(1);
  });

  it("THE CONTROL — the loop guard does not fire on a fault: a second visit asks again", async () => {
    script = [db503];
    await mountResume();
    await tick(30_000);
    expect(refreshes).toBe(4);
    await unmount();
    const el = await mountResume();
    expect(refreshes, "a fault left a stamp that vetoed the next resume").toBe(5);
    expect(text(el)).not.toContain(R.failedTitle);
  });
});

describe("(d) the door's refusals go to /login on the FIRST attempt, with the sentence", () => {
  it.each([
    ["refresh_revoked", "revoked"],
    ["refresh_expired", "expired"],
    ["refresh_missing", "absent"],
    ["unauthorized", "revoked"],
  ])("a coded 401 %s — /login at once, note %s", async (code, note) => {
    script = [refused(code)];
    await mountResume();
    expect(refreshes, "a refusal was retried — the verdict lost its speed").toBe(1);
    expect(replaced).toEqual(["/login"]);
    expect(sessionStorage.getItem(NOTE_KEY)).toBe(note);
    await tick(10_000);
    expect(refreshes).toBe(1);
  });

  it.each([
    ["refresh_revoked", "revoked"],
    ["refresh_expired", "expired"],
  ])("%s with the jar cleared as the server clears it — /login with note %s, never the landing page", async (code, note) => {
    script = [refusedClearing(code)];
    await mountResume();
    expect(reloads, "the door's own refusal was read as a jar that changed hands").toBe(0);
    expect(replaced).toEqual(["/login"]);
    expect(sessionStorage.getItem(NOTE_KEY)).toBe(note);
  });

  it.each([false, true])("a reuse sweep's refusal (the server clears the jar: %s) — /login at once, note reused", async (clearing) => {
    script = [reuseSwept("reuse", clearing)];
    await mountResume();
    expect(refreshes, "the refused token was presented again").toBe(1);
    expect(replaced).toEqual(["/login"]);
    expect(sessionStorage.getItem(NOTE_KEY)).toBe("reused");
  });

  it("the control: a cause this build does not know is the plain revoked note", async () => {
    script = [reuseSwept("replayed", true)];
    await mountResume();
    expect(replaced).toEqual(["/login"]);
    expect(sessionStorage.getItem(NOTE_KEY)).toBe("revoked");
  });

  it("the control: a refusal that lands under another account's jar reloads, with no sentence", async () => {
    script = [() => { document.cookie = "tf_owner=acct_B; Path=/"; return refused("refresh_revoked")(); }];
    await mountResume();
    expect(reloads).toBe(1);
    expect(replaced).toEqual([]);
    expect(sessionStorage.getItem(NOTE_KEY)).toBeNull();
  });

  it("the sign-in form does not wait for the cache purge the refusal sends", async () => {
    // Chrome held a refusal carrying Clear-Site-Data for a walk of its whole disk cache.
    purgeAnswer = () => new Promise<Response>(() => {});
    script = [refusedClearing("refresh_expired")];
    await mountResume();
    expect(purges, "the refusal asked for no cache clear").toBe(1);
    expect(replaced).toEqual(["/login"]);
    expect(sessionStorage.getItem(NOTE_KEY)).toBe("expired");
    expect(refreshes).toBe(1);
  });

  it("an erased account's 410, on a splash that registers no erased door: one purge, then /login", async () => {
    script = [() => {
      document.cookie = "tf_owner=; Path=/; Max-Age=0";
      return json({ error: { code: "account_erased", message: "deleted" } }, 410, { "X-Ohmail-Account": "acct_A" });
    }];
    await mountResume();
    expect(purges, "the erased account's cached files stay on this browser's disk").toBe(1);
    expect(refreshes).toBe(1);
    expect(replaced).toEqual(["/login"]);
  });
});

/**
 * TWO TABS ON THE SPLASH. Tab A presents and hears the refusal while this tab (B) waits on the
 * cross-tab lock; A's answer clears the jar, `tf_owner` with it, and A leaves its sentence for the
 * other tabs. B presents nothing and must not reload into the gate, which sent every reload back
 * here while the clears were held: it goes to the sign-in form with A's sentence.
 */
describe("(e) another tab heard the door while this one waited", () => {
  /** The lock manager B queues on; `meanwhile` is what tab A does before B's grant. */
  function lockedBehindTabA(meanwhile: () => void): void {
    Object.defineProperty(globalThis.navigator, "locks", {
      configurable: true,
      value: {
        request: async (_n: string, _o: unknown, fn: () => Promise<unknown>) => {
          meanwhile();
          return fn();
        },
      },
    });
  }

  it("tab A's refusal empties the jar: B presents nothing, does not reload, and says A's sentence", async () => {
    lockedBehindTabA(() => {
      document.cookie = "tf_owner=; Path=/; Max-Age=0";
      shareSignedOutNote("expired");
    });
    await mountResume();
    expect(refreshes, "B presented a token tab A had just heard refused").toBe(0);
    expect(reloads, "B reloaded into the gate").toBe(0);
    expect(replaced).toEqual(["/login"]);
    expect(sessionStorage.getItem(NOTE_KEY)).toBe("expired");
  });

  it("the control: a sentence older than the window is not taken — the sign-in form alone", async () => {
    lockedBehindTabA(() => {
      shareSignedOutNote("revoked");
      vi.setSystemTime(Date.now() + 16_000);
      document.cookie = "tf_owner=; Path=/; Max-Age=0";
    });
    await mountResume();
    expect(refreshes).toBe(0);
    expect(replaced).toEqual(["/login"]);
    expect(sessionStorage.getItem(NOTE_KEY)).toBeNull();
  });

  it("the control: another account signed in meanwhile — B reloads, with no sentence", async () => {
    lockedBehindTabA(() => {
      shareSignedOutNote("expired");
      document.cookie = "tf_owner=acct_B; Path=/";
    });
    await mountResume();
    expect(refreshes).toBe(0);
    expect(reloads).toBe(1);
    expect(replaced).toEqual([]);
    expect(sessionStorage.getItem(NOTE_KEY)).toBeNull();
  });
});

/**
 * TWO SPLASHES ON ONE ENDED SIGN-IN, each a page of its own (fresh modules) over one jar, one storage
 * and one lock. The browser may grant the next tab before the holder hears its own release (another
 * process): a reason the holder writes after letting go reaches the next tab too late.
 */
describe("(f) every tab on an ended sign-in says the same reason", () => {
  /** The server's half of the jar: a refresh token until the door refuses it and clears the jar. */
  let jarHoldsToken = true;
  const door = (): Response => {
    if (!jarHoldsToken) return refused("refresh_missing")();
    jarHoldsToken = false;
    return refusedClearing("refresh_revoked")();
  };
  /** The note each tab carried to /login, in the order the tabs left. */
  let told: Array<string | null> = [];
  const tabs: Root[] = [];

  beforeEach(() => {
    jarHoldsToken = true;
    script = [door];
    told = [];
    // A tab that leaves takes its note with it: session storage is the tab's own in a browser.
    (window.location as unknown as { replace: (u: string) => void }).replace = (u) => {
      replaced.push(u);
      told.push(sessionStorage.getItem(NOTE_KEY));
      sessionStorage.removeItem(NOTE_KEY);
    };
    let busy = false;
    const waiting: Array<() => void> = [];
    /** Hands the lock on; answers whether a tab was waiting for it. */
    const grantNext = (): boolean => { const run = waiting.shift(); busy = run !== undefined; run?.(); return busy; };
    // A holder that handed the lock on hears its release after the next tab has run.
    const settle = (handed: boolean, done: () => void): void => { if (handed) setTimeout(done, 0); else done(); };
    Object.defineProperty(globalThis.navigator, "locks", {
      configurable: true,
      value: {
        request: (_n: string, _o: unknown, fn: () => Promise<unknown>) => new Promise((resolve, reject) => {
          const run = (): void => {
            void Promise.resolve().then(fn).then(
              (v) => settle(grantNext(), () => resolve(v)),
              (e) => settle(grantNext(), () => reject(e)),
            );
          };
          if (busy) waiting.push(run);
          else { busy = true; run(); }
        }),
      },
    });
  });

  afterEach(async () => {
    for (const r of tabs.splice(0)) await act(async () => { r.unmount(); });
  });

  /** Tabs opened at the same moment, `initialOwner` as each one's edge saw it. */
  async function openTabs(...owners: Array<string | null>): Promise<void> {
    const screens: Array<typeof import("../app/(product)/resume/ResumeScreen.js").ResumeScreen> = [];
    const doors: Array<typeof import("../app/revoked-door.js")> = [];
    for (const _ of owners) {
      vi.resetModules();
      screens.push((await import("../app/(product)/resume/ResumeScreen.js")).ResumeScreen);
      doors.push(await import("../app/revoked-door.js"));
    }
    await act(async () => {
      owners.forEach((owner, i) => {
        const el = document.createElement("div");
        document.body.appendChild(el);
        const r = createRoot(el);
        tabs.push(r);
        r.render(h(NextIntlClientProvider, {
          locale: "en", messages, timeZone: "UTC", children: h(screens[i]!, { initialOwner: owner }),
        }));
      });
    });
    await tick(500);
    await wipesEnded(doors);
  }

  it("opened together on a jar that names the account: both say the refusal's reason", async () => {
    await openTabs("acct_A", "acct_A");
    expect(refreshes, "the second tab presented the refused jar again").toBe(1);
    expect(told).toEqual(["revoked", "revoked"]);
  });

  it("opened together from another site (no marker seen): the empty jar's answer says the first tab's reason", async () => {
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    await openTabs(null, null);
    expect(refreshes).toBe(2);
    expect(told).toEqual(["revoked", "revoked"]);
    expect(JSON.parse(localStorage.getItem("ohmail.signed-out-reason.shared")!).reason, "the reason was overwritten")
      .toBe("revoked");
  });

  it("a tab opened 3 s later meets the emptied jar and says the first tab's reason", async () => {
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    await openTabs(null);
    sessionStorage.clear();
    await tick(2_500);
    await openTabs(null);
    expect(told).toEqual(["revoked", "revoked"]);
  });

  it("the control: a tab opened past the note's window says the jar is empty", async () => {
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    await openTabs(null);
    sessionStorage.clear();
    await tick(16_000);
    await openTabs(null);
    expect(told).toEqual(["revoked", "absent"]);
  });

  it("a tab opened 3 s later on a server that sends it straight to /login says the first tab's reason", async () => {
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    await openTabs(null);
    sessionStorage.clear();
    await tick(3_000);
    expect(text(await mountLogin())).toContain(R.revokedBody);
  });

  /** `/` as the edge answers it for this jar: where it sends the tab, or `null` for the landing. */
  async function edgeSends(build: "cloud" | "selfhost" = "cloud"): Promise<string | null> {
    vi.stubEnv("TF_API_ORIGIN", "https://api.ohmail.app");
    if (build === "selfhost") {
      vi.stubEnv("NEXT_PUBLIC_OHMAIL_FLAVOR", "selfhost");
      vi.stubEnv("OHMAIL_INTERNAL_API_ORIGIN", "http://api:8080");
    }
    vi.resetModules();
    const { middleware } = await import("../middleware");
    const { NextRequest } = await import("next/server");
    const res = await middleware(new NextRequest("https://ohmail.app/", { headers: { cookie: document.cookie } }));
    vi.unstubAllEnvs();
    return res.status === 307 ? new URL(res.headers.get("location")!).pathname : null;
  }

  /** The page on a plain-http origin: its cookie writes carry no `Secure`. */
  const plainHttp = (): void => { (window.location as unknown as { protocol: string }).protocol = "http:"; };

  it("a tab opened 3 s later on ohmail Cloud: the edge sends the emptied jar to /login, which says why", async () => {
    plainHttp();
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    await openTabs(null);
    sessionStorage.clear();
    await tick(3_000);
    expect(await edgeSends(), "the second tab met the landing").toBe("/login");
    expect(await edgeSends("selfhost"), "your own server's door").toBe("/login");
    expect(text(await mountLogin())).toContain(R.revokedBody);
  });

  it("the control: the edge's copy is host-only and lives the note's 15 s; a jar without it gets the landing", async () => {
    plainHttp();
    const writes: string[] = [];
    const jar = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
    vi.spyOn(Document.prototype, "cookie", "set").mockImplementation(function (this: Document, v: string) {
      writes.push(v);
      jar.set!.call(this, v);
    });
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    await openTabs(null);
    expect(writes.filter((w) => w.startsWith("tf_signed_out="))).toEqual(["tf_signed_out=revoked; Path=/; Max-Age=15; SameSite=Lax"]);
    document.cookie = "tf_signed_out=; Path=/; Max-Age=0";
    expect(await edgeSends()).toBeNull();
  });
});

describe("the loop guard reads the answer of the previous pass", () => {
  it("back here right after a MINT: no second rotation, a reload after a backoff", async () => {
    stamp("minted");
    await mountResume();
    expect(refreshes, "a live jar was rotated again").toBe(0);
    await tick(1_300);
    expect(reloads).toBe(1);
    expect(JSON.parse(sessionStorage.getItem(ONCE_KEY)!).reloads).toBe(1);
  });

  it("after the reloads run out: the busy card, never the sign-in card", async () => {
    stamp("minted", 3);
    const el = await mountResume();
    expect(refreshes).toBe(0);
    expect(text(el)).toContain(R.busyTitle);
    expect(buttons(el, R.signIn)).toBe(0);
    expect(text(el)).not.toContain(R.failedTitle);
  });

  it("back here after a REFUSAL: the sign-in card with the sentence that names it", async () => {
    stamp("expired");
    const el = await mountResume();
    expect(refreshes).toBe(0);
    expect(text(el)).toContain(R.failedTitle);
    expect(text(el)).toContain(R.expiredBody);
    expect(buttons(el, R.signIn)).toBe(1);
  });

  it("back here after a REUSE SWEEP: the card says what happened and what to do", async () => {
    stamp("reused");
    const el = await mountResume();
    expect(refreshes).toBe(0);
    expect(text(el)).toContain(R.reusedBody);
    expect(buttons(el, R.signIn)).toBe(1);
  });

  it("a stamp from the previous build — a bare timestamp — resumes; it shows no card", async () => {
    sessionStorage.setItem(ONCE_KEY, String(Date.now()));
    const el = await mountResume();
    expect(refreshes).toBe(1);
    expect(reloads).toBe(1);
    expect(text(el)).not.toContain(R.failedTitle);
  });
});

describe("/login says why the splash sent this tab there", () => {
  it("the note renders its sentence once and is removed", async () => {
    sessionStorage.setItem(NOTE_KEY, "expired");
    const { LoginScreen } = await import("../app/(product)/login/LoginScreen.js");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(LoginScreen) }));
    });
    await flush();
    expect(text(host)).toContain(R.expiredBody);
    expect(sessionStorage.getItem(NOTE_KEY), "the note outlived its one reading").toBeNull();
  });

  it("the reuse note renders its sentence once and is removed", async () => {
    sessionStorage.setItem(NOTE_KEY, "reused");
    const { LoginScreen } = await import("../app/(product)/login/LoginScreen.js");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(LoginScreen) }));
    });
    await flush();
    expect(text(host).split(R.reusedBody).length - 1, "the reuse sentence, once").toBe(1);
    expect(sessionStorage.getItem(NOTE_KEY)).toBeNull();
  });

  it("no note of its own: another tab's young reason is said", async () => {
    shareSignedOutNote("expired");
    await tick(3_000);
    expect(text(await mountLogin())).toContain(R.expiredBody);
  });

  it("the control: another tab's reason older than 15 s is not said", async () => {
    shareSignedOutNote("expired");
    await tick(16_000);
    expect(text(await mountLogin())).not.toContain(R.expiredBody);
  });

  it("THE CONTROL — no note, no sentence", async () => {
    const { LoginScreen } = await import("../app/(product)/login/LoginScreen.js");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(LoginScreen) }));
    });
    await flush();
    for (const body of [R.revokedBody, R.expiredBody, R.absentBody]) expect(text(host)).not.toContain(body);
  });
});

describe("the loop guard belongs to the account that wrote it", () => {
  it("B resuming in the tab where A just resumed asks the door, never reads A's stamp as a loop", async () => {
    stamp("minted");
    document.cookie = "tf_owner=acct_B; Path=/";
    await mountResume("acct_B");
    expect(refreshes, "B's resume was taken for A's loop and never asked the refresh door").toBe(1);
    expect(sessionStorage.getItem(resumeOnceKey("acct_B")), "B's own pass was not stamped under B").not.toBeNull();
  });

  it("control: A back within the window IS a loop for A — its own stamp still reads", async () => {
    stamp("minted");
    await mountResume("acct_A");
    expect(refreshes, "the guard stopped seeing the account's own loop").toBe(0);
  });
});

/**
 * A LAPTOP SIGNED OUT FROM DEVICES WHILE ITS TAB WAS CLOSED meets the refusal here, on its next visit:
 * its copy of the mailbox is gone before the splash sends it to the sign-in form. An expired sign-in
 * keeps the copy for the next sign-in.
 */
describe("(g) a revoked sign-in leaves no copy behind the sign-in form", () => {
  let held: boolean[] = [];
  let engine: typeof import("@ohmail/client-engine");
  /** An account's copy on this browser's disk, closed as a reload leaves it. */
  async function holdCopyOf(owner: string): Promise<void> {
    const store = new engine.IndexedDbMirrorStore({ owner });
    await store.load();
    await store.putLocal("message", "m1", { id: "m1", subject: `a letter of ${owner}` });
    store.close();
  }
  /** The wipe is real I/O, its module loaded on first use: the loop turns until the splash leaves (real time). */
  async function untilLeft(): Promise<void> {
    const end = performance.now() + 10_000;
    while (replaced.length === 0 && performance.now() < end) await act(async () => { await new Promise((r) => setImmediate(r)); });
  }
  beforeEach(async () => {
    const { createRequire } = await import("node:module");
    const { resolve } = await import("node:path");
    const fake = createRequire(resolve("packages/client-engine/package.json"))("fake-indexeddb") as { IDBFactory: new () => IDBFactory; IDBKeyRange: unknown };
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new fake.IDBFactory();
    (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = fake.IDBKeyRange;
    engine = await import("@ohmail/client-engine");
    await holdCopyOf("acct_A");
    held = [];
    (window.location as unknown as { replace: (u: string) => void }).replace = (u) => {
      replaced.push(u);
      held.push(engine.holdsMirrorOf("acct_A"));
    };
  });
  afterEach(() => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it.each([
    ["refresh_revoked", false],
    ["refresh_expired", true],
  ])("%s: the splash leaves for /login with the copy still here: %s", async (code, kept) => {
    script = [refusedClearing(code)];
    await mountResume();
    await untilLeft();
    expect(replaced).toEqual(["/login"]);
    expect(held, kept ? "an expired sign-in's copy was taken" : "the splash left with the revoked account's copy").toEqual([kept]);
  });

  /*
   * Safari keeps a cookie page script wrote for seven days, and every renewal writes `tf_owner` again from script:
   * a laptop left for a week reaches the splash with no name in the jar, and the edge saw none either.
   */
  it("no name in the jar: the one copy this browser holds is gone before the splash leaves", async () => {
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    script = [refusedClearing("refresh_revoked")];
    await mountResume(null);
    await untilLeft();
    expect(replaced).toEqual(["/login"]);
    expect(held, "the splash left with the only copy this browser holds").toEqual([false]);
  });

  it("CONTROL — no name and two accounts' copies: neither is taken on a guess", async () => {
    await holdCopyOf("acct_B");
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    script = [refusedClearing("refresh_revoked")];
    await mountResume(null);
    await untilLeft();
    expect(replaced).toEqual(["/login"]);
    expect([...held, engine.holdsMirrorOf("acct_B")], "a copy went on a guess").toEqual([true, true]);
  });

  it("CONTROL — a sign-in that lands while the copies are counted keeps its copy", async () => {
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    const factory = indexedDB as IDBFactory & { databases: () => Promise<IDBDatabaseInfo[]> };
    const listed = factory.databases.bind(factory);
    factory.databases = async () => { document.cookie = "tf_owner=acct_A; Path=/"; return listed(); };
    script = [refusedClearing("refresh_revoked")];
    await mountResume(null);
    await untilLeft();
    expect(held, "the copy of a session that came back was taken").toEqual([true]);
  });

  /**
   * STRAIGHT TO THE SIGN-IN PAGE (a bookmark, a typed address): the page's own session check hears the refusal.
   * Fresh modules each case: the splash above has registered the door already.
   */
  describe("on /login", () => {
    type SignOut = typeof import("../app/sign-out");
    let wire: string[] = [];
    let loading = false;
    let release = (): void => {};
    let forgets: Array<Promise<unknown>> = [];
    /** Real turns until `done`, at most 10 s: the wipe is real I/O. */
    async function until(done: () => boolean): Promise<boolean> {
      const end = performance.now() + 10_000;
      while (!done() && performance.now() < end) await act(async () => { await new Promise((r) => setImmediate(r)); });
      return done();
    }
    /** /login over a jar the refresh door refuses, once the page's session check has heard the answer. */
    async function loginAfter(answer: () => Response): Promise<HTMLElement> {
      script = [answer];
      const el = await mountLogin();
      const { lastRefreshReport } = await import("../app/session-refresh.js");
      expect(await until(() => lastRefreshReport() !== null), "the page never asked the refresh door").toBe(true);
      return el;
    }
    /** …over a revoke whose wipe waits at its module load for `release`; each forget it then starts is kept. */
    async function loginOverHeldWipe(): Promise<HTMLElement> {
      const gate = new Promise<void>((r) => { release = r; });
      vi.doMock("../app/sign-out", async (importOriginal: () => Promise<SignOut>) => {
        loading = true;
        await gate;
        const real = await importOriginal();
        const forgetThisBrowser: SignOut["forgetThisBrowser"] = (...a) => {
          const p = real.forgetThisBrowser(...a);
          forgets.push(p);
          return p;
        };
        return { ...real, forgetThisBrowser };
      });
      const el = await loginAfter(refusedClearing("refresh_revoked"));
      expect(await until(() => loading), "no wipe started").toBe(true);
      return el;
    }
    async function submit(el: HTMLElement, form: string, fields: Array<[string, string]>): Promise<void> {
      await act(async () => {
        for (const [id, value] of fields) {
          const input = el.querySelector<HTMLInputElement>(id)!;
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      await act(async () => { el.querySelector(form)!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    }
    const signIn = (el: HTMLElement): Promise<void> =>
      submit(el, "form", [["#login-email", "m@example.test"], ["#login-pw", fixturePassword("resume-answers")]]);
    /** The code step, whose answer mints the new session. */
    async function secondFactor(el: HTMLElement): Promise<void> {
      expect(await until(() => el.querySelector("#login-code") !== null), "no code step").toBe(true);
      await submit(el, "form.login-totp", [["#login-code", "123456"]]);
      expect(await until(() => wire.includes("verify")), "the code never left").toBe(true);
    }
    /** The held wipe let go: its module loaded, and whatever it removes, removed. */
    async function wipeOver(): Promise<void> {
      release();
      await act(async () => { await vi.dynamicImportSettled(); });
      await flush();
      await act(async () => { await Promise.allSettled(forgets); });
    }

    beforeEach(() => {
      vi.resetModules();
      wire = [];
      loading = false;
      release = () => {};
      forgets = [];
      const base = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/auth/login")) {
          wire.push(`login, copy ${engine.holdsMirrorOf("acct_A") ? "kept" : "gone"}`);
          return json({ status: "twofa_required", loginToken: "t", methods: ["totp"] }, 200);
        }
        if (!url.includes("/api/auth/2fa/totp/verify")) return base(input as RequestInfo, init);
        wire.push("verify");
        document.cookie = "tf_csrf=minted; Path=/";
        document.cookie = "tf_owner=acct_A; Path=/";
        return json({ user: { userId: "u", accountId: "acct_A" }, scope: "full" }, 200, { "X-Ohmail-Account": "acct_A" });
      }) as unknown as typeof globalThis.fetch;
    });
    afterEach(() => {
      release();
      vi.doUnmock("../app/sign-out");
      document.cookie = "tf_csrf=; Path=/; Max-Age=0";
    });

    it.each([
      ["a revoke", refusedClearing("refresh_revoked"), "acct_A"],
      ["a reuse sweep", reuseSwept("reuse", true), "acct_A"],
      ["a revoke with no name in the jar", refusedClearing("refresh_revoked"), null],
    ] as const)("%s heard by the page's own check: the copy is gone before anyone signs in", async (_, answer, owner) => {
      if (owner === null) document.cookie = "tf_owner=; Path=/; Max-Age=0";
      const el = await loginAfter(answer);
      expect(await until(() => !engine.holdsMirrorOf("acct_A")), "the sign-in form stood over the revoked copy").toBe(true);
      expect(el.querySelector("#login-pw"), "the form went").not.toBeNull();
    });

    it.each(["refresh_expired", "refresh_missing"])("CONTROL — %s: the next sign-in leaves with the copy kept", async (code) => {
      await signIn(await loginAfter(refusedClearing(code)));
      await until(() => wire.length > 0);
      expect(wire).toEqual(["login, copy kept"]);
    });

    it("a sign-in pressed during the wipe leaves once the copy is gone, and the new session keeps its own", async () => {
      const el = await loginOverHeldWipe();
      await signIn(el);
      await tick(10_000);
      expect(wire, "the sign-in left beside the wipe").toEqual([]);
      release();
      await secondFactor(el);
      await holdCopyOf("acct_A");
      await wipeOver();
      expect(wire).toEqual(["login, copy gone", "verify"]);
      expect([document.cookie.includes("tf_owner=acct_A"), engine.holdsMirrorOf("acct_A")]).toEqual([true, true]);
    });

    it.each([
      ["this tab's second factor", true],
      ["another tab's sign-in", false],
    ] as const)("a wipe still loading past its 15 s keeps what %s minted: tf_owner and the copy", async (_, here) => {
      const el = await loginOverHeldWipe();
      if (here) await signIn(el);
      await tick(16_000);
      if (here) await secondFactor(el);
      else {
        document.cookie = "tf_csrf=other-tab; Path=/";
        document.cookie = "tf_owner=acct_A; Path=/";
      }
      await holdCopyOf("acct_A");
      await wipeOver();
      expect(wire).toEqual(here ? ["login, copy kept", "verify"] : []);
      expect([document.cookie.includes("tf_owner=acct_A"), engine.holdsMirrorOf("acct_A")], "the late wipe took the new session's")
        .toEqual([true, true]);
    });
  });
});

/**
 * EVERY PAGE THAT RENEWS A SESSION HEARS A REVOKE, and acts only once the revoked account's copy is gone. A wipe a
 * page could not finish stays owed in this browser, and the next page finishes it; a session minted while a wipe
 * still runs keeps what is its own. Fresh modules each case, as a page load.
 */
describe("(h) a revoke heard on any page: the copy goes before the page acts, and a closed page's wipe is finished", () => {
  type SignOut = typeof import("../app/sign-out");
  const REQUEST = "0b0e6bd6-3c3e-4f39-9a65-1d6a1f7c2a10";
  const PASSWORD = fixturePassword("resume-answers");
  let engine: typeof import("@ohmail/client-engine");
  let wire: string[] = [];
  let holdSession = false;
  let releaseSession = (): void => {};
  /** Session reads, then sign-ins, answered `db_busy` before the server answers them. */
  let busySessions = 0;
  let busyLogins = 0;
  let signInAs = "acct_A";
  let needsSetup = false;
  let loading = false;
  let release = (): void => {};
  let forgets: Array<Promise<unknown>> = [];

  async function holdCopyOf(owner: string): Promise<void> {
    const store = new engine.IndexedDbMirrorStore({ owner });
    await store.load();
    await store.putLocal("message", "m1", { id: "m1", subject: `a letter of ${owner}` });
    store.close();
  }
  /** Real turns until `done`, at most 10 s: the wipe is real I/O. */
  async function until(done: () => boolean): Promise<boolean> {
    const end = performance.now() + 10_000;
    while (!done() && performance.now() < end) await act(async () => { await new Promise((r) => setImmediate(r)); });
    return done();
  }
  /** Whatever the held wipe's sweep removes, removed. */
  async function sweepsOver(): Promise<void> {
    await act(async () => { await vi.dynamicImportSettled(); });
    await flush();
    await act(async () => { await Promise.allSettled(forgets); });
  }
  async function mountPage(node: React.ReactElement): Promise<HTMLElement> {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: node }));
    });
    await flush();
    return host;
  }
  async function submit(el: HTMLElement, form: string, fields: Array<[string, string]>): Promise<void> {
    await act(async () => {
      for (const [id, value] of fields) {
        const input = el.querySelector<HTMLInputElement>(id)!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await act(async () => { el.querySelector(form)!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  }
  const signIn = (el: HTMLElement): Promise<void> =>
    submit(el, "form", [["#login-email", "m@example.test"], ["#login-pw", PASSWORD]]);
  async function secondFactor(el: HTMLElement): Promise<void> {
    expect(await until(() => el.querySelector("#login-code") !== null), "no code step").toBe(true);
    await submit(el, "form.login-totp", [["#login-code", "123456"]]);
    expect(await until(() => wire.includes("verify")), "the code never left").toBe(true);
  }
  /** A form once it is on screen, filled and sent. */
  async function sent(el: HTMLElement, first: string, fields: Array<[string, string]>): Promise<void> {
    expect(await until(() => el.querySelector(first) !== null), "no form").toBe(true);
    await submit(el, "form", fields);
  }
  const account = (f: string): Array<[string, string]> => [[`#${f}-email`, "m@example.test"], [`#${f}-name`, "M"], [`#${f}-pw`, PASSWORD]];
  const register = (el: HTMLElement): Promise<void> => sent(el, "#join-email", account("join"));
  /** /join/invite opened from its link, its form filled and sent. */
  async function invite(): Promise<void> {
    Object.assign(window.location, { hash: "#tok", pathname: "/join/invite", search: "" });
    await sent(await page(async () => (await import("../app/(product)/join/invite/InviteScreen.js")).InviteScreen, {})(),
      "#invite-email", account("invite"));
  }
  /** The wipe a revoke starts waits at its module load until `release`; each sweep it then starts is kept. */
  function holdWipe(): void {
    const gate = new Promise<void>((r) => { release = r; });
    vi.doMock("../app/sign-out", async (importOriginal: () => Promise<SignOut>) => {
      loading = true;
      await gate;
      const real = await importOriginal();
      const forgetThisBrowser: SignOut["forgetThisBrowser"] = (...a) => {
        const p = real.forgetThisBrowser(...a);
        forgets.push(p);
        return p;
      };
      return { ...real, forgetThisBrowser };
    });
  }
  /** /login hears the revoke and is closed while its wipe loads; the next page is a fresh document on the same disk. */
  async function closedMidWipe(): Promise<void> {
    vi.doMock("../app/sign-out", async () => { loading = true; await new Promise(() => {}); return {}; });
    await mountLogin();
    expect(await until(() => loading), "no wipe started").toBe(true);
    await unmount();
    vi.doUnmock("../app/sign-out");
    vi.resetModules();
    loading = false;
    wire = [];
    script = [refusedClearing("refresh_missing")];
  }
  const owed = (): string[] => Object.keys(localStorage).filter((k) => k.startsWith(REVOKE_OWED_PREFIX)).sort();
  const linkUp = (el: HTMLElement): boolean => el.querySelector("a.btn") !== null;
  const page = (load: () => Promise<React.ComponentType<never>>, props: object) => async (): Promise<HTMLElement> =>
    mountPage(h(await load(), props as never));

  beforeEach(async () => {
    vi.resetModules();
    const { createRequire } = await import("node:module");
    const { resolve } = await import("node:path");
    const fake = createRequire(resolve("packages/client-engine/package.json"))("fake-indexeddb") as { IDBFactory: new () => IDBFactory; IDBKeyRange: unknown };
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new fake.IDBFactory();
    (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = fake.IDBKeyRange;
    engine = await import("@ohmail/client-engine");
    await holdCopyOf("acct_A");
    wire = [];
    holdSession = false;
    busySessions = 0;
    busyLogins = 0;
    signInAs = "acct_A";
    needsSetup = false;
    loading = false;
    release = () => {};
    forgets = [];
    script = [refusedClearing("refresh_revoked")];
    router.replace.mockReset();
    router.push.mockReset();
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const copy = engine.holdsMirrorOf("acct_A") ? "kept" : "gone";
      if (url.includes("/auth/refresh") && !new Headers(init?.headers).has("x-ohmail-clear")) wire.push("refresh");
      if (url.includes("/api/auth/session") && busySessions > 0) {
        busySessions -= 1;
        wire.push("session:503");
        return db503();
      }
      if (url.includes("/api/auth/login") && busyLogins > 0) {
        busyLogins -= 1;
        wire.push(`login:503, copy ${copy}`);
        return db503();
      }
      if (url.includes("/api/auth/session")) {
        wire.push("session");
        if (!holdSession) return base(input as RequestInfo, init);
        holdSession = false;
        return new Promise<Response>((answer, refuse) => {
          const stopped = (): void => { wire.push("session:aborted"); refuse(new DOMException("Aborted", "AbortError")); };
          init?.signal?.addEventListener("abort", stopped, { once: true });
          releaseSession = () => { init?.signal?.removeEventListener("abort", stopped); void base(input as RequestInfo, init).then(answer); };
        });
      }
      if (url.includes("/api/auth/login")) {
        wire.push(`login, copy ${copy}`);
        return json({ status: "twofa_required", loginToken: "t", methods: ["totp"] }, 200);
      }
      if (url.includes("/api/auth/2fa/totp/verify")) {
        wire.push("verify");
        document.cookie = `tf_csrf=minted-${signInAs}; Path=/`;
        document.cookie = `tf_owner=${signInAs}; Path=/`;
        return json({ user: { userId: "u", accountId: signInAs }, scope: "full" }, 200, { "X-Ohmail-Account": signInAs });
      }
      if (url.includes("/api/auth/register")) {
        wire.push(`register, copy ${copy}`);
        return json({ status: "ok" }, 202);
      }
      if (url.includes("/api/auth/verify-email")) {
        wire.push(`verify-email, copy ${copy}`);
        return json({ status: "verified" }, 200);
      }
      if (url.includes("/api/pair/redeem")) {
        wire.push(`redeem, copy ${copy}`);
        return json({ invite: { code: "OHMAIL-TEST", email: "m@example.test" } }, 200);
      }
      if (url.includes("/hello")) return json({ product: "ohmail", needsSetup, features: { pairing: false } }, 200);
      return base(input as RequestInfo, init);
    }) as unknown as typeof globalThis.fetch;
  });
  // A wipe a failed case still holds stays parked: let go now, it would load into the next case's modules.
  afterEach(() => {
    vi.doUnmock("../app/sign-out");
    document.cookie = "tf_csrf=; Path=/; Max-Age=0";
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  const PAGES: Array<[string, () => Promise<HTMLElement>, (el: HTMLElement) => boolean, ((el: HTMLElement) => Promise<void>)?]> = [
    ["/join", page(async () => (await import("../app/(product)/join/JoinScreen.js")).JoinScreen,
      { initialCode: "", publicSignup: true, signedIn: true }), () => wire.some((w) => w.startsWith("register")), register],
    ["/approve", page(async () => (await import("../app/(product)/approve/ApproveScreen.js")).ApproveScreen, { request: REQUEST }),
      () => router.replace.mock.calls.length > 0],
    ["/link-desktop", page(async () => (await import("../app/(product)/link-desktop/LinkDesktopScreen.js")).LinkDesktopScreen, {}), linkUp],
    ["/authorize-desktop", page(async () => (await import("../app/(product)/authorize-desktop/AuthorizeDesktopScreen.js"))
      .AuthorizeDesktopScreen, { request: REQUEST }), linkUp],
    ["/setup", page(async () => (await import("../app/(product)/setup/SetupScreen.js")).SetupScreen, {}), linkUp],
    ["/subscribed", page(async () => (await import("../app/(product)/subscribed/SubscribedScreen.js")).SubscribedScreen, {}), linkUp],
  ];

  it.each(PAGES)("%s: its first action waits until the revoked copy is gone", async (_, mount, acted, press) => {
    holdWipe();
    const el = await mount();
    expect(await until(() => loading), "the page heard no revoke").toBe(true);
    await press?.(el);
    await tick(5_000);
    expect(acted(el), "the page acted beside the wipe").toBe(false);
    release();
    expect(await until(() => acted(el)), "the page never acted").toBe(true);
    expect(engine.holdsMirrorOf("acct_A"), "the page acted over the revoked copy").toBe(false);
  });

  it.each(PAGES)("CONTROL — %s over a lapse acts with the copy kept", async (_, mount, acted, press) => {
    script = [refusedClearing("refresh_expired")];
    const el = await mount();
    await press?.(el);
    expect(await until(() => acted(el)), "the page never acted").toBe(true);
    expect(engine.holdsMirrorOf("acct_A"), "a lapse took the copy").toBe(true);
  });

  it("/login: a sign-in pressed before the check's 401 hears it, and leaves once the copy is gone", async () => {
    holdSession = true;
    const el = await mountLogin();
    expect(await until(() => wire.includes("session")), "no session check").toBe(true);
    await signIn(el);
    await tick(1_000);
    expect(wire, "the sign-in did not wait for the check's answer").toEqual(["session"]);
    releaseSession();
    expect(await until(() => wire.some((w) => w.startsWith("login"))), "the sign-in never left").toBe(true);
    expect(wire).toEqual(["session", "refresh", "login, copy gone"]);
  });

  it("/join, no name in the jar: a registration pressed before the check's 401 leaves once the copy is gone", async () => {
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    holdSession = true;
    const el = await page(async () => (await import("../app/(product)/join/JoinScreen.js")).JoinScreen,
      { initialCode: "", publicSignup: true })();
    expect(await until(() => wire.includes("session")), "no session check").toBe(true);
    await register(el);
    await tick(1_000);
    expect(wire, "the registration did not wait for the check's answer").toEqual(["session"]);
    releaseSession();
    expect(await until(() => wire.some((w) => w.startsWith("register"))), "the registration never left").toBe(true);
    expect(wire).toEqual(["session", "refresh", "register, copy gone"]);
  });

  /** /login once its first check was answered `db_busy` with Retry-After 5 s: the ladder waits to ask again. */
  async function loginAfterBusyCheck(): Promise<HTMLElement> {
    const el = await mountLogin();
    expect(await until(() => wire.includes("session:503")), "no session check").toBe(true);
    return el;
  }

  it("/login: a sign-in pressed while the check waits out a busy answer asks once more, and leaves once the copy is gone", async () => {
    busySessions = 1;
    const el = await loginAfterBusyCheck();
    await tick(1_000);
    signInAs = "acct_B";
    await signIn(el);
    await secondFactor(el);
    expect(wire).toEqual(["session:503", "session", "refresh", "login, copy gone", "verify"]);
    expect([engine.holdsMirrorOf("acct_A"), document.cookie.includes("tf_owner=acct_B"), owed()]).toEqual([false, true, []]);
  });

  it("CONTROL — /login: a sign-in after the check's answer asks nothing more", async () => {
    busySessions = 1;
    const el = await loginAfterBusyCheck();
    await tick(6_000);
    expect(await until(() => wire.includes("refresh")), "the ladder never asked again").toBe(true);
    await signIn(el);
    expect(await until(() => wire.some((w) => w.startsWith("login"))), "the sign-in never left").toBe(true);
    expect(wire).toEqual(["session:503", "session", "refresh", "login, copy gone"]);
  });

  it("/login: after a ladder that ran out on a busy server, a sign-in asks once more first", async () => {
    busySessions = 4;
    const el = await loginAfterBusyCheck();
    await tick(25_000);
    expect(wire, "the ladder did not run out").toEqual(Array(4).fill("session:503"));
    await signIn(el);
    expect(await until(() => wire.some((w) => w.startsWith("login"))), "the sign-in never left").toBe(true);
    expect(wire.slice(4)).toEqual(["session", "refresh", "login, copy gone"]);
  });

  it("/login: a sign-in refused busy has asked first, and the next press asks nothing more", async () => {
    busySessions = 1;
    busyLogins = 1;
    const el = await loginAfterBusyCheck();
    await signIn(el);
    expect(await until(() => wire.some((w) => w.startsWith("login:503"))), "the first sign-in never left").toBe(true);
    await signIn(el);
    expect(await until(() => wire.some((w) => w.startsWith("login,"))), "the second sign-in never left").toBe(true);
    expect(wire).toEqual(["session:503", "session", "refresh", "login:503, copy gone", "login, copy gone"]);
  });

  it("/login: the sign-in's own check, never answered, holds it no longer than the bound and is stopped before it leaves", async () => {
    busySessions = 1;
    const el = await loginAfterBusyCheck();
    holdSession = true;
    await signIn(el);
    const { SETTLE_DEADLINE_MS } = await import("../app/session-refresh.js");
    await tick(SETTLE_DEADLINE_MS - 1_000);
    expect(wire, "the sign-in left beside its own check").toEqual(["session:503", "session"]);
    await tick(2_000);
    expect(await until(() => wire.some((w) => w.startsWith("login"))), "the sign-in never left").toBe(true);
    expect(wire).toEqual(["session:503", "session", "session:aborted", "login, copy kept"]);
  });

  it("/join, no name in the jar: a registration after a busy read asks once more, and leaves once the copy is gone", async () => {
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    busySessions = 1;
    const el = await page(async () => (await import("../app/(product)/join/JoinScreen.js")).JoinScreen,
      { initialCode: "", publicSignup: true })();
    expect(await until(() => wire.includes("session:503")), "no session check").toBe(true);
    await tick(2_000);
    await register(el);
    expect(await until(() => wire.some((w) => w.startsWith("register"))), "the registration never left").toBe(true);
    expect(wire).toEqual(["session:503", "session", "refresh", "register, copy gone"]);
  });

  // Nobody: Safari keeps the script-written name seven days, the session cookie longer.
  it.each([["naming an account", "acct_A"], ["naming nobody", null]] as const)(
    "/verify-email, the jar %s: the session is asked first, and the confirmation leaves once the copy is gone", async (_, name) => {
      if (name === null) document.cookie = "tf_owner=; Path=/; Max-Age=0";
      const el = await page(async () => (await import("../app/(product)/verify-email/VerifyEmailScreen.js")).VerifyEmailScreen,
        { initialToken: "tok" })();
      await submit(el, "form", [["#verify-pw", PASSWORD]]);
      expect(await until(() => wire.some((w) => w.startsWith("verify-email"))), "the confirmation never left").toBe(true);
      expect(wire).toEqual(["session", "refresh", "verify-email, copy gone"]);
    });

  // The token is spent first: the check's refusal holds the session ended, and only the account's own request still leaves.
  it.each([["naming an account", "acct_A"], ["naming nobody", null]] as const)(
    "/join/invite, the jar %s: the account is made once the session is asked and the revoked copy is gone", async (_, name) => {
      if (name === null) document.cookie = "tf_owner=; Path=/; Max-Age=0";
      await invite();
      expect(await until(() => wire.some((w) => w.startsWith("register"))), "the account was never made").toBe(true);
      expect(wire).toEqual(["redeem, copy kept", "session", "refresh", "register, copy gone"]);
    });

  it("/join/invite: a session check never answered holds the account no longer than the bound, and is stopped", async () => {
    holdSession = true;
    await invite();
    expect(await until(() => wire.includes("session")), "no session check").toBe(true);
    const { SETTLE_DEADLINE_MS } = await import("../app/session-refresh.js");
    await tick(SETTLE_DEADLINE_MS - 1_000);
    expect(wire, "the account was made beside its check").toEqual(["redeem, copy kept", "session"]);
    await tick(2_000);
    expect(await until(() => wire.some((w) => w.startsWith("register"))), "the account was never made").toBe(true);
    expect(wire).toEqual(["redeem, copy kept", "session", "session:aborted", "register, copy kept"]);
  });

  it.each([
    ["/login", async () => signIn(await mountLogin()), "login"],
    ["/verify-email", async () => submit(await page(async () => (await import("../app/(product)/verify-email/VerifyEmailScreen.js"))
      .VerifyEmailScreen, { initialToken: "tok" })(), "form", [["#verify-pw", PASSWORD]]), "verify-email"],
    ["/join/invite", invite, "redeem"],
    ["/setup on a new server", async () => {
      needsSetup = true;
      await sent(await page(async () => (await import("../app/(product)/setup/SetupScreen.js")).SetupScreen, {})(),
        "#setup-token", [["#setup-token", "tok"], ...account("setup")]);
    }, "redeem"],
  ] as const)("a page closed mid-wipe leaves it owed; the next page, %s, finishes it before its first action", async (_, press, ask) => {
    await closedMidWipe();
    expect(owed(), "the closed page left no record of its wipe").toEqual([`${REVOKE_OWED_PREFIX}acct_A`]);
    await press();
    expect(await until(() => wire.some((w) => w.startsWith(`${ask},`))), "the page never acted").toBe(true);
    expect(wire.filter((w) => w.startsWith(`${ask},`))).toEqual([`${ask}, copy gone`]);
    expect(await until(() => owed().length === 0), "the finished wipe stayed owed").toBe(true);
  });

  it("CONTROL — A signing in again drops A's record, and the resumed wipe takes nothing of A's new session", async () => {
    await closedMidWipe();
    holdWipe();
    const el = await mountLogin();
    expect(await until(() => loading), "the owed wipe was not resumed").toBe(true);
    await signIn(el);
    await tick(16_000);
    await secondFactor(el);
    expect(owed(), "A's session is back and A still owes a wipe").toEqual([]);
    release();
    await sweepsOver();
    expect([engine.holdsMirrorOf("acct_A"), document.cookie.includes("tf_owner=acct_A"), localStorage.getItem(SESSION_MINTED_KEY) !== null],
      "the resumed wipe took the new session's").toEqual([true, true, true]);
  });

  it("CONTROL — a record that names nobody, over two accounts' copies, is dropped and takes neither", async () => {
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    await closedMidWipe();
    expect(owed(), "the closed page left no record of its wipe").toEqual([REVOKE_OWED_PREFIX]);
    await holdCopyOf("acct_B");
    await signIn(await mountLogin());
    expect(await until(() => wire.some((w) => w.startsWith("login,"))), "the sign-in never left").toBe(true);
    expect(await until(() => owed().length === 0), "the record stayed").toBe(true);
    expect([engine.holdsMirrorOf("acct_A"), engine.holdsMirrorOf("acct_B")], "a copy went on a guess").toEqual([true, true]);
  });

  it("a product page that asks nothing (the layout's import) finishes an owed wipe, and asks the server nothing", async () => {
    await closedMidWipe();
    const asked = refreshes;
    await import("../app/(product)/providers.js");
    expect(await until(() => !engine.holdsMirrorOf("acct_A")), "the owed wipe was left").toBe(true);
    expect(await until(() => owed().length === 0), "the finished wipe stayed owed").toBe(true);
    expect([refreshes - asked, wire], "the server was asked").toEqual([0, []]);
  });

  it.each(["acct_A", "acct_B"])("a sign-in as %s that mints while the wipe still sweeps keeps its stamp and its copy", async (who) => {
    holdWipe();
    // A push service that never answers: the wipe's wake revoke waits out its own budget, past the 15 s.
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register: () => new Promise(() => {}) } });
    try {
      const el = await mountLogin();
      expect(await until(() => loading), "no wipe started").toBe(true);
      await signIn(el);
      await tick(12_000);
      release();
      expect(await until(() => forgets.length === 1), "the sweep never started").toBe(true);
      await tick(3_500);
      signInAs = who;
      await secondFactor(el);
      await holdCopyOf(who);
      await tick(1_000);
      await sweepsOver();
      expect([localStorage.getItem(SESSION_MINTED_KEY) !== null, engine.holdsMirrorOf(who), document.cookie.includes(`tf_owner=${who}`)],
        "the late sweep took the new session's").toEqual([true, true, true]);
      expect(engine.holdsMirrorOf("acct_A"), "the revoked account's copy").toBe(who === "acct_A");
    } finally {
      Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "serviceWorker");
    }
  });

  /**
   * A's reply text, face and push id, left by the product's own writers while the jar names A: the reply buffer,
   * the face mirror through the product door's provider, the push row through its announce.
   */
  async function leaveItemsOfA(): Promise<void> {
    (await import("../app/shell/mail-send.js")).writeReplyDraft("m-of-a", { text: "words of A", html: "" });
    const { Providers } = await import("../app/(product)/providers.js");
    const { useTheme } = await import("@ohmail/ui");
    const Adopt = (): null => {
      const { adoptAccountFace } = useTheme();
      React.useEffect(() => { adoptAccountFace("ohmarchy"); }, [adoptAccountFace]);
      return null;
    };
    const faceRoot = createRoot(document.createElement("div"));
    await act(async () => { faceRoot.render(h(Providers, { children: h(Adopt) })); });
    await act(async () => { faceRoot.unmount(); });
    const sub = {
      endpoint: "https://push.example/ep/a", unsubscribe: async () => true,
      getKey: (n: string) => new Uint8Array(n === "auth" ? 16 : 65).fill(7).buffer,
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: async () => ({ pushManager: { getSubscription: async () => null, subscribe: async () => sub } }) },
    });
    try {
      const { syncWebPush } = await import("../app/shell/notification-settings.js");
      expect(await syncWebPush(true, {
        vapidKey: async () => ({ publicKey: "B".repeat(87) }), subscribe: async () => ({ id: "row-of-a" }), unsubscribe: async () => {},
      })).toBe("subscribed");
    } finally {
      Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "serviceWorker");
    }
    expect(itemsOfA(), "the control: A's three are in the jar").toEqual({ reply: true, face: true, push: true });
  }
  const itemsOfA = (): Record<"reply" | "face" | "push", boolean> => ({
    reply: Object.keys(localStorage).some((k) => (localStorage.getItem(k) ?? "").includes("words of A")),
    face: localStorage.getItem("ohmail.face.account") !== null,
    push: localStorage.getItem("ohmail.notifications.subscriptionId") !== null,
  });
  /** B's reply, typed once B's sign-in holds the jar, as read back by B. */
  const replyOfB = async (write: boolean): Promise<string> => {
    const send = await import("../app/shell/mail-send.js");
    if (write) send.writeReplyDraft("m-of-b", { text: "words of B", html: "" });
    return send.readReplyDraft("m-of-b").text;
  };

  it("a wipe held past its 15 s, then a sign-in as another account: the revoked copy goes, the new session keeps its own", async () => {
    holdWipe();
    await leaveItemsOfA();
    const el = await mountLogin();
    expect(await until(() => loading), "no wipe started").toBe(true);
    signInAs = "acct_B";
    await signIn(el);
    await tick(16_000);
    await secondFactor(el);
    await holdCopyOf("acct_B");
    await replyOfB(true);
    release();
    expect(await until(() => forgets.length === 1), "the wipe took nothing").toBe(true);
    await sweepsOver();
    expect(engine.holdsMirrorOf("acct_A"), "the revoked account's copy stayed").toBe(false);
    expect(itemsOfA(), "the revoked account's reply text, face or push id stayed").toEqual({ reply: false, face: false, push: false });
    expect([engine.holdsMirrorOf("acct_B"), document.cookie.includes("tf_owner=acct_B"), localStorage.getItem(SESSION_MINTED_KEY) !== null,
      await replyOfB(false)], "the wipe took the new session's").toEqual([true, true, true, "words of B"]);
  });

  it("CONTROL — the same over a lapse wipes nothing: A's copy, reply text, face and push id stay beside B's reply", async () => {
    script = [refusedClearing("refresh_expired")];
    await leaveItemsOfA();
    const el = await mountLogin();
    signInAs = "acct_B";
    await signIn(el);
    await secondFactor(el);
    await replyOfB(true);
    await tick(16_000);
    await sweepsOver();
    expect([engine.holdsMirrorOf("acct_A"), itemsOfA(), await replyOfB(false)], "a lapse took something")
      .toEqual([true, { reply: true, face: true, push: true }, "words of B"]);
  });
});
