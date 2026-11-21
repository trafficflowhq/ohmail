/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { json } from "./account/account-harness";
import { NEAR } from "./account/storage-fixtures";
import { act, closeMailPage, mountMailPage, prepareMailPage, tick } from "./fixtures/mounted-mail-page";

const rig = vi.hoisted(() => ({ onVerified: null as null | (() => void) }));
vi.mock("../app/(product)/mailbox/StepUpPrompt", () => ({
  StepUpPrompt(props: { onVerified: () => void }) {
    rig.onVerified = props.onVerified;
    return null;
  },
}));

const manage = "https://pay.example.com/manage/t";
const open = (storage: unknown) => ({
  metered: true, access: "open", canAddMailbox: true, mailboxes: 2, aiEnabled: true,
  lifecycle: { state: "trialing", closedReason: null, trialEndsAt: null, graceUntil: null },
  storage,
});
let access: ReturnType<typeof open>;
let changeAnswers: Response[];
let left: string[];
let server: Awaited<ReturnType<typeof prepareMailPage>>;
let page: Awaited<ReturnType<typeof mountMailPage>>;

beforeEach(async () => {
  access = open(NEAR);
  changeAnswers = [];
  left = [];
  rig.onVerified = null;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    left.push(this.href);
  });
  server = await prepareMailPage({
    "GET /api/account/access": () => json(access),
    "POST /api/account/manage-link/change": () => changeAnswers.shift() ?? json({ url: manage }),
    "PATCH /api/account/storage": () => { access = open({ ...NEAR, card: null }); return json({}); },
  });
});

afterEach(() => {
  closeMailPage();
  vi.restoreAllMocks();
});

const card = () => page.getByRole("region", { name: en.settings.storage });

async function press(label: string): Promise<void> {
  const button = within(card()).getByRole("button", { name: label });
  await act(async () => { button.click(); });
  await tick(0);
}

describe("storage in the signed-in Ohbox", () => {
  it("near: how full, the figure, what the mail needs after the import, and the choice that keeps all of it", async () => {
    access = open(NEAR);
    page = await mountMailPage();
    const storage = card();
    const messages = page.getAllByRole("region", { name: en.frame.landmark.list });
    expect(messages.some((region) => region.contains(storage))).toBe(true);
    expect(storage.textContent).toContain("Storage 80% full");
    expect(storage.textContent).toContain("3.2 GB of 4 GB");
    expect(storage.textContent).toContain("Expected about 12.5 GB after the import.");
    expect(storage.textContent).toContain("Plus + 10 GB keeps all of it, $25/month.");
    expect(within(storage).getByRole("button", { name: en.settings.storageAddStorage })).toBeTruthy();
    expect(within(storage).getByRole("button", { name: en.settings.storageChangePlan })).toBeTruthy();
    expect(within(storage).getByRole("link", { name: en.settings.storageWhatCounts }).getAttribute("href"))
      .toBe("#/settings/storage");
  });

  it("Dismiss puts it away on the server and hides it at once", async () => {
    access = open(NEAR);
    page = await mountMailPage();
    await press(en.settings.storageDismiss);
    expect(server.on("PATCH /api/account/storage").map((w) => w.body)).toEqual([{ dismiss: "near" }]);
    expect(page.queryByRole("region", { name: en.settings.storage })).toBeNull();
  });

  it("Change plan leaves for the page that may change the plan", async () => {
    access = open(NEAR);
    page = await mountMailPage();
    await press(en.settings.storageChangePlan);
    expect(server.on("POST /api/account/manage-link/change")).toHaveLength(1);
    expect(left).toEqual([manage]);
  });

  it("a missing second factor is asked for, and the press runs once more after it", async () => {
    access = open(NEAR);
    changeAnswers = [json({ error: { code: "step_up_required", message: "recent two-factor authentication required" } }, 403)];
    page = await mountMailPage();
    await press(en.settings.storageAddStorage);
    expect(left).toEqual([]);
    expect(rig.onVerified, "no step-up prompt").not.toBeNull();
    await act(async () => { rig.onVerified!(); });
    await tick(0);
    expect(server.on("POST /api/account/manage-link/change")).toHaveLength(2);
    expect(left).toEqual([manage]);
  });
});
