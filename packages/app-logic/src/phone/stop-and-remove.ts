/**
 * WHAT STOP AND REMOVE ASKS FIRST. It deletes the store, so it asks while the store holds unsent drafts (or cannot
 * count them) or settings the mailbox does not have yet (or the engine cannot say): `null` only for a known zero and a
 * known `none`, which keeps the single press. Moved as it stood from the phone app's standalone form, where the old
 * Servers screen reads it until that screen is removed; the confirm's lines and its verb answer keys of the phone's
 * catalogue (`servers`), never sentences. Imports nothing.
 */

/**
 * Settings at risk: waiting for the settings question, behind a newer ohmail, refused by the mailbox on the way out,
 * or not known. Removing past a named risk is the person's answer to it.
 */
export type SettingsAtRisk = "answer" | "newer" | "unsaved" | "unknown";

export interface StopAndRemoveAsk {
  /** Unsent drafts in the store; `null` where they cannot be counted, `0` says nothing. */
  readonly drafts: number | null;
  /** Settings at risk; `null` for none. */
  readonly settings: SettingsAtRisk | null;
  /** Asked after the hand-back: nothing was removed and the mailbox stopped here, so Keep opens it again. */
  readonly kept?: true;
}

/** The ask when the removal kept the store: the settings alone, since any drafts were asked about first. */
export function stopAndRemoveKept(settings: SettingsAtRisk): StopAndRemoveAsk {
  return { drafts: 0, settings, kept: true };
}

/** The ask before the removal, or `null` for a single press. A setting this phone cannot read (`null`) is a risk. */
export function stopAndRemoveAsks(
  drafts: number | null,
  settings: SettingsAtRisk | "none" | null,
): StopAndRemoveAsk | null {
  const risk = settings === null ? "unknown" : settings === "none" ? null : settings;
  if (drafts === 0 && risk === null) return null;
  return { drafts, settings: risk };
}

/** A line of the confirm, as its key in the namespace `servers`, with the count where it says one. */
export type StopAndRemoveLine =
  | { readonly key: "remove.drafts"; readonly values: { readonly count: number } }
  | {
      readonly key:
        | "remove.draftsUnknown"
        | "remove.settingsAnswer"
        | "remove.settingsNewer"
        | "remove.settingsUnsaved"
        | "remove.settingsUnknown";
    };

/** The confirm's lines, one per loss, drafts first. */
export function stopAndRemoveLines(ask: StopAndRemoveAsk): StopAndRemoveLine[] {
  const lines: StopAndRemoveLine[] = [];
  if (ask.drafts === null) lines.push({ key: "remove.draftsUnknown" });
  else if (ask.drafts > 0) lines.push({ key: "remove.drafts", values: { count: ask.drafts } });
  if (ask.settings === "answer") lines.push({ key: "remove.settingsAnswer" });
  else if (ask.settings === "newer") lines.push({ key: "remove.settingsNewer" });
  else if (ask.settings === "unsaved") lines.push({ key: "remove.settingsUnsaved" });
  else if (ask.settings === "unknown") lines.push({ key: "remove.settingsUnknown" });
  return lines;
}

/** The confirm's danger verb: "Remove anyway" while settings are at risk. */
export function stopAndRemoveVerb(ask: StopAndRemoveAsk): "remove.removeDrafts" | "remove.removeAnyway" {
  return ask.settings === null ? "remove.removeDrafts" : "remove.removeAnyway";
}
