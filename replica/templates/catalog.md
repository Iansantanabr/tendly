# Catálogo / Catalog (`catalog`) — stage 2

Files `templates/catalog.html` + `templates/pt-BR/catalog.html`. Collection `items`. Settings key `settings`.

## Job

Show a set of things with a picture each, browsable by category and searchable, each with a detail page. Products, services, equipment, courses, suppliers. Reading first, editing second: it should look like a small storefront/brochure, not a spreadsheet.

## Data

Item `{ name, category (option id), price (money|null), image ({path,name,type}|null), summary (text, ≤140), description (markdown), tags: [text], available: bool (default true), order, extra: { [fieldId]: value } }`.
Settings `{ v: 1, currency: 'BRL', showPrice: true, priceLabel: 'Preço', categories: [{id,label,tone}] (default 3: "Produtos", "Serviços", "Outros"), extraFields: [] (kit field schema; for things like "Marca", "Código", "Prazo de entrega"), sort: 'order'|'name'|'price' }`.

## Screens

- **Catálogo** (`data-icon="grid"`): header with title/description and primary "Novo item"; a toolbar row with search (name, summary, tags, extra text fields), category `<t-pills>` with counts, sort select (Ordem manual / Nome / Preço), and a "Mostrar indisponíveis" switch (off: unavailable items hidden). Then `<t-gallery>`: image, name, subtitle = price (when showPrice) or summary, badge = category, unavailable items muted with badge "Indisponível".
- **Item detail**: not a drawer here but a full view `item` (`#item/<id>`, not in nav) laid out like a product page: large image left (on phones on top), right: category badge, name, price, summary, tags, "Disponível/Indisponível", extra fields as `.t-kv`, then the markdown description below full width. Buttons: Editar, Duplicar, Apagar; "‹ Voltar ao catálogo" link at top (this one stays on phones and desktop since it is in-app navigation).
- **Lista** (`data-icon="table"`): `<t-table>` of all items (image thumbnail column is not needed; columns name, category, price, available, updated) for bulk review; drag order is edited only in the gallery with "Ordenar" mode (a toggle that turns the gallery into a draggable list with ↑/↓ buttons).
- Editor (`<t-modal>`): `<t-record-form>` built from the fixed fields + `extraFields`; image field first with a large preview.
- **Ajustes**: Categorias (list editor with tones; deleting asks where to move items), Preço (show price switch, label, currency), Campos extras (`<t-fields-editor>`, no formula), Ordem padrão (segment), then shared blocks. CSV: name, category label, price, summary, tags (joined with ", "), available, extra fields; images are not exported (say so under the button: "As imagens não vão no CSV").

## Examples

9 items over 3 categories without images (the gallery placeholder must look intentional: soft tile with the category's first letter and tone), e.g. "Consultoria de implantação" (Serviços, 2500), "Cadeira ergonômica" (Produtos, 1290), "Treinamento de equipe – 4h" (Serviços, 900), "Kit de boas-vindas" (Produtos, 180, Indisponível)…

## Context

summary "Catálogo: 34 itens (Serviços: 12), busca 'cadeira'"; selection "Item: <name>".

## Acceptance

1. Empty: state with "Novo item" and "Ver com exemplos".
2. Upload an image in the editor; it shows in gallery and detail; deleting the item asks whether to delete the image file too (default yes; uses `tendly.files.remove`).
3. Category pills + search + sort combine; "Nada encontrado · Limpar filtros".
4. Ordering mode reorders and persists.
5. Detail page has its own hash; reload reopens; phone layout stacks image on top, no overflow.
6. Extra field added in Ajustes appears in editor, detail and CSV.
