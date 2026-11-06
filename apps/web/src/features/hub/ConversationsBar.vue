<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { ProviderKind, Session, Workspace } from "@tendly/protocol";
import { providerLabel } from "../clients";
import ProviderIcon from "../ProviderIcon.vue";
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import { inbox, isUnread, markAllSeen, shortAgo } from "./inbox";
import { groupConversations, refreshRoutines, routineBySession, routines } from "./home";
import { focusSessionComposer } from "./reply";

/**
 * The sidebar's "Conversas" view: every conversation in one list, grouped by
 * what it needs from you rather than by folder. It follows the session poll.
 */
const props = defineProps<{ sessions: Session[]; workspaces: Workspace[]; selectedSessionId?: string }>();
const emit = defineEmits<{ openSession: [session: Session]; newConversation: [provider: ProviderKind] }>();
const { t } = useI18n();
const query = ref("");

// Conversations a routine opened; asked again whenever the inbox gets a new
// entry (a routine that ran adds one), so it rides the inbox poll.
onMounted(() => void refreshRoutines());
watch(() => inbox.items[0]?.id, (now, before) => { if (now !== before) void refreshRoutines(); });
const routineOf = computed(() => routineBySession(routines.items));

const lastAt = (s: Session) => inbox.activity[s.id]?.last_turn_at ?? s.updated_at;
const groups = computed(() => groupConversations({
  sessions: props.sessions,
  workspaceId: inbox.conversationsWorkspaceId,
  routines: routineOf.value,
  activity: inbox.activity,
  isUnread,
  query: query.value,
}));
const subtitle = (s: Session) => routineOf.value.get(s.id)?.automation_name || providerLabel(s.provider);
const unreadCount = computed(() => groups.value.flatMap(g => g.items).filter(s => isUnread(s.id)).length);

function reply(s: Session) {
  const from = document.activeElement;
  emit("openSession", s);
  requestAnimationFrame(() => focusSessionComposer(s.id, 60, from));
}
</script>

<template>
  <div class="conversations-bar">
    <div class="conv-new">
      <button type="button" class="conv-new-main" :disabled="!inbox.conversationsWorkspaceId" @click="emit('newConversation', 'claude_code')"><Icon name="plus" :size="14" />{{ t('New conversation') }}</button>
      <button type="button" class="conv-new-alt" :disabled="!inbox.conversationsWorkspaceId" :title="t('New conversation with {client}', { client: providerLabel('codex') })" @click="emit('newConversation', 'codex')">{{ providerLabel('codex') }}</button>
    </div>
    <div v-if="unreadCount" class="conv-head">
      <span>{{ t('{count} unread', { count: unreadCount }) }}</span>
      <button type="button" class="conv-mark" @click="markAllSeen()">{{ t('Mark all as read') }}</button>
    </div>
    <div class="conv-search"><Icon name="search" :size="13" /><input v-model="query" :aria-label="t('Search conversations')" :placeholder="t('Search conversations…')" /></div>
    <p v-if="!groups.length" class="conv-empty">{{ t('Conversations without a project show up here. Start one above.') }}</p>
    <section v-for="group in groups" :key="group.key" class="conv-group">
      <h3><Icon v-if="group.key === 'routines'" name="timer" :size="12" /><i v-else-if="group.key !== 'rest'" :class="['conv-dot', group.key]" />{{ t(group.label) }}</h3>
      <div v-for="s in group.items" :key="s.id" class="conv-item">
        <button type="button" :class="['conv-row', { current: s.id === selectedSessionId, unread: isUnread(s.id) }]" @click="emit('openSession', s)">
          <Icon v-if="routineOf.has(s.id)" name="timer" :size="15" class="conv-mark-icon" />
          <ProviderIcon v-else :provider="s.provider" :size="15" />
          <span class="conv-text"><strong>{{ s.title }}</strong><small>{{ subtitle(s) }}<template v-if="isUnread(s.id)"> · {{ t('Unread') }}</template></small></span>
          <small class="conv-when">{{ shortAgo(lastAt(s), t) }}</small>
        </button>
        <button v-if="group.key === 'waiting'" type="button" class="conv-reply" :aria-label="t('Reply to “{title}”', { title: s.title })" @click="reply(s)">{{ t('Reply') }}</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.conv-new { display: flex; gap: 4px; margin: 4px 6px 2px; }
.conv-new button { border: 1px solid var(--line); background: var(--elevated); color: var(--ink); border-radius: var(--radius-md); padding: 6px 10px; font: inherit; font-size: var(--text-sm); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.conv-new-main { flex: 1; justify-content: center; }
.conv-new button:hover:not(:disabled) { border-color: var(--accent); }
.conv-new button:disabled { opacity: .5; cursor: default; }
.conv-search { display: flex; align-items: center; gap: 7px; padding: 6px 10px; margin: 2px 6px 6px; border: 1px solid transparent; border-radius: var(--radius-sm); background: var(--fill); color: var(--muted); }
.conv-search:focus-within { background: var(--surface); border-color: var(--line-strong); box-shadow: var(--shadow-sm); }
.conv-search:has(input:focus-visible) { outline: 2px solid var(--focus); outline-offset: 2px; }
.conv-search input { width: 100%; min-width: 0; padding: 0; border: 0; background: none; font-size: var(--text-sm); color: var(--ink); outline: 0; }
.conversations-bar { display: grid; align-content: start; gap: 6px; overflow: auto; min-height: 0; padding-bottom: 12px; }
.conv-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 10px; font-size: var(--text-xs); color: var(--muted); }
.conv-mark { border: 0; background: none; padding: 2px 0; color: var(--muted); font: inherit; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.conv-mark:hover { color: var(--ink); }
.conv-empty { color: var(--muted); padding: 0 12px; }
.conv-group h3 { display: flex; align-items: center; gap: 6px; margin: 10px 12px 4px; font-size: .78rem; font-weight: 500; color: var(--muted); }
.conv-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.conv-dot.waiting { background: var(--warn); }
.conv-dot.running { background: var(--ok); }
.conv-item { display: flex; align-items: center; gap: 4px; margin: 0 6px; }
.conv-reply { flex: none; border: 1px solid var(--line-input); background: var(--warn-soft); color: var(--warn-ink); border-radius: var(--radius-sm); padding: 3px 8px; font: inherit; font-size: var(--text-xs); font-weight: 600; cursor: pointer; }
.conv-reply:hover { border-color: var(--warn-ink); }
.conv-mark-icon { color: var(--muted); flex: none; }
.conv-group h3 :deep(svg) { color: var(--muted); }
@media (pointer: coarse) { .conv-reply { min-height: 44px; } }
.conv-row { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 7px 8px; border: 0; border-radius: var(--radius-md); background: none; font: inherit; color: var(--ink); text-align: left; cursor: pointer; }
.conv-row:hover { background: var(--fill-hover); }
.conv-row.current { background: var(--elevated); box-shadow: 0 1px 2px rgb(0 0 0 / 8%); }
.conv-text { flex: 1; min-width: 0; display: grid; }
.conv-text strong, .conv-text small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.conv-text strong { font-weight: 450; }
.conv-row.unread .conv-text strong { font-weight: 650; }
.conv-text small, .conv-when { color: var(--muted); font-size: .8em; }
</style>
