/**
 * Tendly as an installed app: registering the service worker (`/sw.js`, served
 * by the server), talking to it, and knowing whether to suggest installing.
 *
 * The worker is registered only where browsers allow one (https, or
 * localhost) and never by the development server, which has no `/sw.js`.
 */
import { reactive, watch } from "vue";
import type { Router } from "vue-router";
import { useI18n } from "../../i18n";
import { installPresence } from "./presence";

export interface WorkerEnv {
  secure: boolean;
  serviceWorker: boolean;
  dev: boolean;
}

export function canRegisterWorker(env: WorkerEnv): boolean {
  return env.secure && env.serviceWorker && !env.dev;
}

function workerEnv(): WorkerEnv {
  return {
    secure: typeof window !== "undefined" && window.isSecureContext === true,
    serviceWorker: typeof navigator !== "undefined" && "serviceWorker" in navigator,
    dev: import.meta.env?.DEV === true,
  };
}

/** A place inside the app the worker asked to open (a tapped notification), or nothing. */
export function navigationTarget(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const message = data as { type?: unknown; url?: unknown };
  if (message.type !== "tendly:navigate" || typeof message.url !== "string") return undefined;
  const url = message.url;
  return url.startsWith("/") && !url.startsWith("//") && !url.startsWith("/\\") ? url : undefined;
}

let registration: Promise<ServiceWorkerRegistration | undefined> | undefined;

/** The worker's registration, made once; undefined where there can be none. */
export function workerRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!canRegisterWorker(workerEnv())) return Promise.resolve(undefined);
  registration ??= navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  return registration;
}

/** What the worker cannot find out itself: the app's language and this device's name. */
export async function tellWorker(meta: { lang?: string; label?: string }) {
  if (!(await workerRegistration())) return;
  try {
    const ready = await navigator.serviceWorker.ready;
    ready.active?.postMessage({ type: "tendly:meta", ...meta });
  } catch { /* The worker falls back to the browser's language. */ }
}

/** Called once at startup (main.ts). */
export function installPhoneSupport(router: Router) {
  installPresence();
  watchInstall();
  if (!canRegisterWorker(workerEnv())) return;
  navigator.serviceWorker.addEventListener("message", event => {
    const target = navigationTarget(event.data);
    if (target) void router.push(target);
  });
  const start = () => {
    void workerRegistration();
    watch(useI18n().locale, lang => { void tellWorker({ lang }); }, { immediate: true });
  };
  // After the page has loaded, so the worker's own fetches never slow the first paint.
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
}

// ---------------------------------------------------------------- installing

export function isIos(userAgent: string, platform = "", maxTouchPoints = 0): boolean {
  // An iPad says it is a Mac; a Mac has no touch screen.
  return /iPhone|iPad|iPod/.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
}

export interface InstallEnv {
  secure: boolean;
  /** Already running as an installed app. */
  standalone: boolean;
  /** A touch device: the hint is for phones and tablets. */
  coarse: boolean;
  ios: boolean;
  /** The browser offered its own install prompt (Chrome on Android). */
  canPrompt: boolean;
}

/**
 * How to suggest installing:
 * `prompt` a button that opens the browser's dialog, `ios` the Share → Add to
 * Home Screen steps, `menu` the browser-menu steps, `none` nothing to suggest.
 */
export type InstallHintKind = "prompt" | "ios" | "menu" | "none";

export function installHint(env: InstallEnv): InstallHintKind {
  if (env.standalone || !env.coarse) return "none";
  if (env.ios) return "ios";
  // Elsewhere an installed app needs a secure page; the notifications panel says how to get one.
  if (!env.secure) return "none";
  return env.canPrompt ? "prompt" : "menu";
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export const install = reactive({
  prompt: undefined as BeforeInstallPromptEvent | undefined,
  /** Installed during this visit. */
  done: false,
});

let watching = false;
function watchInstall() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    install.prompt = event as BeforeInstallPromptEvent;
  });
  window.addEventListener("appinstalled", () => { install.prompt = undefined; install.done = true; });
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const displayed = typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
  return displayed || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function readInstallEnv(): InstallEnv {
  if (typeof window === "undefined") return { secure: false, standalone: false, coarse: false, ios: false, canPrompt: false };
  return {
    secure: window.isSecureContext === true,
    standalone: isStandalone() || install.done,
    coarse: typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches,
    ios: isIos(navigator.userAgent, navigator.platform, navigator.maxTouchPoints),
    canPrompt: Boolean(install.prompt),
  };
}

/** Opens the browser's install dialog; true if the person accepted. */
export async function promptInstall(): Promise<boolean> {
  const event = install.prompt;
  if (!event) return false;
  await event.prompt();
  const choice = await event.userChoice;
  // The browser allows one use of the event.
  install.prompt = undefined;
  if (choice.outcome === "accepted") install.done = true;
  return choice.outcome === "accepted";
}
