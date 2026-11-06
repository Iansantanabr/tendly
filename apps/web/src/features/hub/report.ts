/** "Report a problem": a small app, `apps/reportes/`, that keeps a list of
 * problems noticed while using Tendly. It is made the first time the person
 * asks for it, in their first project, and only opened after that. */
import { ApiError } from "../api";
import { apps, refreshApps, scaffoldApp, type HubApp } from "./apps";

export const REPORT_SLUG = "reportes";

type Translate = (source: string, values?: Record<string, string | number>) => string;

/** The reports app if some project already has it: the earliest project in the list wins. */
export function existingReportApp(list: readonly HubApp[], projectIds: readonly string[]): HubApp | undefined {
  return list
    .filter(app => app.slug === REPORT_SLUG && projectIds.includes(app.workspace_id))
    .sort((a, b) => projectIds.indexOf(a.workspace_id) - projectIds.indexOf(b.workspace_id))[0];
}

export interface ReportDeps {
  refresh: () => Promise<void>;
  list: () => readonly HubApp[];
  scaffold: typeof scaffoldApp;
}
const hostDeps: ReportDeps = { refresh: refreshApps, list: () => apps.list, scaffold: scaffoldApp };

/** The reports app, made first if no project has it. Call it from a click and
 * nowhere else: nothing is ever created without the person asking. */
export async function openReportApp(projectIds: readonly string[], t: Translate, deps: ReportDeps = hostDeps): Promise<HubApp> {
  if (!projectIds.length) throw new Error(t("Add a project first: the list of problems is kept in a project folder."));
  // A fresh look, so an app made in another window is opened rather than made again.
  await deps.refresh();
  const existing = existingReportApp(deps.list(), projectIds);
  if (existing) return existing;
  try {
    return await deps.scaffold(projectIds[0], {
      slug: REPORT_SLUG,
      name: t("Problem reports"),
      description: t("Problems and ideas noted while using Tendly."),
      color: "rose",
      template: "issues",
    });
  } catch (cause) {
    // The folder is already there: someone made it between the look and the request.
    if (cause instanceof ApiError && cause.status === 409) {
      await deps.refresh();
      const made = existingReportApp(deps.list(), projectIds);
      if (made) return made;
    }
    throw cause;
  }
}
