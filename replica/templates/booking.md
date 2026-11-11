# Reservas / Bookings (`booking`) — stage 3

Files `templates/booking.html` + `templates/pt-BR/booking.html`. Collections `resources` and `bookings`. Settings key `settings`.

## Job

Shared things people reserve: rooms, equipment, cars, service slots. See what is free, book it, cancel it, never double-book. Each resource is booked either by **time slots** (rooms, appointments) or by **whole days** (vehicles, equipment).

## Data

Resource `{ name, kind: 'slots'|'days', color tone, capacity? (text, e.g. "8 pessoas"), location?, description?, slot: { minutes: 30|60|15|90|120, from: 'HH:MM', to: 'HH:MM', weekdays: [1..5] }, active: bool, order }`.
Booking `{ resourceId, resourceName (copied), date: 'YYYY-MM-DD', start: 'HH:MM'|null, end: 'HH:MM'|null (slots), endDate: 'YYYY-MM-DD'|null (days, inclusive), who: text, purpose: text, status: 'confirmed'|'cancelled', cancelledReason?, createdBy }`.
Settings `{ v: 1, person: '', weekStart: 1, horizonDays: 60, allowPast: false }`.

**Conflict rule** (pure, `// LOGIC START … // LOGIC END`, tested in `apps/web/src/features/hub/booking-logic.test.mjs`): two confirmed bookings of the same resource conflict when their intervals overlap (slots: same date and `start < otherEnd && otherStart < end`; days: date ranges overlap inclusive). Before inserting or changing a booking: list the resource's confirmed bookings in the range from the collection (fresh `list`, not the cached render), check, insert, then **re-check** after insert: if a conflicting booking with an earlier `created_at` exists (someone booked at the same moment), remove ours and tell the person "Esse horário acabou de ser reservado por outra pessoa." Functions: `slotsFor(resource, date)`, `overlaps(a, b)`, `freeSlots(resource, date, bookings)`, `conflicts(candidate, bookings)`.

## Screens

- **Reservar** (`data-icon="calendar"`): date navigator (‹ hoje ›, a date input, week strip of 7 days with a dot where you have bookings). For the chosen date: a grid with one row per active `slots` resource and columns per slot time (from–to); free cells are buttons "Livre" (click → quick-book dialog with who/purpose; length selectable as 1–4 slots if consecutive free), booked cells show who/purpose truncated (click → booking detail). Below, the `days` resources as a list for that date: "Livre" with "Reservar" (asks end date) or "Reservado por Ana até 14/11". Phones: one resource at a time (a select on top) as a vertical list of slots.
- **Minhas reservas** (`data-icon="list"`): upcoming confirmed bookings where `who` equals settings.person (or all, toggle), grouped by day; Cancelar (asks reason, keeps record as cancelled), Alterar (reopens the dialog with conflict check).
- **Recursos** (`data-icon="grid"`): cards of resources with kind badge, hours, capacity; "Novo recurso"; editor modal with kind segment (Horários / Dias) and the slot settings (minutes, from, to, weekday toggles).
- **Histórico** (`data-icon="clock"`): `<t-table>` of all bookings incl. cancelled; pills by resource; CSV export here and in Ajustes.
- **Ajustes**: Seu nome, Semana começa, Até quantos dias à frente (horizon), Permitir reservas no passado (switch), then shared blocks.

## Examples

Resources: "Sala de reunião 1" (slots 30 min, 08:00–18:00, seg–sex, 8 pessoas), "Sala de reunião 2" (60 min), "Carro da empresa" (days), "Projetor" (days). 10 bookings across today and the next 7 days, two cancelled.

## Context

summary "Reservas de qui., 13 de nov.: Sala 1 4 de 20 horários ocupados; Carro livre"; selection on a booking "Reserva: Sala de reunião 1, 14:00–15:00, Ana".

## Acceptance

1. Double booking impossible from two panes clicking the same slot at once (the re-check rule).
2. Slot generation respects minutes/from/to/weekdays; past slots disabled unless allowed; horizon enforced.
3. Day bookings across several days block each day.
4. Cancel keeps history; the slot becomes free.
5. Phone layout as described; no horizontal page overflow (the desktop grid scrolls inside its own scroller).
