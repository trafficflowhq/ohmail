### Phone: newsletters wider than the screen are drawn scaled to it, not shown as text

On the phone, a newsletter built on a fixed 520-600 px table inside a full-width one (the layout most
bulk mail uses) was shown as its plain-text version with a note that it was too large to render, even
for a few kilobytes of mail. Such a letter is now laid out at its own width and scaled down to the
screen, as other phone mail apps draw it. A letter that would have to shrink past legibility (one very
long line or unbreakable cell), or whose own styles keep it wider than the screen, is shown as text, and
a letter that cannot be drawn says why: too large only when it is, otherwise that its layout could not
be drawn on this screen.
