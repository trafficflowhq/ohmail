import { useEffect, useRef, useState } from "react";
import { Button, Seg, design, hueStyle } from "@ohmail/ui/base";
import { LookPicture, SettingLine, SettingsSheet, SettingTile, SettingTiles } from "@ohmail/ui/mail";
import { useText, type Text } from "../../text/index.js";
import type { GeneralModel, LookFace, ServerSwitch, ThemeChoice } from "./model.js";
import { GENERAL_NAMESPACE } from "./namespace.js";
import "./subject-picture.css";

export interface GeneralPaneProps {
  readonly model: GeneralModel;
}

/** General: the language, the appearance, how messages are drawn and sent, and the host's own line. */
export function GeneralPane({ model }: GeneralPaneProps) {
  const t = useText("settings");
  const g = useText(GENERAL_NAMESPACE);
  return (
    <>
      {model.language ? <LanguageSheet language={model.language} t={t} /> : null}
      <AppearanceSheet model={model} t={t} g={g} />
      <MessagesSheet model={model} t={t} g={g} />
      {model.defaultMail ? <SettingsSheet>{model.defaultMail()}</SettingsSheet> : null}
    </>
  );
}

function LanguageSheet({ language, t }: { language: NonNullable<GeneralModel["language"]>; t: Text }) {
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const alive = useAlive();
  const choose = (next: string) => {
    // A second press while the first is still being written would race it.
    if (saving || language.busy || next === language.value) return;
    setSaving(true);
    setFailed(false);
    language
      .set(next)
      .catch(() => {
        if (alive.current) setFailed(true);
      })
      .finally(() => {
        if (alive.current) setSaving(false);
      });
  };
  return (
    <SettingsSheet wants={failed ? { word: t("notSaved"), line: t("languageFailed") } : undefined}>
      <SettingLine label={t("language")}>
        <Seg
          label={t("languageAria")}
          value={language.value}
          onChange={choose}
          options={language.choices.map((id) => ({ value: id, label: t(`languageName.${id}`) }))}
        />
      </SettingLine>
      <p className="oh-vh">{t(language.local ? "languageHintLocal" : "languageHint")}</p>
    </SettingsSheet>
  );
}

function AppearanceSheet({ model, t, g }: { model: GeneralModel; t: Text; g: Text }) {
  const { theme, look, textSize } = model;
  const scope = look.scope;
  const rows = [
    { who: g("picture.first"), address: g("picture.first"), time: g("picture.firstTime") },
    { who: g("picture.second"), address: g("picture.second"), time: g("picture.secondTime") },
  ] as const;
  const tile = (face: LookFace, name: string, tag?: string) => (
    <SettingTile
      name={name}
      tag={tag}
      on={look.face === face}
      onPress={() => face !== look.face && look.set(face)}
    >
      <LookPicture face={face} scheme={look.scheme} title={g("picture.title")} rows={rows} />
    </SettingTile>
  );
  return (
    <SettingsSheet title={g("appearance")}>
      <SettingLine label={t("theme")}>
        <Seg<ThemeChoice>
          label={t("themeAria")}
          value={theme.value}
          onChange={(next) => next !== theme.value && theme.set(next)}
          options={[
            { value: "light", label: t("themeLight") },
            { value: "system", label: t("themeAuto") },
            { value: "dark", label: t("themeDark") },
          ]}
        />
      </SettingLine>
      {scope ? (
        <SettingLine
          label={t("face")}
          narrow="detail"
          value={t(
            scope.governs === "all"
              ? "faceScopeAll"
              : scope.governs === "device"
                ? "faceScopeDevice"
                : "faceScopeDefault",
          )}
        >
          {scope.governs === "all" ? null : (
            <Button kind="quiet" size="s" disabled={scope.busy} onPress={() => scope.applyAll()}>
              {t("faceApplyAll")}
            </Button>
          )}
        </SettingLine>
      ) : null}
      <SettingTiles label={g("lookChoice")}>
        {tile("paper", t("facePaper"))}
        {tile("ohmarchy", t("faceOhmarchy"), g("followsOmarchy"))}
      </SettingTiles>
      <SettingLine label={t("textSize")} narrow="under">
        <Seg
          label={t("textSizeAria")}
          value={String(textSize.value)}
          onChange={(next) => {
            const n = Number(next);
            if (n !== textSize.value) textSize.set(n);
          }}
          options={textSize.choices.map((n) => ({ value: String(n), label: t("textSizeValue", { n }) }))}
        />
      </SettingLine>
    </SettingsSheet>
  );
}

function MessagesSheet({ model, t, g }: { model: GeneralModel; t: Text; g: Text }) {
  const { imageQuality, afterVerb, subject, threadOrder, images, pixels } = model;
  const imagesWrite = useServerWrite();
  const pixelsWrite = useServerWrite();
  const failed = imagesWrite.failed ? t("images.failed") : pixelsWrite.failed ? t("pixels.failed") : null;
  return (
    <SettingsSheet title={g("messages")} wants={failed ? { word: t("notSaved"), line: failed } : undefined}>
      <SettingLine label={g("subject")} />
      <SettingTiles label={g("subject")}>
        <SettingTile
          name={g("subjectHead")}
          on={subject.value === "head"}
          onPress={() => subject.set("head")}
        >
          <SubjectPicture each={false} g={g} />
        </SettingTile>
        <SettingTile
          name={g("subjectEach")}
          on={subject.value === "each"}
          onPress={() => subject.set("each")}
        >
          <SubjectPicture each g={g} />
        </SettingTile>
      </SettingTiles>
      <SettingLine label={g("threadOrder")} narrow="under">
        <Seg
          label={g("threadOrder")}
          value={threadOrder.value}
          onChange={threadOrder.set}
          options={[
            { value: "bottom", label: g("threadOrderBottom") },
            { value: "top", label: g("threadOrderTop") },
          ]}
        />
      </SettingLine>
      <SettingLine label={t("imageQuality")} narrow="under">
        <Seg
          label={t("imageQualityAria")}
          value={imageQuality.value}
          onChange={(next) => next !== imageQuality.value && imageQuality.set(next)}
          options={imageQuality.choices.map((id) => ({ value: id, label: t(`imageQualityLevel.${id}`) }))}
        />
      </SettingLine>
      <SettingLine label={t("afterVerb")} narrow="under">
        <Seg
          label={t("afterVerbAria")}
          value={afterVerb.value}
          onChange={(next) => next !== afterVerb.value && afterVerb.set(next)}
          options={afterVerb.choices.map((id) => ({ value: id, label: t(`afterVerbChoice.${id}`) }))}
        />
      </SettingLine>
      {images ? <ImagesLines images={images} write={imagesWrite} t={t} /> : null}
      {pixels ? <PixelsLines pixels={pixels} write={pixelsWrite} t={t} /> : null}
    </SettingsSheet>
  );
}

function SubjectPicture({ each, g }: { each: boolean; g: Text }) {
  return (
    <span className="subject-picture" data-shared={each ? undefined : ""} aria-hidden="true">
      {!each && <b className="subject-picture-heading">{g("subjectSample")}</b>}
      {["subjectSample", "subjectReplySample"].map((sample, index) => (
        <span className="subject-picture-letter" key={sample}>
          {each && <b className="subject-picture-subject">{g(sample)}</b>}
          <i
            className="subject-picture-avatar"
            style={hueStyle(index === 0 ? design.tagHues.terracotta : design.tagHues.slate)}
          />
          <i className="subject-picture-name" />
          <i className="subject-picture-line" />
          <i className="subject-picture-line" />
        </span>
      ))}
    </span>
  );
}

function ImagesLines({ images, write, t }: { images: ServerSwitch; write: ServerWrite; t: Text }) {
  return (
    <SettingLine
      label={t("images.title")}
      off={write.pending}
      toggle={{ on: !images.blocked, onChange: (load) => write.run(() => images.set(!load)) }}
    />
  );
}

function PixelsLines({ pixels, write, t }: { pixels: ServerSwitch; write: ServerWrite; t: Text }) {
  return (
    <SettingLine
      label={t("pixels.title")}
      off={write.pending}
      toggle={{ on: pixels.blocked, onChange: (block) => write.run(() => pixels.set(block)) }}
    />
  );
}

interface ServerWrite {
  readonly pending: boolean;
  readonly failed: boolean;
  run(write: () => Promise<unknown>): void;
}

/** One write at a time; the line draws the server's answer, and a refusal is said until the next press. */
function useServerWrite(): ServerWrite {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const alive = useAlive();
  return {
    pending,
    failed,
    run(write) {
      if (pending) return;
      setPending(true);
      setFailed(false);
      write()
        .catch(() => {
          if (alive.current) setFailed(true);
        })
        .finally(() => {
          if (alive.current) setPending(false);
        });
    },
  };
}

function useAlive() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}
