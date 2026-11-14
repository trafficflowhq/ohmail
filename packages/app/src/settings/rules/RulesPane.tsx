import { useEffect, useRef, useState, type RefObject } from "react";
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
import { useText } from "../../text/index.js";
import { rulesByDecider, rulesRevokable, rulesShown, type RuleItem, type RulesModel } from "./model.js";
import { RULES_NAMESPACE } from "./namespace.js";

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
  const rows = ohmail.length > 0 ? [...yours, null, ...ohmail] : yours;
  const noScroller = useRef<HTMLDivElement>(null);
  const win = useListWindow({ scrollerRef: scroller ?? noScroller, count: rows.length });
  const locked = model.locked !== null;

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
          <div role="list" aria-label={settings("rules")}>
            <div aria-hidden data-window-top="" style={{ height: win.padTop }} />
            {rows.slice(win.start, win.end).map((rule, offset) => {
              const index = win.start + offset;
              return rule === null ? (
                <div key="ohmail-heading" data-index={index}>
                  <GroupHeading count={String(ohmail.length)}>{t("groupByOhmail")}</GroupHeading>
                </div>
              ) : (
                <div
                  key={rule.id}
                  data-index={index}
                  role="listitem"
                  aria-setsize={shown.length}
                  aria-posinset={rule.byOhmail ? index : index + 1}
                >
                  <RuleRow rule={rule} model={model} />
                </div>
              );
            })}
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
            <Seg
              label={t("facetLabel")}
              value={at}
              onChange={(next) => {
                setFacet(next);
                toTop();
              }}
              options={[
                { value: "all", label: t("facetAll") },
                ...model.facets.map((f) => ({ value: f.folder, label: f.name })),
              ]}
            />
          ) : null}
        </SettingFilter>
      ) : null}
    </SettingsSheet>
  );
}
