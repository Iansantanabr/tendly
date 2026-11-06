<script setup lang="ts">
import { computed } from "vue";
import type { PaneNode, Workspace } from "@tendly/protocol";
import { paneString } from "../pane-context";
import AppView from "./AppView.vue";
import { requestAppChat } from "./app-chat";

/**
 * A custom app in a tab of the Mesa. The tab keeps the name and tile it was
 * opened with; the bar follows the app's current app.json. What the bar and
 * the frame do is `AppView.vue`, shared with the full-screen view.
 */
const props = defineProps<{ pane: PaneNode; workspace: Workspace }>();
const emit = defineEmits<{ chat: []; remove: [] }>();

const slug = computed(() => paneString(props.pane, "slug"));
const fallback = computed(() => ({ name: paneString(props.pane, "name") ?? props.pane.title ?? undefined, letter: paneString(props.pane, "letter"), color: paneString(props.pane, "color") }));
/** "Ask for a fix": the conversation open beside the app, or a new one there, with the errors written in its composer. */
function fix(text: string) {
  if (!slug.value) return;
  void requestAppChat({ workspaceId: props.workspace.id, slug: slug.value, name: fallback.value.name ?? slug.value, paneId: props.pane.id, text });
}
</script>

<template>
  <AppView mode="pane" :workspace-id="workspace.id" :workspace-name="workspace.name" :slug="slug" :fallback="fallback" @chat="emit('chat')" @fix="fix" @remove="emit('remove')" />
</template>
