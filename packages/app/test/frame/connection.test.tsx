/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useMemo } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailState, MailStateKey } from "@ohmail/app-logic/mail-state/mail-state";
import { POLL_MS } from "@ohmail/app-logic/session/sync-scheduler";
import type { HostConnectionState } from "../../src/host/index.js";
import { NONE } from "../../src/host/index.js";
import {
  ANNOUNCE_MS,
  connectionOf,
  useConnectionNotice,
  type ConnectionActs,
  type ConnectionInput,
} from "../../src/frame/connection.js";
import type { Recover } from "../../src/frame/contract.js";
import { NoticeHost } from "../../src/frame/NoticeHost.js";
import { createNoticeStore } from "../../src/frame/notice-store.js";
import { fillOver, TextProvider, type Messages } from "../../src/text/index.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import { Frame } from "../../src/frame/Frame.js";
import { useConnectionFeed } from "../../src/frame/commands.js";
import type { PaneProps } from "../../src/frame/contract.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress } from "../support/fake-window.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The two sentences of today's mailbox pane the frame says a refusal with. */
const MAILBOXES: Record<"en" | "de", Messages> = {
  en: {
    mailboxes: {
      err_auth: "The mail server refused the password.",
      err_connect: "The mail server could not be reached.",
    },
  },
  de: {
    mailboxes: {
      err_auth: "Der Mailserver hat das Passwort abgelehnt.",
      err_connect: "Der Mailserver war nicht erreichbar.",
    },
  },
};

function ladder(key: MailStateKey, more: Partial<MailState> = {}): MailState {
  return {
    key,
    clock: false,
    count: 0,
    total: null,
    reason: null,
    errorCode: null,
    asOf: null,
    address: null,
    minutes: null,
    slow: false,
    screenerCandidate: false,
    pending: 0,
    filing: null,
    continuesAtFolder: null,
    settled: true,
    owed: false,
    ...more,
  } as MailState;
}
const quietHost: HostConnectionState = {
  state: "stale",
  words: {
    title: "The computer went quiet",
    detail: "Mail arrives once it answers.",
    link: { href: "/pair", label: "Pair again" },
  },
};
const input = (mail: MailState | null, more: Partial<ConnectionInput> = {}): ConnectionInput => ({
  mail,
  online: true,
  session: "live",
  host: null,
  ...more,
});

function Feed({ input, acts }: { input: ConnectionInput; acts: ConnectionActs }) {
  const store = useMemo(createNoticeStore, []);
  const notice = useConnectionNotice(input, acts);
  useEffect(() => store.post("connection", notice ? [notice] : []), [store, notice]);
  return <NoticeHost store={store} place="rail" />;
}
function said(
  given: ConnectionInput,
  locale: "en" | "de" = "en",
  recover: Recover = NONE,
  more: Partial<ConnectionActs> = {},
) {
  const acts: ConnectionActs = { recover, mailboxes: vi.fn(), help: vi.fn(), follow: vi.fn(), ...more };
  const view = (next: ConnectionInput) => (
    <TextProvider
      locale={locale}
      messages={fillOver(FRAME_WORDS[locale], MAILBOXES[locale])}
      timeZone="Europe/Zurich"
    >
      <Feed input={next} acts={acts} />
    </TextProvider>
  );
  const { rerender } = render(view(given));
  return { acts, again: (next: ConnectionInput) => rerender(view(next)) };
}
const status = () => screen.queryAllByRole("status").map((el) => el.textContent);

describe("the connection states: one closed set", () => {
  const AT = "2026-11-14T08:10:00Z";
  const TABLE: [string, ConnectionInput, string, string][] = [
    [
      "stopped",
      input(ladder("stopped")),
      "Signed out Start ohmail again to sign in.",
      "Abgemeldet Starte ohmail neu, um dich anzumelden.",
    ],
    [
      "ownerLost",
      input(ladder("ownerLost")),
      "Nothing syncs here This window lost track of its account.",
      "Hier wird nichts synchronisiert Dieses Fenster weiß nicht mehr, zu welchem Account es gehört.",
    ],
    [
      "noMailbox",
      input(ladder("noMailbox")),
      "No mailbox connectedConnect a mailbox",
      "Kein Postfach verbundenPostfach verbinden",
    ],
    ["offline", input(ladder("stale", { asOf: AT }), { online: false }), "", ""],
    ["hostQuiet", input(ladder("quiet"), { host: quietHost }), "", ""],
    [
      "mailServerDown",
      input(ladder("mailboxError", { errorCode: "connect", minutes: 31, address: "box" })),
      "box: Mail server unreachableOpen Mailboxes",
      "box nicht erreichtPostfächer öffnen",
    ],
    [
      "mailboxPassword",
      input(ladder("mailboxError", { errorCode: "auth" })),
      "Mailbox sign-in neededOpen Mailboxes",
      "Das Passwort wurde abgelehntPostfächer öffnen",
    ],
    [
      "mailboxSync",
      input(ladder("blocked", { minutes: 31, address: "box", minutes: 31 })),
      "box is not syncingOpen Mailboxes",
      "box synchronisiert nichtPostfächer öffnen",
    ],
    ["reconnecting", input(ladder("failing")), "", ""],
    ["behind", input(ladder("stale", { asOf: AT })), "", ""],
    ["firstSync", input(ladder("importing", { count: 412, total: 9120 })), "", ""],
    ["filing", input(ladder("filing", { pending: 3 })), "", ""],
  ];

  it.each(TABLE)("%s says its sentence in English and in German", (_, given, en, de) => {
    said(given);
    expect(status()).toEqual(en ? [en] : []);
    cleanup();
    said(given, "de");
    expect(status()).toEqual(de ? [de] : []);
  });

  /* The simulation's words: since when, read off the copy's last completed sync (the host's copy-age read), in the
     reader's zone: the hour and minute today, the date before today, and plain Offline where none is known. */
  describe("offline says since the copy last synced, on one line", () => {
    const NOW = new Date("2026-11-14T15:00:00Z");
    const AGES: [string, string | null, string, string][] = [
      ["today", "2026-11-14T08:24:00Z", "Offline since 09:24", "Offline seit 09:24"],
      [
        "today, though yesterday by the clock in London",
        "2026-11-13T23:30:00Z",
        "Offline since 00:30",
        "Offline seit 00:30",
      ],
      ["before today", "2026-11-12T20:00:00Z", "Offline since Nov 12", "Offline seit 12. Nov"],
      ["never known", null, "Offline", "Offline"],
    ];
    it.each(AGES)("%s stays out of the notice slot", (_, copyAsOf) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const given = input(ladder("failing"), { online: false, copyAsOf });
      said(given);
      expect(status()).toEqual([]);
      cleanup();
      said(given, "de");
      expect(status()).toEqual([]);
    });
  });

  it("reads every key of the ladder, and the quiet one says nothing", () => {
    expect(connectionOf(input(ladder("quiet")))).toBeNull();
    expect(connectionOf(input(ladder("awaiting")))).toBe("firstSync");
    expect(connectionOf(input(ladder("catchingUp")))).toBe("behind");
    expect(connectionOf(input(null))).toBeNull();
  });

  it("says nothing for a refused session: the host's own card speaks", () => {
    said(input(ladder("stopped"), { session: "refused" }));
    expect(status()).toEqual([]);
  });

  it("holds 'could not look' apart from 'nothing there': a failing read is reconnecting", () => {
    expect(connectionOf(input(ladder("failing")))).toBe("reconnecting");
    expect(connectionOf(input(ladder("failing"), { online: false }))).toBe("offline");
    expect(connectionOf(input(ladder("quiet"), { online: false }))).toBeNull();
  });

  it("lets the host's silence quiet the catching up", () => {
    expect(connectionOf(input(ladder("stale", { asOf: AT }), { host: quietHost }))).toBe("hostQuiet");
  });

  it("offers Sign in where the host can sign in again, and says it at once as an alert", () => {
    const recover = vi.fn();
    said(input(ladder("stopped")), "en", recover);
    expect(screen.getByRole("alert").textContent).toBe("Signed out");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(recover).toHaveBeenCalledWith("signIn");
  });

  it("offers no control where the host cannot recover, never a guessed one", () => {
    said(input(ladder("ownerLost")));
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("takes a mailbox's refusal to the mailboxes, and the host's link where it gives one", () => {
    const { acts } = said(input(ladder("mailboxError", { errorCode: "auth" })));
    fireEvent.click(screen.getByRole("button", { name: "Open Mailboxes" }));
    expect(acts.mailboxes).toHaveBeenCalledOnce();
    cleanup();
    const host = said(input(ladder("quiet"), { host: quietHost, copyAsOf: AT }));
    fireEvent.click(screen.getByRole("button", { name: "Pair again" }));
    expect(host.acts.follow).toHaveBeenCalledWith("/pair");
  });

  it("keeps first-sync counts in their view throughout import", () => {
    const { again } = said(input(ladder("importing", { count: 3935 })));
    expect(screen.queryByRole("status")).toBeNull();
    act(() => again(input(ladder("quiet"))));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("changing first-sync counts do not announce from the notice slot", () => {
    expect(ANNOUNCE_MS).toBe(POLL_MS);
    vi.useFakeTimers();
    const { again } = said(input(ladder("importing", { count: 100, total: 1000 })));
    expect(status()).toEqual([]);
    act(() => again(input(ladder("importing", { count: 120, total: 1000 }))));
    act(() => again(input(ladder("importing", { count: 160, total: 1000 }))));
    expect(status()).toEqual([]);
    act(() => vi.advanceTimersByTime(ANNOUNCE_MS));
    expect(status()).toEqual([]);
  });
});

/* As a browser shell leads: an assignment of the location. */
const assign = (href: string): void => window.location.assign(href);

describe("Connect, for a person with no mailbox", () => {
  const NO_MAILBOX = ladder("noMailbox");
  const fed: { setupHref: string | null } = { setupHref: null };
  function Feeding(_: PaneProps) {
    useConnectionFeed({ mail: NO_MAILBOX, online: true, setupHref: fed.setupHref, follow: assign });
    return <p>today</p>;
  }
  function mount() {
    const made = fakeHost({
      engine: NO_ENGINE,
      service: "self",
      scope: "acct-1",
      address: fakeAddress("#/reads"),
      places: { news: { id: "news", body: "today", rail: null, panes: { kind: "wide", Wide: Feeding } } },
    });
    const view = () => (
      <TextProvider locale="en" messages={FRAME_WORDS.en} timeZone="Europe/Zurich">
        <Frame host={made.host} />
      </TextProvider>
    );
    const { rerender } = render(view());
    return { made, again: () => rerender(view()) };
  }

  it("follows the setup link today's views feed, and goes to Settings' Mailboxes where none is fed", () => {
    window.location.hash = "";
    fed.setupHref = null;
    const { made, again } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Connect a mailbox" }));
    expect(made.address.read()).toBe("#/settings/mailboxes");
    made.address.visit("#/reads");
    fed.setupHref = "#/setup-step";
    again();
    fireEvent.click(screen.getByRole("button", { name: "Connect a mailbox" }));
    expect(window.location.hash).toBe("#/setup-step");
  });
});

describe("a filing's arm, and the shell's own why", () => {
  const filing = (arm: "working" | "waiting" | "stuck" | "elsewhere") =>
    ladder("filing", { pending: 2, filing: { arm, count: 2 } as never });

  it("names a filing that waits, is stuck or is filed elsewhere apart from one that works", () => {
    expect(connectionOf(input(filing("working")))).toBe("filing");
    expect(connectionOf(input(filing("waiting")))).toBe("filingWaits");
    expect(connectionOf(input(filing("stuck")))).toBe("filingStuck");
    expect(connectionOf(input(filing("elsewhere")))).toBe("filingElsewhere");
  });

  const reasoned: {
    mail: MailState;
    reason: { title?: string; line?: string; href?: string } | null;
    follow: (href: string) => void;
  } = { mail: ladder("quiet"), reason: null, follow: assign };
  function Feeding(_: PaneProps) {
    useConnectionFeed({
      mail: reasoned.mail,
      online: true,
      setupHref: null,
      reason: reasoned.reason,
      follow: reasoned.follow,
    });
    return <p>today</p>;
  }
  const others = (_: PaneProps) => <p>elsewhere</p>;
  function mount() {
    const made = fakeHost({
      engine: NO_ENGINE,
      service: "self",
      scope: "acct-1",
      address: fakeAddress("#/reads"),
      places: {
        news: { id: "news", body: "today", rail: null, panes: { kind: "wide", Wide: Feeding } },
        receipts: { id: "receipts", body: "other", rail: null, panes: { kind: "wide", Wide: others } },
      },
    });
    const view = () => (
      <TextProvider locale="en" messages={FRAME_WORDS.en} timeZone="Europe/Zurich">
        <Frame host={made.host} />
      </TextProvider>
    );
    const { rerender } = render(view());
    return {
      ...made,
      refresh: (mail: MailState) => {
        reasoned.mail = mail;
        rerender(view());
      },
    };
  }

  it("says a blocked mailbox's reason and a stuck filing's why in the shell's words, and its act leads where they say", () => {
    window.location.hash = "";
    reasoned.mail = ladder("blocked", { minutes: 31, address: "lena@example.com" });
    reasoned.reason = {
      line: "Another app organizes this mailbox · since 5 minutes",
      href: "#/settings/mailboxes?mailbox=mb1",
    };
    mount();
    expect(status()[0]).toContain("is not syncing");
    expect(status()[0]).not.toContain("Another app organizes this mailbox");
    fireEvent.click(screen.getByRole("button", { name: "Open Mailboxes" }));
    expect(window.location.hash).toBe("#/settings/mailboxes?mailbox=mb1");
    cleanup();
    reasoned.mail = filing("stuck");
    reasoned.reason = {
      title: "2 messages have not been filed for 75 minutes",
      line: "lena@example.com · the server refused",
    };
    mount();
    expect(status()).toEqual([]);
  });

  it("leads through the fed follow: a press on the notice's link calls it with its address", () => {
    const followed: string[] = [];
    reasoned.mail = ladder("blocked", { minutes: 31, address: "lena@example.com" });
    reasoned.reason = {
      line: "Another app organizes this mailbox",
      href: "#/settings/mailboxes?mailbox=mb2",
    };
    reasoned.follow = (href) => followed.push(href);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Open Mailboxes" }));
    expect(followed).toEqual(["#/settings/mailboxes?mailbox=mb2"]);
    reasoned.follow = assign;
  });

  it("keeps its own words where the state is the frame's alone: a signed-out session is never reworded", () => {
    reasoned.mail = ladder("stopped");
    reasoned.reason = { title: "something else", line: "a line" };
    mount();
    expect(status()).toEqual(["Signed out Start ohmail again to sign in.Hide"]);
  });

  it("keeps a calm connection notice hidden across places that do not feed it", () => {
    reasoned.mail = ladder("behind", { asOf: "2026-11-14T08:10:00Z" });
    reasoned.reason = null;
    const made = mount();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(status()).toEqual([]);
    act(() => made.address.visit("#/receipts"));
    act(() => made.address.visit("#/reads"));
    expect(status()).toEqual([]);
  });

  it("keeps late mail hidden through a clear and return, then shows a different connection kind", () => {
    reasoned.mail = ladder("behind", { asOf: "2026-11-14T08:10:00Z" });
    reasoned.reason = null;
    const made = mount();
    expect(status()[0]).toContain("hasn’t checked mail since");
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    made.refresh(ladder("quiet"));
    expect(status()).toEqual([]);
    made.refresh(ladder("behind", { asOf: "2026-11-14T08:10:00Z" }));
    expect(status()).toEqual([]);

    made.refresh(ladder("mailboxError", { errorCode: "auth", mailboxId: "mb2" }));
    expect(status()[0]).toContain("Mailbox sign-in needed");
    expect(screen.getByRole("button", { name: "Open Mailboxes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide" })).toBeTruthy();

    made.refresh(ladder("behind", { asOf: "2026-11-14T08:10:00Z" }));
    expect(status()[0]).toContain("hasn’t checked mail since");
    expect(screen.getByRole("button", { name: "Hide" })).toBeTruthy();
  });

  it("lets go of the reading when the part that fed it goes", () => {
    reasoned.mail = ladder("blocked", { minutes: 31, address: "lena@example.com" });
    reasoned.reason = null;
    const made = mount();
    expect(status()).toHaveLength(1);
    act(() => made.address.visit("#/receipts"));
    expect(screen.getByText("elsewhere")).toBeTruthy();
    expect(status()).toEqual([]);
  });
});

describe("quiet connection notices", () => {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  it("leaves a five-minute pause quiet and names a 31-minute pause with an action", () => {
    const view = said(input(ladder("behind", { asOf: ago(5) })));
    expect(screen.queryByRole("status")).toBeNull();
    view.again(input(ladder("behind", { asOf: ago(31) })));
    expect(screen.getByRole("status").textContent).toMatch(/hasn’t checked mail since/);
    fireEvent.click(screen.getByRole("button", { name: "Open Mailboxes" }));
    expect(view.acts.mailboxes).toHaveBeenCalledOnce();
  });

  it("keeps a ten-minute server failure quiet and shows a 31-minute failure", () => {
    const failed = (minutes: number) => input(ladder("mailboxError", { errorCode: "connect", minutes }));
    const view = said(failed(10));
    expect(screen.queryByRole("status")).toBeNull();
    view.again(failed(31));
    fireEvent.click(screen.getByRole("button", { name: "Open Mailboxes" }));
    expect(view.acts.mailboxes).toHaveBeenCalledOnce();
  });

  it("offers a mailbox sign-in immediately with an action", () => {
    const view = said(input(ladder("mailboxError", { errorCode: "auth", minutes: 0 })));
    fireEvent.click(screen.getByRole("button", { name: "Open Mailboxes" }));
    expect(view.acts.mailboxes).toHaveBeenCalledOnce();
  });
});
