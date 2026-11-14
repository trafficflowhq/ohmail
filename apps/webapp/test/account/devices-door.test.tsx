/** @vitest-environment jsdom */
import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactorSlot, GatedAsk } from "@ohmail/app/account";
import {
  catchConsole,
  de,
  en,
  foundIn,
  json,
  OFFLINE,
  refusal,
  serve,
  settle,
  type Server,
} from "./account-harness";
import { hello, qr, scanned, watchClipboard, Words } from "./devices-support";
import { DevicesPane } from "../../../../packages/app/src/account/devices/DevicesPane.js";
import { useDevices } from "../../../../packages/app/src/account/devices/use-devices.js";
import { resetSessionTruthForTests } from "@ohmail/app-logic/session/session-truth";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import {
  installConfirmEnv, mountCloudShell, refresh204, rememberOwner, scriptRefresh,
  scriptSession, sessionFull, teardownConfirmEnv, tick,
} from "../fixtures/cloud-confirm-shell";
import { ApiError, bindApiOwner, devices as devicesApi, pair } from "../../app/api-client";
import { devicesDoor, useDevicesDoor } from "../../app/(product)/mailbox/devices-door";

/**
 * SETTINGS › DEVICES OVER THE WEB'S REAL FILLING and a server that records what it is asked. Each verb the server
 * guards with a fresh factor is tried as it is; only the server's refusal asks the factor; the verified factor
 * sends the same request once more; Cancel, a factor that lands late and a pane that was left send nothing. The
 * pairing link is assembled once and is nowhere but in what the person reads and scans.
 *
 * One flavour a process: this file is the managed build (`devices-door-selfhost.test.tsx` is the other arm).
 */
vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
});

const DEVICES = "GET /api/devices";
const CODES = "GET /api/pair";
const HELLO = "GET /api/hello";
const MINT = "POST /api/pair";
const REVOKE = "DELETE /api/pair/pt-1";
const REMOVE = "DELETE /api/devices/dev-2";
const BULK = "POST /api/devices/revoke-web-sessions";
const STEP_UP = () => refusal(403, "step_up_required");
const GONE = () => new Response(null, { status: 204 });

/* What only the person may see: what the server made for the new device, and the link that carries it. */
const MADE = createHash("sha256").update("devices-door fixture").digest("base64url");
const LINK = `https://api.ohmail.app/pair#${MADE}`;
const SECRETS = [MADE, LINK];

const at = {
  createdAt: "2026-08-10T09:00:00.000Z",
  lastSeenAt: "2026-08-19T09:00:00.000Z",
  ip: "",
  pushToken: null,
};
const THIS = { id: "dev-1", kind: "web", label: "", current: true, named: false, ...at };
const PHONE = {
  id: "dev-2",
  kind: "mobile-android",
  label: "Mila's phone",
  current: false,
  named: true,
  ...at,
};
const plain = (n: number) => ({
  id: `sess-${n}`,
  kind: "web",
  label: "",
  current: false,
  named: false,
  ...at,
});
const CODE = {
  id: "pt-1",
  grant: "device-pair",
  label: "Ben",
  createdAt: "2026-08-20T09:00:00.000Z",
  expiresAt: "2026-08-20T09:05:00.000Z",
  consumedAt: null,
  revokedAt: null,
  status: "live",
};
const minted = (id: string, label = "") =>
  json({ id, token: MADE, grant: "device-pair", label, expiresAt: CODE.expiresAt });

let sessions: unknown[] = [];
let codes: unknown[] = [];
let flavor = "managed";
let server: Server;
let written: ReturnType<typeof catchConsole>;
let clipboard: ReturnType<typeof watchClipboard>;
let mounted = false;
const slot = { asked: null as GatedAsk | null };
/** The factor's dialog, stood in for: its ceremony is the doors' own. What is held here is what the pane asks. */
const factor: FactorSlot = (ask) => {
  slot.asked = ask;
  return <p>the factor is asked</p>;
};
const factorAsked = () => screen.queryByText("the factor is asked") !== null;

beforeEach(() => {
  sessions = [THIS, PHONE, plain(1), plain(2)];
  codes = [CODE];
  flavor = "managed";
  slot.asked = null;
  written = catchConsole();
  clipboard = watchClipboard();
  server = serve({
    [DEVICES]: () => json({ items: sessions }),
    [CODES]: () => json({ items: codes }),
    [HELLO]: () => hello(flavor),
    [MINT]: () => minted("pt-9"),
    [REVOKE]: GONE,
    [REMOVE]: GONE,
    [BULK]: () => json({ revoked: 2 }),
  });
});
afterEach(async () => {
  if (mounted) {
    await teardownConfirmEnv();
    bindApiOwner(null);
    mounted = false;
    window.history.replaceState(null, "", "/");
    resetSessionTruthForTests();
    resetStorageOwnerForTest();
  }
  cleanup();
  server.restore();
  written.restore();
  clipboard.restore();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

function Pane() {
  return <DevicesPane model={useDevices(useDevicesDoor())} factor={factor} qr={qr} />;
}
async function opened(lang: "en" | "de" = "en") {
  const view = render(
    <Words lang={lang}>
      <Pane />
    </Words>,
  );
  await settle();
  return view;
}
async function openMountedDevices() {
  const deviceFetch = globalThis.fetch;
  resetSessionTruthForTests();
  resetStorageOwnerForTest();
  installConfirmEnv();
  mounted = true;
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  rememberOwner();
  const shellFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const { pathname } = new URL(String(input), window.location.origin);
    return pathname === "/api/devices" || pathname === "/api/pair" || pathname === "/api/hello"
      ? deviceFetch(input, init)
      : shellFetch(input, init);
  };
  window.location.hash = "#/settings/devices";
  await mountCloudShell();
  await tick(2500);
}

const said = (words: string): boolean => (document.body.textContent ?? "").includes(words);
const dialog = () => screen.getByRole("dialog");
const press = async (name: string, inside: HTMLElement = document.body) => {
  await act(async () => {
    fireEvent.click(within(inside).getByRole("button", { name }));
  });
  await (mounted ? tick(0) : settle());
};
const typeName = (name: string) =>
  act(async () => {
    fireEvent.change(screen.getByRole("textbox", { name: en.devices.addFor }), { target: { value: name } });
  });

describe("a refused verb, as its word", () => {
  const say = (): string => "said by the renderer";
  const SAID = { day: (iso: string) => `day ${iso}`, clock: (iso: string) => `clock ${iso}` };
  const FACTOR = { ok: false, word: "factor" };
  const SIGN_IN = { ok: false, word: "sign_in" };
  const SAID_SO = { ok: false, word: "said", said: "said by the renderer" };
  const TABLE = [
    [new ApiError(403, "step_up_required", "x"), FACTOR],
    [new ApiError(403, "enrollment_incomplete", "x"), SIGN_IN],
    [new ApiError(403, "forbidden", "x"), SIGN_IN],
    [new ApiError(401, "unauthorized", "x"), SIGN_IN],
    [new ApiError(401, "step_up_required", "x"), SIGN_IN],
    [new ApiError(400, "validation_failed", "x"), SAID_SO],
    [new ApiError(500, "internal", "x"), SAID_SO],
    [new Error("x"), SAID_SO],
  ] as const;

  it("each of the four verbs reads the refusal in the order the pane always did", async () => {
    const door = devicesDoor(say, SAID);
    for (const [refused, word] of TABLE) {
      vi.spyOn(pair, "mintDevice").mockRejectedValueOnce(refused);
      vi.spyOn(pair, "revoke").mockRejectedValueOnce(refused);
      vi.spyOn(devicesApi, "revoke").mockRejectedValueOnce(refused);
      vi.spyOn(devicesApi, "revokeWebSessions").mockRejectedValueOnce(refused);
      const answers = [
        await door.add("Ben"),
        await door.revokeCode("pt-1"),
        await door.remove("dev-2"),
        await door.signOutWeb(),
      ];
      expect(answers, String(refused)).toEqual([word, word, word, word]);
    }
  });

  it("a code that is already gone is revoked: 404 is taken, for that verb alone", async () => {
    const door = devicesDoor(say, SAID);
    const gone = new ApiError(404, "not_found", "x");
    vi.spyOn(pair, "revoke").mockRejectedValueOnce(gone);
    vi.spyOn(devicesApi, "revoke").mockRejectedValueOnce(gone);
    expect(await door.revokeCode("pt-1")).toEqual({ ok: true, value: null });
    expect(await door.remove("dev-2")).toEqual(SAID_SO);
  });

  it("a read that failed is said, whatever refused it and whichever list it was", async () => {
    const door = devicesDoor(say, SAID);
    for (const failed of [
      new ApiError(403, "step_up_required", "x"),
      new ApiError(401, "unauthorized", "x"),
      new ApiError(503, "internal", "x"),
    ]) {
      vi.spyOn(devicesApi, "list").mockRejectedValueOnce(failed);
      expect(await door.read()).toEqual(SAID_SO);
      vi.spyOn(pair, "list").mockRejectedValueOnce(failed);
      expect(await door.read()).toEqual(SAID_SO);
    }
  });

  it("answers the lists as the pane names them: kinds, who named each device, plain sign-ins, live pairing codes alone", async () => {
    const row = (id: string, kind: string, label: string) => ({
      id,
      kind,
      label,
      current: false,
      named: true,
      ...at,
    });
    sessions = [
      THIS,
      PHONE,
      row("dev-l", "desktop-linux", "ohmail for Linux"),
      row("dev-m", "macos", "ohmail for Mac"),
      row("dev-w", "desktop-windows", "gaming rig"),
      row("dev-i", "mobile-ios", "ohmail for Mac"),
      row("dev-x", "kind-from-the-future", "mystery"),
      { id: "dev-o", kind: "web", label: "Web", current: false, ...at },
    ];
    codes = [
      CODE,
      { ...CODE, id: "pt-2", label: "" },
      { ...CODE, id: "pt-3", grant: "invite" },
      { ...CODE, id: "pt-4", status: "consumed" },
      { ...CODE, id: "pt-5", status: "expired" },
      { ...CODE, id: "pt-6", status: "revoked" },
    ];
    const days = { added: `day ${at.createdAt}`, seen: `day ${at.lastSeenAt}` };
    const listed = (id: string, kind: string, name: unknown, over = {}) => ({
      id,
      kind,
      name,
      current: false,
      plainWeb: false,
      ...days,
      ...over,
    });
    expect(await devicesDoor(say, SAID).read()).toEqual({
      ok: true,
      value: {
        sessions: [
          listed("dev-1", "web", { by: "nobody" }, { current: true, plainWeb: true }),
          listed("dev-2", "android", { by: "person", said: "Mila's phone" }),
          listed("dev-l", "linux", { by: "ohmail" }),
          listed("dev-m", "mac", { by: "ohmail" }),
          listed("dev-w", "windows", { by: "person", said: "gaming rig" }),
          listed("dev-i", "ios", { by: "person", said: "ohmail for Mac" }),
          listed("dev-x", "other", { by: "person", said: "mystery" }),
          listed("dev-o", "web", { by: "person", said: "Web" }),
        ],
        codes: [
          { id: "pt-1", name: "Ben", until: `clock ${CODE.expiresAt}` },
          { id: "pt-2", name: null, until: `clock ${CODE.expiresAt}` },
        ],
      },
    });
  });

  it("groups the browser sessions only where the server is the managed service or a self-hosted one", async () => {
    const door = devicesDoor(say, SAID);
    for (const [answer, groups] of [
      ["managed", true],
      ["selfhost", true],
      ["desktop-host", false],
      ["local", false],
    ] as const) {
      flavor = answer;
      expect(await door.groupsWebSessions(), answer).toBe(groups);
    }
    server.answer(HELLO, refusal(500, "internal"), OFFLINE);
    expect([await door.groupsWebSessions(), await door.groupsWebSessions()]).toEqual([false, false]);
  });
});

describe("opening the pane", () => {
  it("asks both lists and the server's flavour, each once, however often the pane is drawn again", async () => {
    const view = await opened();
    // Three requests and no fourth. The order they leave in is the client's lane's: the visit holds it.
    const asked = [`${DEVICES} {}`, `${HELLO} {}`, `${CODES} {}`];
    expect([...server.asked()].sort()).toEqual(asked);
    view.rerender(
      <Words>
        <Pane />
      </Words>,
    );
    await settle();
    expect([...server.asked()].sort()).toEqual(asked);
  });

  it("says days and times as the product's one formatter says them", async () => {
    await opened();
    const day = (iso: string) =>
      new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(iso));
    const clock = new Intl.DateTimeFormat("en", { timeStyle: "short", timeZone: "UTC" }).format(
      new Date(CODE.expiresAt),
    );
    expect(said(day(at.createdAt))).toBe(true);
    expect(said(day(at.lastSeenAt))).toBe(true);
    expect(screen.getByRole("group", { name: "Ben" }).textContent).toContain(clock);
    expect(said(day(CODE.expiresAt))).toBe(false);
  });

  it("a read that failed: could not be loaded and Try again, which reads once more; never an empty list", async () => {
    server.answer(DEVICES, refusal(500, "internal"));
    await opened();
    expect(said(en.devices.loadFailed)).toBe(true);
    expect(screen.queryAllByRole("group")).toHaveLength(0);
    await press(en.devices.retry);
    expect(said(en.devices.loadFailed)).toBe(false);
    expect(screen.getByRole("group", { name: "Mila's phone" })).toBeTruthy();
    expect(server.on(DEVICES)).toHaveLength(2);
  });

  it("the other browser sessions are one line only where the server's flavour says so", async () => {
    await opened();
    expect(screen.getAllByRole("button", { name: en.devices.remove })).toHaveLength(1);
    expect(screen.getByRole("button", { name: en.devices.webGroupAction })).toBeTruthy();
    cleanup();
    flavor = "desktop-host";
    await opened();
    expect(screen.getAllByRole("button", { name: en.devices.remove })).toHaveLength(3);
    expect(screen.queryByRole("button", { name: en.devices.webGroupAction })).toBeNull();
  });

  it("an app that paired without a name is named in the reader's language, not as the server stored it", async () => {
    sessions = [THIS, { ...PHONE, kind: "desktop-linux", label: "ohmail for Linux" }];
    await opened("de");
    expect(said("ohmail for Linux")).toBe(false);
    const german = de.devices.mintedName.replace("{kind}", de.devices.kindLinux);
    expect(screen.getByRole("group", { name: german })).toBeTruthy();
    expect(screen.getByRole("button", { name: de.devices.addAction })).toBeTruthy();
  });
});

describe("the pairing link, made once", () => {
  it("one request with the grant and the name; the picture, the printed link and the clipboard are one link, on the API's origin", async () => {
    server.answer(MINT, minted("pt-9", "Ben"));
    await openMountedDevices();
    await typeName("  Ben ");
    await press(en.devices.addAction);
    expect(server.on(MINT).map((sent) => sent.body)).toEqual([{ grant: "device-pair", label: "Ben" }]);
    expect(scanned()).toBe(LINK);
    expect((document.body.textContent ?? "").split(LINK)).toHaveLength(2);
    expect(said(en.devices.copied)).toBe(false);
    await press(en.devices.copyLink);
    expect(clipboard.written).toEqual([LINK]);
    expect(said(en.devices.copied)).toBe(true);
    expect(server.on(MINT)).toHaveLength(1);
  });

  it("no name sends no name, and a clipboard that refuses never says copied", async () => {
    clipboard.restore();
    clipboard = watchClipboard(false);
    await opened();
    await press(en.devices.addAction);
    expect(server.on(MINT).map((sent) => sent.keys)).toEqual([["grant"]]);
    await press(en.devices.copyLink);
    expect(said(en.devices.copyFailed)).toBe(true);
    expect(said(en.devices.copied)).toBe(false);
  });

  it("is in nothing but what is read and scanned; Done takes it off the page and reads both lists again", async () => {
    await opened();
    await press(en.devices.addAction);
    expect(said(LINK)).toBe(true);
    expect(foundIn(SECRETS, server, written.lines)).toEqual([]);
    await press(en.devices.copyLink);
    expect(foundIn(SECRETS, server, written.lines)).toEqual([]);
    server.forget();
    await press(en.devices.mintedDone);
    expect(document.body.innerHTML).not.toContain(MADE);
    expect(scanned()).toBeNull();
    expect(server.asked()).toEqual([`${DEVICES} {}`, `${CODES} {}`]);
    expect(foundIn(SECRETS, server, written.lines)).toEqual([]);
  });

  it("comes down with its own row when that code is revoked, and stays up when another is", async () => {
    codes = [CODE, { ...CODE, id: "pt-9", label: "" }];
    server.answer("DELETE /api/pair/pt-9", GONE());
    await opened();
    await press(en.devices.addAction);
    await press(en.devices.revoke, screen.getByRole("group", { name: "Ben" }));
    expect(scanned()).toBe(LINK);
    await press(en.devices.revoke, screen.getByRole("group", { name: en.devices.codeFallback }));
    expect(server.on("DELETE /api/pair/pt-9")).toHaveLength(1);
    expect(scanned()).toBeNull();
    expect(document.body.innerHTML).not.toContain(MADE);
    expect(said(en.devices.revoked)).toBe(true);
  });

  it("a code the server no longer has is revoked all the same: that is said, and the lists are read again", async () => {
    server.answer(REVOKE, refusal(404, "not_found"));
    await opened();
    server.forget();
    await press(en.devices.revoke);
    expect(server.asked()).toEqual([`${REVOKE} {}`, `${DEVICES} {}`, `${CODES} {}`]);
    expect(said(en.devices.revoked)).toBe(true);
    expect(factorAsked()).toBe(false);
  });
});

describe("a removal is asked about first", () => {
  it("a device: no request leaves before the question's own answer", async () => {
    await opened();
    await press(en.devices.remove);
    expect(dialog().textContent).toContain("Mila's phone");
    expect(server.on(REMOVE)).toHaveLength(0);
    await press(en.devices.cancel, dialog());
    expect(server.on(REMOVE)).toHaveLength(0);
    await press(en.devices.remove);
    await press(en.devices.remove, dialog());
    expect(server.on(REMOVE)).toHaveLength(1);
    expect(said(en.devices.removed)).toBe(true);
  });

  it("the other browser sessions: one request from the question, and how many ended is said as the server counted", async () => {
    server.answer(BULK, json({ revoked: 7 }));
    await opened();
    await press(en.devices.webGroupAction);
    expect(server.on(BULK)).toHaveLength(0);
    await press(en.devices.webGroupAction, dialog());
    expect(server.on(BULK).map((sent) => sent.body)).toEqual([{}]);
    expect(
      screen
        .getAllByRole("status")
        .map((each) => each.textContent)
        .join(""),
    ).toContain("7");
  });
});

/** The four guarded verbs: the request each is, and the presses that send it. */
const VERBS: readonly {
  readonly name: string;
  readonly line: string;
  readonly keys: readonly string[];
  readonly send: () => Promise<void>;
}[] = [
  { name: "a new device", line: MINT, keys: ["grant"], send: () => press(en.devices.addAction) },
  { name: "a code revoked", line: REVOKE, keys: [], send: () => press(en.devices.revoke) },
  {
    name: "a device signed out",
    line: REMOVE,
    keys: [],
    send: async () => {
      await press(en.devices.remove);
      await press(en.devices.remove, dialog());
    },
  },
  {
    name: "the other browser sessions signed out",
    line: BULK,
    keys: [],
    send: async () => {
      await press(en.devices.webGroupAction);
      await press(en.devices.webGroupAction, dialog());
    },
  },
];

/** The pane opened, and the verb sent to a server that refuses it for the factor. */
async function refusedOnce(verb: (typeof VERBS)[number], ...more: Response[]) {
  const view = await opened();
  server.answer(verb.line, STEP_UP(), ...more);
  await verb.send();
  return view;
}

for (const verb of VERBS) {
  describe(`${verb.name}, guarded by the factor`, () => {
    it("is tried as it is; the refusal asks the factor; nothing more leaves before it verifies; then once more, the same", async () => {
      await refusedOnce(verb);
      expect(server.on(verb.line)).toHaveLength(1);
      expect(factorAsked()).toBe(true);
      await settle();
      expect(server.on(verb.line)).toHaveLength(1);
      await act(async () => slot.asked!.onVerified());
      await settle();
      expect(server.on(verb.line).map((sent) => sent.keys)).toEqual([verb.keys, verb.keys]);
      expect(factorAsked()).toBe(false);
      expect(said(en.devices.stepUpExpired)).toBe(false);
    });

    it("a factor that says it verified twice over sends the request once", async () => {
      await refusedOnce(verb);
      const asked = slot.asked!;
      await act(async () => {
        asked.onVerified();
        asked.onVerified();
      });
      await settle();
      expect(server.on(verb.line)).toHaveLength(2);
    });

    it("refused again after the factor: the way back in, no second dialog, no third request", async () => {
      await refusedOnce(verb, STEP_UP());
      await act(async () => slot.asked!.onVerified());
      await settle();
      expect(server.on(verb.line)).toHaveLength(2);
      expect(factorAsked()).toBe(false);
      expect(said(en.devices.stepUpExpired)).toBe(true);
    });

    it("Cancel sends nothing more, and a factor that lands after it says nothing ran", async () => {
      await refusedOnce(verb);
      const asked = slot.asked!;
      await act(async () => asked.onCancel());
      expect(factorAsked()).toBe(false);
      await act(async () => asked.onDiscarded());
      await act(async () => asked.onVerified());
      await settle();
      expect(server.on(verb.line)).toHaveLength(1);
      expect(said(en.devices.stepUpCancelledNothingRan)).toBe(true);
    });

    it("a pane left while the factor is asked sends nothing afterwards", async () => {
      const view = await refusedOnce(verb);
      const asked = slot.asked!;
      view.unmount();
      server.forget();
      await act(async () => asked.onVerified());
      await settle();
      expect(server.asked()).toEqual([]);
    });
  });
}
