/** @vitest-environment jsdom */
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NONE } from "@ohmail/app/host";
import { DESKTOP_DOWNLOAD_URL } from "../app/(product)/mailbox/host";
import { browserOpenLink } from "../app/shell/browser-mail";
import { mountShell, stubDom, unmountAll, waitFor } from "./_draft-shell.js";

const GENERAL = "#/settings/general";
const hasOffer = () => screen.queryByRole("button", { name: "Get it" }) !== null;
const desktopOffer = { url: DESKTOP_DOWNLOAD_URL, openLink: browserOpenLink };

beforeEach(() => {
  localStorage.clear();
  stubDom();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
});

it("offers the desktop app in General settings in the signed-in browser", async () => {
  await mountShell(GENERAL, [], [], { desktopOffer });
  await waitFor(hasOffer, "the desktop offer");
});

it("never offers the desktop app on the demo", async () => {
  await mountShell(GENERAL, [], [], { desktopOffer, demo: true });
  expect(hasOffer()).toBe(false);
});

it.each(["desktop", "pairedPage", "phone"] as const)("never offers the desktop app on %s", async (surface) => {
  await mountShell(GENERAL, [], [], { desktopOffer: { ...desktopOffer, surface } });
  expect(hasOffer()).toBe(false);
});

it("withholds the download when the host cannot open it", async () => {
  await mountShell(GENERAL, [], [], { desktopOffer: { ...desktopOffer, openLink: NONE } });
  expect(hasOffer()).toBe(false);
});

it("withholds the download when the host has no address for it", async () => {
  await mountShell(GENERAL, [], [], { desktopOffer: { ...desktopOffer, url: null } });
  expect(hasOffer()).toBe(false);
});

it("keeps the mail list quiet when the browser has a dismissal saved", async () => {
  localStorage.setItem("ohmail.desktopCtaDismissed", "1");
  await mountShell("#/ohbox", [], [], { desktopOffer });
  expect(hasOffer()).toBe(false);
});

describe("today's strips, as notices in the one slot", () => {
  it("offers the desktop app in a signed-in browser, and a dismissal keeps it away", async () => {
    await mountShell(GENERAL, [], [], { desktopOffer });
    await waitFor(() => screen.queryByText(/Get ohmail for/) !== null, "the desktop download");
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    fireEvent.click(screen.getByRole("button", { name: "Get it" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(DESKTOP_DOWNLOAD_URL, "_blank", "noopener,noreferrer");
    await unmountAll();
    stubDom();
    localStorage.setItem("ohmail.desktopCtaDismissed", "1");
    await mountShell("#/ohbox", [], [], { desktopOffer });
    expect(screen.queryByText(/Get ohmail for/)).toBeNull();
  });

  it("never offers the desktop app inside the desktop app or on the demo", async () => {
    stubDom();
    await mountShell(GENERAL, [], [], { desktopOffer: { ...desktopOffer, surface: "desktop" } });
    expect(screen.queryByText(/Get ohmail for/)).toBeNull();
    await unmountAll();
    stubDom();
    await mountShell(GENERAL, [], [], { desktopOffer, demo: true });
    expect(screen.queryByText(/Get ohmail for/)).toBeNull();
  });
});
