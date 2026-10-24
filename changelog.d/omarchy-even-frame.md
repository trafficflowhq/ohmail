### The Omarchy frame matches Hyprland's gaps

With the Omarchy look, the gap from the window edge to a column's border now equals the gap between two
columns, measured as Hyprland measures its own gaps: to the outer edge of the border. Before, the 2px
borders stood inside the gaps, so the edge read 8px and the gap between columns 6px where Hyprland's own
windows sit 10px apart. A gaps change made with `hyprctl` or a reloaded Hyprland config now reaches an
open window within a few seconds, not only at the next launch (desktop). The thread squares between the
list and the open conversation keep the same 10px to the border on each side.
