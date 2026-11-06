/** What an app tile shows: a letter on one of eight colours, each a `--app-<colour>` token pair in styles.css. */
export const APP_COLORS = ["amber", "green", "blue", "violet", "rose", "slate", "teal", "orange"] as const;
export type AppColor = (typeof APP_COLORS)[number];
export const appColor = (value: unknown): AppColor => (APP_COLORS as readonly unknown[]).includes(value) ? value as AppColor : "slate";
/** The letter on an app's tile: its own, else the first letter of its name. */
export function appLetter(letter: unknown, name: string): string {
  const own = typeof letter === "string" ? letter.trim() : "";
  return ([...(own || name.trim())][0] ?? "?").toUpperCase();
}
