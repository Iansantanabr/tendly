<script setup lang="ts">
/** Versions of one file: who changed it and when, a diff, and restore. */
defineProps<{ workspaceId: string; path: string; dirty: boolean }>();
const emit = defineEmits<{ close: []; restored: [] }>();
</script>

<template>
  <div class="file-history-panel" />
</template>
