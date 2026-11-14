/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/react";
import { createElement } from "react";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import type { MailboxDTO } from "../app/api-client";
import { appointmentStamp } from "@ohmail/client-engine";
import {
  act, installConfirmEnv, ISO, mountCloudShell, refresh204, rememberOwner, scriptRefresh,
  scriptSession, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

/**
 * SETTINGS → MAILBOXES SAYS WHO FILES THE MAILBOX. On the web the organizer is the server the page
 * talks to — ohmail Cloud, or a self-hosted server — and the pane said "This computer files this
 * mailbox" and "This computer stops filing…", which reads as closing the laptop stopping the
 * filing. The role says THIS install files; the build says which install that is.
 *
 * Watched red at the base: every Cloud and server case read the computer sentence. The mutation
 * that reds them again is pointing the pane's filer back at "computer".
 */

const copy: Record<string, string> = en.mailboxes;
const copyDe: Record<string, string> = de.mailboxes;

/** Each build's service selection, handed through the real web entry. */
const build = vi.hoisted(() => ({ selfHost: false }));
vi.mock("../app/hello", async () => ({
  ...await vi.importActual<typeof import("../app/hello")>("../app/hello"),
  get SELF_HOST_BUILD() { return build.selfHost; },
}));

let releaseOutcome: "requested" | "not_organizing" = "requested";
let mounted = false;

/** A mailbox this install organizes, consented, nothing pending. */
const organizing = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "imap", address: "person@example.test",
  displayName: null, status: "connected",
  lastSyncAt: "2026-09-07T09:20:00.000Z", createdAt: "2026-08-01T10:00:00.000Z",
  organizerRole: "organizer",
  organizedBy: null,
  organizerState: null,
  organizeConsentedAt: "2026-08-01T10:05:00.000Z",
  initialImportCompletedAt: "2026-08-01T10:05:00.000Z",
  organizerReleasedAt: null,
  releaseRequestedAt: null,
  ...over,
} as MailboxDTO);

beforeAll(warmCloudShell);
beforeEach(() => { releaseOutcome = "requested"; build.selfHost = false; });
afterEach(unmount);

async function unmount(): Promise<void> {
  if (!mounted) return;
  await teardownConfirmEnv();
  (await import("../app/api-client")).bindApiOwner(null);
  mounted = false;
}

async function mount(locale: "en" | "de", ...items: MailboxDTO[]): Promise<HTMLElement> {
  await unmount();
  installConfirmEnv();
  mounted = true;
  (await import("../app/api-client")).bindApiOwner(null);
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  rememberOwner();
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/account/access") return Response.json({ metered: false });
    if (path === "/api/mailboxes" && method === "GET") return Response.json({ items });
    if (path === `/api/mailboxes/${items[0]?.id}/release` && method === "POST") {
      return Response.json({ outcome: releaseOutcome }, { status: releaseOutcome === "requested" ? 202 : 200 });
    }
    return fetch(input, init);
  };

  const words = locale === "de" ? de : en;
  window.location.hash = "#/settings/mailboxes";
  const frame = await mountCloudShell(locale === "de"
    ? (shell) => createElement(NextIntlClientProvider, { locale, messages: de, timeZone: "UTC", children: shell })
    : undefined);
  await tick(3000);
  const pane = within(frame).getByRole("region", { name: words.settings.mailboxes });
  const row = within(pane).getByRole("button", { name: (name) => name.includes(items[0]!.address), expanded: false });
  await press(row);
  return pane;
}

const buttonExactly = (el: HTMLElement, name: string): HTMLElement | null =>
  within(el).queryByRole("button", { name });

async function press(button: HTMLElement | null, what = "expand the mailbox"): Promise<void> {
  expect(button, `no "${what}" control on the row`).not.toBeNull();
  await act(async () => button!.click());
  await tick(100);
}

const orgText = (el: HTMLElement): string => el.textContent ?? "";

describe.each([
  { name: "ohmail Cloud (the managed build)", selfHost: false, arm: "Cloud" },
  { name: "a self-hosted server", selfHost: true, arm: "Server" },
])("on the web, $name files the mailbox — never this computer", ({ selfHost, arm }) => {
  beforeEach(() => { build.selfHost = selfHost; });

  it("the organizing row names it", async () => {
    const el = await mount("en", organizing());
    expect(orgText(el), "the row says the browser files the mailbox").not.toMatch(/this computer/i);
    expect(orgText(el)).toContain(copy[`stateOrganizing${arm}`]!);
  });

  it("the stop's explanation names it", async () => {
    const el = await mount("en", organizing());
    await press(buttonExactly(el, copy.stopOrganizingHandBack!), copy.stopOrganizingHandBack!);
    expect(orgText(el), "the stop says this computer stops filing").not.toMatch(/this computer/i);
    expect(orgText(el)).toContain(copy[`stopOrganizingWhat${arm}`]!);
  });

  it("the stop's answer names it, requested or not organizing", async () => {
    let el = await mount("en", organizing());
    await press(buttonExactly(el, copy.stopOrganizingHandBack!), copy.stopOrganizingHandBack!);
    await press(buttonExactly(el, copy.stopOrganizingConfirm!), copy.stopOrganizingConfirm!);
    expect(el.textContent ?? "").toContain(copy[`stopOrganizingQueued${arm}`]!);
    expect(el.textContent ?? "").not.toContain(copy.stopOrganizingQueued!);

    releaseOutcome = "not_organizing";
    el = await mount("en", organizing());
    await press(buttonExactly(el, copy.stopOrganizingHandBack!), copy.stopOrganizingHandBack!);
    await press(buttonExactly(el, copy.stopOrganizingConfirm!), copy.stopOrganizingConfirm!);
    expect(el.textContent ?? "").toContain(copy[`stopOrganizingNot${arm}`]!);
    expect(el.textContent ?? "").not.toContain(copy.stopOrganizingNot!);
  });

  it("a stop refused by a live copy names it", async () => {
    const el = await mount("en", organizing({
      releaseRequestedAt: "2026-09-07T09:00:00.000Z", releaseRefusal: "sibling_lapse",
    } as Partial<MailboxDTO>));
    expect(orgText(el)).toContain(copy[`stopOrganizingSiblingLapse${arm}`]!);
    expect(orgText(el), "another copy of this computer, on the web").not.toMatch(/this computer/i);
  });

  it("…in German too, with no raw key on screen", async () => {
    const el = await mount("de", organizing());
    expect(orgText(el)).toContain(copyDe[`stateOrganizing${arm}`]!);
    expect(orgText(el)).not.toContain(copyDe.stateOrganizingHere!);
    expect(orgText(el)).not.toContain(`stateOrganizing${arm}`);
  });
});

/**
 * A MAILBOX THE SERVICE IS NOT CHECKING DOES NOT READ AS HEALTHY. For 26 hours every row said
 * "Connected · Synced" with the time of the day before. The row now leads its state with "Not
 * checked · since …" and carries one note naming who is not checking; a mailbox with its own
 * trouble keeps its own word and its own press.
 *
 * Watched red at the base (every case read "Synced …" and no note). Mutations that red them again:
 * the row's condition no longer asking for a connected, unblocked mailbox (the two own-trouble
 * cases: a second explanation under the row); the note's filer pointed at "cloud" (the
 * self-hosted cases).
 */
describe.each([
  { name: "ohmail Cloud (the managed build)", selfHost: false, arm: "Cloud" },
  { name: "a self-hosted server", selfHost: true, arm: "Server" },
])("a mailbox whose new mail is not being fetched, on $name", ({ selfHost, arm }) => {
  const said = {
    en: createTranslator({ locale: "en", messages: en as never, namespace: "mailboxes" as never }) as unknown as
      (key: string, values?: Record<string, string | number>) => string,
    de: createTranslator({ locale: "de", messages: de as never, namespace: "mailboxes" as never }) as unknown as
      (key: string, values?: Record<string, string | number>) => string,
  };
  const SINCE = new Date(Date.parse(ISO) - 50 * 60_000).toISOString();
  /** The time as the pane says it, through the pane's own formatter and register. */
  const stamp = (locale: "en" | "de" = "en"): string => appointmentStamp(new Date(SINCE), new Date(), "UTC", locale);
  const late = (over: Partial<MailboxDTO> = {}): MailboxDTO =>
    organizing({ lastSyncAt: SINCE, fetching: { behind: true, since: SINCE }, ...over } as Partial<MailboxDTO>);
  /** "Synced " — the healthy line's own words, whatever time follows them. */
  const synced = (locale: "en" | "de"): string => said[locale]("syncedAgo", { when: "" }).trim();

  beforeEach(() => { build.selfHost = selfHost; });

  it("the row leads with not checked and since when, and no longer says synced", async () => {
    const el = await mount("en", late());
    const text = el.textContent ?? "";
    expect(text).toContain(said.en("notChecked", { hasSince: "yes", since: stamp() }));
    expect(text, "the row still reads as healthy").not.toContain(synced("en"));
  });

  it("its note is the notice's sentence for that mailbox, naming who is not checking", async () => {
    const el = await mount("en", late());
    const text = el.textContent ?? "";
    expect(text).toContain(said.en(`notCheckedNote${arm}`, { hasSince: "yes", since: stamp() }));
    if (selfHost) expect(text, "a self-hosted server was called Cloud").not.toMatch(/Cloud/);
    else expect(text).not.toContain(said.en("notCheckedNoteServer", { hasSince: "yes", since: stamp() }));
  });

  it("with no time on record both say so without one", async () => {
    const el = await mount("en", late({ fetching: { behind: true, since: null } } as Partial<MailboxDTO>));
    const text = el.textContent ?? "";
    expect(text).toContain(said.en("notChecked", { hasSince: "no", since: "" }));
    expect(text).toContain(said.en(`notCheckedNote${arm}`, { hasSince: "no", since: "" }));
    expect(text).not.toContain(synced("en"));
  });

  it("it is calm and has no press of its own: the row's controls are the ones it had", async () => {
    const calm = await mount("en", organizing());
    const controls = (pane: HTMLElement): string[] => {
      const row = within(pane).getByRole("button", { expanded: true });
      // The same expander now includes the updated mailbox status in its name.
      return within(pane).getAllByRole("button").map((button) =>
        button === row ? "expanded mailbox" : (button.textContent ?? "").trim());
    };
    const before = controls(calm);
    const el = await mount("en", late());
    expect(controls(el)).toEqual(before);
    expect(within(el).queryByRole("alert")).toBeNull();
  });

  it("a mailbox with its own trouble keeps its own word and its own press, and gets no second explanation", async () => {
    const el = await mount("en", late({ status: "error", errorCode: "auth" } as Partial<MailboxDTO>));
    const text = el.textContent ?? "";
    expect(text).toContain(copy.err_auth!);
    expect(text).not.toContain(said.en("notChecked", { hasSince: "yes", since: stamp() }));
    expect(text).not.toContain(said.en(`notCheckedNote${arm}`, { hasSince: "yes", since: stamp() }));
    expect(buttonExactly(el, copy.syncNow!), "the row lost its press").not.toBeNull();
  });

  it("a mailbox we are declining to sync keeps that sentence", async () => {
    const el = await mount("en", late({
      syncBlockedReason: "at_capacity", syncBlockedSince: SINCE,
    } as Partial<MailboxDTO>));
    const text = el.textContent ?? "";
    expect(text).toContain((en.sync as unknown as Record<string, string>).blocked_at_capacity!);
    expect(text).not.toContain(said.en("notChecked", { hasSince: "yes", since: stamp() }));
    expect(text).not.toContain(said.en(`notCheckedNote${arm}`, { hasSince: "yes", since: stamp() }));
  });

  it.each([
    ["null: this server does not say", null],
    ["absent: an older server", undefined],
    ["not behind", { behind: false, since: SINCE }],
  ] as Array<[string, MailboxDTO["fetching"] | undefined]>)("CONTROL: %s reads as it did", async (_what, fetching) => {
    const el = await mount("en", organizing({
      lastSyncAt: SINCE, ...(fetching === undefined ? {} : { fetching }),
    } as Partial<MailboxDTO>));
    const text = el.textContent ?? "";
    expect(text).toContain(synced("en"));
    expect(text).not.toContain(said.en("notChecked", { hasSince: "no", since: "" }));
  });

  it("…in German too", async () => {
    const el = await mount("de", late());
    const text = el.textContent ?? "";
    const when = stamp("de");
    expect(text).toContain(said.de("notChecked", { hasSince: "yes", since: when }));
    expect(text).toContain(said.de(`notCheckedNote${arm}`, { hasSince: "yes", since: when }));
    expect(text).not.toContain(synced("de"));
    if (selfHost) expect(text).not.toMatch(/Cloud/);
  });
});

describe("the sentence set is in both catalogues", () => {
  it("every key the filer table answers is a translated sentence", async () => {
    const { FILER_KEY_SET } = await import("@ohmail/app-logic/mail-state/mail-state");
    expect(FILER_KEY_SET.length, "the table is empty").toBeGreaterThanOrEqual(16);
    for (const key of FILER_KEY_SET) {
      expect(typeof copy[key], `${key} is missing from en.json`).toBe("string");
      expect(typeof copyDe[key], `${key} is missing from de.json`).toBe("string");
      expect(copyDe[key], `${key} is English in de.json`).not.toBe(copy[key]);
    }
  });
});
