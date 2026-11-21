"use client";

/**
 * Settings → Devices — pair another device with this account, see what is signed in, take one back. Two decisions: a
 * stale step-up window is a ceremony, not a dead end — `step_up_required` parks the verb, opens {@link StepUp}
 * and re-runs it, and the sign-in-again sentence survives only for a genuinely dead session; plain browser sessions
 * collapse into one group ("N other web sessions"), keyed on the server's `named` discriminator and offered only
 * where `/hello` says the bulk route is mounted.
 */

/**
 * The pairing mechanism: mint (`POST /pair`, step-up gated) → ONE link `<apiOrigin>/pair#<token>` shown once as QR
 * plus raw link → redeemed anonymously for a bearer pair; `GET /devices` is what makes the offer safe. Injected by
 * `CloudShell` only when `features.pairing` answers true — no compiled flavor gate, because the managed service
 * mounts the ceremony too.
 */

/**
 * The link's origin is the API's, not this page's: the scanning device redeems at `${origin}/pair/redeem` and lives
 * on `${origin}/sync`, so the origin must answer the API at the ROOT. On self-host that IS the page origin (the
 * reference Caddyfile routes `/pair*` to the api container); on the managed deployment it is `https://api.ohmail.app`
 * — the single member of the compiled allow-list, imported from `app/api-origin.ts` so this file cannot drift.
 */

/**
 * A link minted on the page origin would scan, negotiate against a Next 404 and refuse. The token rides the FRAGMENT
 * — never sent in a request, so no access log and no `Referer`; the raw token appears exactly once, the list carries
 * metadata only, the server stores only a hash. The raw link is printed beside the QR deliberately: a device without
 * a camera needs it typed, and five minutes of single-use lifetime bounds that exposure.
 */

import type { ToastFn } from "@ohmail/app-logic/press/report";
import { useReport } from "@ohmail/app/frame";
import { useCallback, useEffect, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Button, CodeText, CodeTile, Field, RefusalLine } from "@ohmail/ui/base";
import { SettingActs, SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { devicesOf } from "@ohmail/client-engine";
import { useEngineOrNull } from "@ohmail/app-logic/engine/context";
import { showDevicesListed, type ToldDevices } from "@ohmail/app-logic/notices/use-notices";
import {
  ApiError, devices as devicesApi, pair, type DeviceDTO, type PairingTokenDTO,
} from "../../api-client";
import { useRefusalSentence } from "../refusal-sentence";
import { ALLOWED_API_ORIGINS } from "../../api-origin";
import { SELF_HOST_BUILD, serverHello } from "../../hello";
import { useServerWords } from "../../server-words";
import { QrCode } from "../../shell/QrCode";
import { StepUp } from "./StepUp";

/**
 * Should this client offer the Devices pane? One gate, the server's own runtime word — `features.pairing` from
 * `/hello` — because the capability handshake exists so a client learns a ceremony's presence from the descriptor,
 * never from a 404 mid-flow; `false` while pending. `demo` is the first word and it ends the question: a constant
 * `false`, no `/hello` round trip.
 */

/**
 * Before this parameter, a signed-in browser's `/?demo=1` paid that trip, grew a Devices entry in the demo's Settings
 * nav — the one account pane that leaked — and rendered the account's REAL device list inside the fixtures UI with a
 * live mint verb beside it; every verb here is a cookie-authenticated credential mutation, exactly what a fixtures
 * world must not reach. The flag is the same authoritative `demo` the shell masks its other panes by.
 */
/** The label the server stores for a desktop that paired unnamed (`APPROVAL_DEVICE_LABELS`, auth-service). */
const MINTED_LABEL: Readonly<Partial<Record<DeviceDTO["kind"], string>>> = {
  "macos": "ohmail for Mac", "desktop-macos": "ohmail for Mac",
  "desktop-linux": "ohmail for Linux", "desktop-windows": "ohmail for Windows",
};

export function useDevicePairing(demo: boolean): boolean {
  return useServerWords(demo).pairing;
}

/** Where the scanned link points — the origin the API answers at the root. See the header. */
function pairOrigin(): string {
  return SELF_HOST_BUILD ? window.location.origin : ALLOWED_API_ORIGINS[0]!;
}

type Busy = null | "mint" | "web-group" | `revoke:${string}` | `remove:${string}`;

export function PairingDevicesSection() {
  return <DevicesSection report={useReport()} />;
}

export function DevicesSection({ report }: { report: ToastFn }) {
  const t = useTranslations("devices");
  const sentence = useRefusalSentence();
  const format = useFormatter();
  /**
   * A label whose key may not be in `messages/*.json` yet — the same shim, with the same one
   * exit, as `MessagePane.copy` (named `line` here — this pane already has a clipboard verb
   * called `copy`): `t.has` hands the line to the locale files the moment the key
   * lands there, so this can never become a second source of copy. It exists because the
   * messages files are a shared, frequently-touched surface and this pane's states should not
   * wait on them to be editable.
   */
  const line = (key: string, reported: string): string => (t.has(key) ? t(key) : reported);

  /** Live sessions (`GET /devices`). `null` = not read yet. */
  const [items, setItems] = useState<DeviceDTO[] | null>(null);
  /** Open pairing codes — the caller's own, `grant === "device-pair"`, live only. */
  const [codes, setCodes] = useState<PairingTokenDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  /**
   * A step-up-gated verb was refused with `step_up_required` and is PARKED here while the
   * inline factor prompt runs. On success the exact refused action re-runs; on cancel it is
   * dropped. This is the repair for the pane's one dead end: the old answer was "sign in
   * again", a full round trip for someone already in their mailbox.
   */
  const [stepUp, setStepUp] = useState<{ kind: Exclude<Busy, null>; fn: () => Promise<void>; opener: HTMLElement | null } | null>(null);
  /**
   * A factor landed after the prompt's Cancel and was discarded, so the parked verb never ran.
   * Said HERE rather than in the prompt: Cancel hands the pane back, so by the time the response
   * lands there is no prompt left to read a sentence off, and a device list that looks unchanged
   * is exactly what it looks like when a verb DID run and changed nothing.
   */
  const [stepUpDiscarded, setStepUpDiscarded] = useState(false);
  /**
   * May the plain-browser remainder collapse into one group with a bulk sign-out?
   * Hosted/self-host only, decided by the server's own `/hello` flavor: on a DESKTOP-HOST
   * door the device-less non-current session is the host's own launch session and the bulk
   * route is deliberately unmounted — a collapsed group there would offer a verb that 404s.
   * Unknown/absent flavor falls back to individual rows, which every server can serve.
   */
  const [collapseWeb, setCollapseWeb] = useState(false);
  /** The collapsed group's sign-out is awaiting confirmation. */
  const [confirmingGroup, setConfirmingGroup] = useState(false);
  /**
   * The one appearance of a raw token, dressed as the link it is scanned or typed as. `id` is
   * the same row the list below shows, kept so the display retires WITH the row: revoking the
   * just-minted code from the list must take the QR and the typed-entry link down too — a dead
   * credential left on screen reads as usable while every redemption of it refuses.
   */
  const [minted, setMinted] = useState<{ id: string; link: string; label: string } | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  /** The device whose sign-out is awaiting confirmation, or `null`. */
  const [removing, setRemoving] = useState<string | null>(null);

  /** Strict Mode re-arms setup on the same instance — armed in the effect, InvitesSection's fix. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * THE LIST IS LIVE. The account's engine, whose settings record says how many devices were ever
   * made and taken back; `null` outside a shell. A device paired while this pane is open moves the
   * record, and the list is read again by itself. What the list shows is told to the notices
   * (`devices-listed.ts`): the record's two numbers as the read that answered began, so a device
   * the record counts is told without a notice only once it is on this list.
   */
  const engine = useEngineOrNull();
  /** The record's numbers at the start of the last read of the list that answered; `null` while none did, or the last failed. */
  const [listedAt, setListedAt] = useState<ToldDevices | null>(null);
  /** Which read is the latest: an earlier one that answers after it would put an older list on screen. */
  const asked = useRef(0);

  const refresh = useCallback(async () => {
    const ask = ++asked.current;
    const at = engine === null ? null : devicesOf(engine.read());
    try {
      const [{ items: sessions }, { items: mints }] = await Promise.all([
        devicesApi.list(),
        pair.list(),
      ]);
      if (!alive.current || ask !== asked.current) return;
      setItems(sessions);
      // Live device-pair codes only. Spent and expired rows are history, and invite tokens
      // belong to the Invites pane on the build that has one.
      setCodes(mints.filter((m) => m.grant === "device-pair" && m.status === "live"));
      setListedAt(at === null ? null : { made: at.made, revoked: at.revoked });
    } catch (err) {
      if (!alive.current || ask !== asked.current) return;
      setListedAt(null);
      setError(sentence(err));
    }
  }, [sentence, engine]);

  // Told once the list is on screen; taken down when the pane leaves or a later read replaces it.
  useEffect(() => (engine === null ? undefined : showDevicesListed(engine, listedAt)), [engine, listedAt]);

  // The record's made or revoked moves: a device was paired or taken back, so the list is read again.
  useEffect(() => {
    if (engine === null) return undefined;
    const numbers = (): string => {
      const d = devicesOf(engine.read());
      return d === null ? "" : `${d.made}/${d.revoked}`;
    };
    let last = numbers();
    return engine.subscribe(() => {
      const now = numbers();
      if (now === last) return;
      last = now;
      void refresh();
    });
  }, [engine, refresh]);

  useEffect(() => {
    void refresh();
    // The one flavor read the collapse arm branches on — see `collapseWeb`'s doc.
    void serverHello().then((h) => {
      if (alive.current) setCollapseWeb(h?.flavor === "managed" || h?.flavor === "selfhost");
    });
  }, [refresh]);

  /**
   * A step-up-gated call, and the refusal that used to dead-end is now a ceremony:
   * `step_up_required` PARKS the action and opens the factor dialog
   * ({@link StepUp}); a verified factor re-runs the exact action, in place, with the
   * session the browser already holds. Every OTHER refusal keeps `InvitesSection.run`'s
   * honesty — said, never swallowed — and a genuinely dead session (a plain 401) still gets
   * the sign-in-again sentence, because for that one the round trip IS the remedy. A second
   * `step_up_required` after a verified factor is that sentence too, never a second prompt.
   */
  const run = useCallback(
    (kind: Exclude<Busy, null>, fn: () => Promise<void>, verified = false, press?: HTMLElement) => {
      const opener = press ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      void (async () => {
        setBusy(kind);
        setError(null);
        setStepUpDiscarded(false);
        try {
          await fn();
          if (alive.current) setStepUp(null);
        } catch (err) {
          if (!alive.current) return;
          if (err instanceof ApiError && err.status === 403 && err.code === "step_up_required" && !verified) {
            setStepUp({ kind, fn, opener });
          } else {
            setError(
              err instanceof ApiError && (err.status === 401 || err.status === 403)
                ? t("stepUpExpired")
                : sentence(err),
            );
          }
        } finally {
          if (alive.current) setBusy(null);
        }
      })();
    },
    [t, sentence],
  );

  const mint = (press?: HTMLElement) =>
    run("mint", async () => {
      const label = labelDraft.trim();
      const out = await pair.mintDevice(label ? { label } : {});
      if (!alive.current) return;
      // The link, assembled ONCE, here — the frozen fragment idiom. See the module header for
      // why the origin is the API's and why the token rides the fragment.
      setMinted({ id: out.id, link: `${pairOrigin()}/pair#${out.token}`, label: out.label });
      setLabelDraft("");
      await refresh();
    }, false, press);

  const revokeCode = (id: string, press: HTMLElement) =>
    run(`revoke:${id}`, async () => {
      try {
        await pair.revoke(id);
      } catch (err) {
        // 404 is every kind of already-gone (spent, expired, revoked elsewhere) — the row is
        // leaving the list either way, so the refresh below is the honest answer.
        if (!(err instanceof ApiError && err.status === 404)) throw err;
      }
      if (!alive.current) return;
      // The display retires with its row: if the code being revoked is the one whose QR and
      // typed-entry link are still up, they come down in the same act — keyed on the row's own
      // id (a functional update against the stale-closure race), so revoking an OLDER code
      // never takes a live display with it.
      setMinted((cur) => (cur && cur.id === id ? null : cur));
      report(t("revoked"));
      await refresh();
    }, false, press);

  const removeDevice = (id: string, press: HTMLElement) =>
    run(`remove:${id}`, async () => {
      await devicesApi.revoke(id);
      if (!alive.current) return;
      setRemoving(null);
      report(t("removed"));
      await refresh();
    }, false, press);

  /** The collapsed group's one verb — every other plain web session, signed out in one act. */
  const revokeGroup = (press: HTMLElement) =>
    run("web-group", async () => {
      const { revoked } = await devicesApi.revokeWebSessions();
      if (!alive.current) return;
      setConfirmingGroup(false);
      report(t("webGroupDone", { count: revoked }));
      await refresh();
    }, false, press);

  const copy = () => {
    if (!minted) return;
    const link = minted.link;
    // NOT fire-and-forget: the toast speaks only after the clipboard write fulfilled, and a
    // refusal names the paths that still work — the QR, and the link printed beside it.
    void (async () => {
      try {
        await navigator.clipboard.writeText(link);
        if (alive.current) report(t("copied"));
      } catch {
        if (alive.current) setError(t("copyFailed"));
      }
    })();
  };

  const day = (iso: string): string => format.dateTime(new Date(iso), { dateStyle: "medium" });
  /** A five-minute code's deadline is a TIME — the date would be today three ways out of three. */
  const clock = (iso: string): string => format.dateTime(new Date(iso), { timeStyle: "short" });
  // The full device vocabulary, one word each; anything newer than this build falls back to
  // the generic word rather than lying "Browser" about a device that is not one.
  const kindWord = (kind: DeviceDTO["kind"]): string => {
    switch (kind) {
      case "web": return t("kindWeb");
      case "macos": case "desktop-macos": return t("kindMac");
      case "desktop-linux": return t("kindLinux");
      case "desktop-windows": return t("kindWindows");
      case "mobile-android": return t("kindAndroid");
      case "mobile-ios": return t("kindIos");
      default: return t("kindOther");
    }
  };
  /* A desktop that paired without a name carries the server's English default for its kind; that
     label is ohmail's words, not the person's, so it is said in the reader's language. */
  const nameOf = (d: DeviceDTO): string =>
    MINTED_LABEL[d.kind] === d.label ? t("mintedName", { kind: kindWord(d.kind) }) : d.label || kindWord(d.kind);

  // Current pinned first; NAMED devices individually; the plain-browser remainder collapses
  // into `groupedWeb` where the server mounts the bulk verb, and renders row-by-row where it
  // does not (older servers, the desktop-host door) — see `collapseWeb`'s doc for why.
  const current = items?.find((d) => d.current) ?? null;
  const others = (items ?? []).filter((d) => !d.current);
  const groupedWeb = collapseWeb ? others.filter((d) => d.named === false) : [];
  const individualOthers = collapseWeb ? others.filter((d) => d.named !== false) : others;
  const visibleRows = [...(current ? [current] : []), ...individualOthers];

  return (
    <>
    <SettingsSheet title={t("title")}>
      <SettingNote>{t("intro")}</SettingNote>

      {error ? (
        <RefusalLine alert>{error}</RefusalLine>
      ) : null}
      {stepUpDiscarded ? (
        <SettingNote said>{t("stepUpCancelledNothingRan")}</SettingNote>
      ) : null}

      {stepUp ? (
        <StepUp
          inline
          returnFocus={() => stepUp.opener}
          onVerified={() => {
            const parked = stepUp;
            setStepUp(null);
            if (parked) run(parked.kind, parked.fn, true);
          }}
          onCancel={() => setStepUp(null)}
          onDiscarded={() => setStepUpDiscarded(true)}
        />
      ) : null}

      {minted ? (
        <>
          <SettingNote>
            {minted.label ? t("mintedLeadFor", { name: minted.label }) : t("mintedLead")}
          </SettingNote>
          <CodeTile>
            <QrCode value={minted.link} ariaLabel={t("qrAria")} />
          </CodeTile>
          {/* The raw link, FOR TYPED ENTRY, beside the QR — a device without a camera path
              types this into the app's server field. Selectable in one press; broken anywhere
              because a pairing token has no natural word boundary. */}
          <p className="oh-text">{t("typedEntry")}</p>
          <div data-testid="pair-link"><CodeText>{minted.link}</CodeText></div>
          <SettingActs>
            <Button kind="quiet" size="s" icon="copy" onPress={copy}>
              {t("copyLink")}
            </Button>
            {/* Done re-reads the lists: in the ordinary scan-then-Done sequence the code was
                just consumed and the paired device just appeared. */}
            <Button
              onPress={() => {
                setMinted(null);
                void refresh();
              }}
            >
              {t("mintedDone")}
            </Button>
          </SettingActs>
          <p className="oh-text">{t("mintedOnce")}</p>
        </>
      ) : (
        <>
          {/* The add-a-device row — the Invites mint's shape: the (optional) name is the one
              input, the button is the verb, Enter submits. */}
          <Field
            bare label={t("addFor")} placeholder={t("addFor")} value={labelDraft}
            maxLength={100} onChange={setLabelDraft} onEnter={() => { if (busy === null) mint(); }}
          />
          <SettingActs>
            <Button onPress={(event) => mint(event.currentTarget)} busy={busy === "mint"}>
              {busy === "mint" ? t("working") : t("addAction")}
            </Button>
          </SettingActs>
          <SettingNote>{t("addHint")}</SettingNote>
        </>
      )}

    </SettingsSheet>

      {codes.length > 0 ? (
        <SettingsSheet title={t("codesTitle")} aside={codes.length}>
          {codes.map((c) => (
            <SettingLine
              key={c.id}
              label={c.label || t("codeFallback")}
              description={t("codeMeta", { time: clock(c.expiresAt) })}
            >
                  <Button kind="quiet" size="s" onPress={(event) => revokeCode(c.id, event.currentTarget)} busy={busy === `revoke:${c.id}`}>
                    {busy === `revoke:${c.id}` ? t("working") : t("revoke")}
                  </Button>
            </SettingLine>
          ))}
        </SettingsSheet>
      ) : null}

      {items == null ? (
        /* NOT READ YET — the pane used to render NOTHING here until `GET /devices` answered,
           and on a slow answer that was a long blank where the list belongs (owner-reported).
           The subhead renders in both waiting states and stays when the rows arrive, so the
           surrounding layout never jumps; only the sentence under it swaps. `role="status"` so
           a screen reader hears the wait end. A fetch that FAILED with nothing loaded gets the
           plain sentence and a retry — the top-of-pane `acct-warn` already names the error. */
        <SettingsSheet title={t("devicesTitle")}>
          {error == null ? (
            <p className="oh-text" role="status">{line("loading", "Loading your devices…")}</p>
          ) : (
            <>
              <p className="oh-text">{line("loadFailed", "Your devices could not be loaded.")}</p>
              <SettingActs>
                <Button
                  onPress={() => {
                    setError(null);
                    void refresh();
                  }}
                >
                  {line("retry", "Try again")}
                </Button>
              </SettingActs>
            </>
          )}
        </SettingsSheet>
      ) : items.length > 0 ? (
        <SettingsSheet title={t("devicesTitle")} aside={items.length}>
          {/* Current session pinned first, NAMED devices individually, and — where the server
              mounts the bulk verb (`collapseWeb`) — the plain-browser remainder as ONE group
              row with one sign-out. `named === false` is the server's own discriminator; an
              older server that never sends it gets every row individually, exactly as its own
              list has always rendered. */}
          {visibleRows.map((d) =>
            removing === d.id ? (
              <SettingLine
                key={d.id}
                label={t("removeAsk", { name: nameOf(d) })}
                description={t("removeWhat")}
              >
                    <Button
                      kind="ink"
                      onPress={(event) => removeDevice(d.id, event.currentTarget)}
                      busy={busy === `remove:${d.id}`}
                    >
                      {busy === `remove:${d.id}` ? t("working") : t("remove")}
                    </Button>
                    <Button kind="quiet" onPress={() => setRemoving(null)}>
                      {t("cancel")}
                    </Button>
              </SettingLine>
            ) : (
              <SettingLine
                key={d.id}
                label={nameOf(d)}
                description={
                  d.current
                    ? t("thisDevice")
                    : t("deviceMeta", { kind: kindWord(d.kind), created: day(d.createdAt), seen: day(d.lastSeenAt) })
                }
              >
                {/* The current session's removal is the sign-out action. */}
                {d.current ? null : <Button kind="quiet" size="s" onPress={() => setRemoving(d.id)}>{t("remove")}</Button>}
              </SettingLine>
            ),
          )}
          {groupedWeb.length > 0 ? (
            confirmingGroup ? (
              <SettingLine
                key="web-group-confirm"
                label={t("webGroupAsk", { count: groupedWeb.length })}
                description={t("webGroupWhat")}
              >
                    <Button
                      kind="ink"
                      onPress={(event) => revokeGroup(event.currentTarget)}
                      busy={busy === "web-group"}
                    >
                      {busy === "web-group" ? t("working") : t("webGroupAction")}
                    </Button>
                    <Button kind="quiet" onPress={() => setConfirmingGroup(false)}>
                      {t("cancel")}
                    </Button>
              </SettingLine>
            ) : (
              <SettingLine
                key="web-group"
                label={t("webGroup", { count: groupedWeb.length })}
                description={t("webGroupMeta", { seen: day(groupedWeb[0]!.lastSeenAt) })}
              >
                    <Button kind="quiet" size="s" onPress={() => setConfirmingGroup(true)}>{t("webGroupAction")}</Button>
              </SettingLine>
            )
          ) : null}
        </SettingsSheet>
      ) : null}
    </>
  );
}
