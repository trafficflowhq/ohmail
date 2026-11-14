/**
 * Fits the action panel to its room, on the nodes themselves: what folds is hidden, what loses its word is
 * marked short. It returns the verbs that folded, by id, in the order they went.
 *
 * The order of giving up: a verb that gives up its word first; then verbs fold by rank, the highest first
 * and of equals the later one; then a note that need not stay; then the floor's verbs lose their words in
 * their own order; then every other verb that has an icon, the last first; and only then a note that is to
 * stay takes a second line (`data-fold`): it is never taken away. More never leaves.
 */
export function fitPanel(wrap: HTMLElement): string[] {
  const bar = wrap.firstElementChild as HTMLElement | null;
  if (!bar) return [];
  const verbs = [...bar.querySelectorAll<HTMLElement>("[data-rank]")];
  const notes = [...bar.querySelectorAll<HTMLElement>("[data-note]")];
  const more = bar.querySelector<HTMLElement>("[data-more]");
  for (const verb of verbs) {
    verb.hidden = false;
    delete verb.dataset.short;
  }
  for (const note of notes) {
    note.hidden = false;
    delete note.dataset.fold;
  }
  if (more) more.hidden = false;

  const folded: string[] = [];
  const shown = (verb: HTMLElement) => !verb.hidden;
  const worded = (verb: HTMLElement) => verb.dataset.short === undefined;
  const signed = (verb: HTMLElement) => verb.dataset.signed !== undefined;
  const over = () => bar.scrollWidth > wrap.clientWidth + 1;

  for (let guard = 32; guard > 0 && over(); guard--) {
    const early = verbs.find((v) => shown(v) && v.dataset.wordFirst !== undefined && worded(v));
    if (early) {
      early.dataset.short = "";
      continue;
    }
    const foldable = verbs.filter((v) => shown(v) && Number(v.dataset.rank) > 0);
    if (foldable.length) {
      const worst = foldable.reduce((a, b) => (Number(b.dataset.rank) >= Number(a.dataset.rank) ? b : a));
      worst.hidden = true;
      folded.push(worst.dataset.id ?? "");
      continue;
    }
    const note = notes.filter((n) => !n.hidden && n.dataset.keep === undefined).pop();
    if (note) {
      note.hidden = true;
      continue;
    }
    const floor = verbs
      .filter(
        (v) => shown(v) && v.dataset.wordOrder && v.dataset.wordFirst === undefined && worded(v) && signed(v),
      )
      .sort((a, b) => Number(a.dataset.wordOrder) - Number(b.dataset.wordOrder))[0];
    if (floor) {
      floor.dataset.short = "";
      continue;
    }
    const last = verbs.filter((v) => shown(v) && worded(v) && signed(v)).pop();
    if (last) {
      last.dataset.short = "";
      continue;
    }
    const kept = notes.find((n) => !n.hidden && n.dataset.fold === undefined);
    if (!kept) break;
    kept.dataset.fold = "";
  }
  if (more) more.hidden = folded.length === 0 && more.dataset.behind === undefined;
  return folded;
}
