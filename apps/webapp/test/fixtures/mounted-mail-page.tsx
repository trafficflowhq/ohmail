import { act, cleanup, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { vi } from "vitest";
import { resetResumeLaneForTests } from "@ohmail/app-logic/session/resume-lane";
import { resetSessionTruthForTests } from "@ohmail/app-logic/session/session-truth";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import { en, json, serve, session } from "../account/account-harness";

export { act };

export const ISO = "2026-09-04T12:40:00.000Z";
export const ACCOUNT = "account-under-test";
export const MAILBOX = {
  id: "mb_1",
  address: "mailbox@example.invalid",
  status: "connected",
  initialImportCompletedAt: ISO,
  lastSyncAt: ISO,
  organizerRole: "organizer",
  organizeConsentedAt: ISO,
};

const changes = { creates: [], updates: [], moves: [], deletes: [] };
let server: ReturnType<typeof serve>;

export function scopedSyncResponse(body: unknown): Response {
  const response = json(body);
  response.headers.set("X-Ohmail-Account", ACCOUNT);
  return response;
}

export async function prepareMailPage(routes: Parameters<typeof serve>[0] = {}) {
  const { bindApiOwner, forgetAccess } = await import("../../app/api-client");
  bindApiOwner(null);
  forgetAccess();
  resetResumeLaneForTests();
  resetSessionTruthForTests();
  resetStorageOwnerForTest();
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = `tf_owner=${ACCOUNT}; Path=/`;
  history.replaceState(null, "", "#/ohbox");
  vi.useFakeTimers();
  vi.setSystemTime(new Date(ISO));
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.scrollTo ??= () => {};
  server = serve({
    "POST /auth/refresh": () => new Response(null, { status: 204 }),
    "GET /api/auth/session": () => json(session()),
    "GET /api/hello": () => json({ features: { pairing: false } }),
    "GET /api/mailboxes": () => json({ items: [MAILBOX] }),
    "GET /api/account/access": () => json({ metered: false }),
    "GET /api/consent": () => json({ seedConfirmedAt: ISO, dormancyDays: 60, themeFace: null }),
    "GET /api/sync/snapshot": () => new Response(null, { status: 404 }),
    "GET /api/sync": () => scopedSyncResponse({ changes, cursor: "c0", hasMore: false, serverTime: ISO }),
    ...routes,
  });
  return server;
}

export async function tick(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  for (let remaining = ms; remaining > 0; remaining -= 250) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(remaining, 250)); });
  }
}

export async function mountMailPage(demo = false) {
  const { CloudShell } = await import("../../app/(product)/mailbox/CloudShell");
  const { Providers } = await import("../../app/(product)/providers");
  const page = render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC" now={new Date(ISO)}>
      <Providers><CloudShell demo={demo} /></Providers>
    </NextIntlClientProvider>,
  );
  await tick(0);
  await tick(2_500);
  await tick(0);
  return page;
}

export function closeMailPage(): void {
  cleanup();
  server.restore();
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  delete document.documentElement.dataset.face;
  vi.unstubAllGlobals();
  vi.useRealTimers();
}

export const CORRESPONDENT = "writer@example.invalid";

export function inboxPage(count: number) {
  const creates = [{
    type: "rule", op: "create", id: "r1", seq: 1, updatedAt: ISO,
    entity: { id: "r1", kind: "sender", match: CORRESPONDENT, destination: "INBOX", enabled: true, createdAt: ISO },
  }, ...Array.from({ length: count }, (_, index) => {
    const id = `m${index + 1}`;
    return {
      type: "message", op: "create", id, seq: index + 2, updatedAt: ISO,
      entity: {
        id, accountId: ACCOUNT, mailboxId: MAILBOX.id, threadId: id, folder: "INBOX",
        subject: `Subject ${id}`, from: { address: CORRESPONDENT, name: "A writer" }, to: [], cc: [],
        date: ISO, unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {},
        labels: [], snippet: "A letter", triage: null, remoteContent: "none", updatedAt: ISO,
      },
    };
  })];
  return scopedSyncResponse({ changes: { ...changes, creates }, cursor: "c1", hasMore: false, serverTime: ISO });
}
