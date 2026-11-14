/**
 * THE FACETS: who sent it, where it is, with files. The store's once its summary lands — counts over the WHOLE match
 * set — else the device's own, counted over what is on screen. What is pressed narrows the device's first paint here
 * and goes to the store, each as its own filter.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useEffect, useMemo, useState } from "react";
import {
  folderLeaf,
  VIEW_OF_FOLDER,
  type OhmailEngine,
  type SearchHit,
  type ServerSearchFacets,
  type ServerSearchFilters,
  type StoreSearchMeta,
} from "@ohmail/client-engine";
import { displayAddress } from "../text/idn.js";
import type { Translator } from "../text/translator.js";
import type { DevicePaint } from "./local-pass.js";
import type { StorePass } from "./store-pass.js";
import type { SearchFacetGroup, SearchFacetItem, SearchFacetPick } from "./types.js";

/** The pressed facet: its group, the key it is shown under, and the store's own key for it where the store named one. */
export interface Filter {
  group: "folder" | "from" | "refine";
  /** A folder's key, a sender as named, or the files' words. */
  label: string;
  /** The store's own key for this facet — the stored folder path or the sender address. */
  raw?: string;
  /** A Place picked before typing narrows the device to that full path too. */
  exactPath?: true;
}

/** The store's facet for a folder path, as the device keys it: a view id, else the leaf. */
export const folderKeyOf = (folder: string): string =>
  (VIEW_OF_FOLDER as Record<string, string | undefined>)[folder] ?? folderLeaf(folder);

/**
 * WHAT IS PRESSED: at most one facet of each group. Where the host's server takes a person, the place and the files
 * are two parts of the question, each pressed and let go on its own; elsewhere one facet stands at a time.
 */
export type Pressed = readonly Filter[];
export const NONE_PRESSED: Pressed = [];

/** A facet pressed: the same one again lets it go; `apart` keeps the other groups' facets, else it is the only one. */
export function pressOf(pressed: Pressed, next: Filter, apart: boolean): Pressed {
  const same = pressedBy(pressed, filterPick(next));
  const others = apart ? pressed.filter((f) => f.group !== next.group) : NONE_PRESSED;
  return same ? others : [...others, next];
}

/** The store's own filters for what is pressed, side by side — the narrowed question goes to the store. */
export function storeFiltersOf(pressed: Pressed): ServerSearchFilters | undefined {
  const out: ServerSearchFilters = {};
  for (const filter of pressed) {
    if (filter.group === "folder" && filter.raw) out.folder = filter.raw;
    else if (filter.group === "from" && filter.raw) out.sender = filter.raw;
    else if (filter.group === "refine") out.hasAttachments = true;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** One pressed facet holds for a letter. */
function holds(m: EngineMessage, filter: Filter): boolean {
  if (filter.group === "folder") {
    return filter.exactPath
      ? m.folder === filter.raw
      : folderKeyOf(m.folder) === (filter.raw === undefined ? filter.label : folderKeyOf(filter.raw));
  }
  if (filter.group === "from") {
    return filter.raw !== undefined
      ? m.from.address.toLowerCase() === filter.raw.toLowerCase()
      : (m.from.name ?? displayAddress(m.from.address)) === filter.label;
  }
  return m.hasAttachments;
}

/** What is pressed narrows the device's first paint; the store answers it by itself. */
export function applyFilter(list: readonly SearchHit[], pressed: Pressed): readonly SearchHit[] {
  if (pressed.length === 0) return list;
  return list.filter(({ message: m }) => pressed.every((f) => holds(m, f)));
}

/** The pick a facet item carries, as the filter it becomes. */
export function filterOf(pick: SearchFacetPick, t: Translator): Filter {
  if (pick.group === "refine") return { group: "refine", label: t("facetAttachment") };
  return {
    group: pick.group,
    label: pick.key,
    ...(pick.raw !== null ? { raw: pick.raw } : {}),
    ...(pick.group === "folder" && pick.exactPath ? { exactPath: true } : {}),
  };
}

/** Is this item a pressed one. */
function pressedBy(pressed: Pressed, pick: SearchFacetPick): boolean {
  return pressed.some((f) => {
    if (f.group !== pick.group) return false;
    if (pick.group === "refine") return true;
    if (pick.group === "folder" && (f.exactPath || pick.exactPath)) {
      return f.exactPath === pick.exactPath && f.raw === pick.raw;
    }
    return f.label === pick.key;
  });
}

/**
 * THE STORE'S FACETS FOR THE TEXT THAT PRODUCED THEM, kept from the unnarrowed question so pressing one does not zero
 * the others. Kept under the text of the question that PRODUCED them (`question` is this render's): the render after
 * a new text still holds the old answer.
 */
export function useStoreFacets(
  ready: StoreSearchMeta | null,
  pressed: Pressed,
  question: number,
  askedText: { readonly current: { question: number; text: string } | null },
): { q: string; facets: ServerSearchFacets; exact: boolean } | null {
  const [storeFacets, setStoreFacets] = useState<{
    q: string;
    facets: ServerSearchFacets;
    exact: boolean;
  } | null>(null);
  const unpressed = pressed.length === 0;
  useEffect(() => {
    const own = askedText.current;
    if (ready?.facets && unpressed && own !== null && own.question === question) {
      setStoreFacets({ q: own.text, facets: ready.facets, exact: ready.totalExact });
    }
  }, [ready?.facets, ready?.totalExact, unpressed, question, askedText]);
  return storeFacets;
}

/**
 * The facet groups, in their order: from, folder, files. Over the store's facets their numbers only while the total
 * is exact: past the store's cap they count the first page's candidates, so the chips stand without them.
 */
export function facetGroupsOf(
  facets: ServerSearchFacets | null,
  exact: boolean,
  rows: () => readonly EngineMessage[],
  pressed: Pressed,
  t: Translator,
): SearchFacetGroup[] {
  const groups: SearchFacetGroup[] = [];
  const item = (pick: SearchFacetPick, label: string, count: number | null): SearchFacetItem => ({
    pick,
    label,
    count,
    pressed: pressedBy(pressed, pick),
  });
  if (facets) {
    const counted = (n: number): number | null => (exact ? n : null);
    if (facets.sender.length) {
      groups.push({
        group: "from",
        items: facets.sender.slice(0, 5).map((x) => {
          const label = displayAddress(x.address);
          return item({ group: "from", key: label, raw: x.address }, label, counted(x.count));
        }),
      });
    }
    const folders = folderPicks(Object.keys(facets.folder));
    if (folders.length) {
      groups.push({
        group: "folder",
        items: folders.map((pick) => item(pick, pick.key, counted(facets.folder[pick.raw]))),
      });
    }
    if (facets.hasAttachments.true > 0) {
      groups.push({
        group: "refine",
        items: [item({ group: "refine" }, t("facetAttachment"), counted(facets.hasAttachments.true))],
      });
    }
    return groups;
  }
  const senders = new Map<string, number>();
  const folders = new Map<string, number>();
  let attachments = 0;
  for (const m of rows()) {
    const who = m.from.name ?? displayAddress(m.from.address);
    senders.set(who, (senders.get(who) ?? 0) + 1);
    const view = folderKeyOf(m.folder);
    folders.set(view, (folders.get(view) ?? 0) + 1);
    if (m.hasAttachments) attachments++;
  }
  if (senders.size) {
    groups.push({
      group: "from",
      items: [...senders.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([label, count]) => item({ group: "from", key: label, raw: null }, label, count)),
    });
  }
  if (folders.size) {
    groups.push({
      group: "folder",
      items: [...folders.entries()].map(([view, count]) =>
        item({ group: "folder", key: view, raw: null }, view, count),
      ),
    });
  }
  if (attachments > 0) {
    groups.push({ group: "refine", items: [item({ group: "refine" }, t("facetAttachment"), attachments)] });
  }
  return groups;
}

/**
 * A pressed part of the question stands among the facets while it is pressed, even where this answer counted none of
 * it (the words changed under it): it is let go by its own press, never hidden.
 */
export function withPressed(groups: SearchFacetGroup[], pressed: Pressed): SearchFacetGroup[] {
  let out = groups;
  for (const f of pressed) {
    const pick = filterPick(f);
    const group = out.find((g) => g.group === f.group);
    if (group?.items.some((it) => it.pressed)) continue;
    const it: SearchFacetItem = { pick, label: f.label, count: null, pressed: true };
    out = group
      ? out.map((g) => (g === group ? { ...g, items: [it, ...g.items] } : g))
      : [...out, { group: f.group, items: [it] }];
  }
  return out;
}

/** The pick a pressed facet came from. */
function filterPick(f: Filter): SearchFacetPick {
  if (f.group === "refine") return { group: "refine" };
  if (f.group === "folder" && f.exactPath)
    return { group: "folder", key: f.label, raw: f.raw ?? null, exactPath: true };
  return { group: f.group, key: f.label, raw: f.raw ?? null };
}

export interface FacetsInput {
  readonly store: StorePass;
  readonly engine: OhmailEngine;
  readonly trimmed: string;
  readonly pressed: Pressed;
  /** The place and the files are two parts of the question (the host's server takes a person). */
  readonly apart: boolean;
  /** The device's pass answered this text. */
  readonly answered: boolean;
  readonly similarOn: boolean;
  readonly paint: DevicePaint;
  /** The store's walked slots. */
  readonly walked: number;
  readonly t: Translator;
}

/**
 * THE FACETS THE LIST OFFERS: the store's for this text once its summary landed, else counted over the rows a facet
 * fallback may count (the device's paint, or the store's held pages as of this render's revision).
 */
export function useFacets({
  store,
  engine,
  trimmed,
  pressed,
  apart,
  answered,
  similarOn,
  paint,
  walked,
  t,
}: FacetsInput): SearchFacetGroup[] {
  const storeFacets = useStoreFacets(store.ready, pressed, store.question, store.askedText);
  const facets = storeFacets && storeFacets.q === trimmed ? storeFacets.facets : null;
  const rows = (): EngineMessage[] => {
    if (store.ready === null)
      return (similarOn ? [...paint.merged, ...paint.mergedSimilar] : paint.merged).map((h) => h.message);
    const out: EngineMessage[] = [];
    for (let i = 0; i < walked; i++) {
      const r = store.walker.rowAt(i);
      if (r !== null && r !== "gone") out.push(r);
    }
    return out;
  };
  const groups =
    answered && (!apart || trimmed !== "")
      ? facetGroupsOf(facets, storeFacets?.exact === true, rows, pressed, t)
      : [];
  const needsPlaces = apart && !groups.some((group) => group.group === "folder");
  const messageStamp = needsPlaces ? engine.read().stampOf("message") : 0;
  const places = useMemo(
    () => (needsPlaces ? blankPlaces(engine, messageStamp) : []),
    [needsPlaces, engine, messageStamp],
  );
  if (!apart) return groups;
  if (needsPlaces) {
    groups.push({
      group: "folder",
      items: places.map((pick) => ({
        pick,
        label: pick.key,
        count: null,
        pressed: pressedBy(pressed, pick),
      })),
    });
  }
  if (!groups.some((group) => group.group === "refine")) {
    groups.push({
      group: "refine",
      items: [
        {
          pick: { group: "refine" },
          label: t("facetAttachment"),
          count: null,
          pressed: pressedBy(pressed, { group: "refine" }),
        },
      ],
    });
  }
  return withPressed(groups, pressed);
}

/** Offer the folders the mirror knows. These are server query keys, without mirror-only counts. */
function blankPlaces(
  engine: OhmailEngine,
  _messageStamp: number,
): Extract<SearchFacetPick, { group: "folder" }>[] {
  const paths = new Set(
    engine
      .read()
      .list<EngineMessage>("message")
      .map((message) => message.folder),
  );
  return folderPicks(paths).map((pick) => ({ ...pick, exactPath: true }));
}

/** Use the display leaf unless two different paths would have the same name. */
function folderPicks(
  paths: Iterable<string>,
): (Extract<SearchFacetPick, { group: "folder" }> & { raw: string })[] {
  const keys = new Map<string, number>();
  for (const path of paths) {
    const key = folderKeyOf(path);
    keys.set(key, (keys.get(key) ?? 0) + 1);
  }
  return [...paths].map((raw) => {
    const key = folderKeyOf(raw);
    return { group: "folder", key: keys.get(key) === 1 ? key : raw, raw };
  });
}
