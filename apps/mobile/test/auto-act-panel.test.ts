/**
 * THE ACT ON SUGGESTIONS ON THE PHONE — the panel rendered the way
 * `disabled-control-dims.test.ts` renders, its words against the web catalogue, the reader
 * predicate, and the consent read and write over a scripted server. Disabled while automatic
 * suggestions are off, and on a phone that reads mail another install organizes.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const shims = vi.hoisted(() => {
  const colour = new Proxy({}, { get: () => "#000000" });
  const number = new Proxy({}, { get: () => 8 });
  const style = new Proxy({}, { get: () => ({}) });
  return { theme: { c: colour, radius: number, type: style, lift: () => null } };
});
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return { ...real, useState: (v: unknown) => [v, () => {}], useCallback: (f: unknown) => f };
});
vi.mock("react-native", () => ({
  Pressable: "Pressable", RefreshControl: "RefreshControl", ScrollView: "ScrollView",
  Text: "Text", View: "View", StyleSheet: { hairlineWidth: 1 }, Platform: { OS: "android" },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("../src/ui/posture", () => ({ usePosture: () => ({}) }));
vi.mock("../src/ui/Icon", () => ({ Icon: "Icon" }));
vi.mock("../src/theme", () => ({ useTheme: () => shims.theme }));

import { Copy } from "../src/copy";
import { Segmented } from "../src/ui/Segmented";
import { Tap } from "../src/ui/base";
import { AutoActPanel, readsOnly } from "../src/ui/AutoActPanel";
import { readFoldersEnabled, writeAutoAct } from "../src/net/consent";
import type { ConnectedSession } from "../src/net/pairing";
import type { PhoneMailbox } from "../src/net/mailboxes";

type El = { type: unknown; props: Record<string, unknown> };
const en = JSON.parse(readFileSync(fileURLToPath(new URL("../../webapp/messages/en.json", import.meta.url)), "utf8")) as {
  screener: { suggest: Record<string, string> };
};

/** Every element in a tree, depth first. */
function walk(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  if (node && typeof node === "object" && "props" in node) {
    const el = node as El;
    out.push(el);
    walk(el.props.children, out);
  }
  return out;
}
const texts = (tree: El[]): string[] => tree.flatMap((e) =>
  typeof e.props.children === "string" ? [e.props.children] : []);

const render = (p: Partial<Parameters<typeof AutoActPanel>[0]> = {}): El[] =>
  walk(AutoActPanel({ on: false, suggestOn: true, reader: false, pending: false, set: async (v) => v, ...p }));
const segmentedOf = (tree: El[]): El => tree.find((e) => e.type === Segmented)!;

describe("the phone's act on suggestions", () => {
  it("says the web's words, and its control is live with suggestions on", () => {
    const tree = render();
    expect(texts(tree)).toContain(Copy.autoActTitle);
    expect(texts(tree)).toContain(Copy.autoActDescription);
    expect(segmentedOf(tree).props.disabled).toBe(false);
    expect(segmentedOf(tree).props.value).toBe("off");
    expect(texts(tree)).not.toContain(Copy.autoActNeedsSuggest);
    expect(texts(tree)).not.toContain(Copy.autoActReader);
  });

  it("is disabled with 'Needs automatic suggestions' while those are off", () => {
    const tree = render({ suggestOn: false });
    expect(segmentedOf(tree).props.disabled).toBe(true);
    expect(texts(tree)).toContain("Needs automatic suggestions");
  });

  it("on a reader install it is disabled and sends the person to the organizer", () => {
    const tree = render({ reader: true, on: true });
    expect(segmentedOf(tree).props.disabled).toBe(true);
    expect(segmentedOf(tree).props.value, "the stored value is still shown").toBe("on");
    expect(texts(tree)).toContain("Set this on the install that organizes your mail.");
  });

  it("a disabled Segmented renders every segment as a disabled Tap, which dims", () => {
    const seg = walk(Segmented({ segments: [{ value: "off", label: "Off" }, { value: "on", label: "On" }],
      value: "off", onChange: () => {}, disabled: true }));
    const taps = seg.filter((e) => e.type === Tap);
    expect(taps).toHaveLength(2);
    for (const t of taps) {
      expect(t.props.disabled).toBe(true);
      expect((t.props.accessibilityState as { disabled: boolean }).disabled).toBe(true);
    }
  });

  it("every string is the web catalogue's, word for word", () => {
    expect(Copy.autoActTitle).toBe(en.screener.suggest.actTitle);
    expect(Copy.autoActDescription).toBe(en.screener.suggest.actDescription);
    expect(Copy.autoActNeedsSuggest).toBe(en.screener.suggest.actNeedsSuggest);
    expect(Copy.autoActReader).toBe(en.screener.suggest.actReader);
    expect(Copy.autoActFailed).toBe(en.screener.suggest.actFailed);
  });
});

describe("readsOnly — a reader install, the Screener's own reading", () => {
  const row = (organizerRole: PhoneMailbox["organizerRole"], status: string | null = "connected"): PhoneMailbox => ({
    id: `m-${Math.random()}`, address: "a@x.test", organizerRole, organizeConsentedAt: null, organizedBy: null,
    organizedByThisInstall: false, organizerState: null, status, junkFolder: null, sentFolder: null, smtpMaxSizeBytes: null,
    firstSyncStopFolder: null,
  });
  it("reads only when every live mailbox is read, and never before the roster is known", () => {
    expect(readsOnly(true, [row("reader")])).toBe(true);
    expect(readsOnly(true, [row("reader"), row("organizer")])).toBe(false);
    expect(readsOnly(true, [row("reader"), row("organizer", "disabled")])).toBe(true);
    expect(readsOnly(false, [row("reader")])).toBe(false);
    expect(readsOnly(true, [])).toBe(false);
    expect(readsOnly(true, [row(null)]), "an older server's silence is not a reader").toBe(false);
  });
});

describe("the consent wire", () => {
  const sessionAnswering = (fn: (url: string, init?: RequestInit) => Response): ConnectedSession =>
    ({ profile: { origin: "https://host.test", apiBase: null },
      fetch: async (url: string, init?: RequestInit) => fn(url, init) }) as unknown as ConnectedSession;
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

  it("reads the axis and what it needs; an answer without the axis draws no switch", async () => {
    const withAxis = await readFoldersEnabled(sessionAnswering(() => json({
      dormancyDays: 60, autoSuggestAt: "2026-09-27T08:00:00.000Z", autoActAt: null,
    })));
    expect(withAxis).toMatchObject({ autoAct: false, autoSuggestOn: true });
    const without = await readFoldersEnabled(sessionAnswering(() => json({ dormancyDays: 60 })));
    expect(without?.autoAct).toBeNull();
  });

  it("writes one axis, adopts the echo, and rejects a refusal", async () => {
    const bodies: string[] = [];
    const ok = sessionAnswering((_u, init) => { bodies.push(String(init?.body)); return json({ autoActAt: "2026-09-27T08:00:00.000Z" }); });
    expect(await writeAutoAct(ok, true)).toEqual({ on: true });
    expect(bodies).toEqual([JSON.stringify({ autoAct: true })]);
    const refused = sessionAnswering(() => json({ error: { code: "auto_suggest_required" } }, 400));
    await expect(writeAutoAct(refused, true)).rejects.toThrow(/400/);
    const silent = sessionAnswering(() => json({}));
    await expect(writeAutoAct(silent, true)).rejects.toThrow(/no such setting/);
  });
});
