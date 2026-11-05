<script setup lang="ts">
import type { Workspace } from "@tendly/protocol";
import PageShell from "../PageShell.vue";
import { useI18n } from "../../i18n";

/** MCP servers the agents on this machine can reach. Read only. */
defineProps<{ workspaces: Workspace[] }>();
const emit = defineEmits<{ back: [] }>();
const { t } = useI18n();
</script>

<template>
  <PageShell :title="t('Integrations')" @back="emit('back')"><div /></PageShell>
</template>
