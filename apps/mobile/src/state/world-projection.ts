/**
 * THE MAILBOX AS THE SCREENS READ IT — the world's projection, renderer-free so a test drives the
 * shipped derivation over a real engine. `WorldProvider` builds one projector per engine and calls
 * it as its one memo body. Every list is computed when a screen first reads it and kept until an
 * input IT reads moves: the presented reader is kept until the list stamp ({@link listStamp}), the
 * reader's day or a presentation input moves, so a run caused by a settings or queue answer reuses
 * it and the engine's memos hit; each list keys on that reader, the view and its own extras;
 * History's rows are built only when read. Getters read the caches, never a run's locals.
 */
import { Copy } from "../copy";
import type { PhoneMailbox } from "../net/mailboxes";
import type { ServerWaitingSender } from "../net/screener";
import type { ImageRoute } from "../mail/remote-images";
import type { RelayedDecision } from "./relay";
import type { Scope } from "./model";
import { junkFolderSaid } from "./folders";
import {
  NOT_DERIVED_FROM,
  beginDerive,
  hiddenMessagesReader,
  historyRow,
  liveDrafts,
  liveFiles,
  liveFolder,
  liveFolderUnread,
  liveFolders,
  liveMessage,
  liveOhbox,
  livePiles,
  liveReads,
  liveReceipts,
  liveScheduled,
  liveScreener,
  liveSearch,
  liveTagged,
  liveTags,
  liveUnscreened,
  mirrorNewestFirst,
  phoneOrganizer,
  presentedOptions,
  presentedWorld,
  sendingMailboxId,
  soleMessageMailbox,
  storeRowOf,
  waitingOnScreen,
  zonedDayNumber,
  type ConsentOptions,
  type EntityReader,
  type ScreeningPosture,
  type SessionRenewalDoor,
  type StoreSearchWalker,
  type StoreTimelineWalker,
  type WorldActions,
  type WorldView,
} from "./live";
import { routingReader } from "./held-routing";
import type { World } from "./world";

type OhmailEngineLike = Parameters<typeof liveMessage>[0];

/**
 * THE STAMP THE LISTS KEY ON, the web's `useDerivedVersion`: the engine's stamp minus the bodies,
 * or the last body that decides a placement (a body-term rule reads its text) when that is newer.
 * The provider's memo and the presented reader both read it here, so neither keeps a row where a
 * fresh projection would no longer place it, and the eager pass's bodies re-derive nothing.
 */
export const listStamp = (engine: OhmailEngineLike): number =>
  Math.max(engine.read().stampExcept(NOT_DERIVED_FROM), engine.placementStamp());

/** What one run reads — every field is the provider's own state or a stable callback. */
export interface ProjectionInputs {
  engine: OhmailEngineLike;
  worldKey: string;
  standalone: boolean;
  bearer: SessionRenewalDoor | null;
  /** The account's face, built by the provider (the standalone door names the phone). */
  account: (mailboxes: readonly PhoneMailbox[] | null) => { name: string; email: string };
  images: ImageRoute;
  zone: string;
  locale: string;
  /** The clock this run draws with — read by the provider at the run (`world-clock.ts` ticks it). */
  now: Date;
  foldersOn: boolean;
  foldersPending: boolean;
  foldersStorable: boolean;
  setFoldersEnabled: World["folders"]["setEnabled"];
  folderSummary: World["folders"]["summary"];
  signatures: World["signatures"];
  resurfaceTime: World["resurfaceTime"];
  rememberResurfaceTime: World["remember"];
  posture: ScreeningPosture;
  scopes: Record<string, Scope>;
  screenerServer: readonly ServerWaitingSender[] | null;
  relayed: readonly RelayedDecision[] | null;
  leavingWaiting: ReadonlyArray<{ address: string; scope: Scope }>;
  heldDeletes: ReadonlySet<string>;
  heldPlaces: Parameters<typeof routingReader>[1];
  mailboxes: readonly PhoneMailbox[] | null;
  ownAddresses: readonly string[];
  walker: StoreTimelineWalker | null;
  searchWalker: StoreSearchWalker | null;
  openOffMirror: World["store"]["open"];
  actions: WorldActions;
  /** Told the presented reader and its options each run — the verbs that ask about the lists read them. */
  onPresented(pres: EntityReader, options: ConsentOptions): void;
}

export type Projected = Omit<World, "boot" | "abandoned" | "queued" | "face" | "autoAct" | "sendOutcome" | "sendSettlement">;

/** How many derivations this projector ran, by list — the ratchet's counter, and the `ui_vitals` line's source. */
export interface ProjectorStats { runs: number; lists: Record<string, number> }

const same = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

export function createProjector(): { project(inp: ProjectionInputs): Projected; stats(): ProjectorStats } {
  const stats: ProjectorStats = { runs: 0, lists: {} };
  const slots = new Map<string, { key: readonly unknown[]; value: unknown }>();
  /* ONE CACHE PER NAME: a hit is every key element identical to the last computation's. */
  const kept = <T>(name: string, key: readonly unknown[], compute: () => T): T => {
    const hit = slots.get(name);
    if (hit !== undefined && same(hit.key, key)) return hit.value as T;
    const done = beginDerive();
    const value = compute();
    done?.();
    stats.lists[name] = (stats.lists[name] ?? 0) + 1;
    slots.set(name, { key, value });
    return value;
  };

  function project(inp: ProjectionInputs): Projected {
    stats.runs += 1;
    const { engine, zone, locale, foldersOn, posture } = inp;
    const raw = engine.read();
    const stamp = listStamp(engine);
    const now = inp.now;
    const day = zonedDayNumber(now, zone);
    const mailboxes = inp.mailboxes ?? EMPTY_MAILBOXES;
    /* The tags keep their identity while they read the same, so a mail change does not re-key every row. */
    const tagsNow = kept("tagsRead", [engine, stamp], () => liveTags(raw));
    const tags = kept("tags", [JSON.stringify(tagsNow)], () => tagsNow);
    /* The view, one object per (day, zone, language, flags, facts): the row memos key on it. */
    const v: WorldView = kept("view", [day, zone, locale, foldersOn, inp.ownAddresses, mailboxes, posture, tags], () => ({
      now, zone, locale, foldersEnabled: foldersOn, ownAddresses: inp.ownAddresses, mailboxes, screening: posture, tags,
    }));
    /* THE PRESENTED READER, kept across runs: a fresh one per run missed every engine memo keyed on reader identity. */
    const presented = kept("presented", [engine, stamp, day, foldersOn, posture, inp.ownAddresses, inp.heldDeletes, inp.heldPlaces], () => {
      const base = hiddenMessagesReader(raw, inp.heldDeletes);
      const world = presentedWorld(base, v.now, foldersOn, posture, inp.ownAddresses);
      return {
        base, history: world.history, world,
        pres: routingReader(world.reader, inp.heldPlaces),
        options: presentedOptions(v.now, foldersOn, posture, inp.ownAddresses),
      };
    });
    const { base, pres } = presented;
    inp.onPresented(pres, presented.options);
    const openHeld = engine.openRowHeld();
    const screener = () => kept("screener", [pres, v, inp.scopes, inp.screenerServer, inp.leavingWaiting, inp.relayed], () => {
      const s = liveScreener(pres, v, inp.scopes, waitingOnScreen(inp.screenerServer, inp.leavingWaiting));
      return {
        ...s,
        relayed: inp.relayed,
        meta: s.source === "server" ? Copy.metaWaiting(s.waiting.length) : Copy.metaWaitingOnDevice(s.waiting.length),
      };
    });
    const piles = () => kept("piles", [pres, v], () => livePiles(pres, v));
    const folderList = kept("folderList", [engine, stamp, foldersOn], () => (foldersOn ? liveFolders(raw) : []));
    const history = presented.history;
    return {
      live: true,
      worldKey: inp.worldKey,
      account: inp.account(inp.mailboxes),
      standalone: inp.standalone,
      images: inp.images,
      mailboxes: {
        known: inp.mailboxes !== null,
        ownAddresses: inp.ownAddresses,
        organizer: inp.mailboxes === null ? null : phoneOrganizer(inp.mailboxes),
        rows: mailboxes,
        sendingId: kept("sendingId", [base, stamp], () => sendingMailboxId(base)),
        settingsBell: raw.entries("settings")[0]?.seq ?? null,
      },
      get ohbox() {
        return kept("ohbox", [pres, v, openHeld, stamp], () => {
          const o = liveOhbox(pres, v, openHeld);
          return { ...o, meta: Copy.metaUnreadOf(o.unread, o.total), unscreened: liveUnscreened(raw) };
        });
      },
      get doorbell() {
        const s = screener();
        return kept("doorbell", [s], () => ({ initials: s.waiting.map((r) => r.initial), count: s.waiting.length }));
      },
      get reads() {
        return kept("reads", [pres, v], () => {
          const r = liveReads(pres, v);
          return { ...r, waterLabel: Copy.waterline, meta: Copy.metaNew(r.newCount) };
        });
      },
      get receipts() {
        return kept("receipts", [pres, v], () => {
          const r = liveReceipts(pres, v);
          return {
            groups: r.groups, waterlineAboveId: r.waterlineAboveId, waterLabel: Copy.waterline,
            total: r.total, newCount: r.newCount, meta: Copy.metaNew(r.newCount),
          };
        });
      },
      get screener() {
        return screener();
      },
      /* HISTORY'S ROWS ARE BUILT ONLY WHEN READ — the History screen walks the store, and its count is the partition's. */
      history: {
        get items() {
          return kept("history", [base, history, v], () => history.map((m) => historyRow(base, m, v)));
        },
        total: history.length,
        pending: posture.state === "unanswered",
        meta: Copy.historyMeta(history.length),
      },
      get piles() {
        return piles();
      },
      get pilesMeta() {
        return Copy.metaItems(piles().reduce((n, p) => n + p.items.length, 0));
      },
      tags,
      get tagged() {
        return kept("tagged", [pres, v], () => liveTagged(pres, v));
      },
      get scheduled() {
        return kept("scheduled", [engine, stamp, v], () => liveScheduled(raw, v));
      },
      get drafts() {
        /* A send's state is read against THIS run's clock, never the kept view's: the view is kept
           for the day, and a send left `sending` turns interrupted ten minutes later. */
        return kept("drafts", [engine, stamp, v, now.getTime()], () => liveDrafts(raw, { ...v, now }));
      },
      folders: {
        enabled: foldersOn,
        storable: inp.foldersStorable,
        list: folderList,
        get unread() {
          return kept("folderUnread", [pres, foldersOn], () => (foldersOn ? liveFolderUnread(pres) : new Map<string, number>()));
        },
        byId: (id: string) => folderList.find((f) => f.id === id),
        items: (id: string) => {
          const f = folderList.find((x) => x.id === id);
          return f ? kept(`folder:${id}`, [pres, v, f], () => liveFolder(pres, f, v)) : { fresh: [], seen: [], unread: 0, total: 0 };
        },
        pending: inp.foldersPending,
        setEnabled: inp.setFoldersEnabled,
        summary: inp.folderSummary,
        soleCreateMailboxId: foldersOn && folderList.length === 0 ? soleMessageMailbox(raw) : null,
        junkSaid: junkFolderSaid(mailboxes),
      },
      trash: { available: engine.trashAvailable() },
      signatures: inp.signatures,
      resurfaceTime: inp.resurfaceTime,
      remember: inp.rememberResurfaceTime,
      /* The reader opens from the UNHIDDEN mirror; with no delete held that is the projection
         already made, handed in so a render is not a partition. While a delete is held the reader
         partitions the raw mirror itself, as it always did. */
      message: (id) => liveMessage(engine, id, {
        now, zone, locale, foldersEnabled: foldersOn,
        ownAddresses: inp.ownAddresses, mailboxes, screening: posture, tags,
      }, base === raw ? presented.world : undefined),
      filesOf: (id) => liveFiles(engine, id),
      search: liveSearch(engine, base, v),
      store: {
        walker: inp.walker,
        searchWalker: inp.searchWalker,
        renewal: inp.bearer,
        mirrorRows: () => mirrorNewestFirst(engine),
        rowOf: (m, inHistory) => storeRowOf(engine, m, v, inHistory),
        searchAvailable: engine.serverSearchAvailable(),
        open: inp.openOffMirror,
      },
      actions: inp.actions,
    };
  }

  return { project, stats: () => ({ runs: stats.runs, lists: { ...stats.lists } }) };
}

const EMPTY_MAILBOXES: readonly PhoneMailbox[] = [];
