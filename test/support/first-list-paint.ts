import type { Frame, Page } from "@playwright/test";
import type { PlaywrightPerson } from "../journeys/bench/dom-playwright.js";
import { expect } from "vitest";
import { mirrorDbName } from "@ohmail/client-engine";
import type { SyncSnapshotPage } from "@ohmail/wire";
import type { Account, Bench, Person } from "../journeys/bench/seam.js";
import { say } from "../journeys/vocabulary/catalogue.js";
import { PLACES } from "../journeys/vocabulary/places.js";
import { PEOPLE } from "../journeys/vocabulary/world.js";

type ListPaint = { rows: boolean; waiting: boolean };
type ObservedWindow = Window & { firstListPaint?: ListPaint; mirrorAnswerHeld?: boolean; letMirrorOpen?: () => void };

async function watchListPaint(page: Page, listName: string, actionName: string, subject: string) {
  const option = `[role="option"][aria-label*=${JSON.stringify(subject)}]`;
  const actions = `button[aria-label=${JSON.stringify(actionName)}]`;
  await page.addInitScript(({ option, actions, listName }) => {
    // Hold the database notification while the shell paints so a premature list has a frame to show itself.
    const w = window as ObservedWindow;
    const held = new Promise<void>((resolve) => { w.letMirrorOpen = resolve; });
    const open = IDBFactory.prototype.open;
    const success = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "onsuccess")!;
    IDBFactory.prototype.open = function (name, version) {
      const request = open.call(this, name, version);
      if (name.startsWith("ohmail-mirror:")) {
        Object.defineProperty(request, "onsuccess", {
          set(listener: EventListener) {
            success.set!.call(request, (event: Event) => {
              w.mirrorAnswerHeld = true;
              void held.then(() => listener.call(request, event));
            });
          },
        });
      }
      return request;
    };

    const visible = (element: Element | null) =>
      !!element?.getClientRects().length && getComputedStyle(element).visibility === "visible";
    function frame() {
      const list = document.querySelector(`[aria-label="${listName}"]`);
      const rows = visible(list?.querySelector(option) ?? null);
      const waiting = visible(list?.querySelector('[aria-busy="true"]') ?? null);
      if (rows || waiting || visible(list?.querySelector(actions) ?? null)) w.firstListPaint = { rows, waiting };
      else requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }, { option, actions, listName });
}

/** Watch the first list frame on the cached reload while Chromium's local read is held. */
export async function firstCachedOhboxPaint(person: Person, subject: string): Promise<ListPaint | undefined> {
  const { page } = person as PlaywrightPerson;
  const listName = say("frame.landmark.list", {}, person.lang);
  const actionName = say("ohbox.list.menu", {}, person.lang);
  await watchListPaint(page, listName, actionName, subject);
  await page.reload({ waitUntil: "commit" });
  // The list itself may wait for storage. Release on the database answer, after giving any
  // premature list two frames to reveal itself.
  await page.waitForFunction(() => (window as ObservedWindow).mirrorAnswerHeld === true);
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    (window as ObservedWindow).letMirrorOpen!();
  });
  await page.getByRole("option", { name: subject }).waitFor();
  await page.waitForFunction(() => (window as ObservedWindow).firstListPaint !== undefined);
  return page.evaluate(() => (window as ObservedWindow).firstListPaint);
}


async function seedFace(person: Person, owner: string) {
  const { page } = person as PlaywrightPerson;
  await page.evaluate((account) => {
    localStorage.setItem("ohmail.face.account", "ohmarchy");
    localStorage.setItem("ohmail.face.account.owner", account);
    localStorage.setItem("ohmail.face", "paper");
  }, owner);
  return page;
}

async function recordPrivatePaint(page: Page, subject: string) {
  await page.addInitScript((subject) => {
    const paints: { face: boolean; rows: boolean }[] = [];
    Object.assign(window, { privatePaints: paints });
    function sample() {
      if (document.body) {
        paints.push({
          face: document.documentElement.dataset.face === "ohmarchy",
          rows: [...document.querySelectorAll('[role="option"]')].some((row) =>
            row.getAttribute("aria-label")?.includes(subject) && row.getClientRects().length > 0),
        });
      }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  }, subject);
}

async function privatePaints(page: Page) {
  return page.evaluate(async () => {
    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    const frames = (window as Window & { privatePaints: { face: boolean; rows: boolean }[] }).privatePaints;
    return { frames: frames.length, face: frames.some((f) => f.face), rows: frames.some((f) => f.rows) };
  });
}

/** Read just the fixture marker from an already existing browser mirror. */
async function mirrorHolds(page: Page, name: string, marker: string): Promise<boolean> {
  return page.evaluate(async ({ name, marker }) => {
    if (!(await indexedDB.databases()).some((db) => db.name === name)) return false;
    const request = indexedDB.open(name);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => request.transaction!.abort();
    });
    try {
      const read = db.transaction("entities").objectStore("entities").getAll();
      const records = await new Promise<unknown[]>((resolve, reject) => {
        read.onsuccess = () => resolve(read.result);
        read.onerror = () => reject(read.error);
      });
      return JSON.stringify(records).includes(marker);
    } finally {
      db.close();
    }
  }, { name, marker });
}

export async function sharedBrowserPaint(bench: Bench, person: Person, account: Account, subject: string) {
  const owner = account.accountId;
  const page = await seedFace(person, owner);
  // The account face contrasts with the device's paper even while the browser session answer is held.
  await page.evaluate(() => localStorage.removeItem("ohmail.face"));
  await expect.poll(() => mirrorHolds(page, mirrorDbName(owner), subject)).toBe(true);
  const other = await bench.account();
  const [incoming] = await other.planter.plant({ conversations: [{
    from: PEOPLE.giulia,
    subject: "A replacement account's invitation",
    pile: "ohbox",
  }] });
  const hasSessionFamily = (familyId: string) => page.evaluate(
    (id) => document.cookie.split("; ").includes(`tf_family=${id}`),
    familyId,
  );
  await expect.poll(() => hasSessionFamily(account.familyId), { timeout: 10_000 }).toBe(true);
  await bench.signedInElsewhere(person, other);
  expect(await hasSessionFamily(other.familyId), "sign-in replaces the previous session family").toBe(true);
  await page.evaluate((account) => { document.cookie = `tf_owner=${account}; Path=/; Secure; SameSite=Strict`; }, owner);
  await recordPrivatePaint(page, subject);
  await page.setExtraHTTPHeaders({ "x-ohmail-first-page-owner": owner });
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  let asked = false;
  await page.route(/\/api\/auth\/session(?:\?|$)/, async (route) => {
    asked = true;
    await held;
    await route.continue();
  });
  try {
    await page.reload({ waitUntil: "commit" });
    await expect.poll(() => asked).toBe(true);
    // Cross the old warm-open timeout as well as the first frame.
    await page.evaluate(() => new Promise<void>((done) => setTimeout(done, 1_650)));
    const pending = await privatePaints(page);
    expect(pending.frames).toBeGreaterThan(0);
    expect.soft(pending.face).toBe(false);
    expect.soft(pending.rows).toBe(false);
    release();
    await page.getByRole("link", { name: say("session.signIn", {}, person.lang) }).waitFor({ timeout: 20_000 });
    const settled = await privatePaints(page);
    expect(settled).toMatchObject({ face: false, rows: false });
  } finally {
    release();
  }
  await page.unroute(/\/api\/auth\/session(?:\?|$)/);
  await page.setExtraHTTPHeaders({});
  // Make the device's fallback distinct from the departing account's saved face.
  await page.evaluate(() => localStorage.setItem("ohmail.face", "paper"));
  await bench.signedInElsewhere(person, other);
  await person.front();
  await person.here("ohbox");
  await person.see("conversation", { named: `${incoming!.from}: ${incoming!.subject}` });
  await expect.poll(() => mirrorHolds(page, mirrorDbName(other.accountId), incoming!.subject)).toBe(true);
  expect(await privatePaints(page)).toMatchObject({ face: false, rows: false });
  expect(await mirrorHolds(page, mirrorDbName(other.accountId), subject)).toBe(false);
  expect(await mirrorHolds(page, mirrorDbName(owner), incoming!.subject)).toBe(false);
}

/** Hold cookie clearing in the pressing tab, after revocation and the local storage sweep. */
export async function holdSignOutCookieClear(person: Person) {
  const { page } = person as PlaywrightPerson;
  let asked = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/auth\/refresh\/logout$/, async (route) => {
    if (route.request().headers()["x-ohmail-clear-logout"] !== "1") return route.fallback();
    asked = true;
    await held;
    await route.fallback();
  });
  return { asked: () => asked, release };
}

/** The pressing tab reaches the front door after sign-out, on either web deployment. */
export async function signOutReachedFront(person: Person): Promise<void> {
  const { page } = person as PlaywrightPerson;
  await page.waitForURL((url) => url.hash === "" && (url.pathname === "/" || url.pathname === PLACES.gate.route),
    { waitUntil: "domcontentloaded", timeout: 60_000 });
}

export async function signInPaintWhileLeaving(bench: Bench, person: Person, owner: string) {
  const page = await seedFace(person, owner);
  await page.evaluate(() => localStorage.removeItem("ohmail.face"));
  bench.faults.push((method, route) => method === "POST" && route === "/auth/refresh/logout" ? "hold" : null);
  await person.act("press", "sign-out");
  await expect.poll(() => bench.held().includes("POST /auth/refresh/logout")).toBe(true);
  const next = await person.tab() as PlaywrightPerson;
  await recordPrivatePaint(next.page, "");
  await next.front();
  await next.here("gate");
  expect(await next.page.evaluate(() => localStorage.getItem("ohmail.face.account") === "ohmarchy")).toBe(true);
  const observed = await privatePaints(next.page);
  expect(observed.frames).toBeGreaterThan(0);
  expect(observed).toMatchObject({ face: false, rows: false });
}

export async function resetOhboxPaint(person: Person, survivor: string, deleted: { subject: string; messageIds: string[] }) {
  const { page } = person as PlaywrightPerson;
  const row = page.getByRole("option", { name: survivor });
  const removed = page.getByRole("option", { name: deleted.subject });
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  let replacing = false;
  let reloaded = false;
  let expired = false;
  let observing = false;
  const listName = say("frame.landmark.list", {}, person.lang);
  await page.route(/\/api\/sync\?/, async (route) => {
    if (!reloaded || expired) return route.continue();
    expired = true;
    await row.waitFor();
    await removed.waitFor();
    await page.evaluate(({ listName, survivor }) => {
      const trace = { missed: false, frames: 0 };
      Object.assign(window, { resetPaint: trace });
      function frame() {
        const list = document.querySelector(`[aria-label="${listName}"]`);
        trace.frames += 1;
        trace.missed ||= ![...list?.querySelectorAll('[role="option"]') ?? []].some((node) =>
          node.getAttribute("aria-label")?.includes(survivor) && node.getClientRects().length > 0);
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }, { listName, survivor });
    observing = true;
    await route.fulfill({ status: 410, json: { error: { code: "cursor_expired" } } });
  });
  await page.route(/\/api\/sync\/snapshot(?:\?|$)/, async (route) => {
    if (!observing) return route.continue();
    const response = await route.fetch();
    const snapshot = await response.json() as SyncSnapshotPage;
    replacing = true;
    await held;
    await route.fulfill({ response, json: {
      ...snapshot, changes: snapshot.changes.filter((change) => !deleted.messageIds.includes(change.id)),
    } });
  });
  // The outgoing document may still poll. Its cursor and paint trace are irrelevant to this reset.
  const onNavigate = (frame: Frame) => {
    if (frame === page.mainFrame()) reloaded = true;
  };
  page.on("framenavigated", onNavigate);
  try {
    await page.reload({ waitUntil: "commit" });
    await expect.poll(() => replacing, { timeout: 20_000 }).toBe(true);
    const paint = () => page.evaluate(async () => {
      await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      return (window as Window & { resetPaint: { missed: boolean; frames: number } }).resetPaint;
    });
    const heldPaint = await paint();
    expect(heldPaint.frames).toBeGreaterThan(0);
    expect.soft(heldPaint.missed).toBe(false);
    release();
    await row.waitFor();
    await removed.waitFor({ state: "hidden" });
    expect(await row.isVisible()).toBe(true);
    expect((await paint()).missed).toBe(false);
  } finally {
    page.off("framenavigated", onNavigate);
    release();
  }
}
