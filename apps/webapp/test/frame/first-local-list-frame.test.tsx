/** @vitest-environment jsdom */
import { OhmailEngine, SCREENER_WAITING_TYPE } from "@ohmail/client-engine";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { en } from "../account/account-harness";
import { ACCOUNT, closeMailPage, ISO, prepareMailPage, tick } from "../fixtures/mounted-mail-page";

let CloudShell: typeof import("../../app/(product)/mailbox/CloudShell").CloudShell;
let Providers: typeof import("../../app/(product)/providers").Providers;

beforeAll(async () => {
  ({ CloudShell } = await import("../../app/(product)/mailbox/CloudShell"));
  ({ Providers } = await import("../../app/(product)/providers"));
  await (await import("@ohmail/app/mail")).prepareWriting();
}, 60_000);

afterEach(() => {
  closeMailPage();
  vi.restoreAllMocks();
});

it.each([
  ["ohbox", "Ohbox"],
  ["drafts", "Drafts"],
  ["history", "History"],
  ["reads", "News"],
  ["receipts", "Receipts"],
  ["screener", "Screener"],
  ["search", "Search"],
])("waits for the local copy before the first %s list frame", async (place, title) => {
  await prepareMailPage();
  history.replaceState(null, "", `#/${place}`);
  const hydrate = OhmailEngine.prototype.hydrate;
  let release!: () => void;
  const local = new Promise<void>((ready) => { release = ready; });
  const read = vi.spyOn(OhmailEngine.prototype, "hydrate").mockImplementation(async function (this: OhmailEngine) {
    await local;
    await hydrate.call(this);
  });
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC" now={new Date(ISO)}>
      <Providers owner={ACCOUNT} deferLinuxFace><CloudShell demo={false} drawMail="now" edgeOwner={ACCOUNT} /></Providers>
    </NextIntlClientProvider>,
  );
  const headings = () => screen.queryAllByRole("heading", { name: title, level: 1 });
  try {
    await tick(500);
    expect(read).toHaveBeenCalled();
    expect(headings()).toHaveLength(0);
  } finally {
    release();
  }
  await tick(500);
  expect(headings().length).toBeGreaterThan(0);
});

it("opens a server-confirmed mailbox in its saved face while consent is still pending", async () => {
  await prepareMailPage();
  const fetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).endsWith("/consent") ? new Promise<Response>(() => {}) : fetch(input, init));
  localStorage.setItem("ohmail.face.account", "ohmarchy");
  localStorage.setItem("ohmail.face.account.owner", ACCOUNT);
  const firstContent: (string | undefined)[] = [];
  const observer = new MutationObserver(() => {
    if (firstContent.length === 0 && screen.queryByRole("heading", { name: "Ohbox", level: 1 })) {
      firstContent.push(document.documentElement.dataset.face);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true });
  try {
    render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="UTC" now={new Date(ISO)}>
        <Providers deferLinuxFace><CloudShell demo={false} drawMail="wait" edgeOwner={null} /></Providers>
      </NextIntlClientProvider>,
    );
    await tick(1_000);
    expect(firstContent).toEqual(["ohmarchy"]);
  } finally {
    observer.disconnect();
  }
});

it("draws the stored waiting sender when Screener opens while derivation is still idle", async () => {
  await prepareMailPage();
  history.replaceState(null, "", "#/screener");
  vi.stubGlobal("requestIdleCallback", () => 1);
  const hydrate = OhmailEngine.prototype.hydrate;
  vi.spyOn(OhmailEngine.prototype, "hydrate").mockImplementation(async function (this: OhmailEngine) {
    await this.store.commitLocal([
      {
        type: SCREENER_WAITING_TYPE, id: "page",
        entity: { id: "page", kind: "page", total: 1, nextCursor: null, inFlight: [], ask: 1, rows: 1 },
      },
      {
        type: SCREENER_WAITING_TYPE, id: "sender:waiting",
        entity: {
          id: "sender:waiting", kind: "sender", order: 0, messageId: "waiting-letter",
          name: "Waiting sender", address: "waiting@example.invalid", receivedAt: ISO,
          subject: "Waiting letter", snippet: "", mailboxId: null, total: 1,
        },
      },
    ], []);
    await hydrate.call(this);
  });
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC" now={new Date(ISO)}>
      <Providers owner={ACCOUNT} deferLinuxFace><CloudShell demo={false} drawMail="now" edgeOwner={ACCOUNT} /></Providers>
    </NextIntlClientProvider>,
  );
  await tick(1_000);
  expect(screen.queryByRole("option", { name: /Waiting sender/ })).not.toBeNull();
});
