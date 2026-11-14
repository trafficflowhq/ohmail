/** After a verb: when my verb takes the open row out of the list, the cursor lands where the after-verb choice says. */
import { useEffect, useRef, type MutableRefObject } from "react";
import type { EngineMessage, OhboxRow as OhboxRowGroup } from "@ohmail/client-engine";
import { ACTED_FRESH_MS, nextRowAfter } from "../press/after-verb.js";
import type { OhboxListInput } from "./types.js";

/** The row a verb took, and where the verb's own advance put the cursor: the Undo's record reads both. */
export interface AfterVerbLanding {
  verbTook: MutableRefObject<{ id: string; at: number } | null>;
  verbAdvance: MutableRefObject<string | null>;
}

export function useAfterVerbLanding(
  input: OhboxListInput,
  all: EngineMessage[],
  navRows: OhboxRowGroup[],
  suspend: (id: string) => void,
  setLandedOn: (id: string | null) => void,
): AfterVerbLanding {
  const { selectedId, lastActed, onSelect, columnHidden, afterVerb } = input;
  /**
   * AFTER A VERB: when MY verb takes the open row out of the list, apply the after-verb
   * choice instead of always resting on "Nothing open." The order the list held while the row
   * was still in it is tracked per render (`prevIds`), because by the time the pane can react
   * the acted row has no index any more. Gated three ways: the shell's marker must name the
   * selected row (a drain applying another device's work never moves the cursor), the marker
   * must be fresh, and the reading column must be standing — the narrow sheet keeps its own
   * grammar. This is a SELECTION, not an arrival fallback: nobody's mail opens unasked; the
   * person mid-triage asked with the verb itself.
   */
  const prevIds = useRef<string[]>([]);
  /** The previous render's rows (a reference): where the acted row stood. */
  const prevRows = useRef<readonly OhboxRowGroup[]>([]);
  /** The row a verb just took from under the cursor, and where the verb itself put the cursor. */
  const verbTook = useRef<{ id: string; at: number } | null>(null);
  const verbAdvance = useRef<string | null>(null);
  /* The previous render's selection, because `selectedId` is DERIVED in the shell
     (`allOhbox.find`): the render in which the acted row leaves the list is the render in
     which the prop already reads null — the stale id is not visible from here. */
  const prevSel = useRef<string | null>(null);
  useEffect(() => {
    const before = prevIds.current;
    const beforeRows = prevRows.current;
    const wasSel = prevSel.current;
    const ids = all.map((m) => m.id);
    prevIds.current = ids;
    prevRows.current = navRows;
    prevSel.current = selectedId;
    const acted = lastActed?.current;
    /* A VERB TOOK THE OPEN ROW OUT OF THE LIST: remember it as it stood, for an Undo. */
    const fresh = (m: { at: number } | null | undefined): boolean =>
      m != null && Date.now() - m.at <= ACTED_FRESH_MS;
    const took = fresh(acted) ? acted!.id : fresh(verbTook.current) ? verbTook.current!.id : null;
    if (took !== null && wasSel === took && before.includes(took) && !ids.includes(took)) {
      verbTook.current = null;
      suspend(took);
    }
    // A delete drops the shell's selection; Park and Later keep it on the filed message (the mirror still holds it).
    if (!acted || wasSel !== acted.id || (selectedId != null && selectedId !== acted.id)) return;
    if (ids.includes(acted.id)) return; // the verb left the row in place
    if (!before.includes(acted.id)) return; // never in the three groups
    if (Date.now() - acted.at > ACTED_FRESH_MS) return;
    if (columnHidden()) return;
    lastActed.current = null;
    const choice = afterVerb();
    if (choice === "stay") return;
    if (choice === "close") {
      onSelect(null);
      return;
    }
    // Walk the rows as drawn: a folded row's open target can sit far from where the row stands.
    const next = nextRowAfter(beforeRows, new Set(navRows.map((r) => r.key)), acted.id);
    const landing = next == null ? null : (navRows.find((r) => r.key === next)?.openTarget.id ?? null);
    if (landing != null) {
      verbAdvance.current = landing;
      // The landing is a preview, like j, until rested on. Not `selectByUser`, which would let
      // go of the acted row's hold and spend its Undo.
      onSelect(landing);
      setLandedOn(landing);
    }
    /* Keyed on what it reads: a render that changes none of these can neither take the open row out of the list nor
       land anywhere, and the previous render's ids, rows and selection it keeps are the ones it already holds. */
  }, [all, navRows, selectedId, lastActed, columnHidden, afterVerb, suspend, onSelect, setLandedOn]);
  return { verbTook, verbAdvance };
}
