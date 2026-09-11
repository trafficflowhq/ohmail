"use client";

/**
 * Settings → Devices — pair another device with this account, see what is signed in, take one back. Two decisions: a
 * stale step-up window is a ceremony, not a dead end — `step_up_required` parks the verb, opens {@link StepUpPrompt}
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

import { useCallback, useEffect, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Button, SettingsRow, SettingsSection, SettingsSubhead, useToast } from "@ohmail/ui";
import {
  ApiError, devices as devicesApi, messageOf, pair, type DeviceDTO, type PairingTokenDTO,
} from "../../api-client";
import { ALLOWED_API_ORIGINS } from "../../api-origin";
import { SELF_HOST_BUILD, serverHello } from "../../hello";
import { QrCode } from "../../shell/QrCode";
import { StepUpPrompt } from "./StepUpPrompt";

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
export function useDevicePairing(demo: boolean): boolean {
  const [pairing, setPairing] = useState(false);
  useEffect(() => {
    if (demo) return;
    let alive = true;
    void serverHello().then((h) => {
      if (alive) setPairing(h?.features?.pairing === true);
    });
    return () => {
      alive = false;
    };
  }, [demo]);
  return pairing;
}

/** Where the scanned link points — the origin the API answers at the root. See the header. */
function pairOrigin(): string {
  return SELF_HOST_BUILD ? window.location.origin : ALLOWED_API_ORIGINS[0]!;
}

type Busy = null | "mint" | "web-group" | `revoke:${string}` | `remove:${string}`;

export function DevicesSection() {
  const t = useTranslations("devices");
  const format = useFormatter();
  const toast = useToast();
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
  const [stepUp, setStepUp] = useState<{ kind: Exclude<Busy, null>; fn: () => Promise<void> } | null>(null);
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

  const refresh = useCallback(async () => {
    try {
      const [{ items: sessions }, { items: mints }] = await Promise.all([
        devicesApi.list(),
        pair.list(),
      ]);
      if (!alive.current) return;
      setItems(sessions);
      // Live device-pair codes only. Spent and expired rows are history, and invite tokens
      // belong to the Invites pane on the build that has one.
      setCodes(mints.filter((m) => m.grant === "device-pair" && m.status === "live"));
    } catch (err) {
      if (alive.current) setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // The one flavor read the collapse arm branches on — see `collapseWeb`'s doc.
    void serverHello().then((h) => {
      if (alive.current) setCollapseWeb(h?.flavor === "managed" || h?.flavor === "selfhost");
    });
  }, [refresh]);

  /**
   * A step-up-gated call, and the refusal that used to dead-end is now a ceremony:
   * `step_up_required` PARKS the action and opens the inline factor prompt
   * ({@link StepUpPrompt}); a verified factor re-runs the exact action, in place, with the
   * session the browser already holds. Every OTHER refusal keeps `InvitesSection.run`'s
   * honesty — said, never swallowed — and a genuinely dead session (a plain 401) still gets
   * the sign-in-again sentence, because for that one the round trip IS the remedy.
   */
  const run = useCallback(
    (kind: Exclude<Busy, null>, fn: () => Promise<void>) => {
      void (async () => {
        setBusy(kind);
        setError(null);
        try {
          await fn();
          if (alive.current) setStepUp(null);
        } catch (err) {
          if (!alive.current) return;
          if (err instanceof ApiError && err.status === 403 && err.code === "step_up_required") {
            setStepUp({ kind, fn });
          } else {
            setError(
              err instanceof ApiError && (err.status === 401 || err.status === 403)
                ? t("stepUpExpired")
                : messageOf(err),
            );
          }
        } finally {
          if (alive.current) setBusy(null);
        }
      })();
    },
    [t],
  );

  const mint = () =>
    run("mint", async () => {
      const label = labelDraft.trim();
      const out = await pair.mintDevice(label ? { label } : {});
      if (!alive.current) return;
      // The link, assembled ONCE, here — the frozen fragment idiom. See the module header for
      // why the origin is the API's and why the token rides the fragment.
      setMinted({ id: out.id, link: `${pairOrigin()}/pair#${out.token}`, label: out.label });
      setLabelDraft("");
      await refresh();
    });

  const revokeCode = (id: string) =>
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
      toast(t("revoked"));
      await refresh();
    });

  const removeDevice = (id: string) =>
    run(`remove:${id}`, async () => {
      await devicesApi.revoke(id);
      if (!alive.current) return;
      setRemoving(null);
      toast(t("removed"));
      await refresh();
    });

  /** The collapsed group's one verb — every other plain web session, signed out in one act. */
  const revokeGroup = () =>
    run("web-group", async () => {
      const { revoked } = await devicesApi.revokeWebSessions();
      if (!alive.current) return;
      setConfirmingGroup(false);
      toast(t("webGroupDone", { count: revoked }));
      await refresh();
    });

  const copy = () => {
    if (!minted) return;
    const link = minted.link;
    // NOT fire-and-forget: the toast speaks only after the clipboard write fulfilled, and a
    // refusal names the paths that still work — the QR, and the link printed beside it.
    void (async () => {
      try {
        await navigator.clipboard.writeText(link);
        if (alive.current) toast(t("copied"));
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

  // Current pinned first; NAMED devices individually; the plain-browser remainder collapses
  // into `groupedWeb` where the server mounts the bulk verb, and renders row-by-row where it
  // does not (older servers, the desktop-host door) — see `collapseWeb`'s doc for why.
  const current = items?.find((d) => d.current) ?? null;
  const others = (items ?? []).filter((d) => !d.current);
  const groupedWeb = collapseWeb ? others.filter((d) => d.named === false) : [];
  const individualOthers = collapseWeb ? others.filter((d) => d.named !== false) : others;
  const visibleRows = [...(current ? [current] : []), ...individualOthers];

  return (
    <SettingsSection className="acct">
      <h2 className="acct-h">{t("title")}</h2>
      <p className="acct-lead">{t("intro")}</p>

      {error ? (
        <p className="acct-warn" role="alert">
          {error}
        </p>
      ) : null}

      {stepUp ? (
        // The inline ceremony. It REPLACES the add-a-device block below while it runs (one
        // call to action at a time); the lists stay visible, because the person is deciding
        // about exactly those rows. A verified factor re-runs the parked verb unchanged.
        <StepUpPrompt
          onVerified={() => {
            const parked = stepUp;
            setStepUp(null);
            if (parked) run(parked.kind, parked.fn);
          }}
          onCancel={() => setStepUp(null)}
        />
      ) : null}

      {stepUp ? null : minted ? (
        <div className="acct-confirm">
          <p className="acct-lead">
            {minted.label ? t("mintedLeadFor", { name: minted.label }) : t("mintedLead")}
          </p>
          <div className="join-qr">
            <QrCode value={minted.link} ariaLabel={t("qrAria")} />
          </div>
          {/* The raw link, FOR TYPED ENTRY, beside the QR — a device without a camera path
              types this into the app's server field. Selectable in one press; broken anywhere
              because a pairing token has no natural word boundary. */}
          <p className="set-note-inline">{t("typedEntry")}</p>
          <p
            className="set-note-inline"
            style={{ wordBreak: "break-all", userSelect: "all", fontFamily: "var(--font-mono, monospace)" }}
            data-testid="pair-link"
          >
            {minted.link}
          </p>
          <div className="acct-actions">
            <Button variant="primary" onClick={copy}>
              {t("copyLink")}
            </Button>
            {/* Done re-reads the lists: in the ordinary scan-then-Done sequence the code was
                just consumed and the paired device just appeared. */}
            <Button
              onClick={() => {
                setMinted(null);
                void refresh();
              }}
            >
              {t("mintedDone")}
            </Button>
          </div>
          <p className="acct-fine">{t("mintedOnce")}</p>
        </div>
      ) : (
        <>
          {/* The add-a-device row — the Invites mint's shape: the (optional) name is the one
              input, the button is the verb, Enter submits. */}
          <div className="set-row set-tag-edit invites-mint">
            <input
              className="join-input set-tag-input"
              value={labelDraft}
              placeholder={t("addFor")}
              aria-label={t("addFor")}
              maxLength={100}
              onChange={(e) => setLabelDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (busy === null) mint();
                }
              }}
            />
            <span className="set-tag-acts">
              <Button variant="primary" onClick={mint} disabled={busy === "mint"}>
                {busy === "mint" ? t("working") : t("addAction")}
              </Button>
            </span>
          </div>
          <p className="set-note-inline">{t("addHint")}</p>
        </>
      )}

      {codes.length > 0 ? (
        <>
          <SettingsSubhead>{t("codesTitle")}</SettingsSubhead>
          {codes.map((c) => (
            <SettingsRow
              key={c.id}
              label={c.label || t("codeFallback")}
              description={t("codeMeta", { time: clock(c.expiresAt) })}
              control={
                <span className="acct-row-act">
                  <Button onClick={() => revokeCode(c.id)} disabled={busy === `revoke:${c.id}`}>
                    {busy === `revoke:${c.id}` ? t("working") : t("revoke")}
                  </Button>
                </span>
              }
            />
          ))}
        </>
      ) : null}

      {items == null ? (
        /* NOT READ YET — the pane used to render NOTHING here until `GET /devices` answered,
           and on a slow answer that was a long blank where the list belongs (owner-reported).
           The subhead renders in both waiting states and stays when the rows arrive, so the
           surrounding layout never jumps; only the sentence under it swaps. `role="status"` so
           a screen reader hears the wait end. A fetch that FAILED with nothing loaded gets the
           plain sentence and a retry — the top-of-pane `acct-warn` already names the error. */
        <>
          <SettingsSubhead>{t("devicesTitle")}</SettingsSubhead>
          {error == null ? (
            <p className="set-note-inline" role="status">{line("loading", "Loading your devices…")}</p>
          ) : (
            <>
              <p className="set-note-inline">{line("loadFailed", "Your devices could not be loaded.")}</p>
              <div className="acct-actions">
                <Button
                  onClick={() => {
                    setError(null);
                    void refresh();
                  }}
                >
                  {line("retry", "Try again")}
                </Button>
              </div>
            </>
          )}
        </>
      ) : items.length > 0 ? (
        <>
          <SettingsSubhead>{t("devicesTitle")}</SettingsSubhead>
          {/* Current session pinned first, NAMED devices individually, and — where the server
              mounts the bulk verb (`collapseWeb`) — the plain-browser remainder as ONE group
              row with one sign-out. `named === false` is the server's own discriminator; an
              older server that never sends it gets every row individually, exactly as its own
              list has always rendered. */}
          {visibleRows.map((d) =>
            removing === d.id ? (
              <SettingsRow
                key={d.id}
                label={t("removeAsk", { name: d.label || kindWord(d.kind) })}
                description={t("removeWhat")}
                control={
                  <span className="set-tag-acts">
                    <Button
                      variant="primary"
                      className="danger"
                      onClick={() => removeDevice(d.id)}
                      disabled={busy === `remove:${d.id}`}
                    >
                      {busy === `remove:${d.id}` ? t("working") : t("remove")}
                    </Button>
                    <Button variant="ghost" onClick={() => setRemoving(null)}>
                      {t("cancel")}
                    </Button>
                  </span>
                }
              />
            ) : (
              <SettingsRow
                key={d.id}
                label={d.label || kindWord(d.kind)}
                description={
                  d.current
                    ? t("thisDevice")
                    : t("deviceMeta", { kind: kindWord(d.kind), created: day(d.createdAt), seen: day(d.lastSeenAt) })
                }
                control={
                  // The current session's verb already exists and is called signing out; a
                  // remove here would be the same action wearing a costume.
                  d.current ? undefined : (
                    <span className="acct-row-act">
                      <Button onClick={() => setRemoving(d.id)}>{t("remove")}</Button>
                    </span>
                  )
                }
              />
            ),
          )}
          {groupedWeb.length > 0 ? (
            confirmingGroup ? (
              <SettingsRow
                key="web-group-confirm"
                label={t("webGroupAsk", { count: groupedWeb.length })}
                description={t("webGroupWhat")}
                control={
                  <span className="set-tag-acts">
                    <Button
                      variant="primary"
                      className="danger"
                      onClick={revokeGroup}
                      disabled={busy === "web-group"}
                    >
                      {busy === "web-group" ? t("working") : t("webGroupAction")}
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirmingGroup(false)}>
                      {t("cancel")}
                    </Button>
                  </span>
                }
              />
            ) : (
              <SettingsRow
                key="web-group"
                label={t("webGroup", { count: groupedWeb.length })}
                description={t("webGroupMeta", { seen: day(groupedWeb[0]!.lastSeenAt) })}
                control={
                  <span className="acct-row-act">
                    <Button onClick={() => setConfirmingGroup(true)}>{t("webGroupAction")}</Button>
                  </span>
                }
              />
            )
          ) : null}
        </>
      ) : null}
    </SettingsSection>
  );
}
