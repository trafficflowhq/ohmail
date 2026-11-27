import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { ACTS, type ActId } from "../vocabulary/acts.js";
import { say, wordsWithDot, type Language } from "../vocabulary/catalogue.js";
import type { ControlId } from "../vocabulary/controls.js";
import { control } from "../vocabulary/index.js";
import { PLACES, type AriaRole, type Place, type PlaceId } from "../vocabulary/places.js";
import { LOOPBACK, type Found, type NativeActId, type Person, type Size, type Spoken } from "./seam.js";

/**
 * THE SEAM OVER A PLAYWRIGHT PAGE. Every window that has one is driven here: the web bench's Chromium, the
 * stack's, and the phone's web view reached over its debugging socket. A control is found by its role and its
 * whole name, inside what the vocabulary says it is inside.
 */

/** The window at each size class: the frame's own lines fall between them (`guards.test.ts` holds them). */
export const VIEWPORTS: Readonly<Record<Size, { width: number; height: number }>> = {
  expanded: { width: 1440, height: 900 },
  medium: { width: 719, height: 900 },
  compact: { width: 390, height: 844 },
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * An address as a message may print it: the path, and the hash only when it is one of the app's own routes
 * (`#/…`). Any other hash can be a credential handed over in the address (an invite's token, a pairing
 * code), and a failing journey's message goes into a public log.
 */
export function shown(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.hash.startsWith("#/") ? u.hash : u.hash === "" ? "" : "#…"}`;
}

export class PlaywrightPerson implements Person {
  private readonly errors: { message: string; path?: string }[] = [];
  private readonly outside: string[] = [];
  private readonly asked: string[] = [];
  private readonly tabs: PlaywrightPerson[] = [];
  /** The language the app speaks to this person; English until they choose another (`speak`). */
  lang: Language;
  constructor(readonly page: Page, readonly context: BrowserContext, private readonly origin: string, private readonly base: string, lang: Language) {
    this.lang = lang;
    page.on("pageerror", (e) => { this.errors.push({ message: `page error: ${String(e)}` }); });
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const url = URL.parse(m.location().url);
      this.errors.push({
        message: `console: ${m.text()}`,
        path: url?.protocol === "http:" || url?.protocol === "https:" ? url.pathname : undefined,
      });
    });
    page.on("response", (response) => {
      const status = response.status();
      if (status < 400) return;
      this.errors.push({
        message: `http response with a status of ${status}: ${response.request().method()}`,
        path: new URL(response.url()).pathname,
      });
    });
  }

  /** Choose the app's language as a person does: Settings, General, the language's own button. */
  async speak(lang: Language): Promise<void> {
    if (lang === this.lang) return;
    await this.arrive("settings-general");
    await this.act("press", `language-${lang}`);
    this.lang = lang;
    await this.here("settings-general");
  }

  async goOffline(): Promise<void> {
    await this.page.waitForLoadState("networkidle");
    await this.context.setOffline(true);
    // The bench's request fence normally continues local requests.
    await this.page.route("**/*", (route) => route.abort("internetdisconnected"));
  }

  async goOnline(): Promise<void> {
    await this.page.unroute("**/*");
    await this.context.setOffline(false);
  }

  async closeTab(): Promise<void> {
    const closed = this.page.waitForEvent("close");
    await this.page.close({ runBeforeUnload: true });
    await closed;
  }

  async restartForNewBuild(): Promise<void> {
    const version = (url: URL) => url.origin === this.origin && url.pathname === "/version";
    await this.page.route(version, (route) => route.fulfill({ json: { build: "next-fixture-build" } }), { times: 1 });
    await this.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await Promise.all([this.page.waitForEvent("domcontentloaded"), this.act("press", "reload-update")]);
  }

  async goOfflineWhileOpeningSettings(): Promise<void> {
    const previous = this.page.url();
    let held = false;
    let disconnect!: () => void;
    const cut = new Promise<void>((resolve) => { disconnect = resolve; });
    let offline = false;
    await this.page.route("**/*", async (route) => {
      const isChunk = route.request().resourceType() === "script" &&
        new URL(route.request().url()).pathname.startsWith("/_next/static/chunks/");
      if (!offline && !isChunk) return route.fallback();
      held = true;
      await cut;
      await route.abort("internetdisconnected");
    });
    try {
      await this.page.goto(`${this.origin}${this.base}${PLACES.settings.route}`, { waitUntil: "commit" });
      await this.until(async () => held, "a Settings script request to be held", 5_000);
      await this.page.getByRole("status").filter({ hasText: say("viewError.loading", {}, this.lang) })
        .first().waitFor({ state: "visible", timeout: 5_000 });
      await this.context.setOffline(true);
      offline = true;
      await this.page.goto(previous, { waitUntil: "commit" });
    } finally {
      disconnect();
    }
  }

  /** A second tab of the same browser: the same cookies and storage, its own page. */
  async tab(): Promise<PlaywrightPerson> {
    const other = new PlaywrightPerson(await this.context.newPage(), this.context, this.origin, this.base, this.lang);
    this.tabs.push(other);
    return other;
  }

  /** Called by the fence for every request of this person's browser. */
  note(url: string, allowed: boolean): void {
    this.asked.push(url);
    if (!allowed) this.outside.push(`request left the machine: ${url}`);
  }

  /** Every address this browser asked for, the refused ones included. */
  requests(): string[] { return [...this.asked]; }

  /** What breaks the bench's promises: page errors, console errors, requests that tried to leave. */
  problems(tolerated: RegExp[] = []): string[] {
    return [
      ...this.errors
        .filter(({ message }) => !tolerated.some((t) => t.test(message)))
        .map(({ message, path }) => path ? `${message} (${path})` : message),
      ...this.outside,
      ...this.tabs.flatMap((t) => t.problems(tolerated)),
    ];
  }

  private name(id: ControlId, found: Found): string | RegExp | null {
    const c = control(id);
    const from = c.nameFrom ?? "key";
    if (from === "none") return null;
    const text = from === "visible" ? found.named : say(c.key!, found.args ?? {}, this.lang);
    if (text === undefined) throw new Error(`the control ${id} is named by the world: say which one`);
    if (c.searchResult) {
      if (!found.sender) throw new Error("a search result needs its sender and subject");
      return new RegExp(`(?:^|\\s)${escapeRe(found.sender)}\\s+.*?${escapeRe(text)}(?=\\s|$)`);
    }
    if (c.nameSuffix) return `${text} ${say(c.nameSuffix, {}, this.lang)}`;
    return c.counted ? new RegExp(`^${escapeRe(text)}(?: [0-9][0-9.,'’]*\\+?)?$`) : text;
  }

  /** The control, by role and whole name, inside what the vocabulary says it is inside. */
  private find(id: ControlId, found: Found = {}): Locator {
    const c = control(id);
    const scope = c.within === undefined ? this.page
      : c.within in PLACES ? this.page.getByRole("main") : this.find(c.within);
    const name = this.name(id, found);
    if (c.byLabel && name !== null) return scope.getByLabel(name, { exact: true });
    const all = name === null ? scope.getByRole(c.role) : scope.getByRole(c.role, { name, exact: true });
    return c.outer || c.either ? all.first() : all;
  }

  /** Wait until the control is on screen. What was found stays here: a journey gets nothing back to reach past the seam with. */
  async see(id: ControlId, found: Found = {}, ms = 20_000): Promise<void> {
    await this.located(id, found, ms);
  }

  /** The control once it is on screen, for this driver's own acts and reads. */
  private async located(id: ControlId, found: Found = {}, ms = 20_000): Promise<Locator> {
    const target = this.find(id, found);
    await target.waitFor({ state: "visible", timeout: ms }).catch((e) => {
      throw new Error(`never saw ${id}${found.named ? ` (${found.named})` : ""} on ${shown(this.page.url())}: ${String(e).split("\n")[0]}`);
    });
    return target;
  }

  /** Wait until the control is not on screen. */
  async gone(id: ControlId, found: Found = {}, ms = 20_000): Promise<void> {
    await this.find(id, found).waitFor({ state: "hidden", timeout: ms }).catch(() => {
      throw new Error(`${id}${found.named ? ` (${found.named})` : ""} stayed on screen`);
    });
  }

  /** Is the control on screen now? No waiting: for "it is not offered here". */
  async offered(id: ControlId, found: Found = {}): Promise<boolean> {
    return (await this.find(id, found).count()) > 0 && this.find(id, found).isVisible();
  }

  async act(act: ActId, id: ControlId, found: Found & { value?: string } = {}): Promise<void> {
    await ACTS[act].web(await this.located(id, found), this.page, found.value);
  }

  async spoken(id: ControlId, found: Found = {}): Promise<Spoken> {
    const target = await this.located(id, found);
    const attr = (n: string): Promise<string | null> => target.getAttribute(n);
    return {
      description: (await attr("aria-description")) ?? "", pressed: await attr("aria-pressed"),
      selected: await attr("aria-selected"), current: await attr("aria-current"),
      expanded: await attr("aria-expanded"), checked: await attr("aria-checked"), disabled: await target.isDisabled(),
      editable: await target.isEditable().catch(() => false),
    };
  }

  /** The words a box holds now. */
  async holds(id: ControlId, found: Found = {}): Promise<string> {
    return (await this.located(id, found)).inputValue();
  }

  /** The words inside the control, as a person reads them. */
  async text(id: ControlId, found: Found = {}): Promise<string> {
    return (await (await this.located(id, found)).innerText()).trim();
  }

  /** The names of the controls of `role` inside `id`, as a screen reader lists them. */
  async listed(id: ControlId, role: AriaRole): Promise<string[]> {
    return (await this.rows(id, role)).map((r) => r.name);
  }

  /** The controls of `role` inside `id`, each with its name and what it says of itself. */
  async rows(id: ControlId, role: AriaRole): Promise<Array<{ name: string; description: string }>> {
    const all = await (await this.located(id)).getByRole(role).all();
    const rows: Array<{ name: string; description: string }> = [];
    for (const one of all) {
      rows.push({
        name: ((await one.getAttribute("aria-label")) ?? (await one.innerText())).trim(),
        description: (await one.getAttribute("aria-description")) ?? "",
      });
    }
    return rows;
  }

  /** Go to a place and wait for the thing that says you are there. */
  async arrive(place: PlaceId): Promise<void> {
    const p = PLACES[place];
    const url = p.route.startsWith("#") ? `${this.origin}${this.base}${p.route}` : `${this.origin}${p.route}`;
    await this.page.goto(url, { waitUntil: "commit" });
    await this.here(place);
  }

  /** The install's front door, as a person who types its name reaches it. */
  async front(): Promise<void> {
    await this.page.goto(`${this.origin}/`, { waitUntil: "commit" });
  }

  async reload(): Promise<void> {
    await this.page.reload();
  }

  async hearsLanguage(lang: Language): Promise<void> {
    await this.until(async () => await this.page.evaluate(() => document.documentElement.lang) === lang, `the window to declare ${lang}`);
    this.lang = lang;
  }

  async inTag(): Promise<void> {
    await this.until(async () => /^#\/tag\/[^/]+$/.test(new URL(this.page.url()).hash), "a tag's own route");
  }

  async refuseNotificationPrompt(): Promise<void> {
    await this.page.addInitScript(() => {
      if (typeof Notification !== "undefined") {
        Notification.requestPermission = async () => { throw new Error("Demo Settings asked for notification permission"); };
      }
    });
  }

  /** A link handed to this person, opened as they open it. */
  async follow(link: string): Promise<{ status: number | null }> {
    // The browser's own error names the address whole; a link's hash can be its credential (an invite's token).
    const answer = await this.page.goto(link, { waitUntil: "commit" }).catch((e: unknown) => {
      throw new Error(`following ${shown(link)} failed: ${String(e).split("\n")[0]!.replace(/#\S*/g, "#…")}`);
    });
    return { status: answer?.status() ?? null };
  }

  /** Wait for a place's landmark without going anywhere. */
  async here(place: PlaceId, ms = 60_000): Promise<void> {
    const { landmark }: Place = PLACES[place];
    if (place === "gate") {
      const heading = this.page.getByRole("heading", { level: 1 })
        .filter({ has: this.find("login-email") })
        .filter({ has: this.find("login-password") });
      await heading.waitFor({ state: "visible", timeout: ms }).catch(() => {
        throw new Error("the sign-in heading never held both credential fields");
      });
      await this.see("login-continue", {}, ms);
      return;
    }
    const name = say(landmark.key, landmark.args?.(this.lang), this.lang);
    if (place.startsWith("settings-")) {
      const entry = this.find(`menu-${place}`);
      await entry.waitFor({ state: "visible", timeout: ms }).catch(() => { throw new Error(`the Settings menu never listed ${name}`); });
      await this.until(async () => (await entry.getAttribute("aria-current")) === "page", `${name} to be the current section`);
      return;
    }
    const mark = landmark.role === "heading"
      ? this.page.getByRole("heading", { name, exact: true, level: 1 })
      : this.page.getByRole(landmark.role, { name, exact: true });
    await mark.waitFor({ state: "visible", timeout: ms }).catch(() => { throw new Error(`never arrived at ${place}: no ${landmark.role} named ${JSON.stringify(name)}`); });
  }

  /** Wait for the catalogue sentence, or the title and sentence drawn together. */
  async reads(key: string | readonly string[], args: Record<string, string | number> = {}, ms = 20_000): Promise<void> {
    const keys = typeof key === "string" ? [key] : key;
    const sentence = keys.map((part) => say(part, args, this.lang)).join(" ");
    await this.readSentence(String(key), sentence, ms);
  }

  async readsWithDot(key: string, ms = 20_000): Promise<void> {
    await this.readSentence(key, wordsWithDot(key, this.lang), ms);
  }

  private async readSentence(key: string, sentence: string, ms: number): Promise<void> {
    await this.page.getByText(sentence, { exact: true }).first().waitFor({ state: "visible", timeout: ms }).catch(() => {
      throw new Error(`the page never said ${key}: ${JSON.stringify(sentence)}`);
    });
  }

  /** Wait for a sight. Never for time: `sight` is asked until it holds. */
  async until(sight: () => Promise<boolean>, what: string, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await sight().catch(() => false)) return;
      if (Date.now() > deadline) throw new Error(`waited for ${what}, and it never came`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async kept(marks: RegExp): Promise<Record<string, string[]>> {
    const all = await this.page.evaluate(() =>
      Object.fromEntries(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k) ?? ""])));
    const global = new RegExp(marks.source, marks.flags.includes("g") ? marks.flags : `${marks.flags}g`);
    return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, [...new Set(v.match(global) ?? [])].sort()]));
  }

  async holdMirrorWrites(): Promise<void> {
    await this.page.evaluate(async () => {
      const name = (await indexedDB.databases()).find((db) => db.name?.startsWith("ohmail-mirror:"))?.name;
      if (!name) throw new Error("The browser mirror is missing");
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const transaction = db.transaction(["meta", "entities"], "readwrite");
          transaction.onabort = () => db.close();
          transaction.oncomplete = () => db.close();
          const store = transaction.objectStore("meta");
          const keepOpen = (): void => {
            const read = store.get("wait-for-the-tab-to-close");
            read.onsuccess = () => {
              resolve();
              keepOpen();
            };
            read.onerror = () => reject(read.error);
          };
          keepOpen();
        };
      });
    });
  }

  async storedWriting(words: string, draftSubject?: string): Promise<string[]> {
    const other = await this.context.newPage();
    try {
      await other.goto(`${this.origin}/api/hello`, { waitUntil: "commit" });
      return await other.evaluate(async ({ needle, subject }) => {
        const copies = await Promise.all((await indexedDB.databases())
          .filter(({ name }) => name?.startsWith("ohmail-mirror:"))
          .map(({ name }) => new Promise<string[]>((resolve, reject) => {
            const open = indexedDB.open(name!);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const db = open.result;
              const read = db.transaction("entities").objectStore("entities").getAll();
              read.onerror = () => { db.close(); reject(read.error); };
              read.onsuccess = () => {
                const labels = read.result.flatMap(({ type, entity }) => {
                  if (subject !== undefined && type === "draft" && entity?.subject === subject && entity.status === "sent") {
                    return ["sent-draft"];
                  }
                  if (entity == null || !JSON.stringify(entity).includes(needle)) return [];
                  if (type === "draft" && entity.status === "draft") return ["draft"];
                  if (type === "outbox_entry" || type === "outbox_abandoned") {
                    return [`${type}:${entity.mutation?.kind ?? ""}:${entity.lastError?.code ?? ""}`];
                  }
                  return [];
                });
                db.close();
                resolve(labels);
              };
            };
          })));
        const beforeOutbox = Object.keys(localStorage)
          .filter((key) => key.startsWith("ohmail.send.locks."))
          .flatMap((key) => JSON.parse(localStorage.getItem(key) ?? "[]"))
          .some((row) => row?.beforeOutbox?.mutation?.body?.includes(needle));
        return [...copies.flat(), ...(beforeOutbox ? ["pressed-send"] : [])].sort();
      }, { needle: words, subject: draftSubject });
    } finally {
      await other.close();
    }
  }

  async keep(key: string, value: string): Promise<void> {
    /* Another tab of this browser, on the install's name and on no page of the app (the API's answer to a hello), so
       nothing of the app runs there: it writes the entry and closes, as the tab that left it did. */
    const other = await this.context.newPage();
    try {
      await other.goto(`${this.origin}/api/hello`, { waitUntil: "commit" });
      await other.evaluate(([k, v]) => localStorage.setItem(k!, v!), [key, value]);
    } finally {
      await other.close();
    }
  }

  async shows(words: string): Promise<boolean> {
    return (await this.page.evaluate(() => document.body.innerText)).includes(words);
  }

  /** Set by the bench that opened this window with its clock driven (`person({ clock: "driven" })`). */
  driven = false;
  async later(ms: number): Promise<void> {
    if (!this.driven) throw new Error("this window's clock is not driven: open the person with { clock: \"driven\" }");
    await this.page.clock.runFor(ms);
  }

  /** The jar this window shares, signed in as an account with the bench's sign-in cookies (`web.ts`). */
  async jarNames(cookies: Parameters<BrowserContext["addCookies"]>[0]): Promise<void> {
    await this.context.addCookies(cookies);
  }

  /** A browser page has no native doors. */
  async native(act: NativeActId): Promise<void> {
    throw new Error(`this bench has no native doors: ${act} is a phone's or a desktop window's`);
  }
}

/**
 * A browser context that cannot leave the machine, and the page that tells on itself. `allow` names the
 * hosts beyond loopback a bench resolves to loopback itself (the stack's foreign name); nothing else passes.
 */
export async function fenced(browser: Browser, o: { origin: string; base: string; lang: Language; allow?: string[]; size?: Size }): Promise<PlaywrightPerson> {
  const context = await browser.newContext({ viewport: VIEWPORTS[o.size ?? "expanded"], locale: "en-US" });
  const page = await context.newPage();
  const person = new PlaywrightPerson(page, context, o.origin, o.base, o.lang);
  await context.route("**/*", (route) => {
    const url = route.request().url();
    const host = url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:") ? "localhost" : new URL(url).hostname;
    const allowed = LOOPBACK.has(host) || (o.allow ?? []).includes(host);
    person.note(url, allowed);
    return allowed ? route.continue() : route.abort();
  });
  return person;
}
