import { applyHostReady } from "@openchamber/sdk/ui";
import { setTransport } from "../api";
import { isExtension } from "./mode";
import { extensionTransport, host } from "./transport";

/**
 * Wire the console to the OpenChamber host.
 *
 * The host replays the current theme to late `onReady` subscribers, so this is
 * safe even when the iframe starts after the first ready message.
 */
export function bootExtension(): void {
  if (!isExtension()) return;
  host.onReady((context) => {
    applyHostReady(context, document.documentElement);
  });
  setTransport(extensionTransport);
}
