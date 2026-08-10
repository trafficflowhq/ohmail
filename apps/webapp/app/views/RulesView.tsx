"use client";

/**
 * RULES — what the consent gate remembered, and the only way to take it back.
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ─────────────────────────────────────────────────────
 *
 * `POST /screener/:id` writes a `rules` row on EVERY decision, and four controls reach it: the
 * DecisionBar, "apply to all", "mark all spam" and the sender menu. The server's five `/rules`
 * endpoints were mounted, contract-tested and referenced by nothing; `/rules` had zero
 * occurrences anywhere in the client; the `rule` entity had been syncing into the client mirror
 * since the first release and was read by no selector. In a product whose thesis is a gate that
 * remembers your decisions, "and you can never see or undo them" is the part that compounds —
 * a real account had four invisible rules on it before this shipped.
 *
 * ── WHY IT IS A MANAGEMENT SURFACE, NOT A FLAT LIST ─────────────────────────────────────
 *
 * The first cut was `rules.map(row)` with a Change and a Revoke on each. Correct for four rules,
 * and the moment a heavy account has two hundred it is a wall of identical rows with no way to
 * find one or act on many. So this is now a surface you SEARCH (by sender or domain, client-side
 * over the list), FACET (by where a rule files — the frozen {@link RULE_DESTINATIONS}), and act
 * over in bulk. The list is WINDOWED through {@link useListWindow} — the same idiom History uses
 * for the one other unbounded pile — so a thousand rows mount as the ~twenty on screen plus two
 * spacers, not as a thousand nodes.
 *
 * Bulk revoke acts over the FILTERED set, not the whole list: the filter IS the selection, which
 * is why there is no checkbox column. Each rule in that set is revoked through the SAME per-rule
 * `onRevoke` path a single revoke uses — there is no second, weaker consent route — and the same
 * two-click disclosure stands before it fires.
 *
 * ── WHAT IT SAYS, AND THE THREE THINGS IT REFUSES TO SAY ────────────────────────────────
 *
 * 1. NO MESSAGE COUNT. `RuleDTO.stats` offers `hits`, `lastHitAt` and `demotions`; nothing
 *    anywhere has ever written one. The columns are declared and faithfully reported, and
 *    every value is still the insert default. A rule that has quietly filed three thousand
 *    messages would render "0". So the note says the count is not recorded, which is true,
 *    instead of a number that is not. The counts this surface DOES show — how many rules are in
 *    the set you are about to bulk-revoke — are the length of a client-side array, not `stats`,
 *    and they appear only where you are consenting to act on exactly that many.
 *
 * 2. NO PROMISE ABOUT WHERE FUTURE MAIL GOES. A revoked rule stops deciding — it does not
 *    put the sender back at the gate. A promoted YES also inserted a `contacts` row
 *    (`screener-service.ts:360`), and the pipeline routes on known senders independently of
 *    rules, so that sender stays known after their rule is gone; a promoted NO wrote no
 *    contact and genuinely does return to the Screener. Two outcomes from one control, and
 *    the row cannot tell which without reading a table it does not have. It therefore claims
 *    only the half that is true of both: this rule stops deciding.
 *
 * 3. NO RETROACTIVE MOVE, STATED BEFORE THE ACT AND NOT AFTER. `RulesService.remove` is one
 *    transaction over `rules` + `change_log` and never touches `folder_state`, so every
 *    message the rule ever filed stays exactly where it is. That is the RIGHT behaviour —
 *    reversing a rule and silently re-sorting a backlog is a worse surprise than the rule
 *    was — but it is only honest if the confirm step says so before the user commits, which
 *    is why revoking is two clicks and the second one is under that sentence. Bulk revoke keeps
 *    the same clause, pluralised; the disclosure does not weaken because it is applied to many.
 *
 * ── WHY IT IS ITS OWN FILE AND NOT INLINE IN `SettingsView` ─────────────────────────────
 *
 * `SettingsView` renders it as a pane, because a top-level view would need `shell/routing.ts`
 * and the rail. Keeping the component here means a test imports THIS and not the whole
 * settings screen, and it means domain rules over all mail — past and future, as the default
 * — can promote it to a route by adding one branch, with no code moving.
 */
import { useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Icon, SettingsNote, SettingsSection, useToast } from "@ohmail/ui";
import type { Folder, MutationStatus, RuleDTO } from "@ohmail/client-engine";
import { placeLabel } from "../shell/format";
import { useListWindow } from "../shell/list-window";
import "./rules.css";

/**
 * The six canonical folders a rule may file into — the same set the server's rule validation
 * enforces, in the order the rail lists them.
 *
 * Named here rather than derived from `VIEW_OF_FOLDER` because this is an OFFER, not a
 * rendering: the picker must not grow a seventh option because a future folder appeared in a
 * lookup table, when the server would answer 400 for it.
 */
export const RULE_DESTINATIONS: readonly Folder[] = [
  "INBOX",
  "ohmail/Reads",
  "ohmail/Receipts",
  "ohmail/Screener",
  "ohmail/Screened",
  "ohmail/Quarantine",
];

/**
 * The height a rule row occupies, in pixels — fixed, so the window's spacer arithmetic is exact
 * without a per-row measurement. Every row is two ellipsised lines and a fixed-height control
 * cluster (see rules.css), so this is the height of all of them; `useListWindow` measures a
 * `.row` element it will not find here and falls back to this estimate, which is the real value
 * because the CSS fixes it. Kept in step with `.rules-item{height}` in rules.css.
 */
const RULE_ROW_PX = 64;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "4 Aug 2026" — explicit, and deliberately not `toLocaleDateString`.
 *
 * The rest of the client formats dates by hand for the same reason (`selectors.ts`
 * `messageDisplayTime`): a locale-dependent string renders differently under the test
 * runner's ICU than in the browser, so an assertion about it either passes for the wrong
 * reason or is written loosely enough to assert nothing. The YEAR is always present, unlike
 * the message row's stamp — a rule is a standing decision and "2 Aug" on one made last year
 * is the same ambiguity that stamp already fixed for six-day-old mail.
 */
export function ruleDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** A destination and the rules that file into it — the buckets the facet chips are built from. */
export interface RuleGroup {
  destination: Folder;
  rules: RuleDTO[];
}

/**
 * Bucket rules by destination, canonical order first, any non-canonical destination the server
 * sent appended in first-seen order. Only non-empty buckets are returned — a facet chip for a
 * destination with no rules would filter to nothing. Order within a bucket is preserved (newest
 * first, as the caller supplies).
 */
export function groupByDestination(rules: readonly RuleDTO[]): RuleGroup[] {
  const byDest = new Map<Folder, RuleDTO[]>();
  for (const r of rules) {
    const list = byDest.get(r.destination);
    if (list) list.push(r);
    else byDest.set(r.destination, [r]);
  }
  const groups: RuleGroup[] = [];
  for (const d of RULE_DESTINATIONS) {
    const list = byDest.get(d);
    if (list && list.length) {
      groups.push({ destination: d, rules: list });
      byDest.delete(d);
    }
  }
  for (const [destination, list] of byDest) groups.push({ destination, rules: list });
  return groups;
}

/**
 * The rules a search box and a destination facet leave standing. Search is a case-insensitive
 * substring over `rule.match` — the address or domain a person recognises — and nothing else:
 * the origin and destination are chrome, not what someone types when hunting for a sender. An
 * empty or whitespace query matches everything, and `"all"` is every destination.
 */
export function filterRules(
  rules: readonly RuleDTO[],
  query: string,
  facet: Folder | "all",
): RuleDTO[] {
  const q = query.trim().toLowerCase();
  return rules.filter(
    (r) =>
      (facet === "all" || r.destination === facet) &&
      (q === "" || r.match.toLowerCase().includes(q)),
  );
}

/**
 * Which action, if any, is open. One at a time — two open confirms is two questions. A single
 * revoke/retarget carries the rule it targets; the bulk revoke acts over the filtered set and so
 * names no rule.
 */
type OpenAction =
  | { mode: "revoke"; ruleId: string }
  | { mode: "retarget"; ruleId: string }
  | { mode: "bulk" }
  | null;

/**
 * WHAT HAPPENED, AS THE ENGINE REPORTS IT. `engine.mutate` resolves to a `MutationResult`,
 * which satisfies this structurally — the callbacks are `engine.mutate(...)` and nothing else.
 */
export type RuleOutcome = { status: MutationStatus };

export interface RulesViewProps {
  /** Newest first — `rulesList(reader)`. */
  rules: RuleDTO[];
  /** `engine.mutate({ kind: "rule_delete", ruleId })`. */
  onRevoke: (ruleId: string) => Promise<RuleOutcome>;
  /** `engine.mutate({ kind: "rule_update", ruleId, destination })`. */
  onRetarget: (ruleId: string, destination: Folder) => Promise<RuleOutcome>;
}

export function RulesView({ rules, onRevoke, onRetarget }: RulesViewProps) {
  const t = useTranslations("rules");
  const toast = useToast();
  const [open, setOpen] = useState<OpenAction>(null);
  const [query, setQuery] = useState("");
  const [facet, setFacet] = useState<Folder | "all">("all");
  const scrollerRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => groupByDestination(rules), [rules]);
  /**
   * If the selected facet's bucket emptied (its last rule was revoked), fall back to "all" rather
   * than showing an empty pane under a chip that no longer has a bucket. Computed, not stored, so
   * it self-heals on the next render without an effect.
   */
  const activeFacet =
    facet !== "all" && groups.some((g) => g.destination === facet) ? facet : "all";
  const filtered = useMemo(
    () => filterRules(rules, query, activeFacet),
    [rules, query, activeFacet],
  );

  const win = useListWindow({ scrollerRef, count: filtered.length, estimate: RULE_ROW_PX });

  /**
   * THE TOAST WAITS FOR THE OUTCOME, AND IT LIVES HERE RATHER THAN IN THE SHELL.
   *
   * It fired immediately in the first cut, so a server that answered `403` got *"Rule revoked.
   * Your mail hasn't moved."* printed over the refusal — the optimistic tombstone rolled back,
   * so the rule REAPPEARED underneath a message saying it was gone. Only a refusal surfaces
   * this, and `FixturesAdapter` never refuses, so every test stayed green.
   *
   * `queued` is NOT folded into success. The engine keeps a retryable failure on its offline
   * queue with the overlay standing, so the row is correctly gone from the screen — but the
   * server has not been told yet, and "revoked" is a claim about the server.
   */
  const report = (status: MutationStatus, ok: string, queued: string, failed: string): void => {
    toast(status === "rolled_back" ? failed : status === "queued" ? queued : ok);
  };

  /**
   * Bulk revoke fans the SAME per-rule mutation over the filtered set and then reports ONE toast
   * that is true of the whole batch. A batch is not confirmed unless every rule confirmed: a
   * single refusal makes it "revoked X of N, the rest are still in place", never a flat success,
   * because the rules that rolled back are exactly as present as before. Offline (every mutation
   * queued, none refused) reports queued.
   */
  const runBulk = (ids: string[]): void => {
    setOpen(null);
    const total = ids.length;
    void Promise.all(ids.map((id) => onRevoke(id))).then((results) => {
      const ok = results.filter((r) => r.status === "confirmed").length;
      const failed = results.filter((r) => r.status === "rolled_back").length;
      if (failed === 0 && ok === total) toast(t("bulkToastRevoked", { count: total }));
      else if (failed === 0) toast(t("bulkToastQueued"));
      else if (ok > 0) toast(t("bulkToastPartial", { ok, count: total }));
      else toast(t("bulkToastFailed"));
    });
  };

  if (rules.length === 0) {
    return (
      <SettingsSection className="rules-view">
        <p className="set-note-inline">{t("empty")}</p>
        <SettingsNote>{t("noCount")}</SettingsNote>
      </SettingsSection>
    );
  }

  const target = open && "ruleId" in open ? rules.find((r) => r.id === open.ruleId) ?? null : null;
  const showSearch = rules.length >= 2;
  const showFacets = groups.length >= 2;
  const showBulk = filtered.length >= 2;

  return (
    <SettingsSection className="rules-view">
      <p className="set-note-inline">{t("intro")}</p>

      {showSearch || showFacets || showBulk ? (
        <div className="rules-toolbar">
          {showSearch ? (
            <label className="rules-search">
              <Icon name="search" />
              <input
                type="search"
                value={query}
                placeholder={t("search")}
                aria-label={t("searchLabel")}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setOpen(null);
                }}
              />
            </label>
          ) : null}

          {showFacets ? (
            <div className="rules-facets" role="group" aria-label={t("facetLabel")}>
              <button
                type="button"
                className={activeFacet === "all" ? "on" : undefined}
                aria-pressed={activeFacet === "all"}
                onClick={() => {
                  setFacet("all");
                  setOpen(null);
                }}
              >
                {t("facetAll")}
              </button>
              {groups.map((g) => (
                <button
                  key={g.destination}
                  type="button"
                  className={activeFacet === g.destination ? "on" : undefined}
                  aria-pressed={activeFacet === g.destination}
                  onClick={() => {
                    setFacet(g.destination);
                    setOpen(null);
                  }}
                >
                  {placeLabel(g.destination)}
                </button>
              ))}
            </div>
          ) : null}

          {showBulk ? (
            <Button
              variant="ghost"
              className="rules-bulk"
              onClick={() => setOpen(open?.mode === "bulk" ? null : { mode: "bulk" })}
            >
              {t("bulkRevoke", { count: filtered.length })}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* THE ACTION REGION. Every confirm — single revoke, single retarget, bulk revoke — renders
          here, above the list and never scrolled away, so the windowed list below stays a stream
          of fixed-height rows the spacer arithmetic can trust. It is not an "are you sure?": it
          is the one moment at which "your mail does not move" can be read BEFORE it is true.
          Removing it would make the sentence something the product says AFTER the act. */}
      {open?.mode === "bulk" ? (
        <div className="rules-confirm">
          <span>{t("bulkRevokeExplain", { count: filtered.length })}</span>
          <span className="acts">
            <Button variant="primary" onClick={() => runBulk(filtered.map((r) => r.id))}>
              {t("bulkRevokeConfirm", { count: filtered.length })}
            </Button>
            <Button onClick={() => setOpen(null)}>{t("cancel")}</Button>
          </span>
        </div>
      ) : null}

      {open?.mode === "revoke" && target ? (
        <div className="rules-confirm">
          <b className="what">{t(`what.${target.kind}`, { match: target.match })}</b>
          <span>{t("revokeExplain")}</span>
          <span className="acts">
            <Button
              variant="primary"
              onClick={() => {
                setOpen(null);
                void onRevoke(target.id).then((r) =>
                  report(r.status, t("toastRevoked"), t("toastRevokeQueued"), t("toastRevokeFailed")),
                );
              }}
            >
              {t("revokeConfirm")}
            </Button>
            <Button onClick={() => setOpen(null)}>{t("cancel")}</Button>
          </span>
        </div>
      ) : null}

      {open?.mode === "retarget" && target ? (
        <div className="rules-confirm">
          <b className="what">{t(`what.${target.kind}`, { match: target.match })}</b>
          <span>{t("retargetExplain")}</span>
          <span className="acts">
            {/* The CURRENT destination is not offered — re-filing mail where it already goes is a
                no-op the user would have to reason about, and the row states where that is. */}
            {RULE_DESTINATIONS.filter((f) => f !== target.destination).map((folder) => (
              <Button
                key={folder}
                onClick={() => {
                  setOpen(null);
                  void onRetarget(target.id, folder).then((r) =>
                    report(
                      r.status,
                      t("toastRetargeted", { place: placeLabel(folder) }),
                      t("toastRetargetQueued"),
                      t("toastRetargetFailed"),
                    ),
                  );
                }}
              >
                {placeLabel(folder)}
              </Button>
            ))}
            <Button variant="ghost" onClick={() => setOpen(null)}>
              {t("cancel")}
            </Button>
          </span>
        </div>
      ) : null}

      <div className="rules-scroll" ref={scrollerRef}>
        {filtered.length === 0 ? (
          <p className="rules-empty">{t("noMatch")}</p>
        ) : (
          <div className="rules-list">
            {/* The rows above and below the window, as reserved height — empty elements rather
                than a margin, so the scroller's scroll height and scrollbar are what they would
                be with every row mounted. `aria-hidden` because this is geometry. */}
            {win.padTop > 0 ? <div aria-hidden style={{ height: win.padTop }} /> : null}
            {filtered.slice(win.start, win.end).map((rule) => {
              const what = t(`what.${rule.kind}`, { match: rule.match });
              const origin = t(`origin.${rule.provenance}`);
              const meta = rule.enabled
                ? t("meta", { origin, date: ruleDate(rule.createdAt) })
                : t("metaPaused", { origin, date: ruleDate(rule.createdAt) });
              return (
                <div key={rule.id} className="rules-item" data-rule-id={rule.id}>
                  <span className="body">
                    <b className="what">{what}</b>
                    <span className="meta">
                      {meta} · {t("filesInto", { place: placeLabel(rule.destination) })}
                    </span>
                  </span>
                  <span className="acts">
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setOpen(
                          open?.mode === "retarget" && open.ruleId === rule.id
                            ? null
                            : { mode: "retarget", ruleId: rule.id },
                        )
                      }
                    >
                      {t("change")}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setOpen(
                          open?.mode === "revoke" && open.ruleId === rule.id
                            ? null
                            : { mode: "revoke", ruleId: rule.id },
                        )
                      }
                    >
                      {t("revoke")}
                    </Button>
                  </span>
                </div>
              );
            })}
            {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
          </div>
        )}
      </div>

      <SettingsNote>{t("noCount")}</SettingsNote>
    </SettingsSection>
  );
}
