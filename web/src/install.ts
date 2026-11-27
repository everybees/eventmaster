// "Add to Home Screen": Chrome and Edge (Android, desktop) offer a prompt the app can show at a good moment;
// iPhones have none, so the app explains the Share → Add to Home Screen steps instead.
import { useSyncExternalStore } from "react";
import { sendTally } from "./api.ts";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISSED_KEY = "wpg.installDismissed";
let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());

/** Call once at startup: keeps the browser's install prompt for later, and counts installs (anonymously). */
export function watchInstall(): void {
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // instead of the browser's own banner, the app offers it after a few saves
    deferred = e as BeforeInstallPromptEvent;
    changed();
  });
  addEventListener("appinstalled", () => {
    deferred = null;
    sendTally("installed");
    changed();
  });
}

export const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

export const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** How this browser can install the app: a one-tap prompt, iPhone steps, or not at all (installed already, or unsupported). */
export type InstallWay = "prompt" | "ios" | null;
const way = (): InstallWay => (isStandalone() ? null : deferred ? "prompt" : isIos() ? "ios" : null);

export function useInstallWay(): InstallWay {
  return useSyncExternalStore((f) => { listeners.add(f); return () => listeners.delete(f); }, way);
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const event = deferred;
  deferred = null;
  await event.prompt();
  const { outcome } = await event.userChoice;
  changed();
  return outcome === "accepted";
}

export const installDismissed = () => localStorage.getItem(DISMISSED_KEY) === "1";
export const dismissInstall = () => localStorage.setItem(DISMISSED_KEY, "1");
