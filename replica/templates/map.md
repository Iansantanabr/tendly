# Mapa / Locais / Map (`map`) — stage 3

Files `templates/map.html` + `templates/pt-BR/map.html`. Collection `places`. Settings key `settings`. Depends on **Leaflet** being vendored by Opus (with Ian's OK) at `crates/server/src/hub/apps/vendor/leaflet.js` and `leaflet.css`, served at `/api/hub/apps/vendor/leaflet.js|css` and added to the frame's shared paths.

## Job

Places on a map linked to a list: units, job sites, clients, service points, visits. Click a marker or a row to see details; filter by category; plan visits.

## Network (the only template allowed to reach outside GCore)

- Map tiles from `https://tile.openstreetmap.org/{z}/{x}/{y}.png` with the required attribution "© OpenStreetMap" (Leaflet attribution control, always visible).
- Address search through Nominatim `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=<address>&accept-language=<lang>` **only** when the person presses "Buscar endereço" (never on typing; max 1 request per second; show results to pick from). If it fails (offline, refused), say "Não deu para buscar o endereço agora. Marque no mapa ou cole as coordenadas." 
- Ajustes shows a short notice: "O mapa vem do OpenStreetMap: as imagens do mapa e os endereços que você buscar passam pelos servidores deles."
- If tiles can't load (offline), the List view still works and the Map view shows `<t-state kind="error">` "Sem conexão com o mapa" with "Ver lista".

## Data

Place `{ name, category (option id), address, lat: number|null, lng: number|null, phone?, contact?, notes (longtext), status (option id, optional), lastVisit: 'YYYY-MM-DD'|null, order }`.
Settings `{ v: 1, categories: [{id,label,tone}] (default Unidade, Cliente, Obra), statuses: [{id,label,tone}] (default Ativo/ok, Pausado/warn, Encerrado/), center: { lat: -15.78, lng: -47.93, zoom: 4 } (en: { lat: 39.5, lng: -98.35, zoom: 4 }), fitOnOpen: true }`.

## Screens

- **Mapa** (`data-icon="map"`): split layout on desktop: list on the left (search, category pills, each row: name, category badge, address, "Sem localização" badge when lat is null), map on the right (fills height). Markers are Leaflet `circleMarker`s coloured by category tone (resolve the kit CSS variable to a colour via `getComputedStyle` at draw time, so dark mode works), with a tooltip of the name; clicking a marker highlights the row and opens the detail drawer; hovering a row highlights its marker. "Ajustar ao conteúdo" button fits all markers. Phones: a `.t-segment` Mapa / Lista toggles between full-screen map and list.
- Detail (`<t-detail>` drawer; `#map/<id>`): fields, "Abrir no OpenStreetMap" link (`https://www.openstreetmap.org/?mlat=..&mlon=..#map=17/..`) and "Rota no Google Maps" (`https://www.google.com/maps/dir/?api=1&destination=lat,lng`), "Registrar visita hoje" (sets lastVisit), Editar, Apagar.
- Editor modal: name, category, status, address + "Buscar endereço" (results list → sets lat/lng and shows a small preview map), or "Marcar no mapa" (closes the modal into a pick mode: click the map to set the point, Esc cancels), or coordinates inputs (accepts "-23.55, -46.63" pasted in one field and splits it). Phone, contact, notes, last visit.
- **Lista** (`data-icon="table"`): `<t-table>` of places (name, category, status, address, last visit, has location) for review and CSV.
- **Ajustes**: Categorias, Situações (statuses), Ponto inicial do mapa ("Usar a vista atual do mapa" button saves center/zoom), the network notice, then shared blocks (CSV includes lat/lng; import accepts lat/lng columns or leaves them null).

## Examples

8 places in 3 categories around one city (pt: São Paulo coordinates; en: Chicago), with plausible addresses (no real business names), two without coordinates ("Sem localização").

## Context

summary "Mapa: 24 locais (Clientes: 15), 3 sem localização"; selection "Local: <name>".

## Acceptance

1. Map loads from the vendored Leaflet (no CDN), tiles from OSM with attribution.
2. Address search only on button press; picking a result sets the point.
3. Pick-on-map mode works with mouse and touch; Esc cancels.
4. Offline: list works, map shows the error state.
5. Marker colours follow category tones in light and dark.
