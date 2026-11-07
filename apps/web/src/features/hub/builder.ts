/**
 * "Create with the agent": a sentence, a template, and a name, letter and
 * colour guessed from the sentence without asking any model. The app is made
 * from the template on the server (`scaffold`), opened on the Mesa with a
 * conversation beside it, and the first message is written in the composer
 * for the person to send.
 */
import type { AppColor } from "./app-tile";
import { APP_COLORS } from "./app-tile";
import { appConvention, type HubApp } from "./apps";

export type TemplateId = "blank" | "kanban" | "table" | "calendar" | "dashboard" | "form" | "document";

export interface Template {
  id: TemplateId;
  /** Shown as `t(label)`. */
  label: string;
  hint: string;
  color: AppColor;
  /** The collection the template keeps its records in, for the first message. */
  collection: string;
}

export const TEMPLATES: readonly Template[] = [
  { id: "blank", label: "Blank", hint: "A page with a small list, to start from nothing.", color: "slate", collection: "items" },
  { id: "kanban", label: "Kanban / CRM", hint: "Cards in columns you drag between, with a list view.", color: "violet", collection: "cards" },
  { id: "table", label: "Table", hint: "Rows with a filter, categories and totals.", color: "blue", collection: "entries" },
  { id: "calendar", label: "Calendar", hint: "A month with events and the day's agenda.", color: "teal", collection: "events" },
  { id: "dashboard", label: "Dashboard with charts", hint: "Totals and two charts over the entries you add.", color: "amber", collection: "entries" },
  { id: "form", label: "Form + list", hint: "A form people fill in, and the list of what came in.", color: "green", collection: "submissions" },
  { id: "document", label: "Document editor", hint: "Documents with a list and an editor that saves as you type.", color: "orange", collection: "docs" },
];

export const templateById = (id: string): Template => TEMPLATES.find(template => template.id === id) ?? TEMPLATES[0];

// ---------------------------------------------------------------- guessing from the sentence

/** Words that point at a template, in Portuguese and English, as prefixes of the folded word. */
const CLUES: Record<Exclude<TemplateId, "blank">, string[]> = {
  kanban: ["kanban", "quadro", "funil", "pipeline", "crm", "lead", "etapa", "estagio", "stage", "board", "deal", "negocio", "oportunidade", "card", "cartao", "trello", "backlog", "sprint", "prospect"],
  table: ["tabela", "table", "planilha", "spreadsheet", "lista", "list", "inventario", "inventory", "estoque", "stock", "catalogo", "catalog", "cadastro", "registro", "record", "contato", "contact", "cliente", "customer", "produto", "product", "despesa", "expense", "gasto"],
  calendar: ["calendario", "calendar", "agenda", "schedule", "evento", "event", "compromisso", "appointment", "reuniao", "meeting", "escala", "shift", "prazo", "deadline", "aniversario", "birthday", "mes", "month", "semana", "week"],
  dashboard: ["painel", "dashboard", "grafico", "chart", "graph", "metrica", "metric", "indicador", "kpi", "relatorio", "report", "resumo", "summary", "acompanh", "track", "monitor", "medir", "measure", "vendas", "sales", "receita", "revenue", "estatistic", "statistic"],
  form: ["formulario", "form", "pesquisa", "survey", "inscri", "signup", "sign-up", "registration", "pedido", "order", "solicita", "request", "feedback", "questionario", "questionnaire", "enquete", "poll", "candidat", "applica", "chamado", "ticket", "coletar", "collect"],
  document: ["documento", "document", "editor", "texto", "text", "nota", "note", "wiki", "artigo", "article", "manual", "roteiro", "script", "escrever", "write", "redigir", "rascunho", "draft", "ata", "minutes", "diario", "journal", "receita"],
};
/** A clue that beats the others when present, since it names the shape of the app. */
const STRONG: Partial<Record<Exclude<TemplateId, "blank">, string[]>> = {
  kanban: ["kanban", "quadro", "funil", "pipeline", "crm", "board"],
  calendar: ["calendario", "calendar", "agenda"],
  dashboard: ["painel", "dashboard", "grafico", "chart"],
  form: ["formulario", "form", "pesquisa", "survey", "enquete", "questionario"],
  document: ["documento", "document", "editor", "wiki"],
  table: ["tabela", "table", "planilha", "spreadsheet"],
};

export function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
export function words(text: string): string[] {
  return fold(text).replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
}

/** The template a sentence calls for: the strongest clue, else the most clues, else blank. */
export function guessTemplate(sentence: string): TemplateId {
  const list = words(sentence);
  if (!list.length) return "blank";
  const ids = Object.keys(CLUES) as Exclude<TemplateId, "blank">[];
  for (const id of ids) if (list.some(word => (STRONG[id] ?? []).some(clue => word.startsWith(clue)))) return id;
  let best: TemplateId = "blank", bestScore = 0;
  for (const id of ids) {
    const score = list.filter(word => CLUES[id].some(clue => word.startsWith(clue))).length;
    if (score > bestScore) { best = id; bestScore = score; }
  }
  return best;
}

/** Leading phrases that say "an app that…" rather than what it is. */
const LEAD = /^(?:(?:eu\s+)?(?:quero|queria|preciso|precisava|gostaria)\s+(?:de\s+)?|i\s+(?:want|need|would\s+like)\s+(?:an?\s+)?|make\s+(?:me\s+)?|build\s+(?:me\s+)?|create\s+|cri(?:e|ar)\s+|fa(?:z|ça|zer)\s+|monte?\s+|montar\s+)?(?:(?:um|uma|an?|the|o|a)\s+)?(?:app|aplicativo|application|ferramenta|tool|sistema|system|pagina|página|page|painel|dashboard|site)?\s*(?:que|para|pra|de|do|da|dos|das|to|for|that|which|where|onde|com|with)?\s*/i;
const STOP = new Set(["o", "a", "os", "as", "um", "uma", "uns", "umas", "de", "do", "da", "dos", "das", "e", "ou", "que", "para", "pra", "por", "com", "em", "no", "na", "nos", "nas", "the", "an", "and", "or", "of", "to", "for", "with", "in", "on", "at", "by", "my", "our", "your", "me", "meu", "minha", "meus", "minhas", "nosso", "nossa", "seu", "sua", "eu", "i", "we", "it", "is", "are", "be", "this", "that", "these", "those", "isso", "esse", "essa", "este", "esta", "cada", "each", "every", "all", "todos", "todas", "mais", "more", "pode", "possa", "can", "posso", "consiga", "consigo", "quero", "want", "need", "preciso", "onde", "where", "onde", "lets", "let"]);
/** Words that say the shape of the app, and are left out of a name made of other words. */
const SHAPE = new Set(["app", "aplicativo", "application", "ferramenta", "tool", "sistema", "system", "pagina", "page", "site", "simples", "simple", "pequeno", "pequena", "small", "little", "basico", "basic", "novo", "nova", "new"]);

/** A name of two or three telling words from the sentence, title-cased, at most 30 characters. */
export function guessName(sentence: string, template: TemplateId): string {
  const trimmed = sentence.trim().replace(LEAD, "");
  const raw = trimmed.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean);
  const telling = raw.filter(word => { const w = fold(word); return w.length > 1 && !STOP.has(w) && !SHAPE.has(w); });
  const chosen: string[] = [];
  for (const word of telling) {
    if (chosen.join(" ").length + word.length + (chosen.length ? 1 : 0) > 30 || chosen.length >= 3) break;
    chosen.push(word);
  }
  if (!chosen.length) return templateById(template).label.split(" / ")[0].split(" with")[0];
  return chosen.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export interface Suggestion { template: TemplateId; name: string; letter: string; color: AppColor }

/** Everything the panel fills in from the sentence; `template` can be the person's own choice. */
export function suggest(sentence: string, template?: TemplateId): Suggestion {
  const chosen = template ?? guessTemplate(sentence);
  const name = guessName(sentence, chosen);
  return { template: chosen, name, letter: [...name][0]?.toUpperCase() ?? "A", color: chosen === "blank" ? colorOfName(name) : templateById(chosen).color };
}

function colorOfName(name: string): AppColor {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return APP_COLORS[hash % APP_COLORS.length];
}

// ---------------------------------------------------------------- the first message

/** What the composer is filled with once the app exists. Never sent from here. */
export function builderPrompt(input: { app: Pick<HubApp, "name" | "slug">; sentence: string; template: TemplateId }): string {
  const template = templateById(input.template);
  const sentence = input.sentence.trim();
  return [
    `I just created the app "${input.app.name}" in \`apps/${input.app.slug}/\` from the "${template.label}" template. Turn it into this:`,
    "",
    sentence || "(I have not described it yet: ask me what it should do before changing anything.)",
    "",
    `Start by reading \`apps/${input.app.slug}/index.html\` and \`app.json\`: the page already works, uses the Tendly app kit (kit.css + kit.js: \`<t-app>\`, \`<t-kanban>\`, \`<t-table>\`, \`<t-calendar>\`, \`<t-chart>\`, \`<t-modal>\`, \`tkit.live\`, \`tkit.toast\`…) and keeps its records in the collection "${template.collection}" through \`tendly.db\`. Keep the kit and the collections, change the fields, screens and names to what I described, and write the app's text in the language I am writing in.`,
    "",
    appConvention(input.app.slug),
    "",
    `When you are done, call \`GET /api/hub/apps/<workspace id>/${input.app.slug}/diagnostics\` on the Tendly server (curl, loopback) and fix whatever it lists; the open app reloads by itself. Then tell me what changed.`,
  ].join("\n");
}

/** The message "Ask for a fix" writes for an app Tendly cannot read at all (a broken app.json, a missing page). */
export function brokenAppPrompt(slug: string, reason: string): string {
  return [
    `Tendly cannot read the app in \`apps/${slug}/\`: ${reason}`,
    "",
    "Fix it, please: `app.json` must be a JSON object with at least a \"name\" (and, optionally, \"letter\", \"color\", \"description\", \"entry\", \"permissions\"), and the entry page (index.html by default) must exist.",
  ].join("\n");
}

// ---------------------------------------------------------------- time

/** "3 minutes ago", for the catalog cards; empty when the date cannot be read. */
export function updatedAgo(iso: string | null | undefined, t: (text: string, values?: Record<string, string | number>) => string, now = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return t("Updated just now");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("Updated {n} min ago", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t(hours === 1 ? "Updated {n} hour ago" : "Updated {n} hours ago", { n: hours });
  const days = Math.round(hours / 24);
  if (days < 30) return t(days === 1 ? "Updated {n} day ago" : "Updated {n} days ago", { n: days });
  const months = Math.round(days / 30);
  return t(months === 1 ? "Updated {n} month ago" : "Updated {n} months ago", { n: months });
}
