/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { json } from "./account/account-harness";
import { act, closeMailPage, ISO, mountMailPage, prepareMailPage, tick } from "./fixtures/mounted-mail-page";

let applied: boolean;
let server: Awaited<ReturnType<typeof prepareMailPage>>;

function linux(): void {
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Linux x86_64");
  vi.spyOn(window.navigator, "userAgent", "get")
    .mockReturnValue("Mozilla/5.0 (Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0");
}

beforeEach(async () => {
  applied = false;
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
  server = await prepareMailPage({
    "GET /api/consent": () => json({ seedConfirmedAt: ISO, dormancyDays: 60, themeFace: applied ? "ohmarchy" : null }),
    "PATCH /api/consent/settings": () => { applied = true; return json({ themeFace: "ohmarchy" }); },
  });
});

afterEach(() => {
  closeMailPage();
  vi.restoreAllMocks();
});

async function press(button: HTMLElement): Promise<void> {
  await act(async () => { button.click(); });
  await tick(0);
}

const patches = () => server.on("PATCH /api/consent/settings").map((entry) => entry.body);

describe("the mounted appearance offer", () => {
  it("uses one account write and remembers the answer", async () => {
    linux();
    const page = await mountMailPage();
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    await press(page.getByRole("button", { name: en.ohmarchy.offerAction }));
    expect(patches()).toEqual([{ themeFace: "ohmarchy" }]);
    expect(localStorage.getItem("ohmail.face.account")).toBe("ohmarchy");
    expect(localStorage.getItem("ohmail.faceOffer")).toBe("done");
    expect(page.queryByRole("button", { name: en.ohmarchy.offerAction })).toBeNull();
  }, 30_000);

  it("keeps the default when dismissed and stays quiet on the next mount", async () => {
    linux();
    const page = await mountMailPage();
    await press(page.getByRole("button", { name: en.ohmarchy.offerDismissShort }));
    expect(patches()).toEqual([]);
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    expect(localStorage.getItem("ohmail.faceOffer")).toBe("done");
    expect(page.queryByRole("button", { name: en.ohmarchy.offerAction })).toBeNull();
    page.unmount();
    const next = await mountMailPage();
    expect(next.queryByRole("button", { name: en.ohmarchy.offerAction })).toBeNull();
  }, 30_000);

  it("keeps an explicit paper choice and offers nothing", async () => {
    linux();
    localStorage.setItem("ohmail.face", "paper");
    const page = await mountMailPage();
    expect(document.documentElement.dataset.face).toBe("paper");
    expect(page.queryByRole("button", { name: en.ohmarchy.offerAction })).toBeNull();
  }, 30_000);

  it("offers nothing on a non-Linux device", async () => {
    const page = await mountMailPage();
    expect(page.queryByRole("button", { name: en.ohmarchy.offerAction })).toBeNull();
  }, 30_000);
});


it("General applies appearance to all devices when private storage is isolated", async () => {
  linux();
  const { isolateAccountScope } = await import("../app/pending-sign-out-storage");
  const { readOwner } = await import("@ohmail/app-logic/storage/owner-cookie");
  const { readSessionFamily } = await import("../app/signed-out-signal");
  const owner = readOwner();
  expect(owner).not.toBeNull();
  isolateAccountScope(owner!, readSessionFamily());
  const page = await mountMailPage();
  await act(async () => {
    window.location.hash = "#/settings/general";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await tick(0);
  await press(page.getByRole("button", { name: "All devices", pressed: false }));
  expect(patches()).toEqual([{ themeFace: "ohmarchy" }]);
}, 30_000);
