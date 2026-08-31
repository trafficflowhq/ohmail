"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslations } from "next-intl";
import { useTheme } from "@ohmail/ui";

/**
 * The site's face toggle — paper / ohmarchy — directly above the headline, right after
 * the menu (OHMARCHY-PLAN.md §5). Two tabs; the choice flips the WHOLE site: the page's
 * own chrome, the demo's skin and the screenshot set all read the same `data-face`
 * stamp, and content, claims and structure stay identical across faces (the one-UI law
 * applies to the landing too).
 *
 * The machinery is the shared provider's, not a second writer: this control only calls
 * `setFace`, and the ONE ThemeProvider stamps `<html data-face>` (OHMARCHY-CONTRACT.md).
 * The choice persists under `ohmail.face` — the same device pin the product door reads,
 * which is exactly why a visitor who flips the landing and later opens the app meets one
 * coherent device, not two settings pretending to be one.
 *
 * ── THE WINK ────────────────────────────────────────────────────────────────────────────
 * A Linux visitor with no stored choice gets the ohmarchy face first (the §5 wedge bet —
 * a browser can only see "Linux", not "Omarchy", and the plan takes that bet with its
 * guardrails: remembered in localStorage, one click back, an explicit choice always
 * wins). The wink line renders ONLY on that auto-flip — never once a choice exists at
 * either scope, and never on the `#face=` preset, which is the visitor's own request.
 *
 * Hydration: the provider resolves "paper" until it has adopted storage post-mount, so
 * the pressed state and the wink wait for `mounted` — same move as the Nav's theme icon.
 * The page's LOOK never flashes: the marketing boot script stamped `data-face` pre-paint.
 *
 * ── THE CONTROL IS THE PREVIEW (owner review, 2026-08-31) ──────────────────────────────
 * With the hero split parked, this toggle carries the two-faces story alone, so it
 * demonstrates rather than names: the LEFT half is drawn in the paper idiom (the paper
 * stack's type, a soft pill edge, light falloff) and the RIGHT half in the ohmarchy idiom
 * (mono, radius 0, a drawn ring) — whichever face the SITE currently wears. That is why
 * the halves' styles are literal values and not tokens: tokens flip with `data-face`, and
 * a preview that flipped with the thing it previews would show two copies of one face.
 * The active side reads active in its own idiom — paper by lift, ohmarchy by the 2px
 * accent ring the app's tiling face uses (`--lift-3` there). See `.l-face-tab` in
 * landing.css.
 */
export function FaceToggle() {
  const t = useTranslations("face");
  const { face, facePreference, accountFace, linuxDevice, setFace, adoptAccountFace } =
    useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  /* The demo iframe shares this origin, and its own Settings → Look writes the same
     storage keys (review-caught): a face changed INSIDE the demo left the page and this
     toggle on the old face until reload. A write from another document fires `storage`
     here, so the choice is relayed into the ONE provider — which stays the only stamp
     writer; this is propagation of a persisted choice, not a second machinery. A
     same-document write fires no storage event, so the relay cannot loop. */
  useEffect(() => {
    const isFace = (v: string | null): v is "paper" | "ohmarchy" =>
      v === "paper" || v === "ohmarchy";
    const onStorage = (e: StorageEvent) => {
      if (e.key === "ohmail.face") setFace(isFace(e.newValue) ? e.newValue : null);
      else if (e.key === "ohmail.face.account") {
        adoptAccountFace(isFace(e.newValue) ? e.newValue : null);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [setFace, adoptAccountFace]);

  /* Auto-flip = detection chose, nobody did: ohmarchy on a Linux device with no device
     pin and no account echo. The wink is a label on that decision, so it disappears the
     moment the decision is somebody's. */
  const winked =
    mounted &&
    face === "ohmarchy" &&
    facePreference === null &&
    accountFace === null &&
    linuxDevice;

  const active = mounted ? face : "paper";

  return (
    <div className="l-face-bar l-rise" style={{ "--rise": "0.4" } as CSSProperties}>
      <div className="l-face-tabs" role="group" aria-label={t("label")}>
        <button
          type="button"
          className="l-face-tab is-paper"
          aria-pressed={active === "paper"}
          onClick={() => setFace("paper")}
        >
          {t("paper")}
        </button>
        <button
          type="button"
          className="l-face-tab is-oh"
          aria-pressed={active === "ohmarchy"}
          onClick={() => setFace("ohmarchy")}
        >
          {t("ohmarchy")}
        </button>
      </div>
      {winked ? <p className="l-face-wink">{t("wink")}</p> : null}
    </div>
  );
}
