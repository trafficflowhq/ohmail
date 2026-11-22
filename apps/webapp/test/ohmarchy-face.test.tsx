/** @vitest-environment jsdom */
/**
 * THE FACE'S ACCOUNT HALF, THROUGH THE SHIPPED SHELL (OHMARCHY-PLAN.md §3a) — the pieces no
 * component test can prove:
 *
 *  · adoption: a `GET /consent` carrying `themeFace` re-skins this device and mirrors the
 *    answer for the next boot's pre-paint stamp (the AppShell effect, the real one);
 *  · the Settings row: on a signed-in device the segmented control is one `PATCH
 *    /consent/settings {themeFace}` whose ECHO becomes the adopted account face, no pin; an
 *    older build's device-only pin retires once the account holds a look; and two devices
 *    of one account follow the newest choice, at start and on the settings doorbell;
 *  · the Option B offer on a Linux device: appears only while nothing is chosen anywhere,
 *    one tap goes account-wide, dismissal is remembered, and an explicit prior choice
 *    keeps it away entirely.
 *
 * Mounted via the live-walk fixture — the same providers the Cloud entry uses — because the
 * measured failure mode of consent-adjacent UI is exactly "the component that owns the string
 * passes while the shell never wires it" (the fixture's own header).
 */
import { createElement } from "react";
import messages from "../messages/en.json";
import { ToastContext } from "@ohmail/ui";
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorageOwnerForTest, setStorageOwner } from "@ohmail/app-logic/storage/storage-owner";
import {
  ISO,
  act,
  answerConsentWith,
  answerSyncWith,
  installShellEnv,
  mountShell,
  goTo,
  mailbox,
  teardownShellEnv,
  tick,
} from "./fixtures/live-walk-shell";
import { WEB_PANE_PARTS } from "../app/(product)/mailbox/pane-parts";

import { json } from "./account/account-harness";
import { closeMailPage, mountMailPage, prepareMailPage, tick as tickMailPage } from "./fixtures/mounted-mail-page";

const LINUX_UA = "Mozilla/5.0 (X" + "11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

function stubPlatform(platform: string, ua: string): void {
  Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
}

/** Intercept `PATCH /consent/settings`, record bodies, answer with `echo`. */
function captureFacePatch(echo: string | null): { bodies: unknown[] } {
  const record: { bodies: unknown[] } = { bodies: [] };
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (String(input).includes("/consent/settings") && init?.method === "PATCH") {
      record.bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ themeFace: echo }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return inner(input as RequestInfo, init);
  }) as typeof globalThis.fetch;
  return record;
}

const click = async (el: Element): Promise<void> => {
  await act(async () => {
    (el as HTMLElement).click();
    await Promise.resolve();
  });
  await tick(0);
};

const buttonByText = (container: HTMLElement, text: string): HTMLElement => {
  const hit = [...container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!hit) throw new Error(`no button reading "${text}"`);
  return hit;
};

beforeEach(() => {
  installShellEnv();
  stubPlatform("MacIntel", MAC_UA);
  window.localStorage.clear();
  delete document.documentElement.dataset.face;
});

afterEach(async () => {
  await teardownShellEnv();
  const { bindApiOwner } = await import("../app/api-client");
  bindApiOwner(null);
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  resetStorageOwnerForTest();
  window.localStorage.clear();
  delete document.documentElement.dataset.face;
});

/* The adoption is a duty of the boot (the mail ground's), so its cases mount the new shell's door. */
describe("account adoption", () => {
  it("a consent answer carrying themeFace re-skins the device and mirrors it for the next boot", async () => {
    answerConsentWith({ themeFace: "ohmarchy" });
    await mountShell([mailbox()]);
    await tick(10);
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    expect(window.localStorage.getItem("ohmail.face.account")).toBe("ohmarchy");
  });

  it("an older build's device-only pin retires once the account holds a look", async () => {
    window.localStorage.setItem("ohmail.face", "paper");
    answerConsentWith({ themeFace: "ohmarchy" });
    await mountShell([mailbox()]);
    await tick(10);
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    expect(window.localStorage.getItem("ohmail.face")).toBeNull();
    expect(window.localStorage.getItem("ohmail.face.account")).toBe("ohmarchy");
  });
});

/* THE MIRROR NAMES ITS ACCOUNT beside it, so a revoke of that account while another holds the jar can take it. */
describe("the account face's mirror names its account", () => {
  const mirror = (): Array<string | null> =>
    ["ohmail.face.account", "ohmail.face.account.owner"].map((k) => window.localStorage.getItem(k));
  beforeEach(() => { document.cookie = "tf_owner=acct_live_1; Path=/"; });
  afterEach(() => { document.cookie = "tf_owner=; Path=/; Max-Age=0"; });

  it("adopting under A writes the face and names A", async () => {
    answerConsentWith({ themeFace: "ohmarchy" });
    await mountShell([mailbox()]);
    await tick(10);
    expect(mirror()).toEqual(["ohmarchy", "acct_live_1"]);
  });

  it("adopting none removes both", async () => {
    window.localStorage.setItem("ohmail.face.account", "ohmarchy");
    window.localStorage.setItem("ohmail.face.account.owner", "acct_live_1");
    answerConsentWith({ themeFace: null });
    await mountShell([mailbox()]);
    await tick(10);
    expect(mirror()).toEqual([null, null]);
  });
});

describe("account adoption is LIVE-WIRE only", () => {
  it("a hung consent read leaves the device's mirror standing — the boot cache is not an answer about the face", async () => {
    // review-caught: the boot cache can make `consent.known` true while the face is still the
    // resting null; adopting THAT null wiped the mirror on every warm boot whose live read
    // was slow, and armed the offer over an account that may have chosen paper.
    //
    // A REAL warm boot, or the test is vacuous (its own first draft was — it seeded no cache,
    // `known` stayed false, and both gates looked identical): the `tf_owner` cookie names the
    // account and the consent boot cache exists for it, which is exactly the state that made
    // `known` true with the face still resting.
    document.cookie = "tf_owner=acct_live_1";
    window.localStorage.setItem(
      "ohmail.boot.consent.acct_live_1",
      JSON.stringify({ v: 1, seedConfirmedAt: ISO, dormancyDays: 60, screeningBaselineAt: null, foldersEnabledAt: null }),
    );
    window.localStorage.setItem("ohmail.face.account", "ohmarchy");
    stubPlatform("Linux x86_64", LINUX_UA);
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input).includes("/consent") && (init?.method ?? "GET") === "GET") {
        return new Promise<Response>(() => {}); // hangs for the life of the test
      }
      return inner(input as RequestInfo, init);
    }) as typeof globalThis.fetch;
    const container = await mountShell([mailbox()]);
    await tick(50);
    expect(window.localStorage.getItem("ohmail.face.account"),
      "the mirror was wiped by an answer nobody gave").toBe("ohmarchy");
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    // and the account-write affordances stay withheld — no offer without live knowledge
    expect(container.textContent).not.toContain("ohmarchy on this computer");
  });
});

const LOOK_ACCOUNT = "acct_live_1";

async function mountGeneralLook(opts: Pick<NonNullable<Parameters<typeof mountShell>[1]>, "consentTransport" | "wrap"> = {}) {
  setStorageOwner(LOOK_ACCOUNT);
  const page = await mountShell([mailbox()], { general: WEB_PANE_PARTS.general, ...opts });
  const { bindApiOwner } = await import("../app/api-client");
  bindApiOwner(LOOK_ACCOUNT);
  document.cookie = `tf_owner=${LOOK_ACCOUNT}; Path=/`;
  return page;
}

it("keeps the subject display chosen in General after leaving the pane", async () => {
  const page = within(await mountGeneralLook());
  const choice = (name: string) => page.getByRole("button", { name });
  await goTo("settings/general");
  expect(choice("One heading").getAttribute("aria-pressed")).toBe("true");
  await click(choice("On each message"));
  await goTo("ohbox");
  await goTo("settings/general");
  expect(choice("On each message").getAttribute("aria-pressed")).toBe("true");
  await click(choice("One heading"));
  expect(choice("One heading").getAttribute("aria-pressed")).toBe("true");
});

describe("Settings → General → Look", () => {
  it("keeps the newer look chosen after returning to General while the previous write is pending", async () => {
    answerConsentWith({ themeFace: "paper" });
    const inner = globalThis.fetch;
    const submissions: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    globalThis.fetch = async (input, init) => {
      if (!String(input).endsWith("/consent/settings") || init?.method !== "PATCH") return inner(input, init);
      const { themeFace } = JSON.parse(String(init.body)) as { themeFace: string };
      submissions.push(themeFace);
      if (submissions.length === 1) await held;
      return Response.json({ themeFace });
    };
    const page = await mountGeneralLook();
    const tile = (name: RegExp) => within(page).getByRole("button", { name });
    await goTo("settings/general");
    await tick(10);
    await click(tile(/^ohmarchy\b/));
    expect(submissions).toEqual(["ohmarchy"]);
    await goTo("ohbox");
    await goTo("settings/general");
    await click(tile(new RegExp(`^${messages.settings.facePaper}\\b`)));
    expect(tile(new RegExp(`^${messages.settings.facePaper}\\b`)).getAttribute("aria-pressed")).toBe("true");
    await act(async () => { release(); });
    await tick(10);
    expect(submissions).toEqual(["ohmarchy", "paper"]);
    expect(tile(new RegExp(`^${messages.settings.facePaper}\\b`)).getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem("ohmail.face.account")).toBe("paper");
  });

  it.each([
    { answer: "when the first write succeeds", status: 200, queue: true },
    { answer: "when the first write is refused", status: 500, queue: false },
  ])("keeps another account's appearance after its owner marker changes $answer", async ({ status, queue }) => {
    const account = LOOK_ACCOUNT;
    const nextAccount = "acct_face_next";
    const faceKey = "ohmail.face.account";
    const ownerKey = "ohmail.face.account.owner";
    answerConsentWith({ themeFace: "paper" });
    const { cloudConsent } = await import("../app/(product)/mailbox/consent-over-api");
    const { bindApiOwner } = await import("../app/api-client");
    const wire = cloudConsent();
    const apply = vi.fn(cloudConsent(account).setThemeFace!);
    const inner = globalThis.fetch;
    const writes: unknown[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    globalThis.fetch = async (input, init) => {
      if (!String(input).endsWith("/consent/settings") || init?.method !== "PATCH") return inner(input, init);
      writes.push(JSON.parse(String(init.body)));
      await held;
      return Response.json({ themeFace: "paper" }, { status, headers: { "X-Ohmail-Account": account } });
    };

    try {
      const page = await mountGeneralLook({ consentTransport: { ...wire, setThemeFace: apply } });
      const tile = (name: RegExp) => within(page).getByRole("button", { name });
      await goTo("settings/general");
      await tick(10);
      expect(tile(new RegExp(`^${messages.settings.facePaper}\\b`)).getAttribute("aria-pressed")).toBe("true");
      expect(page.textContent).toContain("Applies on all your devices.");
      await click(tile(/^ohmarchy\b/));
      expect(writes).toEqual([{ themeFace: "ohmarchy" }]);
      expect(window.localStorage.getItem(ownerKey)).toBe(account);
      if (queue) {
        await goTo("ohbox");
        await goTo("settings/general");
        await click(tile(new RegExp(`^${messages.settings.facePaper}\\b`)));
        expect(tile(new RegExp(`^${messages.settings.facePaper}\\b`)).getAttribute("aria-pressed")).toBe("true");
      }
      document.cookie = `tf_owner=${nextAccount}; Path=/`;
      window.localStorage.setItem(faceKey, "ohmarchy");
      window.localStorage.setItem(ownerKey, nextAccount);
      await act(async () => { release(); });
      await tick(10);

      expect(apply.mock.calls).toEqual([["ohmarchy"]]);
      expect(writes).toEqual([{ themeFace: "ohmarchy" }]);
      expect(window.localStorage.getItem(faceKey)).toBe("ohmarchy");
      expect(window.localStorage.getItem(ownerKey)).toBe(nextAccount);
      expect(window.localStorage.getItem("ohmail.face")).toBeNull();
      expect(page.textContent).not.toContain("Couldn't save that");
    } finally {
      release();
      bindApiOwner(null);
      document.cookie = "tf_owner=; Path=/; Max-Age=0";
    }
  });

  it("an old General pane cannot change appearance after the account marker changes before pressing", async () => {
    const oldAccount = LOOK_ACCOUNT;
    const newAccount = "acct_face_next";
    const faceKey = "ohmail.face.account";
    const labelKey = "ohmail.face.account.owner";
    answerConsentWith({ themeFace: "paper" });
    const { cloudConsent } = await import("../app/(product)/mailbox/consent-over-api");
    const { bindApiOwner } = await import("../app/api-client");
    const wire = cloudConsent();
    const apply = vi.fn(cloudConsent(oldAccount).setThemeFace!);
    const inner = globalThis.fetch;
    const patches: unknown[] = [];
    globalThis.fetch = async (input, init) => {
      if (!String(input).endsWith("/consent/settings") || init?.method !== "PATCH") return inner(input, init);
      patches.push(JSON.parse(String(init.body)));
      return Response.json({ themeFace: "ohmarchy" }, { headers: { "X-Ohmail-Account": oldAccount } });
    };
    try {
      const page = await mountGeneralLook({ consentTransport: { ...wire, setThemeFace: apply } });
      await goTo("settings/general");
      await tick(10);
      const tile = (name: RegExp) => within(page).getByRole("button", { name });
      expect(tile(new RegExp(`^${messages.settings.facePaper}\\b`)).getAttribute("aria-pressed")).toBe("true");
      expect(page.textContent).toContain("Applies on all your devices.");

      // The browser's other account took the jar and saved its look since this pane last drew.
      document.cookie = `tf_owner=${newAccount}; Path=/`;
      window.localStorage.setItem(faceKey, "ohmarchy");
      window.localStorage.setItem(labelKey, newAccount);
      const stored = vi.spyOn(Storage.prototype, "setItem");
      try {
        await click(tile(/^ohmarchy\b/));
        await tick(10);
        expect.soft(stored.mock.calls.filter(([key]) => key === faceKey || key === labelKey || key === "ohmail.face")).toEqual([]);
        expect.soft(tile(new RegExp(`^${messages.settings.facePaper}\\b`)).getAttribute("aria-pressed")).toBe("true");
      } finally {
        stored.mockRestore();
      }

      expect.soft(apply).not.toHaveBeenCalled();
      expect.soft(patches, "no old-frame appearance request").toEqual([]);
      expect.soft(window.localStorage.getItem(labelKey)).toBe(newAccount);
      expect.soft(window.localStorage.getItem(faceKey), "the old pane cannot replace the other account's face").toBe("ohmarchy");
      expect.soft(window.localStorage.getItem("ohmail.face"), "no stale device pin").toBeNull();
      expect.soft(page.textContent, "no old-frame rollback report").not.toContain("Couldn't save that");
    } finally {
      globalThis.fetch = inner;
      bindApiOwner(null);
      document.cookie = "tf_owner=; Path=/; Max-Age=0";
    }
  });

  it("the segmented control writes the ACCOUNT: shown at once, one PATCH, no device pin", async () => {
    const record = captureFacePatch("ohmarchy");
    const container = await mountGeneralLook();
    await goTo("settings/general");
    await tick(10);

    await click(within(container).getByRole("button", { name: /^ohmarchy\b/ }));
    expect(record.bodies).toEqual([{ themeFace: "ohmarchy" }]);
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    expect(window.localStorage.getItem("ohmail.face")).toBeNull();
    expect(window.localStorage.getItem("ohmail.face.account")).toBe("ohmarchy");
    expect(container.textContent).toContain("Applies on all your devices.");
  });

  it("a refused account write puts the look back and says so", async () => {
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input).includes("/consent/settings") && init?.method === "PATCH") {
        return new Response("{}", { status: 500 });
      }
      return inner(input as RequestInfo, init);
    }) as typeof globalThis.fetch;
    const container = await mountGeneralLook({
      wrap: (shell) => createElement(ToastContext.Provider, { value: null }, shell),
    });
    await goTo("settings/general");
    await tick(10);
    await click(within(container).getByRole("button", { name: /^ohmarchy\b/ }));
    expect(document.documentElement.dataset.face).toBeUndefined();
    expect(window.localStorage.getItem("ohmail.face")).toBeNull();
    expect(window.localStorage.getItem("ohmail.face.account")).toBeNull();
    expect(container.textContent).toContain("Couldn't save that");
    await tick(50);
    expect(within(container).getByRole("status", { name: "Couldn't save that — try again." })).toBeTruthy();
  });

  /** Hold every `GET /consent` until `release()`; then answer them from the fixture. */
  const holdConsentRead = (): { release: () => Promise<void> } => {
    const inner = globalThis.fetch;
    const held: Array<() => void> = [];
    let open = false;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (!open && String(input).includes("/consent") && (init?.method ?? "GET") === "GET") {
        await new Promise<void>((go) => held.push(go));
      }
      return inner(input as RequestInfo, init);
    }) as typeof globalThis.fetch;
    return {
      release: async () => {
        open = true;
        await act(async () => {
          for (const go of held.splice(0)) go();
        });
        await tick(10);
      },
    };
  };

  it("a look chosen before the account answers is written to it, not undone", async () => {
    answerConsentWith({ themeFace: "paper" });
    const record = captureFacePatch("ohmarchy");
    const read = holdConsentRead();
    const container = await mountGeneralLook();
    await goTo("settings/general");
    await tick(10);
    await click(within(container).getByRole("button", { name: /^ohmarchy\b/ }));
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    expect(record.bodies).toEqual([]);

    await read.release();
    expect(record.bodies).toEqual([{ themeFace: "ohmarchy" }]);
    expect(document.documentElement.dataset.face, "the newest choice was undone").toBe("ohmarchy");
    expect(window.localStorage.getItem("ohmail.face.account")).toBe("ohmarchy");
    expect(window.localStorage.getItem("ohmail.face")).toBeNull();
    expect(container.textContent).toContain("Applies on all your devices.");
  });

  it("a look chosen before the account answers stays on the device when its write is refused", async () => {
    answerConsentWith({ themeFace: "paper" });
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input).includes("/consent/settings") && init?.method === "PATCH") {
        return new Response("{}", { status: 503 });
      }
      return inner(input as RequestInfo, init);
    }) as typeof globalThis.fetch;
    const read = holdConsentRead();
    const container = await mountGeneralLook();
    await goTo("settings/general");
    await tick(10);
    await click(within(container).getByRole("button", { name: /^ohmarchy\b/ }));
    await read.release();
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    expect(window.localStorage.getItem("ohmail.face")).toBe("ohmarchy");
    expect(window.localStorage.getItem("ohmail.face.account")).toBe("paper");
    expect(container.textContent).toContain("Couldn't save that");
    expect(container.textContent).toContain("Applies on this device only.");
  });

  it("a Linux device's own default is said plainly, and 'Apply on all devices' sends it", async () => {
    stubPlatform("Linux x86_64", LINUX_UA);
    const record = captureFacePatch("ohmarchy");
    const container = await mountGeneralLook();
    await goTo("settings/general");
    await tick(10);
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    expect(container.textContent).toContain("This device's default until you choose a look.");
    await click(buttonByText(container, "Apply on all devices"));
    expect(record.bodies).toEqual([{ themeFace: "ohmarchy" }]);
    expect(container.textContent).toContain("Applies on all your devices.");
  });
});

describe("two devices of one account (the web and a paired desktop)", () => {
  /* One account row; each device keeps its own storage, swapped in and out between mounts. */
  let stored: string | null = null;
  const serveAccount = (): void => {
    answerConsentWith({ themeFace: stored });
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input).includes("/consent/settings") && init?.method === "PATCH") {
        stored = (JSON.parse(String(init.body)) as { themeFace: string | null }).themeFace;
        answerConsentWith({ themeFace: stored });
        return new Response(JSON.stringify({ themeFace: stored }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return inner(input as RequestInfo, init);
    }) as typeof globalThis.fetch;
  };
  /** Close this device's window and open the other one's, with that device's own storage. */
  const openDevice = async (storage: Record<string, string>): Promise<Record<string, string>> => {
    const left = { ...window.localStorage } as Record<string, string>;
    await teardownShellEnv();
    window.localStorage.clear();
    delete document.documentElement.dataset.face;
    installShellEnv();
    stubPlatform("MacIntel", MAC_UA);
    for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
    serveAccount();
    return left;
  };
  const settingsRow = (stamp: string) => ({
    type: "settings", op: "update", id: "acct_live_1", seq: 2, updatedAt: stamp,
    entity: { accountId: "acct_live_1", updatedAt: stamp },
  });
  const pageOf = (creates: unknown[], cursor: string): Response =>
    new Response(JSON.stringify({
      changes: { creates, updates: [], moves: [], deletes: [] }, cursor, hasMore: false, serverTime: ISO,
    }), { status: 200, headers: { "content-type": "application/json" } });

  it("the newest choice wins on both, read at start and on change", async () => {
    stored = null;
    // The desktop carries a pin from an older build's "only this device" control.
    const desktopStorage: Record<string, string> = { "ohmail.face": "paper" };

    // The web picks ohmarchy.
    serveAccount();
    const web = await mountGeneralLook();
    await goTo("settings/general");
    await tick(10);
    await click(within(web).getByRole("button", { name: /^ohmarchy\b/ }));
    expect(stored).toBe("ohmarchy");

    // The desktop starts and follows.
    const webStorage = await openDevice(desktopStorage);
    const desktop = await mountGeneralLook();
    await goTo("settings/general");
    await tick(10);
    expect(document.documentElement.dataset.face, "the desktop kept its own look").toBe("ohmarchy");
    expect(desktop.textContent).toContain("Applies on all your devices.");

    // The desktop picks paper; the web follows at its next start.
    await click(within(desktop).getByRole("button", { name: new RegExp(`^${messages.settings.facePaper}\\b`) }));
    expect(stored).toBe("paper");
    await openDevice(webStorage);
    let rang = false;
    answerSyncWith(() => {
      if (!rang) return pageOf([], "c1");
      rang = false;
      return pageOf([settingsRow("2026-08-04T10:00:00.000Z")], "c2");
    });
    await mountGeneralLook();
    await tick(30_000);
    expect(document.documentElement.dataset.face, "the web kept the look the desktop replaced").toBeUndefined();

    // A choice made elsewhere while the web is open reaches it on the settings doorbell.
    stored = "ohmarchy";
    answerConsentWith({ themeFace: stored });
    rang = true;
    await tick(30_000);
    expect(document.documentElement.dataset.face, "a change made on another device never arrived").toBe("ohmarchy");
    expect(window.localStorage.getItem("ohmail.face.account"), "the next start would paint the old look").toBe("ohmarchy");
  });
});

describe("the Option B offer (Linux device)", () => {
  afterEach(closeMailPage);

  it("appears when nothing is chosen anywhere; one tap applies account-wide and never re-offers", async () => {
    stubPlatform("Linux x86_64", LINUX_UA);
    const server = await prepareMailPage({
      "PATCH /api/consent/settings": () => json({ themeFace: "ohmarchy" }),
    });
    const { container } = await mountMailPage();
    // the detection default, device-only
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    expect(container.textContent).toContain("All devices");

    await click(within(container).getByRole("button", { name: "All devices" }));
    await tickMailPage(0);
    expect(server.on("PATCH /api/consent/settings").map((entry) => entry.body)).toEqual([{ themeFace: "ohmarchy" }]);
    expect(window.localStorage.getItem("ohmail.face.account")).toBe("ohmarchy");
    expect(window.localStorage.getItem("ohmail.faceOffer")).toBe("done");
    expect(container.textContent).not.toContain("All devices");
  });

  it("dismissal keeps the device default, is remembered, and the next mount stays quiet", async () => {
    stubPlatform("Linux x86_64", LINUX_UA);
    await prepareMailPage();
    const { container, unmount } = await mountMailPage();
    await click(within(container).getByRole("button", { name: "Not now" }));
    expect(container.textContent).not.toContain("ohmarchy on this computer");
    // the dismissal answers the OFFER, not the detection — this device stays ohmarchy
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    expect(window.localStorage.getItem("ohmail.faceOffer")).toBe("done");

    unmount();
    const { container: second } = await mountMailPage();
    expect(second.textContent).not.toContain("ohmarchy on this computer");
  });

  it("an explicit prior choice wins over detection — no offer, no ohmarchy", async () => {
    stubPlatform("Linux x86_64", LINUX_UA);
    await prepareMailPage();
    window.localStorage.setItem("ohmail.face", "paper");
    const { container } = await mountMailPage();
    expect(document.documentElement.dataset.face).toBe("paper");
    expect(container.textContent).not.toContain("ohmarchy on this computer");
  });

  it("never on a non-Linux device", async () => {
    await prepareMailPage();
    const { container } = await mountMailPage();
    expect(container.textContent).not.toContain("ohmarchy on this computer");
  });
});
