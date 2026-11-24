import { useEffect, useRef, useState } from "react";
import { Button, Dialog, EndDot, Menu, MenuItem, Slot } from "@ohmail/ui/base";
import { SettingActs, SettingLine, SettingNote } from "@ohmail/ui/mail";
import type { ScreenerLearningEdit, ScreenerLearningView } from "@ohmail/wire";
import { useText } from "../../text/index.js";
import type { ScreenerLearner } from "./model.js";
import "./learning-controls.css";

function LearnedCard({
  state,
  busy,
  forget,
  startOver,
}: {
  readonly state: ScreenerLearningView;
  readonly busy: boolean;
  readonly forget: (id: string) => void;
  readonly startOver: () => void;
}) {
  const t = useText("settingsScreener");
  return (
    <>
      <div className="oh-settingssheet-head">
        <h3 className="oh-text oh-settingssheet-title">{t("learning.title")}</h3>
      </div>
      <p className="oh-text screener-learned-note">{state.text || t("learning.empty")}</p>
      {state.updatedAt !== null ? (
        <p className="oh-text screener-learning-label">
          <EndDot kind="hot">{t("learning.updated")}</EndDot>
        </p>
      ) : null}
      {state.lessons.length ? (
        <>
          <h4 className="oh-text screener-learning-label">{t("learning.recent")}</h4>
          {state.lessons.map((lesson) => {
            const topic = t(`learning.topics.${lesson.topic}`);
            const previous = lesson.previous ?? lesson.suggested;
            const chosen = t(`learning.places.${lesson.chosen}`);
            const label = previous
              ? t("learning.moved", { topic, from: t(`learning.places.${previous}`), to: chosen })
              : t("learning.chosen", { topic, to: chosen });
            return (
              <SettingLine key={lesson.id} label={label}>
                <Button kind="quiet" size="s" disabled={busy} onPress={() => forget(lesson.id)}>
                  {t("learning.forget")}
                </Button>
              </SettingLine>
            );
          })}
        </>
      ) : null}
      {state.lessons.length || state.text ? (
        <SettingActs>
          <Button kind="quiet" size="s" disabled={busy} onPress={startOver}>
            {t("learning.reset")}
          </Button>
        </SettingActs>
      ) : null}
    </>
  );
}

function LearningMailboxPicker({
  learning,
  id,
  label,
  busy,
  select,
}: {
  readonly learning: ScreenerLearner;
  readonly id: string;
  readonly label: string;
  readonly busy: boolean;
  readonly select: (id: string) => void;
}) {
  const t = useText("settingsScreener");
  const anchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  return (
    <SettingLine label={t("learning.mailbox")}>
      <Slot
        ref={anchor}
        label={t("learning.mailbox")}
        expanded={menu}
        disabled={busy}
        onPress={() => setMenu(!menu)}
      >
        {label}
      </Slot>
      <Menu
        anchor={anchor}
        title={t("learning.mailbox")}
        label={t("learning.mailbox")}
        open={menu}
        onClose={() => setMenu(false)}
      >
        {learning.mailboxes.map((box) => (
          <MenuItem
            key={box.id}
            checked={box.id === id}
            onPress={() => {
              select(box.id);
              setMenu(false);
            }}
          >
            {box.label}
          </MenuItem>
        ))}
      </Menu>
    </SettingLine>
  );
}

export function LearningControls({ learning }: { readonly learning: ScreenerLearner }) {
  const t = useText("settingsScreener");
  const [selected, setSelected] = useState("");
  const mailbox = learning.mailboxes.find((box) => box.id === selected) ?? learning.mailboxes[0];
  const id = mailbox?.id;
  const [loaded, setLoaded] = useState<{
    read: typeof learning.read;
    id: string;
    view: ScreenerLearningView;
  }>();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!id) return;
    let active = true;
    const read = learning.read;
    void read(id).then(
      (view) => {
        if (active && typeof view.enabled === "boolean" && Array.isArray(view.lessons))
          setLoaded({ id, read, view });
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [id, learning.read]);
  const state = loaded?.id === id && loaded?.read === learning.read ? loaded?.view : undefined;
  const change = (edit: ScreenerLearningEdit) => {
    if (!id || !state || busy) return;
    setBusy(true);
    setFailed(false);
    const read = learning.read;
    void learning
      .change(id, edit)
      .then(
        (view) => setLoaded({ id, read, view }),
        () => setFailed(true),
      )
      .finally(() => setBusy(false));
  };
  if (!id || !mailbox) return null;
  return (
    <>
      {learning.mailboxes.length > 1 ? (
        <LearningMailboxPicker
          learning={learning}
          id={id}
          label={mailbox.label}
          busy={busy}
          select={setSelected}
        />
      ) : null}
      {failed ? <SettingNote warn>{t("learning.failed")}</SettingNote> : null}
      {state ? (
        <>
          <SettingLine
            label={t("learning.switch")}
            toggle={{
              on: state.enabled && state.aiEnabled,
              onChange: (enabled) => change({ kind: "enable", enabled }),
            }}
            off={busy || !state.aiEnabled}
          />
          <SettingNote>{t("learning.description")}</SettingNote>
          {state.enabled && state.aiEnabled && state.notice ? (
            <SettingLine label={t("learning.notice")}>
              <Button kind="quiet" size="s" disabled={busy} onPress={() => change({ kind: "notice" })}>
                {t("learning.ok")}
              </Button>
            </SettingLine>
          ) : null}
          {state.enabled && state.aiEnabled && learning.metered ? (
            <SettingNote>{t("learning.price")}</SettingNote>
          ) : null}
          {state.enabled && state.aiEnabled ? (
            <LearnedCard
              state={state}
              busy={busy}
              forget={(id) => change({ kind: "forget", id })}
              startOver={() => setAsking(true)}
            />
          ) : null}
          <Dialog
            alert
            open={asking}
            keysOn="cancel"
            onClose={() => setAsking(false)}
            title={t("learning.reset")}
            hot
            confirm={{
              label: t("learning.reset"),
              onPress: () => {
                setAsking(false);
                change({ kind: "reset" });
              },
            }}
            cancel={{ label: t("learning.cancel") }}
          >
            <p>{t("learning.resetSummary")}</p>
          </Dialog>
        </>
      ) : null}
    </>
  );
}
