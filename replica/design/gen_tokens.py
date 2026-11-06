import re, json, sys
css = open(sys.argv[1]).read(); out = sys.argv[2]
lines = css.splitlines()
def block(start_pat):
    i = next(n for n,l in enumerate(lines) if re.match(start_pat, l))
    depth, vals = 0, {}
    for l in lines[i:]:
        depth += l.count('{') - l.count('}')
        m = re.match(r'\s*--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;', l)
        if m: vals[m.group(1)] = m.group(2)
        if depth <= 0 and '}' in l: break
    return vals
light = block(r'^:root \{'); dark = {**light, **block(r'^:root\[data-theme="dark"\] \{')}
ROLES = {"bg":"bg","surface":"surface","elevated":"elevated","fill":"fill","fill-hover":"fill-hover",
 "border":"line","border-input":"line-input","text":"ink","text-soft":"ink-soft","text-muted":"muted","text-faint":"faint",
 "accent":"accent","on-accent":"on-accent","accent-ink":"accent-ink","accent-soft":"accent-soft","focus":"focus",
 "danger":"danger","danger-ink":"danger-ink","danger-soft":"danger-soft","success":"ok","success-ink":"ok-ink","success-soft":"ok-soft",
 "warning":"warn","warning-ink":"warn-ink","warning-soft":"warn-soft"}
APPS = ["amber","green","blue","violet","rose","slate","teal","orange"]
def colour(v):
    c = {role: v[css_name] for role, css_name in ROLES.items() if css_name in v}
    for a in APPS:
        if f"app-{a}" in v: c[f"app-{a}"] = v[f"app-{a}"]; c[f"app-{a}-soft"] = v[f"app-{a}-soft"]
    return c
pairs = [[t,b] for t in ["text","text-soft","text-muted"] for b in ["bg","surface","elevated","fill"]]
pairs += [["text-faint","surface","ui"],["text-faint","fill","ui"],["on-accent","accent"],["accent-ink","surface"],["accent-ink","accent-soft"],
 ["danger-ink","danger-soft"],["danger-ink","surface"],["success-ink","success-soft"],["warning-ink","warning-soft"],["warning-ink","surface"],
 ["accent","surface","ui"],["border-input","surface","ui"],["focus","surface","ui"],["danger","surface","ui"],["success","surface","ui"],["warning","surface","ui"]]
pairs += [[f"app-{a}", f"app-{a}-soft"] for a in APPS]
common = {
 "font":{"sans":"Instrument Sans Variable, Inter Variable, system-ui, sans-serif (OFL, embutidas pelo Tendly)","mono":"JetBrains Mono Variable, ui-monospace, Menlo, monospace (OFL)"},
 "type":{"xs":{"size":12,"line":16,"weight":500,"css":"--text-xs"},"sm":{"size":13,"line":18,"weight":400,"css":"--text-sm"},"md":{"size":14,"line":20,"weight":400,"css":"--text-md"},
   "base":{"size":15,"line":22,"weight":400,"css":"--text-base"},"lg":{"size":16,"line":24,"weight":600,"css":"--text-lg"},"xl":{"size":18,"line":26,"weight":600,"css":"--text-xl"},
   "2xl":{"size":22,"line":28,"weight":650,"css":"--text-2xl"},"3xl":{"size":28,"line":34,"weight":650,"css":"--text-3xl"},"input":{"size":16,"line":22,"weight":400,"css":"--input-text","_note":"16px mínimo: o iOS não dá zoom no campo"}},
 "space":[0,4,8,12,16,20,24,32,40],
 "radius":{"xs":4,"sm":6,"md":10,"lg":14,"xl":20,"pill":999,"_note":"md/lg/xl multiplicados por --corner-scale"},
 "shadow":{"sm":"--shadow-sm","md":"--shadow-md","lg":"--shadow-lg","card":"--shadow-card"},
 "motion":{"fast":"100ms (--duration-fast)","normal":"--duration-normal","ease":"cubic-bezier(.16,1,.3,1) (--ease-out)","_note":"respeitar prefers-reduced-motion"},
 "layout":{"sidebar":"~264px expandida","page_max":"760–820px nas páginas do hub","pane_min":"360px (apps e painéis precisam funcionar aqui)","breakpoint_mobile":"< 768px","touch_target":"44px com pointer:coarse"}}
about = "Papéis de design do fork, lidos de apps/web/src/styles.css (gerado por gen_tokens.py; não editar à mão). Os nomes de papel são os do replica; a coluna css diz qual variável do Tendly usar no código. Valores = paleta padrão do Tendly (bege + verde-azulado), sem a marca da Ratoeira."
for name, vals in (("tokens.json", light), ("tokens.dark.json", dark)):
    d = {"_about": about, "_theme": "light" if name=="tokens.json" else "dark", "_css": {r: f"var(--{c})" for r,c in ROLES.items()}, "color": colour(vals), "pairs": pairs, **common}
    json.dump(d, open(f"{out}/{name}","w"), ensure_ascii=False, indent=2)
print(len(colour(light)), "cores;", len(pairs), "pares")
