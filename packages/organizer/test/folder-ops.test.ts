import { describe, it, expect } from "vitest";
import type { FolderOpRow, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  FOLDER_DELETE_CHUNKS_PER_CYCLE, FOLDER_DELETE_TOMBSTONE_CHUNK, FOLDER_OP_MAX_ATTEMPTS,
  folderOpsPass, leafFightsDelimiter,
} from "../src/folder-ops.js";
import type { MailboxWriteAuthority } from "../src/lease.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * THE FOLDER-OP PASS against a scripted adapter — the seam contracts the pg tests cannot
 * carry (they prove the swap's transaction; HERE is the ORDER of operations against the
 * mailbox, the idempotent-completion arms, and the failure honesty):
 *
 *  · CREATE completes through the repo only after the adapter's create; a delimiter-fighting
 *    name never reaches the adapter at all (`bad_name`).
 *  · RENAME applies the swap on "renamed" AND on "already" — the crash window's signature —
 *    and fails honestly on "conflict"/"gone" without touching the swap.
 *  · DELETE walks the subtree CHILDREN FIRST; each folder is swept to Trash, its mirror rows
 *    tombstoned to exhaustion, VERIFIED EMPTY AGAINST THE SWEEP'S OWN FENCE by the adapter, and
 *    only then removed — and mail that arrived meanwhile stops the command with the folder
 *    standing and the person told, rather than a second sweep nobody pressed for.
 *  · A transient throw defers with a counted attempt; the cap turns it into the honest
 *    terminal. A fence refusal leaves the pass unreclassified.
 */

type Call = string;

function fakeRepo(ops: FolderOpRow[], opts: {
  calls: Call[];
  subtree?: Array<{ id: string; folder: string }>;
  trash?: string | null;
  /** Messages left per folder path — `tombstoneFolderMessages` drains it chunk by chunk. */
  mirror?: Map<string, number>;
}): WorkerRepo {
  return {
    listFolderOps: async () => ops,
    getMailboxSpecialFolders: async () => ({ junkFolder: null, trashFolder: opts.trash === undefined ? "Trash" : opts.trash }),
    listFolderSubtree: async (_mb: string, folder: string) => {
      const rows = (opts.subtree ?? [{ id: "sub-id", folder }])
        .filter((r) => r.folder === folder || r.folder.startsWith(folder + "/"));
      return rows.sort((a, b) => (b.folder.length - a.folder.length) || (a.folder < b.folder ? -1 : 1));
    },
    completeFolderCreate: async (op: unknown, landed: string) => { opts.calls.push(`complete-create:${(op as FolderOpRow).folderId}:${landed}`); },
    applyFolderRename: async (op: unknown) => {
      const o = op as FolderOpRow & { toFolder: string };
      opts.calls.push(`swap:${o.folder}->${o.toFolder}`);
      return { folders: 1, messages: 0 };
    },
    tombstoneFolderMessages: async (_a: string, _m: string, folder: string, limit: number, sentFolder?: string | null) => {
      const left = opts.mirror?.get(folder) ?? 0;
      const took = Math.min(left, limit);
      opts.mirror?.set(folder, left - took);
      opts.calls.push(`tombstone:${folder}:${took}:${sentFolder ?? "-"}`);
      return took;
    },
    removeFolderRow: async (_a: string, folderId: string) => { opts.calls.push(`remove-row:${folderId}`); },
    failFolderOp: async (op: unknown, error: string) => { opts.calls.push(`fail:${(op as FolderOpRow).folderId}:${error}`); },
    deferFolderOp: async (opId: string, attempts: number) => { opts.calls.push(`defer:${opId}:${attempts}`); },
  } as unknown as WorkerRepo;
}

function fakeAdapter(opts: {
  calls: Call[];
  delimiter?: string;
  renameAnswer?: "renamed" | "already" | "conflict" | "gone";
  deleteAnswers?: Array<"deleted" | "already" | "not_empty" | "changed" | "unverified">;
  createThrows?: Error;
  sweep?: Map<string, number>;
  /** A sweep that got no reading — the delete must fail closed rather than guess. */
  noFence?: boolean;
  sentFolder?: string | null;
  /** Where a CREATE lands (a personal-namespace server prefixes); default: where asked. */
  landsAt?: string;
}): MailboxAdapter {
  const deletes = [...(opts.deleteAnswers ?? [])];
  return {
    // The delete pass reads the RESOLVED Sent path off capabilities once per run — the
    // stale-residue guard's primary comparison (drizzle-repo carries the argument).
    // `sentFolder` ALONE, no `watchedSentFolder` — the precedence's second arm is the one a
    // fake can regress silently, so the fake reports the field the fallback must read.
    capabilities: async () => ({ sentFolder: opts.sentFolder ?? null }),
    hierarchyDelimiter: () => opts.delimiter ?? "/",
    createFolder: async (path: string) => {
      opts.calls.push(`imap-create:${path}`);
      if (opts.createThrows) throw opts.createThrows;
      return opts.landsAt ?? path;
    },
    renameFolder: async (from: string, to: string) => {
      opts.calls.push(`imap-rename:${from}->${to}`);
      return opts.renameAnswer ?? "renamed";
    },
    // The fence is threaded through, not invented here: the delete must be issued against the
    // reading the SWEEP took, so the call records which one it was handed.
    deleteFolder: async (path: string, fence: { exists: number; modseq: string | null } | null) => {
      opts.calls.push(`imap-delete:${path}:${fence === null ? "nofence" : `${fence.exists}/${fence.modseq ?? "-"}`}`);
      return deletes.shift() ?? "deleted";
    },
    moveAll: async (folder: string, to: string) => {
      const n = opts.sweep?.get(folder) ?? 0;
      opts.sweep?.set(folder, 0);
      opts.calls.push(`imap-sweep:${folder}->${to}:${n}`);
      return { moved: n, fence: opts.noFence === true ? null : { exists: 0, modseq: null } };
    },
  } as unknown as MailboxAdapter;
}

const op = (kind: FolderOpRow["op"], over: Partial<FolderOpRow> = {}): FolderOpRow => ({
  id: "op-1", accountId: "acc", mailboxId: "mb", folderId: "fid", folder: "Proj",
  op: kind, toFolder: kind === "rename" ? "Neu" : null, attempts: 0, ...over,
});

const deps = (repo: WorkerRepo, adapter: MailboxAdapter) => ({
  repo, adapter, accountId: "acc", mailboxId: "mb",
  write: <T,>(fn: (r: WorkerRepo) => Promise<T>) => fn(repo),
  /* A fixture holds neither half, and says so rather than leaving the field absent. The cases
     that DRIVE a refusal build their own authority with a throwing fence. */
  writeAuthority: { lease: FIXTURE_LEASE } as MailboxWriteAuthority,
});

describe("create", () => {
  it("IMAP first, completion second — and a delimiter-fighting name never reaches the adapter", async () => {
    const calls: Call[] = [];
    const out = await folderOpsPass(deps(fakeRepo([op("create")], { calls }), fakeAdapter({ calls })));
    expect(out).toEqual({ executed: 1, failed: 0, deferred: 0, owesMore: false });
    expect(calls).toEqual(["imap-create:Proj", "complete-create:fid:Proj"]);

    // A personal-namespace server files the create under INBOX — the completion is told the
    // LANDED path, so the commanded row can be re-spelt instead of standing as a phantom.
    const callsLanded: Call[] = [];
    await folderOpsPass(deps(
      fakeRepo([op("create")], { calls: callsLanded }),
      fakeAdapter({ calls: callsLanded, landsAt: "INBOX/Proj" }),
    ));
    expect(callsLanded).toEqual(["imap-create:Proj", "complete-create:fid:INBOX/Proj"]);

    const calls2: Call[] = [];
    const out2 = await folderOpsPass(deps(
      fakeRepo([op("create", { folder: "Steuern.2026" })], { calls: calls2 }),
      fakeAdapter({ calls: calls2, delimiter: "." }),
    ));
    expect(out2.failed).toBe(1);
    expect(calls2).toEqual(["fail:fid:bad_name"]);
  });
});

describe("rename", () => {
  it("applies the swap on 'renamed' AND on 'already' — the crash window's idempotent re-entry", async () => {
    for (const answer of ["renamed", "already"] as const) {
      const calls: Call[] = [];
      const out = await folderOpsPass(deps(
        fakeRepo([op("rename")], { calls }),
        fakeAdapter({ calls, renameAnswer: answer }),
      ));
      expect(out.executed, answer).toBe(1);
      expect(calls).toEqual(["imap-rename:Proj->Neu", "swap:Proj->Neu"]);
    }
  });

  it("fails honestly on 'conflict' and 'gone' — the swap never runs", async () => {
    for (const [answer, code] of [["conflict", "exists"], ["gone", "gone"]] as const) {
      const calls: Call[] = [];
      const out = await folderOpsPass(deps(
        fakeRepo([op("rename")], { calls }),
        fakeAdapter({ calls, renameAnswer: answer }),
      ));
      expect(out.failed).toBe(1);
      expect(calls).toEqual(["imap-rename:Proj->Neu", `fail:fid:${code}`]);
      expect(calls.some((c) => c.startsWith("swap:"))).toBe(false);
    }
  });
});

describe("delete", () => {
  it("children first: each folder swept, tombstoned to exhaustion, verified empty, then removed — the subject (and its command) LAST", async () => {
    const calls: Call[] = [];
    const subtree = [
      { id: "root-id", folder: "Proj" },
      { id: "kid-id", folder: "Proj/Sub" },
    ];
    // One chunk-boundary case on purpose: exactly one full chunk in the child, so the loop
    // must ask again and hear 0 before believing the mirror side is clean.
    const mirror = new Map([["Proj/Sub", FOLDER_DELETE_TOMBSTONE_CHUNK], ["Proj", 3]]);
    const out = await folderOpsPass(deps(
      fakeRepo([op("delete", { folderId: "root-id" })], { calls, subtree, mirror }),
      fakeAdapter({ calls, sweep: new Map([["Proj/Sub", 250], ["Proj", 3]]) }),
    ));
    expect(out.executed).toBe(1);
    expect(calls).toEqual([
      "imap-sweep:Proj/Sub->Trash:250",
      `tombstone:Proj/Sub:${FOLDER_DELETE_TOMBSTONE_CHUNK}:-`,
      "tombstone:Proj/Sub:0:-",
      "imap-delete:Proj/Sub:0/-",
      "remove-row:kid-id",
      "imap-sweep:Proj->Trash:3",
      "tombstone:Proj:3:-",
      "imap-delete:Proj:0/-",
      "remove-row:root-id",
    ]);
  });

  it("mail that arrived while the folder was being emptied STOPS the command — ONE sweep, the sentence, no row removal", async () => {
    // The pass used to sweep again by itself on `not_empty`, which files a stranger's brand-new
    // message into Trash on the strength of a press made before it existed — and leaves the same
    // race open for the next one. Pressing Delete again is the only thing that sweeps again.
    for (const why of ["not_empty", "changed"] as const) {
      const calls: Call[] = [];
      const out = await folderOpsPass(deps(
        fakeRepo([op("delete")], { calls, subtree: [{ id: "fid", folder: "Proj" }], mirror: new Map() }),
        fakeAdapter({ calls, sweep: new Map(), deleteAnswers: [why] }),
      ));
      expect(out.failed).toBe(1);
      expect(calls[calls.length - 1]).toBe("fail:fid:received_mail");
      expect(calls.filter((c) => c.startsWith("imap-sweep:"))).toHaveLength(1);
      expect(calls.filter((c) => c.startsWith("imap-delete:"))).toHaveLength(1);
      expect(calls.some((c) => c.startsWith("remove-row:"))).toBe(false);
    }
  });

  it("the second press is a new command: one more sweep, and the folder goes if it is empty by then", async () => {
    // What the refusal above leaves the person: the folder, the sentence, and a Delete they can
    // press again. This is that press — a fresh command row, one sweep, one delete.
    const calls: Call[] = [];
    const out = await folderOpsPass(deps(
      fakeRepo([op("delete", { id: "op-2" })], { calls, subtree: [{ id: "fid", folder: "Proj" }], mirror: new Map([["Proj", 1]]) }),
      fakeAdapter({ calls, sweep: new Map([["Proj", 1]]), deleteAnswers: ["deleted"] }),
    ));
    expect(out.executed).toBe(1);
    expect(calls).toEqual([
      "imap-sweep:Proj->Trash:1", "tombstone:Proj:1:-", "imap-delete:Proj:0/-", "remove-row:fid",
    ]);
  });

  it("a sweep that got no reading is 'unverified' at the adapter — the delete never guesses", async () => {
    const calls: Call[] = [];
    const out = await folderOpsPass(deps(
      fakeRepo([op("delete")], { calls, subtree: [{ id: "fid", folder: "Proj" }], mirror: new Map() }),
      fakeAdapter({ calls, sweep: new Map(), noFence: true, deleteAnswers: ["unverified"] }),
    ));
    expect(out.deferred).toBe(1);
    expect(calls).toContain("imap-delete:Proj:nofence");
    expect(calls.some((c) => c.startsWith("remove-row:"))).toBe(false);
  });

  it("refuses up front when discovery lost the Trash — never an expunge path", async () => {
    const calls: Call[] = [];
    const out = await folderOpsPass(deps(
      fakeRepo([op("delete")], { calls, trash: null }),
      fakeAdapter({ calls }),
    ));
    expect(out.failed).toBe(1);
    expect(calls).toEqual(["fail:fid:no_trash_folder"]);
  });
});

describe("the resolved Sent path", () => {
  it("threads from the adapter's capabilities into every tombstone chunk — the stale-residue guard's primary comparison", async () => {
    const calls: Call[] = [];
    const out = await folderOpsPass(deps(
      fakeRepo([op("delete")], { calls, subtree: [{ id: "fid", folder: "Proj" }], mirror: new Map([["Proj", 2]]) }),
      fakeAdapter({ calls, sweep: new Map([["Proj", 2]]), sentFolder: "Archive/Outgoing" }),
    ));
    expect(out.executed).toBe(1);
    expect(calls).toContain("tombstone:Proj:2:Archive/Outgoing");
  });
});

describe("the per-cycle budget and the fence guard", () => {
  it("a delete that runs out its chunk budget PAUSES — pending, attempts untouched, owesMore reported", async () => {
    const calls: Call[] = [];
    const mirror = new Map([["Proj", (FOLDER_DELETE_CHUNKS_PER_CYCLE + 2) * FOLDER_DELETE_TOMBSTONE_CHUNK]]);
    const out = await folderOpsPass(deps(
      fakeRepo([op("delete")], { calls, subtree: [{ id: "fid", folder: "Proj" }], mirror }),
      fakeAdapter({ calls, sweep: new Map([["Proj", 9999]]) }),
    ));
    expect(out).toEqual({ executed: 0, failed: 0, deferred: 0, owesMore: true });
    // No terminal was written: not failed, not deferred — the command simply resumes.
    expect(calls.some((c) => c.startsWith("fail:") || c.startsWith("defer:"))).toBe(false);
    expect(calls.filter((c) => c.startsWith("tombstone:"))).toHaveLength(FOLDER_DELETE_CHUNKS_PER_CYCLE);
    // The folder was NOT deleted and its row not removed — the mirror side is still owed.
    expect(calls.some((c) => c.startsWith("imap-delete:"))).toBe(false);
  });

  it("an 'unverified' emptiness answer is a transient, never a DELETE — the command retries", async () => {
    const calls: Call[] = [];
    const out = await folderOpsPass(deps(
      fakeRepo([op("delete")], { calls, subtree: [{ id: "fid", folder: "Proj" }], mirror: new Map() }),
      fakeAdapter({ calls, sweep: new Map(), deleteAnswers: ["unverified"] }),
    ));
    expect(out.deferred).toBe(1);
    expect(calls[calls.length - 1]).toBe("defer:op-1:1");
    expect(calls.some((c) => c.startsWith("remove-row:"))).toBe(false);
  });

  it("the guard runs BEFORE every IMAP write — a tripped fence stops the pass unreclassified", async () => {
    const calls: Call[] = [];
    const fenced = new Error("the leader lease is gone");
    fenced.name = "LeaderFencedError";
    const guarded = {
      ...deps(fakeRepo([op("create")], { calls }), fakeAdapter({ calls })),
      writeAuthority: {
        fence: async () => { calls.push("guard"); throw fenced; },
        lease: FIXTURE_LEASE,
      } as MailboxWriteAuthority,
    };
    await expect(folderOpsPass(guarded)).rejects.toThrow("the leader lease is gone");
    // The guard fired and NOTHING reached the mailbox or the repo behind it.
    expect(calls).toEqual(["guard"]);
  });
});

describe("failure discipline", () => {
  it("a transient throw defers with a counted attempt; the cap is the honest terminal", async () => {
    const boom = new Error("EPIPE mid-dial");
    const calls: Call[] = [];
    const out = await folderOpsPass(deps(
      fakeRepo([op("create")], { calls }),
      fakeAdapter({ calls, createThrows: boom }),
    ));
    expect(out.deferred).toBe(1);
    expect(calls).toEqual(["imap-create:Proj", "defer:op-1:1"]);

    const calls2: Call[] = [];
    const out2 = await folderOpsPass(deps(
      fakeRepo([op("create", { attempts: FOLDER_OP_MAX_ATTEMPTS - 1 })], { calls: calls2 }),
      fakeAdapter({ calls: calls2, createThrows: boom }),
    ));
    expect(out2.failed).toBe(1);
    expect(calls2).toEqual(["imap-create:Proj", "fail:fid:refused"]);
  });

  it("a fence refusal leaves the pass unreclassified — lost leadership is not evidence about a command", async () => {
    const fenced = new Error("the leader lease is gone");
    fenced.name = "LeaderFencedError";
    const calls: Call[] = [];
    const repo = fakeRepo([op("create")], { calls });
    const failing = {
      ...deps(repo, fakeAdapter({ calls })),
      write: async <T,>(_fn: (r: WorkerRepo) => Promise<T>): Promise<T> => { throw fenced; },
    };
    await expect(folderOpsPass(failing)).rejects.toThrow("the leader lease is gone");
  });
});

describe("leafFightsDelimiter", () => {
  it("only a segment CONTAINING the real delimiter fights it; '/' mailboxes fight nothing", () => {
    expect(leafFightsDelimiter("Steuern 2026/Belege", "/")).toBe(false);
    expect(leafFightsDelimiter("Steuern.2026", ".")).toBe(true);
    expect(leafFightsDelimiter("Steuern/Belege.2026", ".")).toBe(true);
    expect(leafFightsDelimiter("Steuern/Belege", ".")).toBe(false);
  });
});
