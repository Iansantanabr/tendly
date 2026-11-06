<script setup lang="ts">
/**
 * What an app asks to be allowed, and the person's answer. Shown in place the
 * first time an app that asks for something is opened (and again when it asks
 * for more), and from "Permissions" in the app's header afterwards.
 *
 * A new question is answered Allow or Refuse. Refusing keeps what was allowed
 * before and refuses only what is new. An answered list can be changed as a
 * whole: allow everything, or take everything back.
 */
import { computed } from "vue";
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import { grantChoices, permissionText, type AppGrants } from "./app-bridge";

const props = defineProps<{
  name: string;
  grants: AppGrants;
  busy?: boolean;
  problem?: string;
  /** `gate`: the app waits behind this card. `strip`: the app is showing below it. */
  layout: "gate" | "strip";
}>();
const emit = defineEmits<{ decide: [granted: string[]]; close: [] }>();
const { t } = useI18n();

const choices = computed(() => grantChoices(props.grants));
const state = (permission: string) => props.grants.pending.includes(permission) ? "pending" : props.grants.granted.includes(permission) ? "granted" : "refused";
const STATE_TEXT = { pending: "New", granted: "Allowed", refused: "Refused" } as const;
/** Each line says where it stands once something has been answered; a first question is just the list. */
const answered = computed(() => props.grants.granted.length + props.grants.refused.length > 0);
</script>

<template>
  <section :class="['app-permissions', `is-${layout}`]" role="group" :aria-label="t('Permissions of {app}', { app: name })">
    <div class="app-permissions-card">
      <header>
        <Icon name="shield" :size="16" />
        <h3>{{ choices.asking ? t('{app} asks for your permission', { app: name }) : t('What {app} is allowed to do', { app: name }) }}</h3>
        <button v-if="layout === 'strip' && !choices.asking" type="button" class="icon-button" :aria-label="t('Close')" :title="t('Close')" @click="emit('close')"><Icon name="close" :size="13" /></button>
      </header>
      <p class="app-permissions-intro">{{ choices.asking ? t('This app wants to:') : t('This app asked to:') }}</p>
      <ul>
        <li v-for="permission in grants.requested" :key="permission" :class="`is-${state(permission)}`">
          <span class="app-permissions-text">{{ t(permissionText(permission)) }}</span>
          <span v-if="answered" class="app-permissions-state">{{ t(STATE_TEXT[state(permission)]) }}</span>
        </li>
      </ul>
      <p class="app-permissions-note">{{ t('It reads, and never changes, what it is allowed to see. You can change this answer under Permissions, in the app\'s header.') }}</p>
      <p v-if="problem" class="app-permissions-problem" role="alert">{{ problem }}</p>
      <footer>
        <button v-if="choices.refuse" type="button" class="small-button" :disabled="busy" @click="emit('decide', choices.refuse)">{{ choices.asking ? t('Refuse') : t('Take it all back') }}</button>
        <button v-if="choices.allow" type="button" class="small-button primary" :disabled="busy" @click="emit('decide', choices.allow)">{{ choices.asking ? t('Allow') : t('Allow all') }}</button>
      </footer>
    </div>
  </section>
</template>

<style scoped>
.app-permissions { flex: none; min-width: 0; background: var(--surface); }
.app-permissions.is-strip { max-height: 60%; overflow: auto; border-bottom: 1px solid var(--border); padding: 10px 12px; }
.app-permissions.is-gate { flex: 1; min-height: 0; overflow: auto; display: grid; place-items: center; padding: 16px; }
.app-permissions-card { display: grid; gap: 8px; width: 100%; max-width: 480px; min-width: 0; }
.app-permissions.is-gate .app-permissions-card { padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--elevated); box-shadow: var(--shadow-card); }
.app-permissions header { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--muted); }
.app-permissions h3 { flex: 1; min-width: 0; margin: 0; color: var(--ink); font-size: var(--text-md); font-weight: 600; overflow-wrap: anywhere; }
.app-permissions-intro, .app-permissions-note { margin: 0; color: var(--muted); font-size: var(--text-sm); }
.app-permissions-note { font-size: var(--text-xs); }
.app-permissions ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.app-permissions li { display: flex; align-items: baseline; gap: 8px; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--sunken); min-width: 0; }
.app-permissions-text { flex: 1; min-width: 0; color: var(--ink); font-size: var(--text-sm); overflow-wrap: anywhere; }
.app-permissions-state { flex: none; color: var(--muted); font-size: var(--text-xs); font-weight: 600; }
.app-permissions li.is-granted .app-permissions-state { color: var(--ok-ink); }
.app-permissions li.is-refused .app-permissions-state { color: var(--danger-ink); }
.app-permissions li.is-pending .app-permissions-state { color: var(--accent-ink); }
.app-permissions-problem { margin: 0; padding: 4px 8px; border: 1px solid var(--danger-line); border-radius: var(--radius-sm); background: var(--danger-soft); color: var(--danger-ink); font-size: var(--text-xs); }
.app-permissions footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
@media (pointer: coarse) {
  .app-permissions .small-button { min-height: 44px; min-width: 44px; }
  .app-permissions .icon-button { width: 44px; height: 44px; }
}
</style>
