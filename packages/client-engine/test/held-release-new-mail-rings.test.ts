import type {
  EngineMessage,
  Folder,
  HeldReleaseGroupWire,
  HeldReleaseWire,
  RuleEntity as RuleDTO,
} from "@ohmail/wire";
import { describe, expect, it, vi } from "vitest";
import { OhmailEngine } from "../src/engine.js";
import { heldReleaseDismissedOf, heldReleaseGroups } from "../src/selectors.js";
import type { EngineAdapter } from "../src/adapters/adapter.js";
import type { SyncChange } from "../src/types.js";

/**
 * NEW HELD MAIL REACHES AN OPEN SCREEN WITH THE PULL THAT BROUGHT IT.
 *
 * Mail at the gate from a sender the account already decided joins the held set on the server,
 * and nothing rang for it: a surface already showing the Screener re-offered at its next ask (a
 * shell mount, or a settings write anywhere). The engine now re-asks its one held-release door at
 * the settle of a pull that carried such mail — judged against the mirror's rules after the pull,
 * so a rule arriving beside the message counts — once per pull, and only once a surface asked.
 */

const ACCOUNT = "acct-1";
const t0 = Date.parse("2026-09-25T14:00:00.000Z");
const GATE = "ohmail/Screener" as Folder;

const group = (ruleId: string, count: number): HeldReleaseGroupWire => ({
  ruleId, kind: "sender", match: `${ruleId}@shape.test`, destination: "INBOX", count,
});

const rule = (id: string, match: string, destination: Folder = "INBOX" as Folder): RuleDTO => ({
  id, kind: "sender", match, destination, priority: 0, provenance: "manual", enabled: true,
  createdAt: new Date(t0).toISOString(),
} as RuleDTO);

const message = (id: string, from: string, folder: Folder): EngineMessage => ({
  id, accountId: ACCOUNT, mailboxId: "mb1", threadId: null, messageIdHeader: `<${id}@shape.test>`,
  subject: "A note", from: { name: "", address: from }, to: [], cc: [],
  date: new Date(t0).toISOString(), folder, snippet: "", unread: true, hasAttachments: false,
  attachmentCount: 0, sensitivity: {} as EngineMessage["sensitivity"], triage: null, labels: [],
  remoteContent: "none", updatedAt: new Date(t0).toISOString(),
});

/** One hosted account: its log, the held set on the server and a dismissal by fingerprint. */
function account() {
  const log: SyncChange[] = [];
  let seq = 0;
  let groups = [group("r1", 28)];
  let dismissed: string | null = null;
  const fingerprint = () => groups.map((g) => `${g.ruleId}:${g.count}`).join("|");
  const push = (c: Omit<SyncChange, "seq" | "updatedAt">) => {
    const at = new Date(t0 + ++seq * 1_000).toISOString();
    log.push({ ...c, seq, updatedAt: at } as SyncChange);
  };
  push({ type: "settings", op: "update", id: ACCOUNT, entity: { accountId: ACCOUNT, updatedAt: "s0" } });
  push({ type: "rule", op: "create", id: "r1", entity: rule("r1", "known@shape.test") });

  function door() {
    const calls = { held: 0 };
    let fail = 0;
    let hold: ((release: () => void) => void) | null = null;
    const adapter = {
      sync: async ({ since }: { since: string }) => ({
        changes: { creates: [], updates: log.filter((c) => c.seq > Number(since)), moves: [], deletes: [] },
        cursor: String(seq), hasMore: false, serverTime: new Date(t0).toISOString(),
      }),
      mutate: async () => ({ ok: true as const, changes: [] }),
      heldReleases: async (): Promise<HeldReleaseWire> => {
        calls.held++;
        if (fail > 0) { fail--; throw new Error("door down"); }
        const answer = {
          groups, total: groups.reduce((n, g) => n + g.count, 0), max: 200,
          fingerprint: fingerprint(), dismissed: dismissed === fingerprint(),
        };
        const held = hold;
        hold = null;
        if (held) await new Promise<void>((r) => held(r));
        return answer;
      },
      dismissHeldRelease: async (fp: string) => { dismissed = fp; },
    } as unknown as EngineAdapter;
    return {
      adapter, calls, failNext: () => { fail = 1; },
      /** The next answer is read now and handed back only when `release` runs. */
      holdNext: (f: (release: () => void) => void) => { hold = f; },
    };
  }

  return {
    door,
    /** Mail lands (or is moved) somewhere; `held` grows the server's set as the gate would. */
    arrive: (id: string, from: string, folder: Folder, held: boolean, op: "create" | "update" = "create") => {
      push({ type: "message", op, id, entity: message(id, from, folder) });
      if (held) groups = [group("r1", groups[0]!.count + 1)];
    },
    decide: (id: string, match: string) => push({ type: "rule", op: "create", id, entity: rule(id, match) }),
  };
}

async function device(acct: ReturnType<typeof account>, opts: { showsOffer: boolean }) {
  const d = acct.door();
  const engine = new OhmailEngine({ adapter: d.adapter, now: () => new Date(t0) });
  await engine.start();
  if (opts.showsOffer) await engine.refreshHeldReleases();
  return { engine, ...d };
}

const offered = (e: OhmailEngine) =>
  heldReleaseGroups(e.read()).length > 0 && !heldReleaseDismissedOf(e.read());
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A device showing the offer, dismissed, and past the settle of its first pull. */
async function dismissedDevice() {
  const acct = account();
  const desk = await device(acct, { showsOffer: true });
  await desk.engine.dismissHeldRelease();
  await desk.engine.syncOnce();
  await settle();
  expect(offered(desk.engine)).toBe(false);
  return { acct, desk, asks: desk.calls.held };
}

describe("new held mail re-asks the offer at the settle of the pull that brought it", () => {
  it("mail at the gate from a decided sender brings the offer back within one pull", async () => {
    const { acct, desk, asks } = await dismissedDevice();
    acct.arrive("m1", "known@shape.test", GATE, true);
    await desk.engine.syncOnce();
    await vi.waitFor(() => expect(offered(desk.engine), "the open screen waited for its next ask").toBe(true));
    expect(desk.calls.held - asks).toBe(1);
  });

  it("a decided sender's message moved into the gate by hand elsewhere counts too", async () => {
    const { acct, desk, asks } = await dismissedDevice();
    acct.arrive("m1", "known@shape.test", "INBOX" as Folder, false);
    await desk.engine.syncOnce();
    await settle();
    expect(desk.calls.held - asks, "mail outside the gate asked").toBe(0);
    acct.arrive("m1", "known@shape.test", GATE, true, "update");
    await desk.engine.syncOnce();
    await vi.waitFor(() => expect(offered(desk.engine)).toBe(true));
  });

  it("a rule that arrives in the same pull as the gate mail is judged after the pull", async () => {
    const { acct, desk, asks } = await dismissedDevice();
    acct.decide("r2", "late@shape.test");
    acct.arrive("m1", "late@shape.test", GATE, true);
    await desk.engine.syncOnce();
    await vi.waitFor(() => expect(desk.calls.held - asks).toBe(1));
  });

  it("one ask for a pull, however much held mail it carried", async () => {
    const { acct, desk, asks } = await dismissedDevice();
    for (const id of ["m1", "m2", "m3"]) acct.arrive(id, "known@shape.test", GATE, true);
    await desk.engine.syncOnce();
    await vi.waitFor(() => expect(offered(desk.engine)).toBe(true));
    await settle();
    expect(desk.calls.held - asks).toBe(1);
  });

  it("the cost bound: gate mail from an undecided sender asks nothing", async () => {
    const { acct, desk, asks } = await dismissedDevice();
    acct.arrive("m1", "stranger@shape.test", GATE, false);
    await desk.engine.syncOnce();
    await settle();
    expect(desk.calls.held - asks).toBe(0);
  });

  it("an engine no surface asked never reads the offer for it", async () => {
    const acct = account();
    const phone = await device(acct, { showsOffer: false });
    acct.arrive("m1", "known@shape.test", GATE, true);
    await phone.engine.syncOnce();
    await settle();
    expect(phone.calls.held).toBe(0);
  });

  it("held mail arriving while a re-ask is in the air is asked for again", async () => {
    const { acct, desk, asks } = await dismissedDevice();
    let release!: () => void;
    desk.holdNext((r) => { release = r; });
    acct.arrive("m1", "known@shape.test", GATE, true);
    await desk.engine.syncOnce();
    acct.arrive("m2", "known@shape.test", GATE, true);
    await desk.engine.syncOnce();
    release();
    await settle();
    expect(desk.calls.held - asks).toBe(1);
    await desk.engine.syncOnce();
    await vi.waitFor(() => expect(desk.calls.held - asks, "an answer read before m2 stood for it").toBe(2));
  });

  it("a failed ask is asked again at the next settle", async () => {
    const { acct, desk } = await dismissedDevice();
    desk.failNext();
    acct.arrive("m1", "known@shape.test", GATE, true);
    await desk.engine.syncOnce();
    await settle();
    expect(offered(desk.engine), "the failed ask was taken for an answer").toBe(false);
    await desk.engine.syncOnce();
    await vi.waitFor(() => expect(offered(desk.engine)).toBe(true));
  });
});
