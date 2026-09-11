/**
 * Settings — appearance, new mail, and what this build is.
 *
 * Every control here is real, and every claim is one this build can keep: the
 * theme switch is the app's own preference, the New mail block registers with
 * the server this phone is paired with, and the About block states what is live
 * and names what is not. The remaining per-server settings (rules, mailboxes)
 * arrive with later updates — until then they are absent, not mocked. The
 * pairing itself is managed on the Servers screen.
 *
 * The New mail block is the reason this header no longer says notifications are
 * absent: it now shows a real choice when the phone has distributors installed,
 * and one sentence with no control when it does not. Which of the two appears is
 * a fact read from the device, never a build-time assumption.
 */
import Constants from "expo-constants";
import { useState } from "react";
import { Platform, View } from "react-native";
import { buildLabel } from "../src/build-info";
import { Copy } from "../src/copy";
import { type WakeState } from "../src/net/push";
import { useWake } from "../src/state/wake";
import {
  accountGovernsFace,
  accountWideOffered,
  type FaceName,
  type ThemePref,
} from "../src/theme";
import { usePrefs } from "../src/state/store";
import { useWorld } from "../src/state/world";
import { Button, Chip, Panel, Rule, Screen, Scroller, Section, TapRow, Txt } from "../src/ui/base";
import { Sheet, SheetRow } from "../src/ui/Sheet";
import { phoneEngineStart } from "../src/engine/engine-artifact";
import {
  handBackStandalone, organizerRestrictedSaid, standaloneHere, stopOrganizerSession,
} from "../src/engine/organizer-session";
import { PHONE_CLAIM_NAME, standaloneAvailable } from "../src/engine/standalone-door";
import { releaseMailbox } from "../src/net/mailboxes";
import { useConnection } from "../src/net/connection";
import {
  claimChipLabel,
  claimFrom,
  type PhoneClaim,
  mayStopHere,
  platformRuleLine,
} from "../src/ui/standalone-form";
import { useLocale, useLocaleControls } from "../src/i18n/LocaleProvider";
import { type AppLocale } from "../src/i18n/locale";
import { DetailBar } from "../src/ui/chrome";
import { Gated } from "../src/ui/Gated";
import { Segmented } from "../src/ui/Segmented";

/** Gated like the tabs: the About block states a live session's facts, so it needs one. */
export default function SettingsScreen() {
  return (
    <Gated>
      <SettingsBody />
    </Gated>
  );
}

/**
 * SETTINGS → LANGUAGE, as its own component so the null-provider case is a structural absence
 * rather than a branch inside the settings body.
 *
 * `null` is the segment for "follow this phone", and it is a real third state rather than a
 * cosmetic default — see {@link Copy.language}'s note. The control renders what the DEVICE has
 * stored, never the optimistic pick: a refused keystore write leaves the segments where they were
 * and puts one sentence underneath, which is the contract every other settings control here keeps.
 */
function LanguagePanel() {
  const controls = useLocaleControls();
  const [failed, setFailed] = useState(false);
  if (controls === null) return null;
  /* `Segmented` keys its rows by value, so the "follow this phone" state needs a spelling rather
     than `null`. It is translated at this boundary and nowhere else — `LocaleControls` keeps the
     `null` that says "nothing is stored", which is the distinction the keystore actually holds. */
  const segments: { value: AppLocale | "system"; label: string }[] = [
    { value: "system", label: Copy.languageSystem },
    { value: "en", label: Copy.languageEnglish },
    { value: "de", label: Copy.languageGerman },
  ];
  const chosen: AppLocale | "system" = controls.chosen ?? "system";
  return (
    <View style={{ paddingHorizontal: 16, marginTop: 18 }}>
      <Txt variant="settingsLabel" style={{ marginBottom: 10 }}>{Copy.language}</Txt>
      <Segmented<AppLocale | "system">
        value={chosen}
        onChange={(next) => {
          if (controls.busy || next === chosen) return;
          setFailed(false);
          controls.setLocale(next === "system" ? null : next).catch(() => { setFailed(true); });
        }}
        segments={segments}
      />
      <Txt variant="caption" tone="ink3" style={{ marginTop: 10 }}>
        {failed ? Copy.languageFailed : Copy.languageNote}
      </Txt>
    </View>
  );
}

/**
 * The one sentence the New mail block renders, chosen from the wake state.
 *
 * Exported nowhere and pure, so `test/wake-copy.test.ts` can assert that every state has a
 * sentence and that none of them claims a wake this build can deliver. A `switch` over the union
 * rather than a lookup, because adding a state to {@link WakeState} then fails to compile here
 * instead of silently rendering nothing.
 */
export function wakeSentence(state: WakeState): string {
  switch (state.k) {
    case "no_distributor": return Copy.wakeNoDistributor;
    case "not_supported_here": return Copy.wakeDesktopHost;
    case "server_has_no_key": return Copy.wakeServerNoKey;
    case "on": return Copy.wakeOn;
    // `row_remains` is not "we could not set it up" — it is "we could not take it back", and the
    // two have different sentences and different remedies.
    case "off": return state.reason === "row_remains" ? Copy.wakeRowRemains : Copy.wakeOff(state.reason);
  }
}

function SettingsBody() {
  /* Subscribed: this is the screen the switch is made ON, so it is the screen that must redraw
     under the finger rather than on the next navigation. */
  useLocale();
  const w = useWorld();
  const { themePref, setTheme, facePin, setFacePin } = usePrefs();
  const wake = useWake();
  /*
   * The build's own name, read once. `expoConfig` is the config `expo prebuild` embedded in this
   * artifact — the same source `android/app/build.gradle` and `Info.plist` are generated from,
   * held equal to them by `build-info.test.ts`. The narrowing (and why an absent version renders
   * NOTHING rather than "unknown") is `buildLabel`'s; this line only hands it the platform.
   */
  const version = buildLabel(
    {
      version: Constants.expoConfig?.version,
      androidVersionCode: Constants.expoConfig?.android?.versionCode,
      iosBuildNumber: Constants.expoConfig?.ios?.buildNumber,
    },
    Platform.OS,
  );

  return (
    <Screen>
      <DetailBar title={Copy.settings} />
      <Scroller>
        <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 16 }}>
          <Txt variant="h1">{Copy.settings}</Txt>
        </View>

        {/* this phone — first, because it is the only block that says what this phone IS */}
        <ThisPhonePanel />

        {/* appearance */}
        <Panel style={{ paddingBottom: 16, marginBottom: 14 }}>
          <Section style={{ paddingTop: 16 }}>{Copy.theme}</Section>
          <View style={{ paddingHorizontal: 16 }}>
            <Segmented<ThemePref>
              value={themePref}
              onChange={setTheme}
              segments={[
                { value: "system", label: Copy.themeSystem },
                { value: "light", label: Copy.themeLight },
                { value: "dark", label: Copy.themeDark },
              ]}
            />
            <Txt variant="caption" tone="ink3" style={{ marginTop: 10 }}>
              {Copy.themeNote}
            </Txt>
          </View>

          {/*
            LANGUAGE — the same shape as the control above it, one row down, because it is the same
            kind of choice. It draws nothing when no locale provider is mounted, which is the demo's
            bare panes and the node suite's component renders: a selector that cannot select is the
            built-and-unreachable shape this screen avoids everywhere else.
          */}
          <LanguagePanel />

          {/*
            LOOK — the face, in the same panel as light/dark because they are the same class of
            decision: how the app is drawn, changing nothing about anybody's mail.
          */}
          <FacePanel
            pin={facePin}
            account={w.face.account}
            accountKnown={w.face.known}
            pending={w.face.pending}
            setPin={setFacePin}
            applyAll={w.face.applyAll}
          />
        </Panel>

        {/*
          NEW MAIL — a real control when there is a real choice, and a sentence otherwise.

          The list comes from the DEVICE (`listDistributors()`), so this block shows rows only when
          the phone actually has distributors installed. On a phone with none — and on every iPhone,
          where UnifiedPush cannot exist — `wake.choices` is empty and the pane is one sentence with
          no control, which is the rule this screen was built on: a toggle that cannot move is worse
          than a paragraph saying why.

          The `None` row is last and separated, because it is the only destructive option here: it
          drops the registration from the server as well as forgetting the distributor.
        */}
        <Panel style={{ paddingVertical: 18, marginBottom: 14 }}>
          <View style={{ paddingHorizontal: 20, gap: 6 }}>
            <Txt variant="settingsLabel">{Copy.wake}</Txt>
            <Txt variant="note" tone="ink2">{wakeSentence(wake.state)}</Txt>
          </View>

          {wake.choices.length > 0 && (
            <View style={{ marginTop: 14 }}>
              <Section>{Copy.wakeDistributor}</Section>
              <View style={{ paddingHorizontal: 12, gap: 2 }}>
                {wake.choices.map((d) => (
                  <TapRow
                    key={d.id}
                    selected={d.id === wake.chosen}
                    disabled={wake.busy}
                    onPress={() => { wake.choose(d.id); }}
                    style={{ paddingHorizontal: 8, paddingVertical: 12 }}
                  >
                    <Txt variant="body">{d.name}</Txt>
                  </TapRow>
                ))}
                <Rule inset={8} />
                <TapRow
                  selected={wake.chosen === null}
                  disabled={wake.busy}
                  onPress={() => { wake.turnOff(); }}
                  style={{ paddingHorizontal: 8, paddingVertical: 12 }}
                >
                  <Txt variant="body" tone="ink2">{Copy.wakeDistributorNone}</Txt>
                </TapRow>
              </View>
              <View style={{ paddingHorizontal: 20, paddingTop: 10 }}>
                {/* THE HINT IS A CLAIM, so it is withheld when the sentence above contradicts it.
                    "Turning this off … removes the registration from your server" is exactly what
                    `row_remains` says did NOT happen, and the two were rendered together: the same
                    screen asserting a take-back and its failure. The state's own sentence stands
                    alone in that case. */}
                <Txt variant="caption" tone="ink3">
                  {wake.state.k === "off" && wake.state.reason === "row_remains"
                    ? ""
                    : wake.chosen === null ? Copy.wakeDistributorNoneHint : Copy.wakeDistributorHint}
                </Txt>
              </View>
            </View>
          )}
        </Panel>

        {/*
          FOLDERS — the feature's master toggle (FOLDERS-SPEC.md §6; owner decision 1: fully
          optional, off by default). The control renders the value the SERVER last answered
          with, never the optimistic pick — a refused write must not draw a folders group the
          account does not have (the webapp FoldersRow's rule; the world layer holds it). A
          plain switch and not a confirm: ON is a read-only act on the mailbox — it shows
          folders that already exist and moves nothing.
        */}
        <FoldersPanel
          on={w.folders.enabled}
          pending={w.folders.pending}
          setEnabled={w.folders.setEnabled}
        />

        {/* about — one sentence, true of the session on screen */}
        <Panel style={{ paddingVertical: 18, marginBottom: 10 }}>
          <View style={{ paddingHorizontal: 20, gap: 6 }}>
            <Txt variant="settingsLabel">{Copy.about}</Txt>
            {/* WHICH build. The block was headed "About this build" and named no version, so a
                tester holding a sideloaded APK could not say which one they had. The numbers are
                the embedded app config's, which `build-info.test.ts` holds equal to the package
                manifest's. `null` only where there is no version to state — see `buildLabel`. */}
            {version !== null ? (
              <Txt variant="note" tone="ink2">
                {version}
              </Txt>
            ) : null}
            <Txt variant="note" tone="ink2">
              {Copy.aboutLive(w.account.name)}
            </Txt>
            {/* What leaving actually leaves — including the one thing this build cannot yet
                take back (an iOS backup carries the copied mail). See `Copy.aboutOnDevice`. */}
            <Txt variant="note" tone="ink3">
              {Copy.aboutOnDevice}
            </Txt>
          </View>
        </Panel>
      </Scroller>
    </Screen>
  );
}

/**
 * THE FACE, AND ITS TWO SCOPES — the phone's half of OHMARCHY-PLAN.md §3a.
 *
 * The segmented control is "only this device": it writes the DEVICE PIN, instantly, with no
 * server involved — which is why it works with the radio off, on a phone that has never been
 * paired, and while a sync is failing. The quiet line under it is "apply on all devices": one
 * press PATCHes the account (`{themeFace}` alone — the one axis this control owns), adopts the
 * ECHO, and clears the pin, so the account governs this device too, which is what the press
 * asked for. A pinned device deliberately ignores an account change made on a laptop, and the
 * scope line says which of the two states this device is in.
 *
 * The apply-all affordance is WITHHELD, not disabled, where no account can hold a face — the
 * webapp `FaceRow`'s rule, expressed the same way: a control that cannot control is never drawn.
 * TWO conditions withhold it, and the second is the subtle one (review-caught):
 *
 *  · nothing is connected, so there is no account row to store a shared choice in;
 *  · the account's face has not been READ yet ({@link World.face.known}). While it is unknown,
 *    `account` is null, the control shows paper, and pressing apply-all would PATCH paper over an
 *    ohmarchy the account really holds whose read was slow or failed. The webapp gates the same
 *    affordance on `themeFaceKnown` for the same reason.
 *
 * The failure is said and the control does not move wrongly: the device flip cannot fail (it is
 * local), and a refused account write leaves the segmented control on this device's real face
 * with one sentence under it.
 */
/**
 * ═══ SETTINGS → THIS PHONE ═════════════════════════════════════════════════════════════════════
 *
 * One card per mailbox: its address, the claim state as a chip, the platform rule line, and — where
 * there is a claim of ours to give up — the hand-back. The MAILBOXES-COMPACT idiom, in the phone's
 * own primitives.
 *
 * ── IT RENDERS ONLY WHERE THIS PHONE COULD ORGANIZE, AND ONLY OVER A READ ──────────────────────
 *
 * `standaloneAvailable` is the build's answer and `known` is the read's. A phone with no engine has
 * nothing to say here; a phone that has not read yet must say nothing about who organizes anything,
 * which is the rule `world.mailboxes.known` exists for. Both absences are silence, not a placeholder.
 *
 * The five chip states are the desktop's own keys, and the verb is plain: the consequence and the
 * danger-styled confirm are in the sheet, where a press is deliberate.
 */
/**
 * THE STANDALONE CARD'S ROW KEY — a constant, and deliberately NOT a mailbox id.
 *
 * The door answers for the one mailbox it serves and the app holds no id for it. This names the
 * `asked` entry and React's row; the stop it selects takes the engine's own `handBack`, which
 * needs no id. It must never reach a route, which is why it is not id-shaped.
 */
const HERE_CARD = "this-phone";

function ThisPhonePanel() {
  const w = useWorld();
  const conn = useConnection();
  const session = conn.state.k === "live" ? conn.state.session : null;
  /* WHICH MAILBOXES THIS PHONE HAS ASKED TO HAND BACK — by id, held for this screen's life. The
     press is the newest word until the row carries the release; the desktop's `stopQueued` rule. */
  const [asked, setAsked] = useState<readonly string[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);

  if (!standaloneAvailable({ startEngine: phoneEngineStart() })) return null;

  /**
   * ── WHERE THE CARDS COME FROM, AND WHY THE DOOR ANSWERS FIRST ────────────────────────────
   *
   * This panel used to be derived from `world.mailboxes` alone — a loopback `GET /mailboxes`
   * whose three outcomes (never asked, asked and refused, answered empty) all arrive as one
   * `known: false`. So on a phone that had opened its own mailbox the panel rendered NOTHING,
   * with an engine running behind it and no sentence anywhere: measured on a device across three
   * release builds, and the roster read is not even needed there.
   *
   * `standaloneHere()` is the engine in this process answering for itself, with no request:
   * the address it serves and whether this install organizes it. A PAIRED session has no such
   * door and keeps the roster exactly as before — the arm beside the one that moved.
   *
   * The standalone card's key is a constant and NOT a mailbox id, because it is not one: it
   * names the `asked` entry and React's row, and the standalone stop needs no id at all (the
   * engine's `handBack` releases every mailbox it holds).
   */
  const here = standaloneHere();
  const cards: readonly { key: string; address: string; claim: PhoneClaim }[] = here !== null
    ? [{
        key: HERE_CARD,
        address: here.address,
        claim: claimFrom(
          {
            /* `organizing: null` is "the engine has not said yet", which `claimFrom` renders as
               `unknown`: no chip and no stop verb, rather than "nothing organizes this mailbox"
               a second after the door opened. */
            known: here.organizing !== null,
            organizer: here.organizing === true ? { name: PHONE_CLAIM_NAME, stopped: false } : null,
          },
          PHONE_CLAIM_NAME,
          asked.includes(HERE_CARD),
        ),
      }]
    : w.mailboxes.rows.map((row) => ({
        key: row.id,
        address: row.address,
        claim: claimFrom(
          { known: w.mailboxes.known, organizer: holderFor(row) },
          /* THE SAME CONSTANT THE CLAIM WAS WRITTEN WITH — never `Copy.phoneThisPhone`, which
             changes with the language and would make this phone read its own claim as a
             stranger's the first time somebody switches. The deck string is the section LABEL
             above, which is the half a reader sees. */
          PHONE_CLAIM_NAME,
          asked.includes(row.id),
        ),
      }));
  if (cards.length === 0) return null;

  return (
    <>
      <Panel style={{ paddingVertical: 18, marginBottom: 14 }}>
        <Section>{Copy.phoneThisPhone}</Section>
        {cards.map((row, i) => {
          const claim = row.claim;
          const chip = claimChipLabel(claim);
          return (
            <View key={row.key}>
              {i > 0 ? <Rule inset={20} /> : null}
              <View style={{ paddingHorizontal: 20, paddingTop: 10, gap: 6 }}>
                <Txt variant="settingsLabel">{row.address}</Txt>
                {/* NO CHIP FOR `unknown`, rather than a chip that guesses — `claimChipLabel`
                    answers null there and this renders the absence. */}
                {chip === null ? null : (
                  <Chip style={{ alignSelf: "flex-start" }}>{chip}</Chip>
                )}
                <Txt variant="note" tone="ink2">
                  {platformRuleLine(Platform.OS)}
                </Txt>
                {/* BATTERY SAVER, SAID WHERE THE PLATFORM RULE IS — and only once the background
                    half has actually met it. `organizerRestrictedSaid` is the record
                    `announceRestricted` writes; the deck's own note says this app organizes while
                    it is open instead, which contradicts the rule line above it, so it sits
                    directly under it rather than somewhere else on the screen. */}
                {organizerRestrictedSaid() ? (
                  <Txt variant="note" tone="ink2">{Copy.organizerRestricted}</Txt>
                ) : null}
                {mayStopHere(claim) ? (
                  <Button
                    label={Copy.settingsStopHere}
                    variant="quiet"
                    onPress={() => setConfirming(row.key)}
                    style={{ alignSelf: "flex-start", marginTop: 4 }}
                  />
                ) : null}
              </View>
            </View>
          );
        })}
      </Panel>

      {/* THE CONSEQUENCE, THEN THE ONE DELIBERATE PRESS — the app's own destructive idiom
          (`FoldersGroup`'s delete confirm). The danger is on the confirm and nowhere else. */}
      {confirming !== null ? (
        <Sheet open onClose={() => setConfirming(null)} label={Copy.settingsStopHere}>
          <Txt variant="note" tone="ink2" style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
            {Copy.settingsStopHereWhat}
          </Txt>
          <SheetRow
            icon="pause"
            label={Copy.settingsStopHereConfirm}
            onPress={() => {
              const id = confirming;
              setConfirming(null);
              /* RECORDED BEFORE THE REQUEST LEAVES, so the chip stops saying "Organizing" the
                 moment the press lands rather than a poll later — and a refusal is not a reason
                 to claim the mailbox is still being filed by a phone that asked to stop. */
              setAsked((cur) => (cur.includes(id) ? cur : [...cur, id]));
              /* THE DOOR RELEASES ITSELF WHERE THERE IS ONE. `POST /mailboxes/:id/release` needs
                 a mailbox id, which on this door the app does not hold — `HERE_CARD` is a row key
                 and must never reach a route. The engine's `handBack` needs none: it removes this
                 install's claim from every mailbox it holds, which on a phone is the one. */
              if (id === HERE_CARD) void handBackStandalone();
              else if (session !== null) void releaseMailbox(session, id);
              /* AND THE NOTIFICATION COMES DOWN WITH THE CLAIM. The claim has been given back, so
                 a foreground service left standing would say "Organizing <address>" over a phone
                 that reads — on the one surface a person cannot argue with. */
              void stopOrganizerSession();
            }}
          />
          <SheetRow icon="x" label={Copy.settingsStopHereCancel} onPress={() => setConfirming(null)} />
        </Sheet>
      ) : null}
    </>
  );
}

/** One row's holder in `claimFrom`'s shape — a named holder, or nothing. */
function holderFor(row: {
  organizedBy: { kind: string | null; name: string | null } | null;
  organizerState: "held" | "stopped" | null;
}): { name: string; stopped: boolean } | null {
  const name = row.organizedBy?.name ?? "";
  return name === "" ? null : { name, stopped: row.organizerState === "stopped" };
}

function FacePanel({
  pin,
  account,
  accountKnown,
  pending,
  setPin,
  applyAll,
}: {
  pin: FaceName | null;
  account: FaceName | null;
  accountKnown: boolean;
  pending: boolean;
  setPin: (face: FaceName | null) => void;
  applyAll: (face: FaceName) => Promise<boolean>;
}) {
  const [failed, setFailed] = useState(false);
  /* The face on screen — the provider resolves the same way; this recomputes it rather than
     reading the theme, because the CONTROL must show the choice, and reading `useTheme().face`
     would draw the same value through a longer path. `accountGovernsFace` is the pure rule. */
  const face: FaceName = pin ?? account ?? "paper";
  const governed = accountGovernsFace(face, pin, account);
  return (
    <>
      <Section style={{ paddingTop: 18 }}>{Copy.face}</Section>
      <View style={{ paddingHorizontal: 16 }}>
        <Segmented<FaceName>
          value={face}
          /* Device-local and instant — the "only this device" scope. Never the account. */
          onChange={(next) => {
            if (next === face) return;
            setFailed(false);
            setPin(next);
          }}
          segments={[
            { value: "paper", label: Copy.facePaper },
            { value: "ohmarchy", label: Copy.faceOhmarchy },
          ]}
        />
        <Txt variant="caption" tone="ink3" style={{ marginTop: 10 }}>
          {Copy.faceHint}
        </Txt>
        <Txt variant="caption" tone="ink3" style={{ marginTop: 6 }}>
          {governed ? Copy.faceScopeAll : Copy.faceScopeDevice}
        </Txt>
        {accountWideOffered(accountKnown, face, pin, account) ? (
          <Button
            label={Copy.faceApplyAll}
            variant="quiet"
            style={{ alignSelf: "flex-start", marginTop: 4, paddingHorizontal: 0 }}
            onPress={() => {
              // `pending` guards the double-write, exactly like the wake rows and the Folders
              // pane — one write on the wire at a time, and the second press is not asked for.
              if (pending) return;
              setFailed(false);
              void applyAll(face).then((ok) => {
                if (!ok) setFailed(true);
              });
            }}
          />
        ) : null}
        {failed ? (
          <Txt variant="caption" tone="ink3" style={{ marginTop: 6 }}>
            {Copy.faceFailed}
          </Txt>
        ) : null}
      </View>
    </>
  );
}

/**
 * The Folders pane: the description states the current answer (`useOn`/`useOff` — the webapp
 * catalogue's own sentences), the control moves it, and a refusal is one visible sentence
 * with the control back on the server's value. `pending` guards the double-write exactly
 * like the wake rows above.
 */
function FoldersPanel({
  on,
  pending,
  setEnabled,
}: {
  on: boolean;
  pending: boolean;
  setEnabled: (on: boolean) => Promise<boolean>;
}) {
  const [failed, setFailed] = useState(false);
  const write = (next: "on" | "off") => {
    if (pending) return;
    setFailed(false);
    void setEnabled(next === "on").then((ok) => {
      if (!ok) setFailed(true);
    });
  };
  return (
    <Panel style={{ paddingVertical: 18, marginBottom: 14 }}>
      <View style={{ paddingHorizontal: 20, gap: 6 }}>
        <Txt variant="settingsLabel">{Copy.foldersUseTitle}</Txt>
        <Txt variant="note" tone="ink2">{on ? Copy.foldersUseOn : Copy.foldersUseOff}</Txt>
      </View>
      <View style={{ paddingHorizontal: 16, marginTop: 12 }}>
        <Segmented<"on" | "off">
          value={on ? "on" : "off"}
          onChange={write}
          segments={[
            { value: "off", label: Copy.switchOff },
            { value: "on", label: Copy.switchOn },
          ]}
        />
        <Txt variant="caption" tone="ink3" style={{ marginTop: 10 }}>
          {Copy.foldersMicrocopy}
        </Txt>
        {failed ? (
          <Txt variant="caption" tone="ink3" style={{ marginTop: 6 }}>
            {Copy.foldersFailed}
          </Txt>
        ) : null}
      </View>
    </Panel>
  );
}
