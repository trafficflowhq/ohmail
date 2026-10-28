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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  window.localStorage.clear();
  delete document.documentElement.dataset.face;
});

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
    expect(container.textContent).not.toContain("Go full Ohmarchy Theme");
  });
});

describe("Settings → General → Look", () => {
  it("the segmented control writes the ACCOUNT: shown at once, one PATCH, no device pin", async () => {
    const record = captureFacePatch("ohmarchy");
    const container = await mountShell([mailbox()]);
    await goTo("settings");
    await tick(10);

    await click(buttonByText(container, "ohmarchy"));
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
    const container = await mountShell([mailbox()]);
    await goTo("settings");
    await tick(10);
    await click(buttonByText(container, "ohmarchy"));
    expect(document.documentElement.dataset.face).toBeUndefined();
    expect(window.localStorage.getItem("ohmail.face")).toBeNull();
    expect(window.localStorage.getItem("ohmail.face.account")).toBeNull();
    expect(container.textContent).toContain("Couldn't save that");
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
    const container = await mountShell([mailbox()]);
    await goTo("settings");
    await tick(10);
    await click(buttonByText(container, "ohmarchy"));
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
    const container = await mountShell([mailbox()]);
    await goTo("settings");
    await tick(10);
    await click(buttonByText(container, "ohmarchy"));
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
    const container = await mountShell([mailbox()]);
    await goTo("settings");
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
    const web = await mountShell([mailbox()]);
    await goTo("settings");
    await tick(10);
    await click(buttonByText(web, "ohmarchy"));
    expect(stored).toBe("ohmarchy");

    // The desktop starts and follows.
    const webStorage = await openDevice(desktopStorage);
    const desktop = await mountShell([mailbox()]);
    await goTo("settings");
    await tick(10);
    expect(document.documentElement.dataset.face, "the desktop kept its own look").toBe("ohmarchy");
    expect(desktop.textContent).toContain("Applies on all your devices.");

    // The desktop picks paper; the web follows at its next start.
    await click(buttonByText(desktop, "paper"));
    expect(stored).toBe("paper");
    await openDevice(webStorage);
    let rang = false;
    answerSyncWith(() => {
      if (!rang) return pageOf([], "c1");
      rang = false;
      return pageOf([settingsRow("2026-08-04T10:00:00.000Z")], "c2");
    });
    await mountShell([mailbox()]);
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
  it("appears when nothing is chosen anywhere; one tap applies account-wide and never re-offers", async () => {
    stubPlatform("Linux x86_64", LINUX_UA);
    const record = captureFacePatch("ohmarchy");
    const container = await mountShell([mailbox()]);
    await tick(10);
    // the detection default, device-only
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    expect(container.textContent).toContain("Go full Ohmarchy Theme on all your devices");

    await click(buttonByText(container, "Go full Ohmarchy Theme on all your devices"));
    expect(record.bodies).toEqual([{ themeFace: "ohmarchy" }]);
    expect(window.localStorage.getItem("ohmail.face.account")).toBe("ohmarchy");
    expect(window.localStorage.getItem("ohmail.faceOffer")).toBe("done");
    expect(container.textContent).not.toContain("Go full Ohmarchy Theme on all your devices");
  });

  it("dismissal keeps the device default, is remembered, and the next mount stays quiet", async () => {
    stubPlatform("Linux x86_64", LINUX_UA);
    const container = await mountShell([mailbox()]);
    await tick(10);
    await click(buttonByText(container, "Not now"));
    expect(container.textContent).not.toContain("Go full Ohmarchy Theme");
    // the dismissal answers the OFFER, not the detection — this device stays ohmarchy
    expect(document.documentElement.dataset.face).toBe("ohmarchy");
    expect(window.localStorage.getItem("ohmail.faceOffer")).toBe("done");

    const second = await mountShell([mailbox()]);
    await tick(10);
    expect(second.textContent).not.toContain("Go full Ohmarchy Theme");
  });

  it("an explicit prior choice wins over detection — no offer, no ohmarchy", async () => {
    stubPlatform("Linux x86_64", LINUX_UA);
    window.localStorage.setItem("ohmail.face", "paper");
    const container = await mountShell([mailbox()]);
    await tick(10);
    expect(document.documentElement.dataset.face).toBeUndefined();
    expect(container.textContent).not.toContain("Go full Ohmarchy Theme");
  });

  it("never on a non-Linux device", async () => {
    const container = await mountShell([mailbox()]);
    await tick(10);
    expect(container.textContent).not.toContain("Go full Ohmarchy Theme");
  });
});
