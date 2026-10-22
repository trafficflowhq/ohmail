### A second engine can no longer open the same mail store on macOS and Windows

On macOS and Windows the desktop app's engine now holds its local mail store with an operating-system
lock for as long as it runs, so a second engine started on the same store is refused instead of
opening it beside the first and corrupting it. A store left behind by a crash or a power cut opens
again by itself.
