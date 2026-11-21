/**
 * THE QUEUE'S TOOLS, over Waiting: the filter (the groups the suggestions make, each with its count, the whole queue
 * first), Suggest (where the shell hands a run: the price before the spend, nothing bought before the confirm), and
 * Apply, which files every sender with a real suggestion where it says, and names those places on its button.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  PILE_KEY,
  refused,
  type DecisionDestination,
  type ScreenerFilterId,
  type ScreenerView,
} from "@ohmail/app-logic/screener";
import { stripStandingKey } from "@ohmail/app-logic/screener/no-suggestion";
import { Button, Menu, MenuItem, Seg } from "@ohmail/ui/base";
import { GroupHeading, ListLine } from "@ohmail/ui/mail";
import { NONE } from "../../host/index.js";
import { useText, type Text } from "../../text/index.js";
import { ListMenu } from "./ListMenu.js";
import { useNoAdvice, useScreener, useScreenerBeside } from "../contract.js";
import type { ScreenerSuggest } from "../ports.js";

function ScreeningProgress({ label, done, total }: { label: string; done: number; total: number }) {
  return (
    <div className="sc-progress">
      <span role="status">{label}</span>
      {total > 0 ? (
        <progress className="sc-progress-track" aria-hidden="true" value={done} max={total} />
      ) : null}
    </div>
  );
}

/** The places Apply files into, as one phrase: "Ohbox, News & Receipts". */
function pileList(dests: readonly DecisionDestination[], t: Text): string {
  const names = dests.map((d) => t(PILE_KEY[d]));
  if (names.length <= 1) return names[0] ?? "";
  const last = names[names.length - 1]!;
  return t("pileJoin", { a: names.slice(0, -1).join(", "), b: last });
}

const filterWord = (t: Text, id: ScreenerFilterId): string =>
  id === "none" ? t("filterNone") : t(PILE_KEY[id as DecisionDestination]);

function Filter({
  view,
  open,
  onOpen,
}: {
  view: ScreenerView;
  open: boolean;
  onOpen: (open: boolean) => void;
}) {
  const t = useText("screener");
  const at = useRef<HTMLDivElement | null>(null);
  const { counts, active, choices, choose } = view.filter;
  const all = choices.reduce((n, id) => n + counts[id], 0);
  return (
    <div ref={at}>
      <GroupHeading
        opensMenu
        count={String(active === null ? all : counts[active])}
        onPress={() => onOpen(!open)}
      >
        {active === null ? t("filterAll") : filterWord(t, active)}
      </GroupHeading>
      <Menu
        open={open}
        onClose={() => onOpen(false)}
        anchor={at}
        label={t("filterAria")}
        title={t("place.show")}
      >
        <MenuItem
          checked={active === null}
          note={String(all)}
          onPress={() => {
            choose(null);
            onOpen(false);
          }}
        >
          {t("filterAll")}
        </MenuItem>
        {choices.map((id) => (
          <MenuItem
            key={id}
            checked={active === id}
            note={String(counts[id])}
            onPress={() => {
              choose(id);
              onOpen(false);
            }}
          >
            {filterWord(t, id)}
          </MenuItem>
        ))}
      </Menu>
    </div>
  );
}

function Suggest({ suggest, allAnswered }: { suggest: ScreenerSuggest; allAnswered: boolean }) {
  const t = useText("screener");
  const buyAnchor = useRef<HTMLButtonElement | null>(null);
  const reaskAnchor = useRef<HTMLButtonElement | null>(null);
  const reaskContent = useRef<HTMLDivElement | null>(null);
  const c = suggest.control;
  const open = c.phase !== "closed";
  const [again, setAgain] = useState(false);
  if (!open && c.available === 0 && c.resuggestable === 0) return null;
  const price =
    c.quote === null || again
      ? undefined
      : suggest.priced
        ? t("suggest.price", { senders: c.quote.senders, credits: c.quote.credits })
        : t("suggest.priceUnmetered", { senders: c.quote.senders });
  return (
    <>
      {!open && c.available === 0 && allAnswered ? (
        <p className="oh-text" role="status">
          {t("suggest.allSuggested", { count: c.resuggestable })}
        </p>
      ) : null}
      {(open ? !again : c.available > 0) ? (
        <Button
          kind="quiet"
          size="s"
          opens="menu"
          expanded={!c.disabled && open}
          disabled={c.disabled || c.phase === "running"}
          ref={buyAnchor}
          onPress={
            open
              ? c.cancel
              : () => {
                  setAgain(false);
                  c.open();
                }
          }
        >
          {t("suggest.open")}
        </Button>
      ) : null}
      {(open ? again : c.resuggestable > 0) ? (
        <Button
          kind="quiet"
          size="s"
          opens="menu"
          expanded={!c.disabled && open}
          disabled={c.disabled || c.phase === "running"}
          ref={reaskAnchor}
          onPress={
            open
              ? c.cancel
              : () => {
                  setAgain(true);
                  c.openAgain();
                }
          }
        >
          {t("suggest.again")}
        </Button>
      ) : null}
      <Menu
        open={!c.disabled && open}
        onClose={c.cancel}
        anchor={again ? reaskAnchor : buyAnchor}
        label={again ? t("suggest.ariaAgain") : t("suggest.aria")}
        kind="ask"
        fitContent={again}
        initialFocus={again ? reaskContent : undefined}
        title={again ? t("suggest.labelAgain") : t("suggest.label")}
        aside={c.phase === "ready" ? price : undefined}
      >
        <SuggestMenuContent suggest={suggest} again={again} contentRef={reaskContent} />
      </Menu>
    </>
  );
}

function SuggestMenuContent({
  suggest,
  again,
  contentRef,
}: {
  suggest: ScreenerSuggest;
  again: boolean;
  contentRef: RefObject<HTMLDivElement | null>;
}) {
  const t = useText("screener");
  const c = suggest.control;
  const open = !c.disabled && c.phase !== "closed";
  const emptyAgain = again && c.phase === "ready" && c.quote?.senders === 0;
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (again && open && content && content.ownerDocument.activeElement === content.ownerDocument.body) {
      content.focus({ preventScroll: true });
    }
  }, [again, open, c.phase, emptyAgain, contentRef]);
  const n = c.quote?.senders ?? c.size;
  const count = n > 1 && n === c.size ? (n === c.pool ? "all" : "first") : "count";
  const showSizes = !again || (c.sizes.length > 1 && (!emptyAgain || c.size < c.pool));
  const creditPrice =
    again && suggest.priced && !emptyAgain && c.phase === "ready" && c.quote !== null
      ? t("suggest.credits", { credits: c.quote.credits })
      : null;
  const noControls = c.phase === "running" || (emptyAgain && !showSizes);
  return (
    <div ref={contentRef} tabIndex={again ? (noControls ? 0 : -1) : undefined}>
      {c.phase === "pricing" ? (
        <p className="oh-text" role="status" aria-busy="true">
          {t("suggest.pricing")}
        </p>
      ) : null}
      {c.phase === "running" ? (
        c.progress === null ? (
          <p className="oh-text" role="status" aria-busy="true">
            {t("suggest.running")}
          </p>
        ) : (
          <ScreeningProgress label={t("suggest.progress", c.progress)} {...c.progress} />
        )
      ) : (
        <>
          {showSizes ? (
            <Seg
              label={again ? t("suggest.ariaAgain") : t("suggest.aria")}
              value={String(c.size)}
              options={c.sizes.map((size) => ({
                value: String(size),
                label: size === c.pool ? t("suggest.sizeAll", { count: size }) : String(size),
              }))}
              onChange={(size) => c.choose(Number(size))}
            />
          ) : null}
          {creditPrice ? <p className="oh-text sc-suggest-copy">{creditPrice}</p> : null}
          <div className={again && !emptyAgain ? "sc-suggest-actions" : undefined}>
            {!again || (c.phase === "ready" && c.quote !== null && !emptyAgain) ? (
              <Button
                kind="ink"
                size="s"
                disabled={c.phase !== "ready" || c.quote === null || c.quote.senders === 0}
                onPress={c.confirm}
              >
                {again ? t("suggest.confirmAgain", { n, count }) : t("suggest.confirm", { n })}
              </Button>
            ) : null}
            {!emptyAgain ? (
              <Button kind="quiet" size="s" onPress={c.cancel}>
                {t("suggest.cancel")}
              </Button>
            ) : null}
          </div>
          {c.notice ? (
            <p className={again ? "oh-text sc-suggest-copy" : "oh-text"} role="status">
              {c.notice}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

export function Tools({ view }: { view: ScreenerView }) {
  const t = useText("screener");
  const model = useScreener();
  const { suggest, ownSuggest } = useScreenerBeside();
  const { standing, subscriptionPane } = useNoAdvice();
  const standingLine = stripStandingKey(standing, subscriptionPane);
  if (view.segment !== "waiting") return null;
  const { applying } = model;
  const progress =
    applying === null ? null : <ScreeningProgress label={t("applying", applying)} {...applying} />;
  if (model.waitingCount === 0) {
    // The last decision can remove the last row before the bulk summary arrives.
    return progress === null ? null : (
      <div className="sc-tools" role="group" aria-label={t("bulkAria")}>
        {progress}
      </div>
    );
  }
  const may = !refused(model.role);
  const filtering = view.filter.choices.length > 0;
  const apply = may && model.suggestedCount > 0;
  /* What Spam and Screen out also send is said on any waiting queue this install may decide, tools or none. */
  const unsub =
    may &&
    model.waiting.some((x) => !model.isExiting(x.id) && model.unsubClaimOf(x, view.scopeOf(x)) !== "none");
  return (
    <div className="sc-tools" role="group" aria-label={t("bulkAria")}>
      {filtering ? (
        <Filter view={view} open={view.shown === "filter"} onOpen={(o) => view.show(o ? "filter" : null)} />
      ) : (
        <GroupHeading count={String(model.waitingCount)}>{t("filterAll")}</GroupHeading>
      )}
      {/* Offered to a reader too, as the released Screener offers it: advice moves no mail. */}
      {ownSuggest ??
        (suggest !== NONE ? (
          <Suggest suggest={suggest} allAnswered={model.waitingCount === model.suggestedCount} />
        ) : null)}
      {apply && applying === null ? (
        <Button kind="quiet" size="s" onPress={view.askApplySuggestions}>
          {t("applyAll", { count: model.suggestedCount, piles: pileList(model.suggestedDests, t) })}
        </Button>
      ) : null}
      {progress}
      <ListMenu view={view} />
      {standingLine ? <ListLine said>{t(standingLine)}</ListLine> : null}
      {unsub ? <ListLine>{t("bulkUnsub")}</ListLine> : null}
    </div>
  );
}
