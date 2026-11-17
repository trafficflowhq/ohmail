/**
 * MESSAGE-ACTION PARITY WITH THE WEBAPP — derived from the webapp's own source, not from a list
 * maintained here that could quietly drift.
 *
 * A reported defect this guard exists for (2026-08-22): "on the android app, opening a message
 * does give me only limited 3 action buttons and not the ones from our actual webapp / desktop
 * ui, this must be consistent UX". The webapp's reading pane is the reference surface (the
 * desktop composes the same shell, so it is consistent by construction); this phone's message
 * screen is the one that can drift, and it did.
 *
 * HOW THE VERB LIST IS DERIVED. `apps/webapp/app/shell/MessagePane.tsx` renders the action bar
 * from catalogue keys (`t("actionReply")`, `copy("actionLater", …)`, `tr("action")` for
 * Screening), and `MessageCard.tsx` carries the per-message Forward item (`tm("menuForward")`).
 * The regexes below lift exactly those keys out of the source, so a verb ADDED to the webapp
 * bar turns this suite red on the phone that lacks it — the settings-parity idiom: the webapp
 * file is the source of truth and this file has no list of its own to go stale.
 *
 * WHAT PARITY MEANS HERE, checked per derived key:
 *   1. the phone's copy deck (`src/copy.ts`) HAS the verb;
 *   2. its wording EQUALS the webapp catalogue's (`messages/en.json`) — same names, not
 *      near-misses (the phone ships one locale, English, mirroring the canonical deck; a
 *      second locale arrives with a phone i18n mechanism, which does not exist yet);
 *   3. the message screen's action surface actually REFERENCES it — reachable, not just
 *      defined. (Placement is the phone's own idiom — bar + sheets — and is not asserted.)
 *
 * THE ONE DOCUMENTED GAP rides {@link GAPS} with its evidence, and the guard holds the gap
 * honest from both sides: the webapp must still carry the verb (else the entry is stale) and
 * the phone must NOT render a control for it (a button wired to nothing is worse than an
 * absent one — `app/message/[id].tsx`'s own rule).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Copy } from "../src/copy";
import { MOVE_TARGETS } from "../src/state/live";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const read = (p: string) => readFileSync(at(p), "utf8");
/** A phone source that does not exist yet reads as empty — so the verbs fail as UNREACHABLE, not as ENOENT. */
const readMobile = (p: string) => (existsSync(at(p)) ? read(p) : "");

/* ── the reference surface ────────────────────────────────────────────────────────────────── */

const pane = read("../../webapp/app/shell/MessagePane.tsx");
const card = read("../../webapp/app/shell/MessageCard.tsx");
const en = JSON.parse(read("../../webapp/messages/en.json")) as {
  ohbox: Record<string, string>;
  screening: Record<string, string>;
  message: Record<string, string>;
};

/** The bar's catalogue keys, lifted from the webapp source — see the header. */
function webappVerbKeys(): Set<string> {
  const keys = new Set<string>();
  // `t("actionReply")`, `t("resurfaceNow")`, `t("moveLabel")`, … — the ohbox namespace.
  for (const m of pane.matchAll(/[^A-Za-z]t\("((?:action|resurface|move)[A-Za-z]+)"\)/g)) {
    keys.add(m[1]!);
  }
  // `copy("actionLater", "Later")` — the not-yet-in-catalogue shim; same namespace.
  for (const m of pane.matchAll(/copy\("(action[A-Za-z]+)"/g)) keys.add(m[1]!);
  // Screening is its own namespace (`tr("action")` — screening.action).
  if (pane.includes('tr("action")')) keys.add("SCREENING");
  // Forward lives on the per-message menu (`tm("menuForward")` — message.menuForward).
  if (card.includes('tm("menuForward")')) keys.add("FORWARD");
  return keys;
}

/** The webapp string a derived key resolves to. */
function webappLabel(key: string): string | undefined {
  if (key === "SCREENING") return en.screening.action;
  if (key === "FORWARD") return en.message.menuForward;
  return en.ohbox[key];
}

/** The phone's name for a derived key — identity within ohbox; the two foreign namespaces map. */
function mobileKey(key: string): string {
  if (key === "SCREENING") return "actionScreening";
  if (key === "FORWARD") return "actionForward";
  return key;
}

/**
 * VERBS THE PHONE DOES NOT CARRY, each with the evidence for why — the reachable set ships,
 * the unreachable one is a recorded gap, never a dead button.
 */
const GAPS: Record<string, string> = {
  // The AI drafter is a shell machine, not an engine verb: the offer/price/confirm ceremony is
  // apps/webapp/app/shell/draft-reply.ts (openOffer → POST /messages/:id/draft with the AI
  // consent state from consent-state.ts), the route is called by the shell's own fetch — there
  // is no EngineMutation for it, and the phone's network access is confined to the engine seam
  // (test/privacy.test.ts). Porting the drafter means porting the consent + credits surface;
  // until then the verb is absent rather than fake.
  actionDraftReply: "apps/webapp/app/shell/draft-reply.ts — shell fetch + AI consent ceremony, no engine mutation",
};

/* ── the phone's action surface ───────────────────────────────────────────────────────────── */

const mobileSources = [
  readMobile("../app/message/[id].tsx"),
  readMobile("../src/ui/MessageActions.tsx"),
  // The sheet primitives were lifted here when the folders group gained its verbs — the
  // Cancel row (Copy.moveCancel) is a control THIS file renders now.
  readMobile("../src/ui/Sheet.tsx"),
].join("\n");

/**
 * THE VERBS THAT ARE CONTROLS, as the phone renders them: every `Copy.<key>` standing as a
 * pressable's label (`<SheetRow|BarToggle|Button label={…}>`, or a `<Tap accessibilityLabel>`).
 * A bare `includes(Copy.key)` was measured to pass with the verb's ENTRY ROW deleted — the
 * dead sheet's own title kept the string in the file — so reachability is asserted at the
 * control position, not by mention. `[^<]*?` holds the match inside ONE opening tag (JSX
 * attributes carry no `<`), so a sheet's title cannot stand in for its missing entry row.
 */
const controlLabels = new Set(
  [...mobileSources.matchAll(
    /<(?:SheetRow|BarToggle|Button|Tap)\b[^<]*?(?:label|accessibilityLabel)=\{Copy\.(\w+)\}/g,
  )].map((m) => m[1]!),
);

/** Panel captions, not pressables — in the webapp too (`.abar-lab`); presence is what parity means. */
const CAPTION_KEYS = new Set(["resurfaceWhen", "moveLabel"]);

/* ── the suite ────────────────────────────────────────────────────────────────────────────── */

describe("the message screen carries the webapp's verbs", () => {
  const keys = webappVerbKeys();

  it("the derivation is not vacuous — it found the bar", () => {
    // A refactor that renames the call shapes must fail HERE, loudly, not by deriving an empty
    // set that every later assertion trivially passes over.
    expect(keys.size).toBeGreaterThanOrEqual(15);
    expect(keys.has("actionReply")).toBe(true);
    expect(keys.has("actionMove")).toBe(true);
    expect(keys.has("SCREENING")).toBe(true);
    expect(keys.has("FORWARD")).toBe(true);
  });

  for (const key of [...webappVerbKeys()].sort()) {
    if (GAPS[key]) continue;
    const mk = mobileKey(key);
    it(`${key} — named identically and reachable on the phone (Copy.${mk})`, () => {
      const label = (Copy as Record<string, unknown>)[mk];
      expect(label, `src/copy.ts has no "${mk}"`).toBeTypeOf("string");
      expect(label).toBe(webappLabel(key));
      const reachable = CAPTION_KEYS.has(mk)
        ? mobileSources.includes(`Copy.${mk}`)
        : controlLabels.has(mk);
      expect(
        reachable,
        `the message screen renders no control labelled Copy.${mk} — the verb is defined but unreachable`,
      ).toBe(true);
    });
  }

  it("the documented gaps are still honest on both sides", () => {
    for (const key of Object.keys(GAPS)) {
      // The webapp still carries the verb — otherwise this entry is stale and must go.
      expect(keys.has(key), `${key} left the webapp bar; drop it from GAPS`).toBe(true);
      // And the phone renders no control for it — an absent verb, never a dead one.
      expect(mobileSources.includes(mobileKey(key))).toBe(false);
    }
  });
});

describe("the move destinations are the webapp's", () => {
  it("MOVE_TARGETS match the webapp's own vocabulary", () => {
    // Declared with the web's verbs in the behaviour's own file since the Ohbox's lift; the pane imports it.
    const actions = read("../../../packages/app-logic/src/press/actions.ts");
    const m = actions.match(/export const MOVE_TARGETS[^=]*= \[([^\]]+)\]/);
    expect(m, "packages/app-logic/src/press/actions.ts no longer declares MOVE_TARGETS").not.toBeNull();
    const webappTargets = [...m![1]!.matchAll(/"([a-z]+)"/g)].map((x) => x[1]!);
    expect([...MOVE_TARGETS]).toEqual(webappTargets);
  });

  it("each destination is labelled with the webapp's place name", () => {
    // PLACE_EN in packages/app-logic/src/text/format.ts is the catalogue's English half — the same
    // labels the webapp's move panel renders (`PLACE_LABEL[v]`).
    const format = read("../../../packages/app-logic/src/text/format.ts");
    const block = format.match(/const PLACE_EN = \{([\s\S]*?)\};/);
    expect(block).not.toBeNull();
    const places = new Map<string, string>();
    for (const m of block![1]!.matchAll(/(\w+): "([^"]+)"/g)) places.set(m[1]!, m[2]!);
    for (const target of MOVE_TARGETS) {
      const mk = `place${target[0]!.toUpperCase()}${target.slice(1)}`;
      const label = (Copy as Record<string, unknown>)[mk];
      expect(label, `src/copy.ts has no "${mk}"`).toBe(places.get(target));
    }
  });
});
