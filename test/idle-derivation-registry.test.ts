import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../scripts/lib/source-scan.mjs";

/**
 * EVERY IDLE-PATH DERIVATION IS KEYED ON A CHANGE SIGNAL.
 *
 * The invariant of the 0.19.1 idle work: an idle tick's cost is proportional to what changed, and
 * when nothing changed it is a comparison. Seven periodic paths were found doing work proportional
 * to the MAILBOX on a tick where nothing had; this registry is the list, and each row has to say
 * what its derivation is keyed ON.
 *
 * Two admissible states and no third. A site is KEYED — it names a signal, and the literal that
 * DECIDES appears in the file it names, so deleting the gate reddens this file — or it is
 * DEFERRED to a named row somewhere else, which is a decision somebody wrote down. A site that is
 * neither is refused BY NAME, which is the only thing that stops this list becoming a list of
 * intentions.
 *
 * The needles are read through the repository's one comment scanner: a gate that survives only in
 * a comment is not a gate, and this census would otherwise pass on the prose describing the code
 * somebody deleted.
 */

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");

interface Site {
  /** The inventory's own number, so a row cannot quietly change which site it is about. */
  site: number;
  what: string;
  file: string;
  /** What the derivation is keyed on, in words. Empty ⇒ unkeyed ⇒ refused. */
  signal: string;
  /** The literal that DECIDES, as it stands in the code. Absent from the file ⇒ refused. */
  needle: string;
  /** For a site this work did not build: the row that carries it. Empty unless `signal` is. */
  deferredTo?: string;
}

const REGISTRY: readonly Site[] = [
  {
    site: 1,
    what: "the local engine re-queried every locator each idle cycle",
    file: "apps/sidecar/src/engine.ts",
    signal: "the change-log mark read immediately before the drain, plus every write the cycle "
      + "makes (the known-set proxy) and any throw",
    needle: 'knownSet.drop("the store moved outside the drain")',
  },
  {
    site: 2,
    what: "a cached cycle still reconstructed all remembered locators",
    file: "apps/worker/src/sync.ts",
    signal: "the known-set generation, and each folder's own row epoch",
    needle: "derived.rowEpochs.get(f) !== cur",
  },
  {
    site: 3,
    what: "an empty drain still ranked the mirror (the windowed prune)",
    file: "packages/client-engine/src/engine/windowed.ts",
    signal: "stampExcept over every type but bodies, and the cutline generation",
    needle: "=== this.prunedAtStamp",
  },
  {
    site: 3,
    what: "an empty drain still rebuilt the eager window (the body pass)",
    file: "packages/client-engine/src/engine/hydration.ts",
    signal: "the store version — any record write, a landed body included",
    needle: "rankedAt === this.eagerRankedAt",
  },
  {
    site: 4,
    what: "every settled poll repeated a mailbox-sized missing-body absence query",
    file: "apps/sidecar/src/cloud-mirror.ts",
    signal: "an ask that found nothing to want latches; a pull that applied rows unlatches",
    needle: "if (bodyGapKnownEmpty) return 0;",
  },
  {
    site: 5,
    what: "successful empty cycles still checkpointed",
    file: "apps/sidecar/src/engine.ts",
    signal: "the changes the cycle observed, and the change-log mark across the drain's tail",
    needle: "census.observed > 0 || tailWrote",
  },
  {
    site: 6,
    what: "status transitions triggered retained-mailbox derivation through a shared memo owner",
    file: "apps/mobile/src/state/world.tsx",
    signal: "the mirror's derived stamp (bodies excluded), the screening answer and the folders flag — never the connection",
    needle: "const projected = useMemo<",
  },
  {
    site: 7,
    what: "the session timer can reclaim after an Android reader backgrounded without its service",
    file: "apps/mobile/src/engine/background.ts",
    // ANSWERED, and by the lease rather than by a tick budget: whether that reclaim may happen is
    // a one-organizer question, and the ruling is that a phone behind the person with nothing
    // running makes no press at all. So this site is KEYED like the six before it, and the row it
    // was deferred to is closed.
    signal: "the app phase and the service, read at the tick — a press only from a phone in front "
      + "of the person, or one whose notification is still up",
    needle: "if (inBackground && !organizerRuns()) return;",
  },
];

/** The file's code, comments blanked — a gate that lives in prose is not a gate. */
const codeOf = (file: string): string => withoutComments(readFileSync(join(REPO, file), "utf8"));

describe("the idle-derivation registry", () => {
  it("covers the seven sites the inventory named, and no others", () => {
    expect([...new Set(REGISTRY.map((r) => r.site))].sort((a, b) => a - b))
      .toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("refuses a site that is neither keyed nor deferred, by name", () => {
    const unkeyed = REGISTRY
      .filter((r) => r.signal.trim() === "" && (r.deferredTo ?? "").trim() === "")
      .map((r) => `site ${r.site}: ${r.what}`);
    expect(unkeyed).toEqual([]);
  });

  it("finds the deciding literal of every keyed site in the file it names", () => {
    const missing = REGISTRY
      .filter((r) => r.signal.trim() !== "")
      .filter((r) => !codeOf(r.file).includes(r.needle))
      .map((r) => `site ${r.site}: ${r.needle} is not in ${r.file}`);
    expect(missing).toEqual([]);
  });

  it("holds every keyed site to a signal stated in words", () => {
    for (const r of REGISTRY.filter((x) => x.needle !== "")) {
      expect(r.signal.length, `site ${r.site} states no signal`).toBeGreaterThan(20);
    }
  });

  /**
   * THE REFUSAL ARM. Its subject HAS the property under test — an entry that names no signal and
   * no row — so the check above is watched refusing rather than assumed to.
   */
  it("would refuse an entry that names neither", () => {
    const rogue: Site[] = [
      ...REGISTRY,
      { site: 3, what: "a derivation somebody added later", file: "x.ts", signal: "", needle: "" },
    ];
    const unkeyed = rogue
      .filter((r) => r.signal.trim() === "" && (r.deferredTo ?? "").trim() === "")
      .map((r) => `site ${r.site}: ${r.what}`);
    expect(unkeyed).toEqual(["site 3: a derivation somebody added later"]);
  });

  /**
   * SITE 6's REFUSAL IS THE ABSENCE OF A DEPENDENCY, which no needle can state: the projection is
   * wrong exactly when the connection's state is back in its dependency array. Read off the array
   * itself, between the memo and the line that closes it.
   */
  it("keeps the connection out of the phone's projection", () => {
    const code = codeOf("apps/mobile/src/state/world.tsx");
    const start = code.indexOf("const projected = useMemo<");
    expect(start).toBeGreaterThan(0);
    const deps = code.slice(code.indexOf("}, [", start), code.indexOf("]);", code.indexOf("}, [", start)));
    // The mirror's derived stamp: the version less the bodies, which no list reads.
    expect(deps).toContain("derivedStamp");
    expect(deps).not.toContain("conn.syncing");
    expect(deps).not.toContain("conn.syncError");
  });
});
