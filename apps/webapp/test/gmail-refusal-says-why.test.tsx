/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import en from "../messages/en.json";
import { ApiError, type MailboxDTO } from "../app/api-client";
import { launchRefused } from "@trafficflow/services/mail";
import { drawPane } from "../../../packages/app/test/mailboxes/pane/support.js";
import { mountStage, type MountedStage } from "./_first-run-stage.js";

/**
 * GMAIL'S REFUSED SIGN-IN SAYS WHY, AND THE NOTE IS THERE BEFORE THE PRESS — on every web form.
 *
 * A Reddit user was stuck on "the mail server refused the password" with a Google password in the
 * field. The service now stamps `details.authHint` on Google's refusals (`launchRefused`, the real
 * refusal builder, makes each one here); the Settings pane (connect, Test, edit), /join and the
 * first-run form say Google's sentence for it, with the 2-Step Verification and App Passwords links
 * under the two password kinds. No hint, or a word outside the set, is the generic sentence. /join
 * has its own file (`gmail-refusal-join.test.tsx`): it runs on the real client over a fetch double.
 */

/*
 * RE-POINTED (the switch's older tests, sorted once; share first-run-and-account-1). Every form here is the one connect
 * form of the new shell (`packages/app/src/mailboxes/connect`) over the web's own wires, `webConnectWire` and
 * `webMailboxesWire`, over the same `api-client` mock: the refusal is still `launchRefused`'s, thrown by the API as the
 * client receives it.
 *  - The first run's form is the stage's mailbox step (the new frame's `firstRun` stage, an add run on the hosted door,
 *    as today's case mounted it with `add`).
 *  - Settings → Mailboxes' connect IS the stage's add run (ruled: the pane's Connect opens the first run's add run and
 *    calls nothing, held by `packages/app/test/mailboxes/pane/pane.test.tsx` "Connect a mailbox is a button named by
 *    mailboxes.connect that opens the add run and calls nothing"); its connect and Test cases are walked there. The
 *    rows and the edit are the Mailboxes pane itself (`MailboxesPane`, drawn by its own test door `drawPane`).
 *  - NO TILE IS PRESELECTED (the ruled design: `r2-mailboxes/REVIEW-two.md`, "no preselected tile"; `ProviderTiles`:
 *    nothing is pre-chosen but what the typed address chose): the first run's case types a Gmail address, which
 *    chooses Gmail's tile, before it reads what was pre-selected. The pane's walk presses Gmail's tile as it did.
 *  - The refusal and the Test's refused verdict are one line at the press (`RefusalLine`, an alert), Google's two links
 *    standing under it beside the form, no longer inside a verdict box: "the links under the verdict" are read as the
 *    page's links beyond the note's own pair (each of Google's two pages linked once more, or not at all).
 * Every expectation is as it stood.
 */

const M = en.mailboxes as unknown as Record<string, string>;
const P = en.providerPicker as unknown as Record<string, string>;
const O = en.onboarding as unknown as Record<string, string>;
const HINTS = ["app_password_required", "invalid", "web_login", "imap_disabled"] as const;
const LINKS = { prereq: "https://myaccount.google.com/signinoptions/twosv", help: "https://myaccount.google.com/apppasswords" };

/** The refusal the API sends for a hint, built by the service's own builder, as the client receives it. */
const refusalFor = (hint?: string): ApiError => {
  const r = launchRefused("auth", false, hint as never) as unknown as { httpStatus: number; code: string; message: string; details: unknown };
  return new ApiError(r.httpStatus, r.code, r.message, r.details);
};
const hrefs = (el: Element): string[] => [...el.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
/** How many times the page links a page of Google's. */
const linked = (el: Element, url: string): number => hrefs(el).filter((u) => u === url).length;
/** The refusals said at the press, line by line: a refusal is an alert. */
const alerts = (el: Element): string[] =>
  [...el.querySelectorAll('[role="alert"]')].map((n) => (n.textContent ?? "").trim()).filter(Boolean);

let mockThrows: unknown = null;
let mockListed: MailboxDTO[] = [];
vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    assertPasskey: async () => ({}),
    webauthnAvailable: () => false,
    auth: { session: async () => ({ user: { email: "person@example.test", emailVerified: true }, scope: "full" }) },
    mailboxes: {
      ...actual.mailboxes,
      list: async () => ({ items: mockListed }),
      resync: async () => undefined,
      probe: async () => { if (mockThrows) throw mockThrows; return { host: "imap.gmail.com", user: "u", folders: 3 }; },
      create: async () => { if (mockThrows) throw mockThrows; return mockListed[0]; },
      update: async () => { if (mockThrows) throw mockThrows; return mockListed[0]; },
    },
  };
});
vi.mock("../app/hello", () => ({ SELF_HOST_BUILD: false, serverHello: async () => null }));

beforeEach(() => { mockThrows = null; mockListed = []; });
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const settle = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }); };
async function typeInto(el: HTMLElement, label: string, value: string): Promise<void> {
  const input = within(el).getByLabelText(label) as HTMLInputElement;
  await act(async () => { fireEvent.change(input, { target: { value } }); });
  await settle();
}
/** A tile of the provider picker by its name, and whether it stands chosen. */
const tile = (el: HTMLElement, name: string): HTMLElement | undefined =>
  [...within(el).getByRole("group", { name: P.label! }).querySelectorAll<HTMLElement>("button")]
    .find((b) => (b.textContent ?? "").trim().startsWith(name));

/** The connect form of the hosted door's add run, over the web's own connect wire. */
async function addRun(): Promise<MountedStage> {
  const { webConnectWire } = await import("../app/(product)/mailbox/connect-wire");
  return mountStage({
    rows: [], at: "#/first-run/add", door: "cloud", verbs: { ai: "on" },
    account: { onboardingCompletedAt: "2026-03-01T11:30:00.000Z" },
    connect: webConnectWire({ owner: () => null, returned: "page" }),
  });
}

/* ── Settings → Mailboxes ─────────────────────────────────────────────────────────────── */

async function pane(...items: MailboxDTO[]): Promise<HTMLElement> {
  mockListed = items;
  const { webMailboxesWire } = await import("../app/(product)/mailbox/mailboxes-wire");
  const { webConnectWire } = await import("../app/(product)/mailbox/connect-wire");
  const view = drawPane(webMailboxesWire(), {
    connect: webConnectWire({ owner: () => null, returned: "page" }),
    opened: items[0]?.id ?? null,
  });
  await settle();
  return view.container;
}
/** Settings → Mailboxes' connect: the add run it opens, Gmail's tile pressed and the fields typed. */
async function gmailForm(): Promise<MountedStage> {
  const st = await addRun();
  await st.press("Gmail");
  await typeInto(st.el, O.address!, "someone@gmail.test");
  await typeInto(st.el, O.password!, "the-google-password");
  return st;
}
const dto = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "gmail", address: "someone@example.test", displayName: null, status: "connected",
  lastSyncAt: "2026-10-20T11:00:00.000Z", createdAt: "2026-10-20T10:00:00.000Z", ...over,
} as MailboxDTO);

describe("Settings → Mailboxes", () => {
  it("the Gmail note says App Password, its two links, before any press", async () => {
    const { el } = await gmailForm();
    expect(el.textContent).toContain(P.note_gmail);
    expect(hrefs(el)).toEqual(expect.arrayContaining([LINKS.prereq, LINKS.help]));
  });

  for (const hint of HINTS) {
    it(`connect and Test, ${hint}: Google's sentence`, async () => {
      mockThrows = refusalFor(hint);
      const st = await gmailForm();
      await st.press(O.connect!);
      const said = alerts(st.el);
      expect(said, hint).toEqual([M[`probe_auth_gmail_${hint}`]]);
      const linkedHint = hint === "app_password_required" || hint === "invalid";
      // The links under the refusal, besides the note's own pair.
      expect(linked(st.el, LINKS.help), hint).toBe(linkedHint ? 2 : 1);

      await st.press(O.test!);
      expect(alerts(st.el).join(" "), hint).toContain(M[`probe_auth_gmail_${hint}`]);
      // Google's two pages linked under the refused verdict, besides the note's own pair: both, or none.
      expect(linked(st.el, LINKS.prereq) + linked(st.el, LINKS.help) - 2, hint).toBe(linkedHint ? 2 : 0);
    });
  }

  it("control: no hint and an unknown hint are the generic sentence, with no links", async () => {
    for (const thrown of [refusalFor(), new ApiError(400, "mailbox_probe_failed", "x", { reason: "auth", transport: "imap", authHint: "toString" })]) {
      mockThrows = thrown;
      const st = await gmailForm();
      await st.press(O.test!);
      expect(alerts(st.el).join(" ")).toContain(M.probe_auth);
      // No link under the verdict: the note's own pair alone.
      expect([linked(st.el, LINKS.prereq), linked(st.el, LINKS.help)]).toEqual([1, 1]);
      cleanup();
      document.body.innerHTML = "";
    }
  });

  it("edit: a Gmail row asks for a new App Password, and a refused one says Google's sentence", async () => {
    mockThrows = refusalFor("invalid");
    const el = await pane(dto());
    fireEvent.click(within(el).getByRole("button", { name: M.edit }));
    await settle();
    expect(el.textContent).toContain(M.editIntro_gmail);
    await typeInto(el, M.passwordLabel!, "old-app-password");
    fireEvent.click(within(el).getByRole("button", { name: M.continue }));
    await settle();
    expect(el.textContent).toContain(M.probe_auth_gmail_invalid);
  });

  it("the row: a Gmail mailbox whose password stops working says a changed Google password ends it", async () => {
    const el = await pane(dto({ status: "error", errorCode: "auth" } as Partial<MailboxDTO>));
    expect(el.textContent).toContain(M.err_auth_gmail);
  });

  it("control: another provider's row and edit say what they said", async () => {
    const el = await pane(dto({ provider: "icloud", address: "someone@example.test", status: "error", errorCode: "auth" } as Partial<MailboxDTO>));
    expect(el.textContent).toContain(M.err_auth);
    expect(el.textContent).not.toContain(M.err_auth_gmail);
    fireEvent.click(within(el).getByRole("button", { name: M.edit }));
    await settle();
    expect(el.textContent).toContain(M.editIntro);
    expect(el.textContent).not.toContain(M.editIntro_gmail);
  });
});

/* ── The first-run form ───────────────────────────────────────────────────────────────── */

describe("the first-run mailbox form", () => {
  /** The stage's mailbox step on the hosted door, its probe the web's own over the API's answer. */
  async function firstRun(): Promise<MountedStage> {
    return addRun();
  }
  /** A Gmail address chooses Gmail's tile (no tile is preselected), and its password field stands. */
  const GMAIL = "do-not-reply@gmail.com";
  const fill = async (el: HTMLElement): Promise<void> => {
    await typeInto(el, O.address!, GMAIL);
    await typeInto(el, O.password!, "the-google-password");
  };

  it("Gmail is pre-selected, and its note and links are on screen before the press", async () => {
    const { el } = await firstRun();
    // No tile is preselected by the ruled design: the typed address chooses Gmail's.
    await typeInto(el, O.address!, GMAIL);
    expect(tile(el, "Gmail")?.getAttribute("aria-pressed")).toBe("true");
    expect(el.textContent).toContain(P.note_gmail);
    expect(hrefs(el)).toEqual(expect.arrayContaining([LINKS.prereq, LINKS.help]));
  });

  for (const hint of HINTS) {
    it(`Test, ${hint}: Google's sentence`, async () => {
      mockThrows = refusalFor(hint);
      const st = await firstRun();
      const { el } = st;
      await fill(el);
      await st.press("Test connection");
      expect(alerts(el).join(" ")).toContain(M[`probe_auth_gmail_${hint}`]);
      expect(linked(el, LINKS.prereq) + linked(el, LINKS.help) - 2, hint).toBe(hint === "app_password_required" || hint === "invalid" ? 2 : 0);
    });
  }

  it("control: no hint and an unknown hint are the generic sentence", async () => {
    for (const thrown of [refusalFor(), new ApiError(400, "mailbox_probe_failed", "x", { reason: "auth", transport: "imap", authHint: "constructor" })]) {
      mockThrows = thrown;
      const st = await firstRun();
      const { el } = st;
      await fill(el);
      await st.press("Test connection");
      expect(alerts(el).join(" ")).toContain(M.probe_auth);
      cleanup();
      document.body.innerHTML = "";
    }
  });
});
