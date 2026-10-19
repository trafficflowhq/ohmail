# Serving your devices from the desktop

A running desktop install is already a self-hosted ohmail. The complete
organizer (Screener, rules, filing) runs on your machine against your own
mailbox, the mailbox stays the source of truth, and no server is in the path.
Host mode is the next step: on a computer that stays awake, that same install can
also be the ohmail server your other devices use.

## Turning it on

A desktop install that organizes your own mailbox can serve it to your other
devices: **Settings → Devices**, one switch. Your phone's browser then opens the
same client this repository builds (your Ohbox, your Screener, reading and
filing real mail) through your own computer, while it is awake.

Nothing is opened to the internet. The engine listens on this computer only, and
[Tailscale](https://tailscale.com), a free private tunnel between your own
devices, carries it to your phone under a real HTTPS address. The pane detects
whether Tailscale is installed and running and walks you through what is
missing, in plain words.

## Pairing a device

Adding a device is a QR code: scan it with the device's camera, and it opens
your mail and pairs in one step. The ohmail app for Android
([apps/mobile](../../apps/mobile)) pairs by scanning the same code, or by a typed
address over the LAN door below. Each code works once and expires in five
minutes.

## Removing a device

Every paired device is listed and can be removed at any moment; removing one
cuts it off with its next request. Relaunching or updating the desktop app does
not unpair anything.

## The tray and start-at-login

When host mode is on, closing the window hides the app instead of quitting it,
and the tray brings it back. The enable step offers start-at-login as a visible
choice, not a hidden default. Turned off, none of this machinery exists: no
listener and no tray.

## The LAN door

For devices on the same network there is also a plain-HTTP door you can opt into,
for apps and API clients, not for phone browsers, which require HTTPS and use the
Tailscale address. It binds one address you choose, never all of them.

## Host mode or a server?

If the machine you would run ohmail on is the desktop in front of you, host mode
may be all you need. The [server stack](README.md) is for a box without a
screen, and for what host mode leaves out: accounts for the other people in your
household, sign-in from any browser over the open internet, and new-mail push
for the phone, which takes a full server that has set up its own push keypair.
