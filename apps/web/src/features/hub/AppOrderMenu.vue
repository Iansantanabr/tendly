<script setup lang="ts">
/**
 * What the "…" of an app offers: pin it first, move it up or down, hide it.
 * The same menu under a row of the sidebar list, under a card of the Apps
 * page and beside a tile of the icon rail; whoever shows it decides where.
 */
import { computed, nextTick, onMounted, ref } from "vue";
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import { apps } from "./apps";
import { appKey, appOrder, appOrderError, canMoveApp, changeAppOrder, isHiddenApp, isPinnedApp, moveApp, setAppHidden, setAppPinned } from "./app-order";

const props = defineProps<{ app: { workspace_id: string; slug: string; name: string }; /** Take the keyboard when shown (a menu opened by a key or a click). */ autofocus?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

const root = ref<HTMLElement>();
const busy = ref(false);
const key = computed(() => appKey(props.app));
const pinned = computed(() => isPinnedApp(appOrder.value, key.value));
const hidden = computed(() => isHiddenApp(appOrder.value, key.value));
const canUp = computed(() => !hidden.value && canMoveApp(apps.list, appOrder.value, key.value, -1));
const canDown = computed(() => !hidden.value && canMoveApp(apps.list, appOrder.value, key.value, 1));

const items = () => Array.from(root.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
onMounted(() => { appOrderError.value = ""; if (props.autofocus) void nextTick(() => items()[0]?.focus()); });

async function run(change: () => Promise<boolean>, action: string, closes = false) {
  if (busy.value) return;
  // Only a menu the keyboard is in gets the focus back afterwards.
  const hadFocus = !!root.value?.contains(document.activeElement);
  busy.value = true;
  const saved = await change();
  busy.value = false;
  if (saved && closes) { emit("close"); return; }
  // Moving to an end disables the button that had the focus: keep the keyboard inside the menu,
  // on the same action if it can still be done, else on the opposite move.
  await nextTick();
  const menu = root.value, focused = document.activeElement;
  if (!menu || !hadFocus) return;
  if (focused instanceof HTMLButtonElement && menu.contains(focused) && !focused.disabled) return;
  const other = action === "up" ? "down" : action === "down" ? "up" : action;
  (menu.querySelector<HTMLButtonElement>(`[data-action="${action}"]:not(:disabled)`) ?? menu.querySelector<HTMLButtonElement>(`[data-action="${other}"]:not(:disabled)`) ?? items()[0])?.focus();
}
const move = (by: -1 | 1) => run(() => changeAppOrder(moveApp(apps.list, appOrder.value, key.value, by)), by < 0 ? "up" : "down");
const togglePin = () => run(() => changeAppOrder(setAppPinned(appOrder.value, key.value, !pinned.value)), "pin");
const toggleHidden = () => run(() => changeAppOrder(setAppHidden(appOrder.value, key.value, !hidden.value)), "hide", !hidden.value);

/** Up and down walk the menu; the rest (Enter, Esc, Tab) is the host's or the browser's. */
function walk(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const list = items(), index = list.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "ArrowDown" ? (index + 1) % list.length : event.key === "ArrowUp" ? (index - 1 + list.length) % list.length : event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : -1;
  if (next < 0 || !list.length) return;
  event.preventDefault(); event.stopPropagation();
  list[next]?.focus();
}
</script>

<template>
  <div ref="root" class="app-order-menu" role="menu" :aria-label="t('Options for {app}', { app: app.name })" :aria-busy="busy" @keydown="walk">
    <button type="button" role="menuitem" data-action="pin" @click="togglePin"><Icon name="pin" :size="14" /><span>{{ t(pinned ? 'Unpin' : 'Pin to the top') }}</span></button>
    <button type="button" role="menuitem" data-action="up" :disabled="!canUp" @click="move(-1)"><Icon name="arrowUp" :size="14" /><span>{{ t('Move up') }}</span></button>
    <button type="button" role="menuitem" data-action="down" :disabled="!canDown" @click="move(1)"><Icon name="arrowUp" :size="14" class="app-order-down" /><span>{{ t('Move down') }}</span></button>
    <button type="button" role="menuitem" data-action="hide" :title="hidden ? undefined : t('Takes it out of the icon rail, the sidebar and Home. It stays on the Apps page.')" @click="toggleHidden"><Icon :name="hidden ? 'check' : 'close'" :size="14" /><span>{{ t(hidden ? 'Show again' : 'Hide') }}</span></button>
    <p v-if="hidden" class="app-order-note">{{ t('Hidden: it is only on the Apps page.') }}</p>
    <p v-if="appOrderError" class="app-order-error" role="alert">{{ t('Could not save the order: {reason}', { reason: appOrderError }) }}</p>
  </div>
</template>

<style scoped>
.app-order-menu { display: grid; gap: 1px; min-width: 0; }
.app-order-menu > button { display: flex; align-items: center; gap: var(--space-2); width: 100%; min-height: 30px; padding: 5px 8px; border: 0; border-radius: var(--radius-xs); background: none; color: var(--ink-soft); font: inherit; font-size: var(--text-sm); text-align: left; cursor: pointer; }
.app-order-menu > button > span { min-width: 0; overflow-wrap: anywhere; }
.app-order-menu > button > svg { flex: none; color: var(--muted); }
.app-order-menu > button:hover:not(:disabled) { background: var(--fill); color: var(--ink); }
.app-order-menu > button:disabled { opacity: .45; cursor: default; }
/* The menus this sits in clip what spills out: draw the focus ring inside the row. */
.app-order-menu > button:focus-visible { outline-offset: -2px; }
.app-order-down { transform: rotate(180deg); }
.app-order-note, .app-order-error { margin: 0; padding: 4px 8px; font-size: var(--text-xs); line-height: 1.4; color: var(--muted); overflow-wrap: anywhere; }
.app-order-error { color: var(--danger-ink); }
@media (pointer: coarse) { .app-order-menu > button { min-height: 44px; } }
</style>
