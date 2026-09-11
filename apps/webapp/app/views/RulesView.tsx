"use client";

/**
 * Rules — what the consent gate remembered, and the only way to take it back. `POST /screener/:id` writes a `rules`
 * row on every decision, and the five `/rules` endpoints were referenced by nothing: in a product whose thesis is a
 * gate that remembers your decisions, "and you can never see or undo them" is the part that compounds — a real
 * account had four invisible rules before this shipped.
 */

/**
 * A management surface, not a flat list: SEARCH (by sender or domain, client-side), FACET (by destination — the
 * frozen {@link RULE_DESTINATIONS}), act in bulk, and the list is windowed through {@link useListWindow} (History's
 * idiom). Bulk revoke acts over the FILTERED set — the filter IS the selection, so there is no checkbox column —
 * through the SAME per-rule `onRevoke` path a single revoke uses, behind the same two-click disclosure.
 */

/**
 * Three things it refuses to say. (1) No message count: `RuleDTO.stats` is declared and nothing has ever written one,
 * so a rule that filed three thousand messages would render "0" — the note says the count is not recorded, which is
 * true; the counts shown are the length of a client-side array, only where you consent to act on exactly that many.
 */

/**
 * (2) No promise about where future mail goes: a promoted YES also inserted a `contacts` row and the pipeline routes
 * on known senders independently of rules, so that sender stays known after the rule is gone, while a promoted NO
 * genuinely returns to the Screener — the row cannot tell which, so it claims only the half true of both: this rule
 * stops deciding. (3) No retroactive move, stated BEFORE the act: `RulesService.remove` never touches `folder_state`,
 * and revoking is two clicks with the second under that sentence — pluralised for bulk, never weakened. A pane of
 * `SettingsView`, its own file so a test imports THIS and a route promotion is one branch.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Icon, SettingsNote, SettingsSection, TextField, useToast } from "@ohmail/ui";
import type { Folder, MutationStatus, RuleDTO } from "@ohmail/client-engine";
import { placeLabel } from "../shell/format";
import { displayRuleMatch } from "../shell/idn";
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
 * The rule's SECOND term, trimmed — or `""` when it carries none (mail 0050).
 *
 * One accessor rather than four inline `?? ""`s, because "does this rule have a subject term" is
 * asked by the row, the search, the confirm and the bulk copy, and a reading that drifts between
 * them is a rule the list describes differently depending on which control you touched. The
 * whitespace class is `core/src/rules.ts#SUBJECT_TERM_TRIM`'s, so this file agrees with the router
 * about which values mean "no term".
 */
export function subjectTermOf(rule: RuleDTO): string {
  return (rule.subjectContains ?? "").replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
}

/** The rule's THIRD term (mail 0052), on `subjectTermOf`'s contract — `""` for none. */
export function bodyTermOf(rule: RuleDTO): string {
  return (rule.bodyContains ?? "").replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
}

/**
 * The rules a search box and a destination facet leave standing. Search is a case-insensitive
 * substring over `rule.match` — the address or domain a person recognises — AND over the subject
 * term, because a subject rule is the one kind whose defining feature is not its address: somebody
 * hunting for "the NinjaFirewall rule" types the token, and before mail 0050 there was nothing else
 * to type. The origin and destination are still excluded: they are chrome, not what anybody searches
 * for. An empty or whitespace query matches everything, and `"all"` is every destination.
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
      (q === "" ||
        r.match.toLowerCase().includes(q) ||
        // …and over the form the ROW SHOWS. On an internationalized domain the row reads
        // `müller.example` and the stored match is `xn--mller-kva.example`, so searching only the
        // stored one loses the rule to the very characters the reader can see (`shell/idn.ts`).
        displayRuleMatch(r.match).toLowerCase().includes(q) ||
        subjectTermOf(r).toLowerCase().includes(q) ||
        // The body term (mail 0052), for the subject term's reason: it is what defines the rule.
        bodyTermOf(r).toLowerCase().includes(q)),
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

  /**
   * WHAT A RULE SAYS, IN ONE LINE — and for a subject rule that is TWO terms, not one. `what.sender` renders "mail
   * from x@y.com". A rule carrying `subjectContains` says something strictly narrower, and rendering it with the same
   * string is the defect this exists to close: two rules for one address — the broad one and the `[NinjaFirewall]`
   * one — would appear as identical rows with identical Change and Revoke buttons, and revoking "the wrong one" would
   * be a coin toss a person could not even see they were making. The conjunction is spelled out rather than
   * abbreviated to a chip, because the term is the thing the reader has to check character by character: a rule that
   * is one letter off looks right and files nothing.
   */
  const whatOf = (rule: RuleDTO): string => {
    const base = t(`what.${rule.kind}`, { match: displayRuleMatch(rule.match) });
    const term = subjectTermOf(rule);
    const body = bodyTermOf(rule);
    // A rule may carry either term or both (mail 0052); every carried term is spelled out, because
    // an unnamed conjunct is a row indistinguishable from a broader rule — the defect above.
    if (term !== "" && body !== "") {
      return t("whatBoth", { base, term, body });
    }
    if (body !== "") return t("whatBody", { base, body });
    if (term === "") return base;
    return t("whatSubject", { base, term });
  };
  const [open, setOpen] = useState<OpenAction>(null);
  const [query, setQuery] = useState("");
  const [facet, setFacet] = useState<Folder | "all">("all");
  const scrollerRef = useRef<HTMLDivElement>(null);
  /**
   * The open single-rule confirm's element, brought on-screen when it opens. `block: "nearest"`
   * so a confirm that is already visible moves NOTHING — only one that opened below the fold of
   * the bounded `.rules-scroll` (or of the page) slides in, by the minimum. Optional-called
   * because jsdom mounts this component without implementing scrollIntoView.
   */
  const confirmRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (open && open.mode !== "bulk") confirmRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [open]);

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
   * THE TOAST WAITS FOR THE OUTCOME, AND IT LIVES HERE RATHER THAN IN THE SHELL. It fired immediately in the first
   * cut, so a server that answered `403` got *"Rule revoked. Your mail hasn't moved."* printed over the refusal — the
   * optimistic tombstone rolled back, so the rule REAPPEARED underneath a message saying it was gone. Only a refusal
   * surfaces this, and `FixturesAdapter` never refuses, so every test stayed green. `queued` is NOT folded into
   * success. The engine keeps a retryable failure on its offline queue with the overlay standing, so the row is
   * correctly gone from the screen — but the server has not been told yet, and "revoked" is a claim about the server.
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
              <TextField
                shape="line"
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

      {/* THE BULK ACTION REGION. Only the bulk confirm renders up here: it is about the whole
          filtered set, so the head of that set is where its disclosure belongs. A SINGLE
          revoke/retarget confirm renders inside the list, at the row it targets — see the
          window's map below. Either way it is not an "are you sure?": it is the one
          moment at which "your mail does not move" can be read BEFORE it is true. Removing it
          would make the sentence something the product says AFTER the act. */}
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

      <div className="rules-scroll" ref={scrollerRef}>
        {filtered.length === 0 ? (
          <p className="rules-empty">{t("noMatch")}</p>
        ) : (
          <div className="rules-list">
            {/* The rows above and below the window, as reserved height — empty elements rather
                than a margin, so the scroller's scroll height and scrollbar match every row
                mounted; `aria-hidden` because this is geometry. The open confirm is the one
                non-row child (SET-M4), rendered directly under its target row so the disclosure
                is read AT the rule it is about, and Cancel leaves the reader in place. The
                spacers ignore its height on purpose: per-row bookkeeping would re-couple the
                window to variable heights, the oscillation `useListWindow` avoids. The error is
                bounded by one confirm's height (~2 rows) and the 8-row overscan covers it; when
                the row scrolls out, the confirm unmounts and returns with it — `open` state
                unaffected. */}
            {win.padTop > 0 ? <div aria-hidden style={{ height: win.padTop }} /> : null}
            {filtered.slice(win.start, win.end).map((rule) => {
              const what = whatOf(rule);
              const origin = t(`origin.${rule.provenance}`);
              const meta = rule.enabled
                ? t("meta", { origin, date: ruleDate(rule.createdAt) })
                : t("metaPaused", { origin, date: ruleDate(rule.createdAt) });
              const openHere = open !== null && "ruleId" in open && open.ruleId === rule.id;
              return (
                <Fragment key={rule.id}>
                  <div
                    className={openHere ? "rules-item editing" : "rules-item"}
                    data-rule-id={rule.id}
                  >
                    <span className="body">
                      <b className="what">{what}</b>
                      <span className="meta">
                        {meta} · {t("filesInto", { place: placeLabel(rule.destination) })}
                      </span>
                    </span>
                    <span className="acts">
                      <Button
                        variant="ghost"
                        aria-expanded={openHere && open.mode === "retarget"}
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
                        aria-expanded={openHere && open.mode === "revoke"}
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

                  {openHere && open.mode === "revoke" ? (
                    <div className="rules-confirm" ref={confirmRef}>
                      <b className="what">{what}</b>
                      <span>{t("revokeExplain")}</span>
                      <span className="acts">
                        <Button
                          variant="primary"
                          onClick={() => {
                            setOpen(null);
                            void onRevoke(rule.id).then((r) =>
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

                  {openHere && open.mode === "retarget" ? (
                    <div className="rules-confirm" ref={confirmRef}>
                      <b className="what">{what}</b>
                      <span>{t("retargetExplain")}</span>
                      <span className="acts">
                        {/* The CURRENT destination is not offered — re-filing mail where it
                            already goes is a no-op the user would have to reason about, and
                            the row states where that is. */}
                        {RULE_DESTINATIONS.filter((f) => f !== rule.destination).map((folder) => (
                          <Button
                            key={folder}
                            onClick={() => {
                              setOpen(null);
                              void onRetarget(rule.id, folder).then((r) =>
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
                </Fragment>
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
