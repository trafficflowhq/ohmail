# paper and ohmarchy

The short version is in the [README](../README.md#what-else-is-in-it).

## The two faces

ohmail ships one interface wearing two faces. **paper** is the quiet one and
the default everywhere but Linux: light, letter-like, sculpted by shadow rather
than line. **ohmarchy** is the loud one: hard corners, drawn borders, mono
type, tiled panes with real gaps, and a louder keyboard cursor — a homage to
[Omarchy](https://omarchy.org)'s way of working, built for people who live in
a tiling window manager. It is a *face*, not a fork: same components, same
features, same keyboard — different tokens. A face may change how the app
looks, never what it is. On a Linux machine ohmail wears ohmarchy first; your
own choice always wins and is one press away, in the app under
**Settings → General → Look**. The README has a twin,
[README.ohmarchy.md](../README.ohmarchy.md), wearing the other face: the switch
at the top of the page flips the screenshots, and not one sentence.

## Omarchy themes

The face's palette is not
hardcoded: a palette mapping derives the interface's color tokens from an
Omarchy theme's own `colors.toml`, with contrast floors so a readable theme
stays readable here — theme-agnostic by construction, custom themes included.
On an Omarchy system the desktop app reads the active theme from
`~/.local/state/omarchy/current/theme` and watches it, so `omarchy theme set`
re-skins ohmail moments after it re-skins your desktop. Anywhere else the face
keeps its static defaults: Tokyo Night in the dark, Flexoki in the light.
Flip through every theme Omarchy ships — no install, no signup:
[**the live demo, wearing ohmarchy →**](https://ohmail.app/#face=ohmarchy)
