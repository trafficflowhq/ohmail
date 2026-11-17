import type { ReactNode } from "react";
import { Button } from "@ohmail/ui/base";

/**
 * A WAY OUT OF A DOOR'S PAGE: a link to an address the host hands as a constant of its own (the web's route writes it
 * as a literal, never a value of the request), or, where the host has no address to hand, a press. The page writes no
 * address itself, and a door names one of the two: there is no default.
 */
export type DoorWay = { readonly href: string } | { press(): void };

/** The kit's Button for a way out: a link to the address the host handed, or a button that presses where it had none. */
export function WayButton(p: {
  way: DoorWay;
  kind?: "ink" | "two" | "quiet";
  size?: "s" | "l";
  children: string;
}): ReactNode {
  const { way, kind, size, children } = p;
  if ("href" in way) {
    return (
      <Button kind={kind} size={size} href={way.href}>
        {children}
      </Button>
    );
  }
  return (
    <Button kind={kind} size={size} onPress={() => way.press()}>
      {children}
    </Button>
  );
}
