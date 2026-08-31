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
import { useState } from "react";
import { View } from "react-native";
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
import { Button, Panel, Rule, Screen, Scroller, Section, TapRow, Txt } from "../src/ui/base";
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
  const w = useWorld();
  const { themePref, setTheme, facePin, setFacePin } = usePrefs();
  const wake = useWake();

  return (
    <Screen>
      <DetailBar title={Copy.settings} />
      <Scroller>
        <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 16 }}>
          <Txt variant="h1">{Copy.settings}</Txt>
        </View>

        {/* appearance */}
        <Panel style={{ paddingBottom: 16, marginBottom: 14 }}>
          <Section style={{ paddingTop: 16 }}>{Copy.theme}</Section>
          <View style={{ paddingHorizontal: 16 }}>
            <Segmented<ThemePref>
              value={themePref}
              onChange={setTheme}
              segments={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
            <Txt variant="caption" tone="ink3" style={{ marginTop: 10 }}>
              {Copy.themeNote}
            </Txt>
          </View>

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
            { value: "off", label: "Off" },
            { value: "on", label: "On" },
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
