<script setup lang="ts">
import type { EndpointProfile, Session, Workspace } from "@tendly/protocol";
import PageShell from "../PageShell.vue";
import { useI18n } from "../../i18n";

/** Scheduled scripts and agent routines. Filled in by the automations work. */
defineProps<{ workspaces: Workspace[]; sessions: Session[]; profiles: EndpointProfile[] }>();
const emit = defineEmits<{ back: []; openSession: [session: Session]; started: [sessionId: string] }>();
const { t } = useI18n();
</script>

<template>
  <PageShell :title="t('Automations')" @back="emit('back')"><div /></PageShell>
</template>
