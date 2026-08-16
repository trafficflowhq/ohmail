import type { MetadataRoute } from "next";

/* THE manifest for the whole origin, now that the marketing site and the
   product are one app — it sits outside both route groups because a
   metadata route needs no layout, and there is only one `/manifest.webmanifest`
   to have.

   It exists for one concrete reason: it is the only way an installed icon gets
   the `maskable` treatment. Android crops a plain icon to whatever shape the
   launcher wants and will letterbox our squircle inside its own circle; a
   maskable entry says "this art is full-bleed, crop it" and points at the pair
   generated for that purpose (all ink inside the 80% safe circle —
   design/icon/oh, asserted by icon:check).

   Static on purpose: a manifest is fetched without a locale and cached
   aggressively, so it carries the product name rather than translated copy.
   `start_url` and `scope` are `/` in earnest now — that one URL is the landing
   to a stranger and the mail client to a session, so an installed shortcut
   lands on whichever the holder is entitled to. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ohmail",
    short_name: "ohmail",
    description: "Consent-first email on the mailboxes you already own.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fbfaf9",
    theme_color: "#fbfaf9",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
