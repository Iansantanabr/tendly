<script setup lang="ts">
import type { Workspace } from "@tendly/protocol";
import PageShell from "../PageShell.vue";
import { useI18n } from "../../i18n";

/** Skills the agents on this machine can load. Read only. */
defineProps<{ workspaces: Workspace[] }>();
const emit = defineEmits<{ back: []; openFile: [workspaceId: string, path: string] }>();
const { t } = useI18n();
</script>

<template>
  <PageShell :title="t('Skills')" @back="emit('back')"><div /></PageShell>
</template>
