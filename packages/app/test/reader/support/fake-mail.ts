/**
 * A MIRROR OF HAND-MADE LETTERS behind an engine that answers the reader and its press seam, recording every
 * mutation and body ask. No test library: the states page draws the reader over it in a browser too.
 */
import type { EngineMessage, EngineMutation, EntityReader, OhmailEngine } from "@ohmail/client-engine";

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

export interface FakeMail {
  readonly engine: OhmailEngine;
  readonly mutations: EngineMutation[];
  readonly bodyAsks: string[];
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
  } as unknown as OhmailEngine;
  return {
    engine,
    mutations,
    bodyAsks,
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
