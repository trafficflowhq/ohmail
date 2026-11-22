import { useContext, useState, type ComponentProps } from "react";
import { ContactCard } from "@ohmail/ui/mail";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { Dialog, Field, MenuItem, RadioLines, Switch } from "@ohmail/ui/base";
import { placeOfFolder } from "@ohmail/app-logic/reader";
import { ConsentContext } from "@ohmail/app-logic/consent";
import { useDemoMode, useEngineOrNull } from "@ohmail/app-logic/engine";
import { otherOrganizerOf, useMailboxFacts } from "@ohmail/app-logic/mail-state";
import { contactScreening, screenContact } from "@ohmail/app-logic/press";
import { firstImportsOf } from "@ohmail/app-logic/press/consent-options";
import {
  countedOf,
  screeningOrganizerCopy,
  RETRO_DEFAULT_ON,
  SCREENING_DESTS,
  type ScreeningDest,
  type ScreeningPlace,
  type ScreeningScope,
} from "@ohmail/app-logic/press/sender-screening";
import {
  MAX_SUBJECT_TERM_CHARS,
  planSubjectRule,
  subjectOrganizerMissing,
  subjectRuleContext,
  subjectMatchCount,
  subjectRuleToast,
} from "@ohmail/app-logic/press/subject-rule";
import { browserOffline, queuedWaitOf } from "@ohmail/app-logic/press/queued-sentence";
import { isSharedDomain, PILE_KEY } from "@ohmail/app-logic/screener";
import { displayDomainLabel } from "@ohmail/app-logic/text/idn";
import { useFrame, useReport } from "../../frame/index.js";
import { useOwnAddresses, usePressWhereOn } from "../../frame/room.js";
import { NONE } from "../../host/index.js";
import { useText, useTextLookup } from "../../text/index.js";
import { PartsContext } from "../parts.js";
import { ContactDetails, type ContactOf } from "./Contact.js";

type Extras = Pick<ComponentProps<typeof ContactCard>, "scope" | "now" | "goes" | "rules" | "switches">;

export function Contact({ person, onClose }: { person: ContactOf | null; onClose: () => void }) {
  const inReader = useContext(PartsContext);
  const { host } = useFrame();
  const reader = host.features.reader;
  const Screening = reader === NONE ? undefined : reader.Screening;
  const clipboard = inReader?.copy ?? (reader === NONE ? NONE : (reader.copy ?? NONE));
  if (person && Screening) {
    return (
      <Screening key={person.slot} person={person} direct={person.direct} onClose={onClose}>
        {(subjectRule, card, showAddress) => (
          <ContactDetails
            person={person}
            clipboard={clipboard}
            onClose={onClose}
            subjectRule={subjectRule}
            card={card}
            showAddress={showAddress}
          />
        )}
      </Screening>
    );
  }
  return person ? (
    <ScreeningContact key={person.slot} person={person} onClose={onClose} clipboard={clipboard} />
  ) : null;
}

function ScreeningContact({
  person,
  onClose,
  clipboard,
}: {
  person: ContactOf;
  onClose: () => void;
  clipboard: ComponentProps<typeof ContactDetails>["clipboard"];
}) {
  const { host, commands } = useFrame();
  const engine = useEngineOrNull();
  const press = usePressWhereOn();
  const consent = useContext(ConsentContext);
  const facts = useMailboxFacts();
  const ownAddresses = useOwnAddresses();
  const demo = useDemoMode();
  const [scope, setScope] = useState<ScreeningScope>("sender");
  const [rule, setRule] = useState(true);
  const [retro, setRetro] = useState(RETRO_DEFAULT_ON);
  const [subjectOpen, setSubjectOpen] = useState(false);
  const t = useText("screening");
  const s = useText("screener");
  const report = useReport();
  const lookup = useTextLookup();
  const seedId = person.messageId;
  const input =
    seedId && engine && press && host.features.places.screener !== NONE
      ? {
          engine,
          press,
          consent,
          demo,
          ownAddresses,
          seedId,
          address: person.address,
          firstImports: firstImportsOf(facts),
        }
      : null;
  const sender = input && contactScreening(input);
  if (!input || !sender) return <ContactDetails person={person} clipboard={clipboard} onClose={onClose} />;

  const shared = isSharedDomain(person.address);
  const scopeHere = shared || !sender.domain ? "sender" : scope;
  const model = sender.scopes[scopeHere];
  const makeRule = model.waiting || rule;
  const organizer = otherOrganizerOf(facts, new Set(sender.messages.map((message) => message.mailboxId)));
  const organizerNote =
    organizer && (organizer.nobody || makeRule) ? screeningOrganizerCopy(organizer) : null;
  const placeName = (place: ScreeningPlace): string => {
    if (place === "screener") return t("placeScreener");
    if (place === "history") return t("placeHistory");
    if (place.startsWith("folder:")) return place.split("|").slice(1).join("|");
    return s(PILE_KEY[place as ScreeningDest]);
  };
  const places = SCREENING_DESTS.map((value) => ({ value, label: placeName(value) }));
  const subject =
    subjectOpen && person.onSender ? subjectRuleContext(input.engine.verbRead(), input.seedId) : null;
  if (subjectOpen && subject && subject.address.toLowerCase() === person.address.toLowerCase()) {
    const nobody =
      otherOrganizerOf(facts, new Set(subject.messages.map((message) => message.mailboxId)))?.nobody === true;
    return (
      <SubjectContact input={input} context={subject} places={places} onClose={onClose} nobody={nobody} />
    );
  }
  const extras = screeningExtras({
    sender,
    scope: { value: scopeHere, shared, set: setScope },
    rules: { rule, setRule, retro, setRetro },
    address: person.address,
    copy: { places, placeName, t },
    openAudit: auditAction(host.features.places.address !== NONE, person.address, commands, onClose),
    onFile: (value) => {
      const dest = SCREENING_DESTS.find((dest) => dest === value);
      if (!dest) return;
      onClose();
      screenContact({
        ...input,
        dest,
        scope: scopeHere,
        makeRule,
        applyRetro: makeRule && retro,
        name: person.name,
        place: placeName(dest),
        toast: report,
        t: (key, values) => {
          const dot = key.indexOf(".");
          return lookup(key.slice(0, dot))(key.slice(dot + 1), values);
        },
      });
    },
  });
  return (
    <ContactDetails
      person={person}
      clipboard={clipboard}
      onClose={onClose}
      screening={extras}
      organizerNote={organizerNote ? t(organizerNote.key, organizerNote.values) : undefined}
      subjectRule={
        person.onSender ? (
          <MenuItem icon="plus" onPress={() => setSubjectOpen(true)}>
            {t("subjectRuleOpen")}
          </MenuItem>
        ) : undefined
      }
    />
  );
}

function auditAction(
  available: boolean,
  address: string,
  commands: ReturnType<typeof useFrame>["commands"],
  onClose: () => void,
): (() => void) | undefined {
  if (!available) return undefined;
  return () => {
    onClose();
    commands.go({ place: "address", sub: address });
  };
}

function screeningExtras({
  sender,
  scope: { value: scopeHere, shared, set: setScope },
  rules: { rule, setRule, retro, setRetro },
  address,
  copy: { places, placeName, t },
  openAudit,
  onFile,
}: {
  sender: NonNullable<ReturnType<typeof contactScreening>>;
  scope: { value: ScreeningScope; shared: boolean; set: (scope: ScreeningScope) => void };
  rules: {
    rule: boolean;
    setRule: (rule: boolean) => void;
    retro: boolean;
    setRetro: (retro: boolean) => void;
  };
  address: string;
  copy: {
    places: NonNullable<Extras["goes"]>["places"];
    placeName: (place: ScreeningPlace) => string;
    t: ReturnType<typeof useText>;
  };
  openAudit?: () => void;
  onFile: (value: string) => void;
}): Extras {
  const model = sender.scopes[scopeHere];
  const makeRule = model.waiting || rule;
  const count = countedOf(model);
  const current = model.current === null ? "" : placeName(model.current);
  return {
    scope:
      shared || !sender.domain
        ? undefined
        : {
            label: t("scopeAria"),
            value: scopeHere,
            options: [
              {
                value: "sender",
                label: t("scopeAddress"),
                note: t("scopeCountOne", { count: countedOf(sender.scopes.sender) }),
              },
              {
                value: "domain",
                label: t("scopeDomain", { domain: displayDomainLabel(address) }),
                note: t("scopeCount", {
                  count: countedOf(sender.scopes.domain),
                  senders: sender.scopes.domain.placedSenders,
                }),
              },
            ],
            onChange: (value) => setScope(value === "domain" ? "domain" : "sender"),
          },
    now:
      count > 0
        ? {
            line: current ? t("nowIn", { place: current }) : t("nowSpread", { count }),
            description: current ? t("nowInWithCount", { place: current, count }) : undefined,
            place: current,
            all:
              scopeHere === "sender" && openAudit
                ? {
                    label: t("auditOpen"),
                    ariaLabel: t("auditOpenAria", { count: model.messages.length }),
                    onPress: openAudit,
                  }
                : undefined,
          }
        : undefined,
    goes: {
      label: t("sectionWhere"),
      value: model.ruled ?? model.current ?? undefined,
      places,
      onChange: onFile,
    },
    rules: sender.rules.slice(0, 3).map((r) => ({
      place: placeName((placeOfFolder(r.destination) as ScreeningPlace | null) ?? "history"),
      note: r.subjectContains
        ? t("ruleSubject", { term: r.subjectContains })
        : r.bodyContains
          ? t("ruleBody", { term: r.bodyContains })
          : r.kind === "domain"
            ? t("scopeDomain", { domain: displayDomainLabel(address) })
            : t("ruleAll"),
    })),
    switches: [
      ...(model.waiting ? [] : [{ label: t("ruleToggle"), on: rule, onChange: setRule }]),
      ...(makeRule ? [{ label: t("retroToggleAria"), on: retro, onChange: setRetro }] : []),
    ],
  };
}

function SubjectContact({
  input,
  context,
  places,
  onClose,
  nobody,
}: {
  input: NonNullable<Parameters<typeof contactScreening>[0]>;
  context: NonNullable<ReturnType<typeof subjectRuleContext>>;
  places: readonly { value: ScreeningDest; label: string }[];
  onClose: () => void;
  nobody: boolean;
}) {
  const t = useText("screening");
  const report = useReport();
  const [term, setTerm] = useState(context.token ?? context.subject);
  const [dest, setDest] = useState<ScreeningDest | null>(null);
  const [retro, setRetro] = useState(RETRO_DEFAULT_ON);
  const place = places.find((place) => place.value === dest)?.label ?? "";
  const confirm = () => {
    if (!dest) return;
    const live = subjectRuleContext(input.engine.verbRead(), input.seedId);
    if (!live || live.address.toLowerCase() !== input.address.toLowerCase() || !contactScreening(input))
      return;
    const plan = planSubjectRule(live, term, dest, "subject", retro);
    onClose();
    const send = (mutation: (typeof plan.mutations)[number]) =>
      input.press.fileAndRefresh(input.engine.mutate(mutation));
    void Promise.all(plan.mutations.map(send)).then((results) => {
      const key = subjectRuleToast(plan, results[0]?.status ?? null, queuedWaitOf(results, browserOffline()));
      if (key) report(t(key, { term: plan.term, place, count: plan.matched }));
    });
  };
  const where = t("subjectMatchCount", {
    hit: subjectMatchCount(context.messages, term),
    total: context.messages.length,
  });
  return (
    <Dialog
      open
      title={t("subjectAria")}
      line={displayAddress(context.address)}
      onClose={onClose}
      cancel={{ label: t("cancel") }}
      keysOn="cancel"
      confirm={{
        label: t("subjectConfirmGo"),
        onPress: confirm,
        disabled: !dest || term.trim() === "" || term.trim().length > MAX_SUBJECT_TERM_CHARS,
      }}
    >
      <Field
        label={t("subjectTermAria")}
        placeholder={t("subjectTermPlaceholder")}
        value={term}
        onChange={setTerm}
      />
      <p className="oh-text" aria-hidden="true">
        {where}
      </p>
      <RadioLines
        label={where}
        options={places}
        value={dest ?? ""}
        onChange={(value) => {
          setDest(SCREENING_DESTS.find((dest) => dest === value) ?? null);
        }}
      />
      <Switch label={t("retroToggleAria")} on={retro} onChange={setRetro} />
      {nobody ? <p>{t(subjectOrganizerMissing)}</p> : null}
    </Dialog>
  );
}
