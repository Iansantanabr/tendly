<script setup lang="ts">
import { ref, watch } from "vue";
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import type { ConversationRef } from "./conversation-link";

/** Conversations attached to a message as context, each removable. */
const props = defineProps<{ items: ConversationRef[] }>();
const emit = defineEmits<{ remove: [id: string] }>();
const { t } = useI18n();
/** Adding and removing are announced, not only shown. */
const said = ref("");
watch(() => props.items, (now, before = []) => {
  const added = now.find(item => !before.some(old => old.id === item.id));
  const removed = before.find(old => !now.some(item => item.id === old.id));
  if (added) said.value = t("Conversation {name} added as context", { name: added.title });
  else if (removed) said.value = t("Conversation {name} removed", { name: removed.title });
});
</script>

<template>
  <span class="sr-only" role="status" aria-live="polite">{{ said }}</span>
  <ul v-if="items.length" class="conversation-chips" :aria-label="t('Conversations as context')">
    <li v-for="item in items" :key="item.id" class="conversation-chip" :title="t('The agent reads this conversation with tendly_read_conversation')">
      <Icon name="chat" :size="13" /><span class="conversation-chip-name">{{ item.title || t('Conversation') }}</span>
      <button type="button" :aria-label="t('Remove conversation {name}', { name: item.title || item.id })" @click="emit('remove', item.id)"><Icon name="close" :size="11" /></button>
    </li>
  </ul>
</template>

<style scoped>
.conversation-chips { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; margin: 0; padding: 0 2px 6px; }
.conversation-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 260px; padding: 2px 4px 2px 10px; border-radius: var(--radius-full); background: var(--fill); color: var(--ink-soft); font-size: var(--text-xs); }
.conversation-chip-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.conversation-chip button { display: grid; place-items: center; width: 20px; height: 20px; border: 0; border-radius: var(--radius-full); background: none; color: var(--muted); cursor: pointer; }
.conversation-chip button:hover { background: var(--fill-hover); color: var(--ink); }
@media (pointer: coarse) { .conversation-chip button { width: 32px; height: 32px; } }
</style>
