/**
 * A MIRROR OF HAND-MADE LETTERS behind an engine that answers the reader and its press seam, recording every
 * mutation and body ask. No test library: the states page draws the reader over it in a browser too.
 */
import type { EngineMessage, EngineMutation, EntityReader, OhmailEngine } from "@ohmail/client-engine";
import { COMPOSER_AT_REST } from "../../support/fake-host.js";

/** A letter, every field a surface reads, the rest from `over`. */
export function letter(id: string, over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id,
    accountId: "acct-1",
    mailboxId: "mb-1",
    threadId: null,
    messageIdHeader: null,
    subject: "Kiln schedule",
    from: { name: "Ben Kiln", address: "ben@kiln.example" },
    to: [{ name: null, address: "me@studio.example" }],
    cc: [],
    date: "2026-11-10T09:00:00.000Z",
    arrivedAt: "2026-11-10T09:00:00.000Z",
    folder: "INBOX",
    snippet: `snippet of ${id}`,
    unread: true,
    lastReadAt: null,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: {
      sensitive: false,
      category: null,
      no_ai: false,
      no_forward: false,
      no_kb: false,
      priority: false,
    },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-11-10T09:00:00.000Z",
    body: `The text of ${id}.`,
    ...over,
  } as EngineMessage;
}

/** One object for the engine's verdict on the copy's age: a reader that subscribes to it needs the same one back. */
const COPY_AGE_UNKNOWN = { state: "unknown", asOf: null } as const;
/** One list for every read: the model keeps what it was last answered by identity. */
const NOTHING_ABANDONED: readonly never[] = [];

export interface FakeMail {
  readonly engine: OhmailEngine;
  readonly mutations: EngineMutation[];
  readonly bodyAsks: string[];
  /** What a part above the panes told the engine: each cutline and each list of Sent folders, as handed. */
  readonly told: { readonly cutlines: unknown[]; readonly sentFolders: unknown[] };
  /** Change a letter, as a drain would. */
  readonly patch: (id: string, over: Partial<EngineMessage>) => void;
  /** A letter arrives, as a page of the mirror would bring it. */
  readonly add: (m: EngineMessage) => void;
}

export function fakeMail(
  letters: readonly EngineMessage[],
  gone: readonly string[] = [],
  bodies: Readonly<Record<string, unknown>> = {},
  /** Any other rows, keyed `<type>:<id>` (a tag, a folder). */
  more: Readonly<Record<string, unknown>> = {},
): FakeMail {
  const rows = new Map<string, unknown>([
    ...letters.map((m): [string, unknown] => [`message:${m.id}`, m]),
    ...Object.entries(bodies).map(([id, b]): [string, unknown] => [`message_body:${id}`, b]),
    ...Object.entries(more),
  ]);
  let version = 1;
  const listeners = new Set<() => void>();
  const tell = (): void => {
    version += 1;
    for (const l of [...listeners]) l();
  };
  const reader: EntityReader = {
    get: <T>(type: string, id: string) => rows.get(`${type}:${id}`) as T | undefined,
    list: <T>(type: string) =>
      [...rows.entries()].filter(([k]) => k.startsWith(`${type}:`)).map(([, v]) => v as T),
    entries: <T>(type: string) =>
      [...rows.entries()]
        .filter(([k]) => k.startsWith(`${type}:`))
        .map(([k, v]) => ({ id: k.slice(type.length + 1), entity: v as T, seq: version })),
    version: () => version,
    stampOf: () => version,
    stampExcept: () => version,
  } as unknown as EntityReader;
  const mutations: EngineMutation[] = [];
  const bodyAsks: string[] = [];
  const told = { cutlines: [] as unknown[], sentFolders: [] as unknown[] };
  const engine = {
    read: () => reader,
    verbRead: () => reader,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    mutate: async (m: EngineMutation) => {
      mutations.push(m);
      return { status: "confirmed" };
    },
    hydrate: async () => undefined,
    hydrateBody: async (id: string, opts?: { urgent?: boolean; retry?: boolean }) => {
      bodyAsks.push(opts?.urgent ? `${id} urgent` : opts?.retry ? `${id} retry` : id);
    },
    hydrateThread: async (ids: string[]) => {
      bodyAsks.push(`thread ${ids.join(",")}`);
    },
    messageIsGone: (id: string) => gone.includes(id),
    trashAvailable: () => true,
    replayDelete: async () => ({ status: "confirmed" }),
    restoreFromTrash: async () => ({ status: "confirmed" }),
    /* What the mail ground reads of an engine at rest (the stamp a placing body moves, the rows taken in, the copy's
       age, how often a Sent folder was asked for), and the two things it tells it, kept as they were handed. */
    placementStamp: () => 0,
    receivedMessages: () => 0,
    freshness: () => COPY_AGE_UNKNOWN,
    sentFolderAsks: () => 0,
    /* It opens no file: the ground's file door stands over it as no door. */
    attachmentsAvailable: () => false,
    /* And what the Screener's model, which the ground stands, reads at rest: no change the server refused, a queue
       this device cannot page, and its asks at the mount, answered with nothing. */
    abandoned: () => NOTHING_ABANDONED,
    screenerWaitingAvailable: () => false,
    refreshScreenerWaiting: async () => undefined,
    refreshHeldReleases: async () => undefined,
    refreshUnscreened: async () => undefined,
    autoFiled: async () => null,
    setCutline: (cutline: unknown) => {
      told.cutlines.push(cutline);
    },
    setSentFolders: (mailboxes: unknown) => {
      told.sentFolders.push(mailboxes);
      return false;
    },
    /* What the one composer reads of an engine at rest: the ground mounts it above every place. */
    ...COMPOSER_AT_REST,
  } as unknown as OhmailEngine;
  return {
    engine,
    mutations,
    bodyAsks,
    told,
    patch: (id, over) => {
      const m = rows.get(`message:${id}`) as EngineMessage;
      rows.set(`message:${id}`, { ...m, ...over });
      tell();
    },
    add: (m) => {
      rows.set(`message:${m.id}`, m);
      tell();
    },
  };
}
