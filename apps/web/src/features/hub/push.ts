/**
 * Push notifications on this device: whether the browser can receive them,
 * subscribing with the server's key, and the list of subscribed devices.
 */
import { json, request } from "../api";
import { isIos, isStandalone, tellWorker, workerRegistration } from "./pwa";

/** One subscribed browser, as the server lists it (no endpoint, no keys). */
export interface PushDevice {
  id: string;
  label: string;
  /** The push service's host, e.g. `fcm.googleapis.com`. */
  service: string;
  /** SHA-256 of the endpoint: how a browser recognises its own row. */
  endpoint_sha256: string;
  created_at: string;
  last_ok_at: string | null;
  failures: number;
}

export interface PushTestReport {
  sent: number;
  failed: number;
  removed: number;
  waiting: number;
}

/**
 * `insecure` the page is not https (or localhost); `needs-install` an iPhone
 * or iPad, which only delivers pushes to an app on the Home Screen;
 * `unsupported` the browser has no push at all; `denied` the person (or a
 * policy) blocked notifications for this site; `ready` it can be turned on.
 */
export type PushSupport = "insecure" | "needs-install" | "unsupported" | "denied" | "ready";

export interface PushEnv {
  secure: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  permission?: NotificationPermission;
  ios: boolean;
  standalone: boolean;
}

export function pushSupport(env: PushEnv): PushSupport {
  if (!env.secure) return "insecure";
  const capable = env.serviceWorker && env.pushManager && env.notification;
  if (!capable) return env.ios && !env.standalone ? "needs-install" : "unsupported";
  return env.permission === "denied" ? "denied" : "ready";
}

export function readPushEnv(): PushEnv {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return { secure: false, serviceWorker: false, pushManager: false, notification: false, ios: false, standalone: false };
  }
  const notification = "Notification" in window;
  return {
    secure: window.isSecureContext === true,
    serviceWorker: "serviceWorker" in navigator,
    pushManager: "PushManager" in window,
    notification,
    permission: notification ? Notification.permission : undefined,
    ios: isIos(navigator.userAgent, navigator.platform, navigator.maxTouchPoints),
    standalone: isStandalone(),
  };
}

/** A short name for this browser on this device: "iPhone", "Android · Chrome", "Mac · Safari". */
export function deviceLabel(userAgent: string, platform = "", maxTouchPoints = 0): string {
  const device = /iPhone|iPod/.test(userAgent) ? "iPhone"
    : /iPad/.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1) ? "iPad"
    : /Android/.test(userAgent) ? "Android"
    : /Macintosh|Mac OS X/.test(userAgent) ? "Mac"
    : /Windows/.test(userAgent) ? "Windows"
    : /CrOS/.test(userAgent) ? "Chromebook"
    : /Linux/.test(userAgent) ? "Linux"
    : "";
  // Order matters: Edge and Opera also say Chrome, and Chrome also says Safari.
  const browser = /Edg(?:e|A|iOS)?\//.test(userAgent) ? "Edge"
    : /OPR\/|Opera/.test(userAgent) ? "Opera"
    : /SamsungBrowser\//.test(userAgent) ? "Samsung Internet"
    : /Firefox\/|FxiOS\//.test(userAgent) ? "Firefox"
    : /Chrome\/|CriOS\//.test(userAgent) ? "Chrome"
    : /Safari\//.test(userAgent) ? "Safari"
    : "";
  // On an iPhone or iPad the installed app is the only one that gets pushes: the device says it all.
  if (device === "iPhone" || device === "iPad") return device;
  return [device, browser].filter(Boolean).join(" · ");
}

/** Whose push service a device uses, in words. */
export function serviceName(host: string): string {
  if (host.endsWith("googleapis.com") || host.endsWith("google.com")) return "Google";
  if (host.endsWith("push.apple.com")) return "Apple";
  if (host.endsWith("mozilla.com") || host.endsWith("mozilla.org")) return "Mozilla";
  if (host.endsWith("windows.com") || host.endsWith("microsoft.com")) return "Microsoft";
  return host;
}

/** The server's key as the bytes `pushManager.subscribe` wants. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Whether a subscription was made with this server key (it is useless with any other). */
export function sameKey(existing: ArrayBuffer | null | undefined, key: string): boolean {
  if (!existing) return false;
  const have = new Uint8Array(existing), want = keyBytes(key);
  return have.length === want.length && have.every((byte, index) => byte === want[index]);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export const listDevices = async () => (await request<{ subscriptions: PushDevice[] }>("/hub/push/subscriptions")).subscriptions;
export const removeDevice = (id: string) => request<void>(`/hub/push/subscriptions/${encodeURIComponent(id)}`, json("DELETE"));
export const sendTestPush = () => request<PushTestReport>("/hub/push/test", json("POST"));

export const PUSH_ERROR_TEXT: Record<"denied" | "dismissed" | "worker" | "subscribe", string> = {
  denied: "Notifications are blocked for this site. Allow them in the site settings of the browser, then turn this on again.",
  dismissed: "The browser did not get an answer. Turn this on again and choose Allow.",
  worker: "The app could not finish getting ready on this device. Reload the page and try again.",
  subscribe: "The browser could not subscribe to notifications. Check the connection and try again.",
};

/** Why turning notifications on did not work, as a key for `t()`. */
export class PushError extends Error {
  /** `detail` is what the browser itself said, shown after the translated text. */
  constructor(readonly reason: "denied" | "dismissed" | "worker" | "subscribe", readonly detail = "") {
    super(PUSH_ERROR_TEXT[reason]);
    this.name = "PushError";
  }
}

async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  const registered = await workerRegistration();
  if (!registered) throw new PushError("worker");
  // `ready` never settles if the worker failed to install; do not wait forever.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 10_000); }),
  ]);
  clearTimeout(timer);
  if (!ready) throw new PushError("worker");
  return ready;
}

/** This browser's own subscription, if it has one. */
async function ownSubscription(): Promise<PushSubscription | null> {
  if (pushSupport(readPushEnv()) === "insecure" || !("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const registered = await workerRegistration();
  if (!registered) return null;
  try { return await registered.pushManager.getSubscription(); } catch { return null; }
}

/** The hash of this browser's endpoint, to find it in the device list; null if not subscribed. */
export async function ownEndpointHash(): Promise<string | null> {
  const subscription = await ownSubscription();
  return subscription ? sha256Hex(subscription.endpoint) : null;
}

/**
 * Turns notifications on here: asks permission (from the click that called
 * this), subscribes with the server's key and tells the server.
 */
export async function enablePush(): Promise<string> {
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission === "denied") throw new PushError("denied");
  if (permission !== "granted") throw new PushError("dismissed");
  const registration = await readyRegistration();
  const { key } = await request<{ key: string }>("/hub/push/key");
  let subscription: PushSubscription | null;
  try {
    subscription = await registration.pushManager.getSubscription();
    // Made with another server key (the server's was replaced): it would be refused.
    // (A browser that does not say which key it used gets a fresh one too.)
    if (subscription && !sameKey((subscription.options as PushSubscriptionOptions | undefined)?.applicationServerKey, key)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  } catch (cause) {
    if (typeof Notification !== "undefined" && Notification.permission === "denied") throw new PushError("denied");
    throw new PushError("subscribe", cause instanceof Error ? cause.message : "");
  }
  const body = subscription.toJSON();
  const label = deviceLabel(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
  const { id } = await request<{ id: string }>("/hub/push/subscriptions", json("POST", { endpoint: body.endpoint, keys: body.keys, label }));
  void tellWorker({ label });
  return id;
}

/** Turns them off here: the server forgets this device and the browser its subscription. */
export async function disablePush(devices: readonly PushDevice[]) {
  const subscription = await ownSubscription();
  if (!subscription) return;
  const hash = await sha256Hex(subscription.endpoint);
  const row = devices.find(device => device.endpoint_sha256 === hash);
  if (row) await removeDevice(row.id);
  try { await subscription.unsubscribe(); } catch { /* The server no longer sends to it either way. */ }
}
