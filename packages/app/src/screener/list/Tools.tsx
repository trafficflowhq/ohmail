/**
 * THE QUEUE'S TOOLS, over Waiting: the filter (the groups the suggestions make, each with its count, the whole queue
 * first), Suggest (where the shell hands a run: the price before the spend, nothing bought before the confirm), and
 * Apply, which files every sender with a suggestion into the proposed pile.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  PILE_KEY,
  refused,
  type DecisionDestination,
  type ScreenerFilterId,
  type ScreenerView,
} from "@ohmail/app-logic/screener";
import { suggestMenuStandingKey } from "@ohmail/app-logic/screener/no-suggestion";
import { Button, Menu, MenuItem, MenuRule, Seg } from "@ohmail/ui/base";
import { GroupHeading } from "@ohmail/ui/mail";
import { NONE } from "../../host/index.js";
import { useText, type Text } from "../../text/index.js";
import { ListMenu, type ListMenuItem } from "../../place-list/ListMenu.js";
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
    <div className="sc-tool-heading" ref={at}>
      <GroupHeading
        opensMenu
        flushEnd
        hot
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

function Suggest({
  suggest,
  touch,
  listAnchor,
  again,
  fromList,
  start,
}: {
  suggest: ScreenerSuggest;
  touch: boolean;
  listAnchor: RefObject<HTMLButtonElement | null>;
  again: boolean;
  fromList: boolean;
  start: (again: boolean, fromList?: boolean) => void;
}) {
  const t = useText("screener");
  const button = useRef<HTMLButtonElement | null>(null);
  const reaskContent = useRef<HTMLDivElement | null>(null);
  const { standing, subscriptionPane } = useNoAdvice();
  const c = suggest.control;
  const open = c.phase !== "closed";
  const first = c.available > 0;
  if (!open && !first && c.resuggestable === 0) return null;
  const inline = !touch && first;
  const price =
    c.quote === null || again
      ? undefined
      : suggest.priced
        ? t("suggest.price", { senders: c.quote.senders, credits: c.quote.credits })
        : t("suggest.priceUnmetered", { senders: c.quote.senders });
  return (
    <>
      {inline ? (
        <Button
          kind="quiet"
          size="s"
          opens="menu"
          expanded={!c.disabled && open}
          disabled={c.disabled || c.phase === "running"}
          ref={button}
          onPress={open && !fromList ? c.cancel : () => start(false)}
        >
          {t("suggest.open")}
        </Button>
      ) : null}
      <Menu
        open={!c.disabled && open}
        onClose={c.cancel}
        anchor={inline && !fromList ? button : listAnchor}
        label={again ? t("suggest.ariaAgain") : t("suggest.aria")}
        kind="ask"
        fitContent={again}
        initialFocus={again ? reaskContent : undefined}
        title={again ? t("suggest.labelAgain") : t("suggest.label")}
        aside={c.phase === "ready" ? price : undefined}
      >
        <SuggestMenuContent
          suggest={suggest}
          again={again}
          contentRef={reaskContent}
          standingLine={suggestMenuStandingKey(standing, subscriptionPane)}
        />
        {!again && c.phase === "ready" && c.resuggestable > 0 ? (
          <>
            <MenuRule />
            <div className="sc-suggest-actions">
              <Button kind="quiet" size="s" onPress={() => start(true, fromList)}>
                {t("suggest.again")}
              </Button>
            </div>
          </>
        ) : null}
      </Menu>
    </>
  );
}

function SuggestMenuContent({
  suggest,
  again,
  contentRef,
  standingLine,
}: {
  suggest: ScreenerSuggest;
  again: boolean;
  contentRef: RefObject<HTMLDivElement | null>;
  standingLine: string | null;
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
  const creditRefusal = useText("aiRefusal")("insufficientCredits");
  const notice =
    standingLine !== null && (c.notice === null || c.notice === creditRefusal) ? t(standingLine) : c.notice;
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
                {t(again ? "suggest.confirmAgain" : "suggest.confirm", { n, count })}
              </Button>
            ) : null}
            {!emptyAgain ? (
              <Button kind="quiet" size="s" onPress={c.cancel}>
                {t("suggest.cancel")}
              </Button>
            ) : null}
          </div>
          {notice ? (
            <p className={again ? "oh-text sc-suggest-copy" : "oh-text"} role="status">
              {notice}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

export function Tools({
  view,
  touch,
  junkCount,
  extra,
}: {
  view: ScreenerView;
  touch?: boolean;
  junkCount?: number | null;
  extra?: ListMenuItem;
}) {
  const t = useText("screener");
  const model = useScreener();
  const { suggest, ownSuggest, facts } = useScreenerBeside();
  const listAnchor = useRef<HTMLButtonElement>(null);
  const [suggestionMenu, setSuggestionMenu] = useState({ again: false, fromList: false });
  const { applying } = model;
  const progress =
    applying === null ? null : <ScreeningProgress label={t("applying", applying)} {...applying} />;
  const waiting = view.segment === "waiting";
  const count = waiting ? model.waitingCount : (junkCount ?? view.rows.length);
  const counted = waiting
    ? model.queueSettled
    : junkCount !== undefined
      ? junkCount !== null
      : model.queueSettled && !facts.owed && model.copyBehind !== true;
  const may = !refused(model.role);
  const control = waiting && ownSuggest == null && suggest !== NONE ? suggest.control : null;
  const start = (again: boolean, fromList = false) => {
    setSuggestionMenu({ again, fromList });
    if (again) control?.openAgain();
    else control?.open();
  };
  const first = control !== null && control.available > 0;
  const reask = control !== null && control.resuggestable > 0;
  const items: ListMenuItem[] = extra ? [extra] : [];
  if (control && (first || reask)) {
    const label = t(first ? "suggest.open" : "suggest.again");
    items.push({
      label,
      spoken: label,
      note: String(first ? control.available : control.resuggestable),
      disabled: control.disabled,
      onPress: () => start(!first, true),
      apart: true,
    });
  }
  if (waiting && count > 0 && may)
    items.push({
      label: t("markAllSpam"),
      spoken: t("markAllSpam"),
      note: String(model.spamAllCount),
      onPress: view.askAllSpam,
      apart: items.length === 0,
    });
  const apply = waiting && may && model.suggestedCount > 0 && applying === null;
  const hasFilter = waiting && view.filter.choices.length > 0;
  const heading = t(waiting ? "filterAll" : view.segment === "screened" ? "segScreened" : "segSpam");
  return (
    <div
      className="sc-tools"
      role={waiting ? "group" : undefined}
      aria-label={waiting ? t("bulkAria") : undefined}
    >
      {hasFilter ? (
        <Filter view={view} open={view.shown === "filter"} onOpen={(o) => view.show(o ? "filter" : null)} />
      ) : (
        <div className="sc-tool-heading">
          <GroupHeading flushEnd hot={waiting} count={counted ? String(count) : undefined}>
            {heading}
          </GroupHeading>
        </div>
      )}
      {waiting &&
        (ownSuggest ??
          (suggest !== NONE ? (
            <Suggest
              suggest={suggest}
              touch={touch === true}
              listAnchor={listAnchor}
              {...suggestionMenu}
              start={start}
            />
          ) : null))}
      {apply ? (
        <Button kind="two" size="s" keyHint="a" onPress={view.askApplySuggestions}>
          {t("applyAll", { count: model.suggestedCount })}
        </Button>
      ) : null}
      <ListMenu label={t("place.listMenu")} size="s" items={items} mail anchorRef={listAnchor} />
      {progress}
    </div>
  );
}
