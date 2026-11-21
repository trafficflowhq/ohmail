import type { ComponentProps } from "react";
import "./slot.css";

export type NativeSelectProps = Omit<ComponentProps<"select">, "className">;

/** A slot that uses the platform's selection menu and keyboard behavior. */
export function NativeSelect(props: NativeSelectProps) {
  return <select {...props} className="oh-control oh-slot oh-native-select" />;
}
