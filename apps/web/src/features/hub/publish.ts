/** Publishing a file at /p/{slug}: the API and the small rules the dialog shares. */
import { json, request } from "../api";

export type Visibility = "team" | "password" | "public";
export type PublishMode = "frozen" | "live";

export interface Publication {
  slug: string;
  workspace_id: string;
  path: string;
  visibility: Visibility;
  mode: PublishMode;
  created_at: string;
  updated_at: string;
  frozen_at: string | null;
  has_password: boolean;
  /** Relative to this server: `/p/<slug>`. */
  url: string;
}

export interface PublicationChanges {
  visibility?: Visibility;
  password?: string;
  mode?: PublishMode;
  slug?: string;
}

export const MIN_PASSWORD = 4;

export const VISIBILITIES: { value: Visibility; label: string }[] = [
  { value: "team", label: "Only the team" },
  { value: "password", label: "Anyone with the password" },
  { value: "public", label: "Anyone with the link" },
];
export const MODES: { value: PublishMode; label: string }[] = [
  { value: "frozen", label: "Frozen: only when you click Update" },
  { value: "live", label: "Live: always shows the current file" },
];

/** Short labels for a list of publications. */
export const VISIBILITY_SHORT: Record<Visibility, string> = { team: "Team only", password: "Password", public: "Public" };
export const MODE_SHORT: Record<PublishMode, string> = { frozen: "Frozen", live: "Live" };

export const fileName = (path: string) => path.split("/").pop() || path;

/** What "Ask the agent" sends: get this file ready to publish on its own. */
export function publishAgentPrompt(path: string, t: (source: string, values?: Record<string, string | number>) => string): string {
  return t("Help me publish {path} with Tendly. Check that the page works on its own: every image, style, script and font it uses sits inside its folder and is referenced with a relative path, with nothing loaded by an absolute path from this computer, and that it reads well on a phone. Fix what is missing and tell me what you changed. Then I will publish it from the globe button (Publish) at the top of the file.", { path });
}

export const listPublications = () => request<Publication[]>("/hub/publications");
export const publicationFor = (workspaceId: string, path: string) =>
  request<Publication | null>(`/hub/publications/for?workspace_id=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`);
export const publish = (workspaceId: string, path: string, changes: PublicationChanges & { visibility: Visibility; mode: PublishMode }) =>
  request<Publication>("/hub/publications", json("POST", { workspace_id: workspaceId, path, ...changes }));
export const updatePublication = (slug: string, changes: PublicationChanges) =>
  request<Publication>(`/hub/publications/${encodeURIComponent(slug)}`, json("PATCH", changes));
export const refreshPublication = (slug: string) =>
  request<Publication>(`/hub/publications/${encodeURIComponent(slug)}/refresh`, json("POST"));
export const unpublish = (slug: string) =>
  request<void>(`/hub/publications/${encodeURIComponent(slug)}`, json("DELETE"));

/** The full address to share. */
export const publicLink = (publication: Pick<Publication, "url">, origin: string) => `${origin.replace(/\/$/, "")}${publication.url}`;

export const validSlug = (slug: string) => /^[a-z0-9-]{3,64}$/.test(slug);

/** What someone typed as a link name, as the server will accept it. */
export function tidySlug(text: string): string {
  return text
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64);
}

/** Why the settings cannot be sent yet, or "" when they can. */
export function problem(
  form: { visibility: Visibility; password: string; slug: string },
  hasPassword: boolean,
  t: (source: string, values?: Record<string, string | number>) => string,
): string {
  if (form.visibility === "password" && (form.password || !hasPassword) && form.password.length < MIN_PASSWORD)
    return t("Enter a password of at least {count} characters.", { count: MIN_PASSWORD });
  const slug = form.slug.replace(/-+$/, "");
  if (slug && !validSlug(slug)) return t("A link name has 3 to 64 lowercase letters, digits or hyphens.");
  return "";
}

/** Only what changed, for PATCH. An empty password keeps the current one. */
export function changes(
  current: Publication,
  form: { visibility: Visibility; password: string; mode: PublishMode; slug: string },
): PublicationChanges {
  const out: PublicationChanges = {};
  if (form.visibility !== current.visibility) out.visibility = form.visibility;
  if (form.visibility === "password" && form.password) out.password = form.password;
  if (form.mode !== current.mode) out.mode = form.mode;
  const slug = form.slug.replace(/-+$/, "");
  if (slug && slug !== current.slug) out.slug = slug;
  return out;
}
