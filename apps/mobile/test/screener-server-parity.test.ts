/**
 * THE PHONE'S SCREENER LISTS WHAT THE ACCOUNT'S CUTLINE LISTS — measured, not assumed.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────────────────────
 *
 * With `GET /screener` listing six waiting senders, the phone's Screener showed two. Both ends
 * run the SAME rule — `activeSenderExpr` on the server, `senderActivity` in the engine, and
 * `packages/client-engine/test/consent-cutline.test.ts` pins the two resolutions to each other.
 * What differed were its INPUTS. `presentedOf` passed `consentPartition` nothing but the clock,
 * so the phone partitioned every mailbox on `DEFAULT_DORMANCY_DAYS` measured back from now, with
 * no baseline and no mode, while the server answered from `account_settings`. A sender the
 * account's own answer holds at the gate was filed by the phone into History — and at the time the
 * phone had NO History surface, so the row was in no list at all. It has one now
 * (`app/history.tsx`), which is what makes the retired arm below assertable rather than a drop.
 *
 * `GET /consent` has carried all three fields since mail 0056/0083, and this app already reads
 * that route once per boot and after every drain for the folders flag and the signatures. It was
 * throwing the cutline half of the answer away.
 *
 * ── WHAT IS DRIVEN HERE ───────────────────────────────────────────────────────────────────
 *
 * Six senders' mail sits in the gate folder on a real loopback server; the real engine drains it
 * through `bootEngine`; the screens' own `liveScreener(presentedOf(…))` is read. Four of the six
 * are older than the product default and read, so the default window retires them and the
 * account's answer (`all_time`) does not.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FOLDER_OF_VIEW, senderActivity, type EngineMessage } from "@ohmail/client-engine";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import {
  liveHistory, liveScreener, presentedOf, presentedWorld, screeningAnswered,
  SCREENING_UNANSWERED, SCREENING_UNSUPPLIED, type WorldView,
} from "../src/state/live";
import { readFoldersEnabled } from "../src/net/consent";
import type { ConnectedSession } from "../src/net/pairing";
import { dto, listen, mailServer, type Dto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const NOW = new Date("2026-09-11T12:00:00.000Z");
const view: WorldView = { now: NOW, zone: "UTC" };

/** The account's stored answer — a real baseline and the mode the Settings control writes. */
const ACCOUNT = {
  dormancyDays: 60,
  screeningBaselineAt: "2026-01-01T00:00:00.000Z",
  screeningScope: "all_time",
} as const;

/** Recent and unread: active under ANY window. */
const RECENT = "2026-09-05T08:00:00.000Z";
/** Old and read: retired by the product default, held by the account's answer. */
const OLD = "2024-02-01T08:00:00.000Z";
/**
 * Read, and between the two cutoffs — older than `now - 60d` (2026-07-13) and newer than
 * `baseline - 60d` (2025-11-02). The BASELINE alone decides this sender, which is why the arm
 * below exists: under `all_time` the mode wins above the baseline in `cutlineFor`, so a fixture
 * with only that mode cannot watch the baseline fail.
 */
const MIDDLE = "2026-03-01T08:00:00.000Z";
/**
 * Read, and decided by the DIAL alone: inside `baseline - 365d` (2025-01-01) and outside
 * `baseline - 60d` (2025-11-02). A fixture whose dial happens to equal the product default
 * cannot watch the dial fail, which is what the first draft of this file measured.
 */
const WIDE = "2025-06-01T08:00:00.000Z";

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })(),
};

/** A minimal session for the consent seam: ONE origin, a plain fetch — the seam needs no more. */
function sessionFor(origin: string): ConnectedSession {
  /* THE SESSION'S OWN TRANSPORT, which is what the consent reads take: a door that mints its own
     credential has no bearer to rotate, so `session.fetch` is the one field every reader uses.
     A double offering `bearer.fetch` alone measured nothing here — the read threw and its catch
     answered `null`, which reads as "the server is too old to carry these fields". */
  return {
    profile: { origin },
    fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
  } as unknown as ConnectedSession;
}

/** Six strangers at the gate — two recent and unread, four old and read. */
function sixWaiting(fake: ReturnType<typeof mailServer>): void {
  const at = (n: number, date: string, unread: boolean) =>
    fake.addMessage(dto(`s${n}`, {
      subject: `From stranger ${n}`,
      folder: FOLDER_OF_VIEW.screener,
      from: { name: `Stranger ${n}`, address: `stranger${n}@fake.test` },
      date,
      unread,
    }));
  at(1, RECENT, true);
  at(2, RECENT, true);
  for (const n of [3, 4, 5, 6]) at(n, OLD, false);
}

/** Two more, read, that only the account's BASELINE keeps at the gate. */
function twoMiddling(fake: ReturnType<typeof mailServer>): void {
  for (const n of [7, 8]) {
    fake.addMessage(dto(`s${n}`, {
      subject: `From stranger ${n}`,
      folder: FOLDER_OF_VIEW.screener,
      from: { name: `Stranger ${n}`, address: `stranger${n}@fake.test` },
      date: MIDDLE,
      unread: false,
    }));
  }
}

async function bootOn(fake: ReturnType<typeof mailServer>, origin: string) {
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error(`boot refused: ${boot.kind === "refused" ? boot.reason : ""}`);
  await boot.verifyIdentity();
  await boot.engine.start();
  return boot;
}

describe("the account's cutline answer travels to the phone", () => {
  it("the consent read carries the three fields `GET /screener` resolves from", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.setScreening({ ...ACCOUNT });
      const ans = await readFoldersEnabled(sessionFor(origin));
      expect(ans).not.toBeNull();
      expect(ans!.screening).toEqual({
        dormancyDays: 60,
        baselineAt: "2026-01-01T00:00:00.000Z",
        scope: "all_time",
      });
    } finally {
      fake.server.close();
    }
  });

  it("a server too old to carry them answers NO ANSWER, never a window of its own", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.setScreening(undefined);
      const ans = await readFoldersEnabled(sessionFor(origin));
      expect(ans).not.toBeNull();
      // `null` is "this server said nothing about the cutline" — distinct from every window a
      // number could spell, and what makes the non-dropping branch below reachable.
      expect(ans!.screening).toBeNull();
    } finally {
      fake.server.close();
    }
  });

  it("a malformed dormancy or an unknown mode does not throw the whole answer away", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.setScreening({
        dormancyDays: "sixty" as unknown as number,
        screeningBaselineAt: 7 as unknown as string,
        screeningScope: "next_tuesday",
      });
      const ans = await readFoldersEnabled(sessionFor(origin));
      // The narrow reading for the mode (screening everything is a lot of mail to unfile by
      // hand), the product default for the dial, and no baseline for an unreadable instant.
      expect(ans!.screening).toEqual({ dormancyDays: null, baselineAt: null, scope: "window" });
    } finally {
      fake.server.close();
    }
  });
});

describe("six waiting senders on the server are six on the phone", () => {
  it("the account's own answer holds all six at the gate", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.setScreening({ ...ACCOUNT });
      sixWaiting(fake);
      const boot = await bootOn(fake, origin);
      const reader = boot.engine.read();
      expect(reader.list<EngineMessage>("message")).toHaveLength(6);

      const answered = presentedOf(reader, NOW, false, screeningAnswered({
        dormancyDays: ACCOUNT.dormancyDays,
        baselineAt: ACCOUNT.screeningBaselineAt,
        scope: ACCOUNT.screeningScope,
      }));
      const rows = liveScreener(answered, view).waiting;
      expect(rows).toHaveLength(6);
      expect(rows.map((r) => r.address).sort()).toEqual(
        [1, 2, 3, 4, 5, 6].map((n) => `stranger${n}@fake.test`),
      );
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("THE REPRODUCTION: the product default alone shows two of the six", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.setScreening({ ...ACCOUNT });
      sixWaiting(fake);
      const boot = await bootOn(fake, origin);
      const reader = boot.engine.read();

      // The defect's own inputs: no dormancy, no baseline, no mode. Four senders are retired by
      // a window the account never asked for — into a History the phone now has, which is the
      // difference between a wrong list and no list.
      const defaultInputs = screeningAnswered({ dormancyDays: null, baselineAt: null, scope: "window" });
      const parted = presentedWorld(reader, NOW, false, defaultInputs);
      const defaulted = liveScreener(parted.reader, view).waiting;
      expect(defaulted).toHaveLength(2);
      expect(defaulted.map((r) => r.address).sort()).toEqual([
        "stranger1@fake.test", "stranger2@fake.test",
      ]);
      /* THE OTHER ARM OF THE SAME PARTITION, which is where the four went. Four retired senders,
         one message each, so the two lists ACCOUNT FOR ALL SIX: the drop this fix is about is
         now a list, and a sender is in exactly one of the two. */
      const retired = liveHistory(reader, parted.history, view).items;
      expect(retired.map((m) => m.from.address).sort()).toEqual(
        [3, 4, 5, 6].map((n) => `stranger${n}@fake.test`),
      );
      expect(defaulted.length + retired.length).toBe(6);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("the BASELINE alone holds two senders the sliding window retires", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      // The mode OFF, so the baseline is the only thing that can decide: an account that
      // finished screening its backlog measures the window from THAT instant, and a stranger
      // who wrote after it never ages out unanswered.
      const windowed = screeningAnswered({
        dormancyDays: 60, baselineAt: "2026-01-01T00:00:00.000Z", scope: "window",
      });
      twoMiddling(fake);
      const boot = await bootOn(fake, origin);
      const reader = boot.engine.read();

      const held = liveScreener(presentedOf(reader, NOW, false, windowed), view).waiting;
      expect(held.map((r) => r.address).sort()).toEqual([
        "stranger7@fake.test", "stranger8@fake.test",
      ]);
      // The product default alone retires both — the drop this fix is about, on the other axis.
      const defaulted = liveScreener(
        presentedOf(reader, NOW, false, screeningAnswered({ dormancyDays: 60, baselineAt: null, scope: "window" })),
        view,
      ).waiting;
      expect(defaulted).toHaveLength(0);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("the DIAL alone holds a sender the product default retires", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      // An account that widened its window to a year. The baseline is the same in both arms, so
      // the only thing that can decide this sender is the number of days.
      const base = "2026-01-01T00:00:00.000Z";
      fake.addMessage(dto("s9", {
        subject: "From stranger 9",
        folder: FOLDER_OF_VIEW.screener,
        from: { name: "Stranger 9", address: "stranger9@fake.test" },
        date: WIDE,
        unread: false,
      }));
      const boot = await bootOn(fake, origin);
      const reader = boot.engine.read();

      const wide = liveScreener(
        presentedOf(reader, NOW, false, screeningAnswered({ dormancyDays: 365, baselineAt: base, scope: "window" })),
        view,
      ).waiting;
      expect(wide.map((r) => r.address)).toEqual(["stranger9@fake.test"]);
      // The product default over the same baseline retires them.
      const narrow = liveScreener(
        presentedOf(reader, NOW, false, screeningAnswered({ dormancyDays: null, baselineAt: base, scope: "window" })),
        view,
      ).waiting;
      expect(narrow).toHaveLength(0);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("a held letter is dated by its ARRIVAL: an old Date received now waits, read or unread, after a reload too", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      const JUNE = "2026-06-02T09:00:00.000Z";
      const held = (id: string, who: string, unread: boolean, sortAt: string) => fake.addMessage({
        ...dto(id, { folder: FOLDER_OF_VIEW.screener, from: { name: who, address: `${who}@fake.test` }, date: JUNE, unread }),
        sortAt,
      } as Dto);
      held("u1", "udo", true, "2026-09-11T11:58:00.000Z");
      held("o1", "olga", false, "2026-09-11T11:58:00.000Z");
      // The same June letter, received in June: History, unread as it is.
      held("j1", "june", true, JUNE);
      const windowed = screeningAnswered({ dormancyDays: 60, baselineAt: "2026-09-01T00:00:00.000Z", scope: "window" });
      const lists = (reader: ReturnType<Awaited<ReturnType<typeof bootOn>>["engine"]["read"]>) => {
        const parted = presentedWorld(reader, NOW, false, windowed);
        return {
          waiting: liveScreener(parted.reader, view).waiting.map((r) => r.address).sort(),
          history: liveHistory(reader, parted.history, view).items.map((m) => m.id),
        };
      };
      const expected = { waiting: ["olga@fake.test", "udo@fake.test"], history: ["j1"] };
      const boot = await bootOn(fake, origin);
      expect(lists(boot.engine.read())).toEqual(expected);
      boot.store.close();
      // A second engine over the same store gives the same answer.
      const again = await bootOn(fake, origin);
      expect(lists(again.engine.read())).toEqual(expected);
      again.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("NOBODY CAN ANSWER: the server carries no cutline fields, so nobody is dropped", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      fake.setScreening(undefined);
      sixWaiting(fake);
      const boot = await bootOn(fake, origin);
      const reader = boot.engine.read();
      /* A server too old to hold the three fields answers nothing further, ever — so this is a
         SETTLED "retire nobody", not a wait, and the shelf stands rather than being withheld.
         An absent argument is the same state under its own name: this caller never supplied one.
         (The other half of the old `null` — a read still in flight — is the arm below.) */
      const unsupplied = liveScreener(presentedOf(reader, NOW, false, SCREENING_UNSUPPLIED), view);
      expect(unsupplied.waiting).toHaveLength(6);
      expect(unsupplied.waitingPending).toBe(false);
      expect(liveScreener(presentedOf(reader, NOW), view).waiting).toHaveLength(6);
      // …and no row is deleted from the projected mirror.
      expect(presentedOf(reader, NOW).list<EngineMessage>("message")).toHaveLength(6);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });
});

describe("the world layer actually hands the answer over", () => {
  /* The behavioural arms above drive `presentedOf` directly, so they would all stay green with
     the world layer still calling it on the clock alone — which is the defect. These two lines
     are the wiring, and there is no renderer here to drive them through. */
  const world = readFileSync(
    fileURLToPath(new URL("../src/state/world.tsx", import.meta.url)), "utf8",
  );
  /* The projection the provider runs as its one memo body (`world-memo-owner.test.ts`). */
  const projection = readFileSync(
    fileURLToPath(new URL("../src/state/world-projection.ts", import.meta.url)), "utf8",
  );

  it("the projection the lists read takes the cutline answer and the reader's addresses", () => {
    /* `posture` is `screening` with the standalone door's answer folded in — the one value the
       partition, the shelves and the reading screen all take (`cutline-unanswered.test.ts`). */
    expect(projection).toContain("presentedWorld(base, v.now, foldersOn, posture, inp.ownAddresses, imports)");
    expect(world).toContain("mailboxes, ownAddresses: addressesNow.current,");
  });

  it("BOTH arms come off that ONE call — the Screener's and History's", () => {
    /* Two `presentedWorld` calls would be one rule read at two clocks: a sender could be at the
       gate in one list and retired in the other, or in neither. The world derives the projection
       and the History rows from the same result. */
    expect(projection.match(/presentedWorld\(/g) ?? []).toHaveLength(1);
    expect(world.match(/presentedWorld\(/g) ?? []).toHaveLength(0);
    /* THE LISTS' READER IS THAT CALL'S OWN, through the routing window's overlay and nothing
       else. `presentAt` re-places the rows a held Move named for the length of its undo window
       (`held-routing.ts#routingReader`); it takes `world.reader` as its base, so both arms
       still come off the one call. What this refuses is a SECOND projection built beside it. */
    expect(projection).toContain("pres: routingReader(world.reader, inp.heldPlaces),");
    expect(projection).toContain("history.map((m) => historyRow(base, m, v))");
    expect(projection).toContain("Copy.historyMeta(history.length)");
  });

  it("the READING screen's view carries the same two facts as the lists'", () => {
    // A row the list showed under the account's window must open under it too; and reply-all
    // resolved against an empty own-address set leaves the reader in their own audience.
    const at = projection.indexOf("message: (id) => liveMessage(");
    expect(at).toBeGreaterThan(-1);
    const call = projection.slice(at, at + 260);
    expect(call).toContain("ownAddresses: inp.ownAddresses");
    expect(call).toContain("screening");
  });

  it("a session swap forgets the previous account's answer", () => {
    // Account A's window must never decide which of account B's senders are worth a decision —
    // and the state it goes back to is the one a session that has asked nothing is really in.
    expect(world).toContain("setScreening(SCREENING_UNANSWERED)");
  });
});

describe("the phone's rule is the engine's rule — the inputs were the whole defect", () => {
  it("the same six rows retire under a plain window and stay under the account's mode", () => {
    const messages: EngineMessage[] = [1, 2, 3, 4, 5, 6].map((n) => ({
      id: `s${n}`,
      folder: FOLDER_OF_VIEW.screener,
      from: { name: `Stranger ${n}`, address: `stranger${n}@fake.test` },
      date: n <= 2 ? RECENT : OLD,
      unread: n <= 2,
    } as EngineMessage));
    const windowed = senderActivity(messages, { now: NOW, dormancyDays: 60 });
    expect([...windowed.values()].filter((a) => a === "active")).toHaveLength(2);
    const allTime = senderActivity(messages, { now: NOW, dormancyDays: 60, screeningScope: "all_time" });
    expect([...allTime.values()].filter((a) => a === "active")).toHaveLength(6);
  });
});
