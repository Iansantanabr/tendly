/**
 * The fork's own settings (`/api/hub/settings`): the time zone automations run
 * in, the public address published links are shown with, dictation, how the
 * sidebar looks on the Mesa and the order of the apps.
 *
 * They are read once per page load and shared: the dictation button, the
 * publish panel and Settings → Addresses and time zone all look at the same
 * value, and saving in one place updates the others.
 */
import { computed, ref } from "vue";
import { json, request } from "../api";

export type DictationMode = "browser" | "off";
/** On the Mesa: a narrow rail of icons, or the full sidebar as on the other pages. */
export type MesaSidebar = "icons" | "expanded";
export interface HubSettings {
  /** IANA zone for automations that name none. */
  timezone: string;
  /** `https://pub.example.com`, or "" for this server's own address. */
  public_base_url: string;
  dictation: DictationMode;
  mesa_sidebar: MesaSidebar;
  /** The person's arrangement of their apps (app-order.ts); entries are `<workspace id>/<slug>`. */
  app_order: { pinned: string[]; order: string[]; hidden: string[] };
}
export interface ZoneList {
  zones: string[];
  /** The zone of the machine the server runs on (UTC on a VPS), when it can tell. */
  server: string | null;
}

/** What the server answers before anything is saved. */
export const DEFAULT_SETTINGS: HubSettings = { timezone: "America/Sao_Paulo", public_base_url: "", dictation: "browser", mesa_sidebar: "icons", app_order: { pinned: [], order: [], hidden: [] } };

export const hubSettings = ref<HubSettings>();
/** Asked and answered (or failed): from here on `hubSettings` or the defaults are what there is. */
export const hubSettingsKnown = ref(false);
let loading: Promise<void> | undefined;

/** Reads the settings once; later calls wait for the same answer. A server without them keeps the defaults. */
export function loadHubSettings(fetchSettings: () => Promise<HubSettings> = () => request<HubSettings>("/hub/settings")): Promise<void> {
  loading ??= fetchSettings()
    .then(value => { hubSettings.value = value; })
    .catch(() => { loading = undefined; })
    .finally(() => { hubSettingsKnown.value = true; });
  return loading;
}

/** Forgets what was read, for tests. */
export function resetHubSettings() { loading = undefined; hubSettings.value = undefined; hubSettingsKnown.value = false; }

export async function saveHubSettings(changes: Partial<HubSettings>): Promise<HubSettings> {
  const saved = await request<HubSettings>("/hub/settings", json("PUT", changes));
  hubSettings.value = saved;
  hubSettingsKnown.value = true;
  return saved;
}

/** Every zone the server accepts; read once, it does not change while the server runs. */
export const zoneList = ref<ZoneList>();
export async function loadZones(): Promise<ZoneList> {
  zoneList.value ??= await request<ZoneList>("/hub/settings/timezones");
  return zoneList.value;
}

/** The microphone button shows only once the setting is known not to be "off". */
export const dictationAllowed = computed(() => hubSettingsKnown.value && (hubSettings.value?.dictation ?? DEFAULT_SETTINGS.dictation) !== "off");
export const publicBaseUrl = computed(() => hubSettings.value?.public_base_url ?? "");
export const hubTimezone = computed(() => hubSettings.value?.timezone ?? DEFAULT_SETTINGS.timezone);

// ---------------------------------------------------------------------------
// The public address

type Translate = (source: string, values?: Record<string, string | number>) => string;

/** What was typed, as it will be stored: no spaces around it, no trailing slash. */
export function tidyBaseUrl(text: string): string {
  return text.trim().replace(/\/+$/, "");
}

/** Why an address cannot be saved, or "" when it can. Empty is fine: it means "this server's own address". */
export function baseUrlProblem(text: string, t: Translate): string {
  const value = text.trim();
  if (!value) return "";
  if (/^http:\/\//i.test(value)) return t("The address has to start with https://. Published pages ask for passwords, so plain http is not accepted.");
  if (!/^https:\/\//i.test(value)) return t("Start the address with https://, for example https://pub.example.com.");
  let url: URL;
  try { url = new URL(value); } catch { return t("That is not a complete address. Example: https://pub.example.com."); }
  if (!url.hostname) return t("That is not a complete address. Example: https://pub.example.com.");
  if (url.username || url.password) return t("The address cannot carry a user name or password.");
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash || value.includes("?") || value.includes("#"))
    return t("Use only the domain, without a path: links are always the address followed by /p/ and the name of the link.");
  return "";
}

/** A link as it will look with this address, for the example under the field. */
export function sampleLink(base: string, origin: string, slug = "report-k3f9"): string {
  return `${tidyBaseUrl(base) || origin.replace(/\/+$/, "")}/p/${slug}`;
}

// ---------------------------------------------------------------------------
// Time zones

/** Letters only, so "sao paulo", "São_Paulo" and "sao-paulo" are the same search. */
const plain = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim();

/** The zones matching what was typed, every word of it; `keep` (the chosen one) always stays in the list. */
export function filterZones(zones: readonly string[], query: string, keep = ""): string[] {
  const words = plain(query).split(" ").filter(Boolean);
  if (!words.length) return [...zones];
  return zones.filter(zone => {
    if (zone === keep) return true;
    const name = plain(zone);
    return words.every(word => name.includes(word));
  });
}

/** "UTC−03:00" for a zone at a moment, or "" when this browser does not know the zone. */
export function zoneOffset(zone: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(at).find(entry => entry.type === "timeZoneName")?.value ?? "";
    const match = /^GMT(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/.exec(part);
    if (!match) return "";
    const hours = match[2]?.padStart(2, "0") ?? "00", minutes = match[3] ?? "00";
    // Zero is written one way, whether the runtime says "GMT" or "GMT+00:00".
    if (hours === "00" && minutes === "00") return "UTC±00:00";
    return `UTC${match[1] === "-" ? "−" : "+"}${hours}:${minutes}`;
  } catch { return ""; }
}

/** "America/Sao_Paulo" as people read it: "America / Sao Paulo". */
export const zoneLabel = (zone: string) => zone.replace(/_/g, " ").replace(/\//g, " / ");

/** The time on the clock in a zone, for "it is now 14:32 there". */
export function timeInZone(zone: string, at: Date = new Date(), locale?: string): string {
  try { return new Intl.DateTimeFormat(locale, { timeZone: zone, hour: "2-digit", minute: "2-digit", weekday: "short" }).format(at); }
  catch { return ""; }
}
