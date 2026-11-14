import { useRef, useState } from "react";
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
export function RulesPane({ model }: { readonly model: RulesModel }) {
  const t = useText("rules");
  const own = useText(RULES_NAMESPACE);
  const [query, setQuery] = useState("");
  const [facet, setFacet] = useState("all");
  const [bulkOpen, setBulkOpen] = useState(false);
  const shown = rulesShown(model, query, facet);
  const at = facet !== "all" && model.facets.some((f) => f.folder === facet) ? facet : "all";
  const revokable = rulesRevokable(shown);
  const { yours, ohmail } = rulesByDecider(shown);
  const showSearch = model.rules.length >= 2;
  const showFacets = model.facets.length >= 2;
  const showBulk = revokable.length >= 2;
  const locked = model.locked !== null;

  return (
    <>
      <SettingsSheet
        wants={
          model.refusal
            ? {
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
            onChange={setQuery}
            bare
            sign="search"
          />
        ) : null}
        {showFacets || showBulk ? (
          <SettingFilter
            act={
              showBulk ? (
                <Button
                  kind="quiet"
                  size="s"
                  disabled={locked}
                  opens="dialog"
                  onPress={() => setBulkOpen(true)}
                >
                  {t("bulkRevoke", { count: revokable.length })}
                </Button>
              ) : undefined
            }
          >
            {showFacets ? (
              <Seg
                label={t("facetLabel")}
                value={at}
                onChange={setFacet}
                options={[
                  { value: "all", label: t("facetAll") },
                  ...model.facets.map((f) => ({ value: f.folder, label: f.name })),
                ]}
              />
            ) : null}
          </SettingFilter>
        ) : null}
      </SettingsSheet>
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
          <>
            {yours.map((rule) => (
              <RuleRow key={rule.id} rule={rule} model={model} />
            ))}
            {ohmail.length > 0 ? (
              <GroupHeading count={String(ohmail.length)}>{t("groupByOhmail")}</GroupHeading>
            ) : null}
            {ohmail.map((rule) => (
              <RuleRow key={rule.id} rule={rule} model={model} />
            ))}
          </>
        )}
        <SettingNote>{t("noCount")}</SettingNote>
      </SettingsSheet>
      <Dialog
        open={bulkOpen}
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
  return (
    <>
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
            expanded={changing}
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
      <Menu
        open={changing}
        onClose={() => setChanging(false)}
        anchor={slot}
        label={t("change")}
        kind="card"
        title={rule.what}
      >
        <SettingNote>{refile ? rule.refile.on : t("retargetExplain")}</SettingNote>
        <Switch label={rule.refile.label} on={refile} onChange={setRefile} labelled />
        <SettingNote>{rule.refile.note}</SettingNote>
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
      <Dialog
        open={revoking}
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
    </>
  );
}
