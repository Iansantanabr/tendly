<script setup lang="ts">
import { onMounted } from "vue";
import { useRouter } from "vue-router";
import type { Session } from "@tendly/protocol";
import PageShell from "../PageShell.vue";
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import { inbox, inboxLink, inboxMessage, markInboxRead, refreshInbox, shortAgo, type InboxItem } from "./inbox";

/** The bell: what finished, what failed and what waits for you, newest first. */
const props = defineProps<{ sessions: Session[] }>();
const emit = defineEmits<{ back: []; openSession: [session: Session] }>();
const { t } = useI18n();
const router = useRouter();
onMounted(refreshInbox);

function open(item: InboxItem) {
  void markInboxRead([item.id]);
  // An app's notice opens the app; everything else, its conversation.
  const link = inboxLink(item);
  if (link) { void router.push(link); return; }
  const session = props.sessions.find(s => s.id === item.session_id);
  if (session) emit("openSession", session);
}
</script>

<template>
  <PageShell :title="t('Notifications')" :subtitle="inbox.unread ? t('{count} unread', { count: inbox.unread }) : t('All caught up')" @back="emit('back')">
    <template #actions><button type="button" class="secondary-button" :disabled="!inbox.unread" @click="markInboxRead()"><Icon name="check" :size="14" />{{ t('Mark all as read') }}</button></template>
    <div class="inbox-page">
      <p v-if="!inbox.available" class="inline-notice">{{ t('This backend does not keep notifications yet.') }}</p>
      <p v-else-if="!inbox.items.length" class="home-empty">{{ t('Nothing here yet. When an agent finishes or needs you, it shows up here.') }}</p>
      <ul class="inbox-list">
        <li v-for="item in inbox.items" :key="item.id">
          <button type="button" :class="['inbox-item', { unread: !item.read_at }]" @click="open(item)">
            <i :class="['inbox-dot', item.kind]" />
            <span class="inbox-text"><strong>{{ item.title || t(item.kind === 'app' ? 'App' : 'Conversation') }}</strong><span>{{ t(inboxMessage(item.kind)) }}<template v-if="item.body"> · {{ item.body }}</template></span></span>
            <small>{{ shortAgo(item.created_at, t) }}</small>
            <Icon name="chevron" :size="12" class="inbox-go" />
          </button>
        </li>
      </ul>
    </div>
  </PageShell>
</template>

<style scoped>
.inbox-page { display: grid; gap: 12px; }
.inbox-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.inbox-item { width: 100%; display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 0; border-radius: var(--radius-md); background: none; font: inherit; color: var(--ink); text-align: left; cursor: pointer; }
.inbox-item:hover { background: var(--fill-hover); }
.inbox-item:not(.unread) { opacity: .7; }
.inbox-item.unread strong { font-weight: 650; }
.inbox-text { flex: 1; min-width: 0; display: grid; }
.inbox-text strong, .inbox-text span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inbox-text span { color: var(--muted); }
.inbox-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); flex: none; }
.inbox-dot.turn_failed, .inbox-dot.automation_failed { background: var(--danger); }
.inbox-dot.waiting { background: var(--warn); }
.inbox-item small { color: var(--muted); white-space: nowrap; }
.inbox-go { opacity: .5; }
@media (pointer: coarse) { .inbox-item { min-height: 56px; } }
.home-empty { color: var(--muted); }
</style>
