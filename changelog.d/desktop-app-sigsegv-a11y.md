### ohmail on Linux keeps running when an accessibility tool stops while you type

On the Linux desktop app, a screen reader or another accessibility tool that quit or restarted while
you were typing could take the whole app down with it: GTK freed the tool's key listener while it was
still handing that key press to it. ohmail now holds such a removal until GTK has finished with the key,
then completes it. Every key still reaches every running tool once, as before, and accessibility stays on.
