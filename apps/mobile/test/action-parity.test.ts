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
 * HOW THE VERB LIST IS DERIVED. The web's reference surface is the new reader's action panel
 * (`packages/app/src/reader/actions/ActionBar.tsx`) and its Resurface chooser (`ResurfaceMenu.tsx`):
 * re-pointed there by path when the switch to the new shell retired today's reading pane
 * (`apps/webapp/app/shell/MessagePane.tsx`, `MessageCard.tsx`; share reader-1). The panel names its
 * verbs from the `reader` catalogue (`t("verb.reply")`, the filing toggles `file("later", …)`, the
 * read slot's two words) and the message menu's (`tm("menuForward")`, `tm("menuReplyAll")`); the
 * chooser's rows are `t("resurface.now")` and its time field `t("resurface.time")`. The regexes lift
 * exactly those keys out of the source and name each one as today's bar and the phone's deck name it
 * (`verb.<x>` is `action<X>`, `resurface.<x>` is `resurface<X>`, `menu<X>` is `action<X>`; the two
 * the reader's catalogue renamed are in {@link RENAMED}), so a verb ADDED to the web panel turns this
 * suite red on the phone that lacks it: the settings-parity idiom: the web file is the source of
 * truth and this file has no list of verbs of its own to go stale. The AI drafter has left the panel
 * for Write's reply sheet (`packages/app/src/write/draft/Draft.tsx`, `t("draft.verb")`), where the
 * documented gap's web side is read.
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

const ACTIONS = "../../../packages/app/src/reader/actions/";
const panel = read(`${ACTIONS}ActionBar.tsx`);
/* The chooser's own face: Pick a date's month (`PickDay`, below it in the file) is the picker's, compared nowhere, as today's was not. */
const chooser = read(`${ACTIONS}ResurfaceMenu.tsx`).split(/\nfunction PickDay\b/)[0]!;
const verbsOf = read(`${ACTIONS}use-verbs.ts`);
const replySheet = read("../../../packages/app/src/write/draft/Draft.tsx");
const en = JSON.parse(read("../../webapp/messages/en.json")) as Record<string, Record<string, unknown>>;

/** The two keys the reader's catalogue renamed from today's bar, by the name today's bar and the phone's deck give them. */
const RENAMED: Record<string, string> = {
  "reader:verb.aside": "actionSetAside",
  "reader:resurface.cancel": "moveCancel",
};
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** The panel's keys, lifted from the web source (see the header), each named as the phone names it, with the catalogue path it reads. */
function webappVerbs(): Map<string, string> {
  const found = new Map<string, string>();
  const add = (path: string, name: string) => found.set(RENAMED[path] ?? name, path);
  // `t("verb.reply")`, `t("verb.move")`, … — the reader namespace, on the panel and the chooser's head.
  for (const src of [panel, chooser]) {
    for (const m of src.matchAll(/[^A-Za-z]t\("verb\.([A-Za-z]+)"\)/g)) add(`reader:verb.${m[1]!}`, `action${cap(m[1]!)}`);
  }
  // The filing toggles: `file("later", …)`, `file("aside", …)`, each labelled `t(`verb.${id}`)`.
  for (const m of panel.matchAll(/[^A-Za-z]file\("([A-Za-z]+)"/g)) add(`reader:verb.${m[1]!}`, `action${cap(m[1]!)}`);
  // The read slot, labelled `t(`verb.${readSlot}`)`: its two words are the slot's type.
  const slot = verbsOf.match(/readSlot: ((?:"[A-Za-z]+" \| )+)null/);
  for (const m of (slot?.[1] ?? "").matchAll(/"([A-Za-z]+)"/g)) add(`reader:verb.${m[1]!}`, `action${cap(m[1]!)}`);
  // The message menu's words on the panel: Forward (a sentinel, as before) and Reply all.
  for (const m of panel.matchAll(/[^A-Za-z]tm\("menu([A-Za-z]+)"\)/g)) {
    add(`message:menu${m[1]!}`, m[1] === "Forward" ? "FORWARD" : `action${m[1]!}`);
  }
  // The chooser's rows (`{t("resurface.now")}` as a MenuItem's words) and its time field.
  for (const m of chooser.matchAll(/>\s*\{t\("resurface\.([A-Za-z]+)"\)\}\s*<\/MenuItem>/g)) {
    add(`reader:resurface.${m[1]!}`, `resurface${cap(m[1]!)}`);
  }
  for (const m of chooser.matchAll(/aria-label=\{t\("resurface\.([A-Za-z]+)"\)\}/g)) add(`reader:resurface.${m[1]!}`, `resurface${cap(m[1]!)}`);
  // Screening is its own namespace: the panel would read it through `useText("screening")`.
  if (panel.includes('useText("screening")')) found.set("SCREENING", "screening:action");
  // The AI drafter's verb, in Write's reply sheet.
  if (replySheet.includes('t("draft.verb")')) add("write:draft.verb", "actionDraftReply");
  return found;
}

/** The bar's catalogue keys, lifted from the web source — see the header. */
function webappVerbKeys(): Set<string> {
  return new Set(webappVerbs().keys());
}

/** The web string a derived key resolves to. */
function webappLabel(key: string): string | undefined {
  const path = webappVerbs().get(key);
  if (path === undefined) return undefined;
  const [ns, dotted] = path.split(":") as [string, string];
  let at: unknown = en[ns];
  for (const part of dotted.split(".")) at = (at as Record<string, unknown> | undefined)?.[part];
  return typeof at === "string" ? at : undefined;
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
