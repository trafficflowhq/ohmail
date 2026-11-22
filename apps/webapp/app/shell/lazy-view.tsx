"use client";

import type { ComponentProps, ComponentType, ReactElement } from "react";
import { LoadFailed as FrameLoadFailed, lazyView as fromFrame } from "@ohmail/app/frame";
import { BrowserChunkLoads } from "../chunk-loads.js";
import { TextFromIntl } from "./LocaleContext.js";

export { BrowserChunkLoads, page } from "../chunk-loads.js";
export { ViewLoadFailed } from "@ohmail/app/frame";

export function lazyView<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
  frame?: Parameters<typeof fromFrame<T>>[1],
): ComponentType<ComponentProps<T>> {
  const View = fromFrame(load, frame);
  return function WebView(props: ComponentProps<T>) {
    return <TextFromIntl><BrowserChunkLoads><View {...props} /></BrowserChunkLoads></TextFromIntl>;
  };
}

export function LoadFailed(props: { onRetry: () => void }): ReactElement {
  return <TextFromIntl><FrameLoadFailed {...props} /></TextFromIntl>;
}
