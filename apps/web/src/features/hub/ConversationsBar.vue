<script setup lang="ts">
import { computed, ref } from "vue";
import type { Session, Workspace } from "@tendly/protocol";
import ProviderIcon from "../ProviderIcon.vue";
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import { inbox, isUnread, markAllSeen, shortAgo } from "./inbox";

/**
 * The sidebar's "Conversas" view: every conversation in one list, grouped by
 * what it needs from you rather than by folder. It follows the session poll.
 */
const props = defineProps<{ sessions: Session[]; workspaces: Workspace[]; selectedSessionId?: string }>();
const emit = defineEmits<{ openSession: [session: Session] }>();
const { t } = useI18n();
const query = ref("");

const conversations = computed(() => {
  const q = query.value.trim().toLowerCase();
  return props.sessions
    .filter(s => !s.archived_at && s.provider !== "terminal")
    .filter(s => !q || s.title.toLowerCase().includes(q))
    .sort((a, b) => (lastAt(b) ?? "").localeCompare(lastAt(a) ?? ""));
});
const lastAt = (s: Session) => inbox.activity[s.id]?.last_turn_at ?? s.updated_at;
const groups = computed(() => {
  const waiting: Session[] = [], running: Session[] = [], unread: Session[] = [], rest: Session[] = [];
  for (const s of conversations.value) {
    if (s.status === "waiting") waiting.push(s);
    else if (s.status === "running" || s.status === "starting") running.push(s);
    else if (isUnread(s.id)) unread.push(s);
    else rest.push(s);
  }
  return [
    { key: "unread", label: "Unread", items: unread },
    { key: "waiting", label: "Waiting for your reply", items: waiting },
    { key: "running", label: "Running now", items: running },
    { key: "rest", label: "Your conversations", items: rest },
  ].filter(g => g.items.length);
});
const workspaceName = (id: string) => props.workspaces.find(w => w.id === id)?.name ?? "";
const anyUnread = computed(() => conversations.value.some(s => isUnread(s.id)));
</script>

<template>
  <div class="conversations-bar">
    <div class="conv-search"><Icon name="search" :size="13" /><input v-model="query" :aria-label="t('Search conversations')" :placeholder="t('Search conversations…')" /></div>
    <button v-if="anyUnread" type="button" class="conv-mark" @click="markAllSeen()">{{ t('Mark all as read') }}</button>
    <p v-if="!groups.length" class="conv-empty">{{ t('No conversations yet.') }}</p>
    <section v-for="group in groups" :key="group.key" class="conv-group">
      <h3><i v-if="group.key !== 'rest'" :class="['conv-dot', group.key]" />{{ t(group.label) }}</h3>
      <button v-for="s in group.items" :key="s.id" type="button" :class="['conv-row', { current: s.id === selectedSessionId, unread: isUnread(s.id) }]" @click="emit('openSession', s)">
        <ProviderIcon :provider="s.provider" :size="15" />
        <span class="conv-text"><strong>{{ s.title }}</strong><small>{{ workspaceName(s.workspace_id) }}</small></span>
        <small class="conv-when">{{ shortAgo(lastAt(s), t) }}</small>
      </button>
    </section>
  </div>
</template>

<style scoped>
.conv-search { display: flex; align-items: center; gap: 7px; padding: 6px 10px; margin: 2px 6px 6px; border: 1px solid transparent; border-radius: var(--radius-sm); background: var(--fill); color: var(--muted); }
.conv-search:focus-within { background: var(--surface); border-color: var(--line-strong); box-shadow: var(--shadow-sm); }
.conv-search input { width: 100%; min-width: 0; padding: 0; border: 0; background: none; font-size: var(--text-sm); color: var(--ink); outline: 0; }
.conversations-bar { display: grid; align-content: start; gap: 6px; overflow: auto; min-height: 0; padding-bottom: 12px; }
.conv-mark { justify-self: start; margin: 0 10px; border: 0; background: none; color: var(--muted); font: inherit; font-size: .85em; cursor: pointer; }
.conv-mark:hover { color: var(--ink); }
.conv-empty { color: var(--muted); padding: 0 12px; }
.conv-group h3 { display: flex; align-items: center; gap: 6px; margin: 10px 12px 4px; font-size: .78rem; font-weight: 500; color: var(--muted); }
.conv-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.conv-dot.waiting { background: var(--warn); }
.conv-dot.running { background: var(--ok); }
.conv-row { width: calc(100% - 12px); margin: 0 6px; display: flex; align-items: center; gap: 10px; padding: 7px 8px; border: 0; border-radius: var(--radius-md); background: none; font: inherit; color: var(--ink); text-align: left; cursor: pointer; }
.conv-row:hover { background: var(--fill-hover); }
.conv-row.current { background: var(--elevated); box-shadow: 0 1px 2px rgb(0 0 0 / 8%); }
.conv-text { flex: 1; min-width: 0; display: grid; }
.conv-text strong, .conv-text small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.conv-text strong { font-weight: 450; }
.conv-row.unread .conv-text strong { font-weight: 650; }
.conv-text small, .conv-when { color: var(--muted); font-size: .8em; }
</style>
