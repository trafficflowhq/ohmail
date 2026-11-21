import { useContext, useEffect, useRef, useState, type RefObject } from "react";
import { useListWindow } from "@ohmail/app-logic/lists";
import { Button, Dialog, Empty, Field, Menu, MenuItem, Seg, Slot, Switch } from "@ohmail/ui/base";
import {
  GroupHeading,
  RuleLine,
  SettingFilter,
  SettingLine,
  SettingNote,
  SettingsSheet,
} from "@ohmail/ui/mail";
import { FrameContext } from "../../frame/commands.js";
import { useText } from "../../text/index.js";
import { rulesByDecider, rulesRevokable, rulesShown, type RuleItem, type RulesModel } from "./model.js";
import { RULES_NAMESPACE } from "./namespace.js";
import "./rule-facets.css";

/**
 * Settings › Rules: every rule as its sentence, searchable by sender or domain and filtered by where it files. A
 * change and a revoke each say, before they happen, that mail already filed stays where it is; a change may also ask
 * the pass to move the mail the rule filed, and says how much.
 */
export function RulesPane({
  model,
  scroller,
}: {
  readonly model: RulesModel;
  readonly scroller?: RefObject<HTMLDivElement | null>;
}) {
  const t = useText("rules");
  const settings = useText("settings");
  const own = useText(RULES_NAMESPACE);
  const [query, setQuery] = useState("");
  const [facet, setFacet] = useState("all");
  const [bulkOpen, setBulkOpen] = useState(false);
  const shown = rulesShown(model, query, facet);
  const at = facet !== "all" && model.facets.some((f) => f.folder === facet) ? facet : "all";
  const revokable = rulesRevokable(shown);
  const canRevokeGroup = model.locked === null && revokable.length > 0;
  useEffect(() => {
    if (!canRevokeGroup) setBulkOpen(false);
  }, [canRevokeGroup]);
  const { yours, ohmail } = rulesByDecider(shown);
  const headingIndex = yours.length;
  const noScroller = useRef<HTMLDivElement>(null);
  const win = useListWindow({
    scrollerRef: scroller ?? noScroller,
    count: shown.length + (ohmail.length > 0 ? 1 : 0),
  });
  const locked = model.locked !== null;
  const list = (rules: readonly RuleItem[], start: number, label: string) => {
    const from = Math.max(0, win.start - start);
    const until = Math.max(0, win.end - start);
    if (from >= rules.length || until <= from) return null;
    return (
      <div role="list" aria-label={label}>
        {rules.slice(from, until).map((rule, offset) => (
          <div
            key={rule.id}
            data-index={start + from + offset}
            role="listitem"
            aria-setsize={rules.length}
            aria-posinset={from + offset + 1}
          >
            <RuleRow rule={rule} model={model} />
          </div>
        ))}
      </div>
    );
  };

  return (
    <>
      <RulesFilters
        model={model}
        query={query}
        setQuery={setQuery}
        at={at}
        setFacet={setFacet}
        revokableCount={revokable.length}
        openBulk={() => setBulkOpen(true)}
        toTop={win.toTop}
      />
      {model.waiting.length > 0 ? (
        <SettingsSheet title={t("waitingGroup")}>
          {model.waiting.map((w) => (
            <WaitingLine key={w.key} what={w.what} line={w.line} />
          ))}
        </SettingsSheet>
      ) : null}
      <SettingsSheet>
        {model.rules.length === 0 ? (
          model.waiting.length === 0 ? (
            <Empty label={t("empty")} />
          ) : null
        ) : shown.length === 0 ? (
          <Empty label={t("noMatch")} />
        ) : (
          <div>
            <div aria-hidden data-window-top="" style={{ height: win.padTop }} />
            {list(yours, 0, settings("rules"))}
            {ohmail.length > 0 && win.start <= headingIndex && headingIndex < win.end ? (
              <div key="ohmail-heading" data-index={headingIndex}>
                <GroupHeading count={String(ohmail.length)}>{t("groupByOhmail")}</GroupHeading>
              </div>
            ) : null}
            {list(ohmail, headingIndex + 1, t("groupByOhmail"))}
            {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
          </div>
        )}
        <SettingNote>{t("noCount")}</SettingNote>
      </SettingsSheet>
      <Dialog
        open={bulkOpen && canRevokeGroup}
        onClose={() => setBulkOpen(false)}
        title={t("bulkRevokeConfirm", { count: revokable.length })}
        line={t("bulkRevokeExplain", { count: revokable.length })}
        confirm={{
          label: t("bulkRevokeConfirm", { count: revokable.length }),
          onPress: () => {
            setBulkOpen(false);
            model.revokeAll(revokable.map((r) => r.id));
          },
        }}
        cancel={{ label: t("cancel") }}
      />
    </>
  );
}

function WaitingLine({ what, line }: { readonly what: string; readonly line: string }) {
  return (
    <>
      <SettingLine label={what} />
      <SettingNote>{line}</SettingNote>
    </>
  );
}

/** One rule: its sentence with the place as the word that changes it, where it came from, what stands about it, Revoke. */
function RuleRow({ rule, model }: { readonly rule: RuleItem; readonly model: RulesModel }) {
  const t = useText("rules");
  const [changing, setChanging] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [refile, setRefile] = useState(model.refileFirst);
  const slot = useRef<HTMLButtonElement | null>(null);
  const held = model.locked !== null || rule.queued;
  const person = rule.person;
  const changeDetails = changing && !held ? rule.refile : null;
  useEffect(() => {
    if (held) {
      setChanging(false);
      setRevoking(false);
    }
  }, [held]);
  return (
    <div role="group" aria-label={rule.what}>
      <RuleLine
        who={rule.who}
        person={
          person
            ? {
                name: person.name,
                address: person.address,
                label: person.name,
                onContact: (anchor) => model.contact(person.address, anchor),
              }
            : undefined
        }
        goes={
          <Slot
            ref={slot}
            label={t("filesInto", { place: rule.place })}
            disabled={held}
            expanded={changing && !held}
            onPress={() => {
              if (held) return;
              setRefile(model.refileFirst);
              setChanging((open) => !open);
            }}
          >
            {rule.place}
          </Slot>
        }
        origin={rule.origin}
        act={
          <Button kind="quiet" size="s" disabled={held} opens="dialog" onPress={() => setRevoking(true)}>
            {t("revoke")}
          </Button>
        }
      />
      {rule.notes.map((note) => (
        <SettingNote key={note}>{note}</SettingNote>
      ))}
      {rule.outranked ? (
        <Button kind="quiet" size="s" disabled={held} onPress={() => model.lift(rule.id)}>
          {t("liftAction")}
        </Button>
      ) : null}
      {changeDetails && (
        <Menu
          open={changing}
          onClose={() => setChanging(false)}
          anchor={slot}
          label={t("change")}
          kind="card"
          title={rule.what}
        >
          <SettingNote>{refile ? changeDetails.on : t("retargetExplain")}</SettingNote>
          <Switch label={changeDetails.label} on={refile} onChange={setRefile} labelled />
          <SettingNote>{changeDetails.note}</SettingNote>
          {rule.places.map((place) => (
            <MenuItem
              key={place.folder}
              checked={place.current}
              disabled={place.current}
              onPress={() => {
                setChanging(false);
                model.retarget(rule.id, place.folder, refile);
              }}
            >
              {place.name}
            </MenuItem>
          ))}
        </Menu>
      )}
      <Dialog
        open={revoking && !held}
        onClose={() => setRevoking(false)}
        title={t("revokeConfirm")}
        line={t("revokeExplain")}
        kind="delete"
        confirm={{
          label: t("revokeConfirm"),
          onPress: () => {
            setRevoking(false);
            model.revoke(rule.id);
          },
        }}
        cancel={{ label: t("cancel") }}
      >
        <SettingNote>{rule.what}</SettingNote>
      </Dialog>
    </div>
  );
}

function RulesFilters({
  model,
  query,
  setQuery,
  at,
  setFacet,
  revokableCount,
  openBulk,
  toTop,
}: {
  model: RulesModel;
  query: string;
  setQuery: (query: string) => void;
  at: "all" | RulesModel["facets"][number]["folder"];
  setFacet: (facet: "all" | RulesModel["facets"][number]["folder"]) => void;
  revokableCount: number;
  openBulk: () => void;
  toTop: () => void;
}) {
  const t = useText("rules");
  const own = useText(RULES_NAMESPACE);
  const showSearch = model.rules.length >= 2;
  const showFacets = model.facets.length >= 2;
  const showBulk = revokableCount >= 2;
  const locked = model.locked !== null;
  return (
    <SettingsSheet
      wants={
        model.refusal
          ? {
              alert: true,
              word: own("notChanged"),
              line: model.refusal.why ? `${model.refusal.lead} ${model.refusal.why}` : model.refusal.lead,
            }
          : undefined
      }
    >
      <SettingNote>{model.intro}</SettingNote>
      {model.locked ? <SettingNote warn>{model.locked}</SettingNote> : null}
      {model.bound ? <SettingNote>{model.bound}</SettingNote> : null}
      {showSearch ? (
        <Field
          label={t("searchLabel")}
          placeholder={t("search")}
          type="search"
          value={query}
          onChange={(next) => {
            setQuery(next);
            toTop();
          }}
          bare
          sign="search"
        />
      ) : null}
      {showFacets || showBulk ? (
        <SettingFilter
          act={
            showBulk ? (
              <Button kind="quiet" size="s" disabled={locked} opens="dialog" onPress={() => openBulk()}>
                {t("bulkRevoke", { count: revokableCount })}
              </Button>
            ) : undefined
          }
        >
          {showFacets ? (
            <DestinationFilter
              model={model}
              value={at}
              onChange={(next) => {
                setFacet(next);
                toTop();
              }}
            />
          ) : null}
        </SettingFilter>
      ) : null}
    </SettingsSheet>
  );
}

function DestinationFilter({
  model,
  value,
  onChange,
}: {
  model: RulesModel;
  value: RulesModel["facets"][number]["folder"] | "all";
  onChange: (value: RulesModel["facets"][number]["folder"] | "all") => void;
}) {
  const t = useText("rules");
  const touch = (useContext(FrameContext)?.api.plan.device ?? "desktop") !== "desktop";
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const options = [
    { value: "all", label: t("facetAll") },
    ...model.facets.map((facet) => ({ value: facet.folder, label: facet.name })),
  ];
  const label = t("facetLabel");
  useEffect(() => {
    if (!touch) setOpen(false);
  }, [touch]);
  if (!touch) return <Seg label={label} value={value} onChange={onChange} options={options} />;
  return (
    <div className="rules-facet">
      <span className="rules-facet-key">{t("facetKey")}</span>
      <Slot ref={anchor} label={label} expanded={open} onPress={() => setOpen(!open)}>
        {options.find((option) => option.value === value)?.label ?? t("facetAll")}
      </Slot>
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} label={label} title={t("facetKey")}>
        {options.map((option) => (
          <MenuItem
            key={option.value}
            checked={option.value === value}
            onPress={() => {
              setOpen(false);
              onChange(option.value);
            }}
          >
            {option.label}
          </MenuItem>
        ))}
      </Menu>
    </div>
  );
}
