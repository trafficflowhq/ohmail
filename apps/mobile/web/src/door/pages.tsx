/**
 * THE DOOR'S TWO PAGES, by route. A line is filled by the feature that draws its page; `none` is a page not built
 * into this page yet, and nothing is drawn for it.
 */
import type { ReactNode } from "react";
import { NONE, type None } from "@ohmail/app/host";
import type { DoorAt } from "../../../src/shell/door-kinds";
import type { DoorHandle } from "./handle";

export type DoorPage = (props: { readonly door: DoorHandle }) => ReactNode;

export const pages: { readonly [At in DoorAt]: DoorPage | None } = {
  welcome: NONE,
  servers: NONE,
};
