/**
 * THE QUEUE'S TOOLS, over Waiting: the filter (the groups the suggestions make, each with its count, the whole queue
 * first), Suggest (where the shell hands a run: the price before the spend, nothing bought before the confirm), and
 * Apply, which files every sender with a real suggestion where it says, and names those places on its button.
 */
import { useRef } from "react";
import {
  PILE_KEY,
  refused,
  type DecisionDestination,
  type ScreenerFilterId,
  type ScreenerView,
} from "@ohmail/app-logic/screener";
import { Button, Menu, MenuItem, Seg } from "@ohmail/ui/base";
import { GroupHeading, ListLine } from "@ohmail/ui/mail";
import { NONE } from "../../host/index.js";
import { useText, type Text } from "../../text/index.js";
import { ListMenu } from "./ListMenu.js";
import { useScreener, useScreenerBeside } from "../contract.js";
import type { ScreenerSuggest } from "../ports.js";

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

function Suggest({ suggest }: { suggest: ScreenerSuggest }) {
  const t = useText("screener");
  const at = useRef<HTMLButtonElement | null>(null);
  const c = suggest.control;
  const again = c.available === 0;
  if (c.available === 0 && c.resuggestable === 0) return null;
  const price =
    c.phase === "pricing" || c.quote === null
      ? t("suggest.pricing")
      : suggest.priced
        ? t("suggest.price", { senders: c.quote.senders, credits: c.quote.credits })
        : t("suggest.priceUnmetered", { senders: c.quote.senders });
  const n = c.quote?.senders ?? c.size;
  return (
    <>
      <Button
        kind="quiet"
        size="s"
        opens="menu"
        expanded={c.phase !== "closed"}
        ref={at}
        onPress={() => (c.phase === "closed" ? (again ? c.openAgain() : c.open()) : c.cancel())}
      >
        {again ? t("suggest.again") : t("suggest.open")}
      </Button>
      <Menu
        open={c.phase !== "closed"}
        onClose={c.cancel}
        anchor={at}
        label={again ? t("suggest.ariaAgain") : t("suggest.aria")}
        kind="ask"
        title={again ? t("suggest.labelAgain") : t("suggest.label")}
        aside={c.phase === "running" ? undefined : price}
      >
        {c.phase === "running" && c.progress !== null ? (
          <p className="oh-text">{t("suggest.progress", c.progress)}</p>
        ) : (
          <>
            <Seg
              label={again ? t("suggest.ariaAgain") : t("suggest.aria")}
              value={String(c.size)}
              options={c.sizes.map((size) => ({
                value: String(size),
                label: size === c.pool ? t("suggest.sizeAll", { count: size }) : String(size),
              }))}
              onChange={(size) => c.choose(Number(size))}
            />
            <Button kind="ink" size="s" disabled={c.phase !== "ready"} onPress={c.confirm}>
              {again ? t("suggest.confirmAgain", { n }) : t("suggest.confirm", { n })}
            </Button>
            <Button kind="quiet" size="s" onPress={c.cancel}>
              {t("suggest.cancel")}
            </Button>
          </>
        )}
        {c.notice ? <p className="oh-text">{c.notice}</p> : null}
      </Menu>
    </>
  );
}

export function Tools({ view }: { view: ScreenerView }) {
  const t = useText("screener");
  const model = useScreener();
  const { suggest } = useScreenerBeside();
  if (view.segment !== "waiting" || model.waitingCount === 0) return null;
  const may = !refused(model.role);
  const filtering = view.filter.choices.length > 0;
  const apply = may && model.suggestedCount > 0 && model.applying === null;
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
      {suggest !== NONE ? <Suggest suggest={suggest} /> : null}
      {model.applying !== null ? (
        <ListLine>{t("applying", model.applying)}</ListLine>
      ) : apply ? (
        <Button kind="quiet" size="s" onPress={() => model.applyAll(view.scopeOf)}>
          {t("applyAll", { count: model.suggestedCount, piles: pileList(model.suggestedDests, t) })}
        </Button>
      ) : null}
      <ListMenu view={view} />
      {unsub ? <ListLine>{t("bulkUnsub")}</ListLine> : null}
    </div>
  );
}
