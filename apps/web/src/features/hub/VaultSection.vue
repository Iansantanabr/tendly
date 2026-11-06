<script setup lang="ts">
/** The 1Password vaults the `op` CLI on the server can see. Read only: vault
 * names, never an item, and no place to type a token. */
import { computed, onMounted, ref } from "vue";
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import { ONE_PASSWORD_CLI_URL, loadVault, vaultState, type VaultInfo } from "./catalog";

const { t } = useI18n();
const vault = ref<VaultInfo>();
const loading = ref(false);
const failure = ref("");

async function load(unlock = false) {
  loading.value = true;
  failure.value = "";
  try { vault.value = await loadVault(unlock); }
  catch (error) { failure.value = error instanceof Error ? error.message : String(error); }
  finally { loading.value = false; }
}
onMounted(() => { void load(); });

const state = computed(() => vault.value ? vaultState(vault.value) : undefined);
const pill = computed(() => {
  if (state.value === "signed_in") return t("Signed in");
  if (state.value === "signed_out") return t("Not signed in");
  if (state.value === "missing") return t("Not installed");
  return "";
});
</script>

<template>
  <section class="vault" aria-labelledby="vault-title">
    <h2 id="vault-title">{{ t('1Password vault') }}</h2>
    <div class="vault-card">
      <div class="vault-head">
        <Icon name="shield" :size="16" class="vault-icon" />
        <div class="vault-text">
          <strong>{{ t('1Password CLI (op)') }}<span v-if="vault?.version" class="vault-version">{{ vault.version }}</span></strong>
          <span v-if="!vault && loading" class="vault-note">{{ t('Looking for the 1Password CLI…') }}</span>
          <span v-else-if="state === 'missing'" class="vault-note">{{ t('The 1Password CLI is not installed on the computer that runs Tendly.') }}</span>
          <span v-else-if="state === 'signed_in'" class="vault-note">
            <template v-if="vault?.account">{{ vault.account }}</template>
            <span v-if="vault?.service_account" class="vault-tag">{{ t('service account') }}</span>
          </span>
          <span v-else-if="state === 'signed_out'" class="vault-note">{{ t('Nobody is signed in to 1Password in the CLI.') }}</span>
        </div>
        <span v-if="pill" :class="['vault-pill', state]">{{ pill }}</span>
        <button type="button" class="small-button" :disabled="loading" @click="load(false)">{{ loading ? t('Checking…') : t('Check again') }}</button>
      </div>

      <p v-if="failure" class="inline-error" role="alert">{{ failure }}</p>
      <p v-else-if="vault?.error" class="inline-error" role="alert">{{ t(vault.error) }}</p>

      <div v-if="state === 'missing'" class="vault-body">
        <p v-if="vault?.platform === 'macos'" class="vault-note">{{ t('To install it on this Mac, run this in a terminal:') }} <code>brew install 1password-cli</code></p>
        <p class="vault-note">
          {{ t('Installation steps for every system:') }}
          <a class="vault-link" :href="ONE_PASSWORD_CLI_URL" target="_blank" rel="noopener" :aria-label="t('1Password CLI installation guide (opens in a new tab)')">developer.1password.com/docs/cli/get-started <span aria-hidden="true">↗</span></a>
        </p>
        <p class="vault-note">{{ t('After installing, restart Tendly so it finds the op command, then check again.') }}</p>
      </div>

      <div v-else-if="state === 'signed_out'" class="vault-body">
        <p class="vault-note">{{ t('Turn on “Integrate with 1Password CLI” in the 1Password app (Settings → Developer), then list the vaults. 1Password asks you to approve it on the computer that runs Tendly.') }}</p>
        <div><button type="button" class="small-button primary" :disabled="loading" @click="load(true)">{{ loading ? t('Waiting for 1Password…') : t('List vaults') }}</button></div>
      </div>

      <div v-else-if="state === 'signed_in'" class="vault-body">
        <p v-if="vault?.listed && !vault.vaults.length && !vault.error" class="vault-note">{{ t('This account sees no vault.') }}</p>
        <template v-else-if="vault?.vaults.length">
          <p class="vault-note">{{ t('{count} vaults this account can read:', { count: vault.vaults.length }) }}</p>
          <ul class="vault-names"><li v-for="name in vault.vaults" :key="name">{{ name }}</li></ul>
        </template>
      </div>

      <p class="vault-foot">{{ t('On a server without the 1Password app, use a service account: put its token in OP_SERVICE_ACCOUNT_TOKEN in the environment Tendly starts with (on the VPS, /etc/tendly/tendly.env). Tendly never stores the token and reads only the names of the vaults, never what is inside them.') }}</p>
    </div>
  </section>
</template>

<style scoped>
.vault { display: grid; gap: 6px; }
.vault h2 { margin: 6px 0 0; font-size: var(--text-sm); font-weight: 600; color: var(--muted); }
.vault-card { display: grid; gap: 10px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); }
.vault-head { display: flex; align-items: flex-start; gap: 12px; min-width: 0; flex-wrap: wrap; }
.vault-icon { flex: none; margin-top: 2px; color: var(--muted); }
.vault-text { flex: 1 1 12em; min-width: 0; display: grid; gap: 2px; }
.vault-text strong { display: flex; align-items: baseline; gap: 8px; color: var(--ink); font-weight: 600; }
.vault-version { color: var(--muted); font-family: var(--mono); font-size: var(--text-xs); font-weight: 400; }
.vault-note { margin: 0; color: var(--muted); font-size: var(--text-sm); overflow-wrap: anywhere; }
.vault-note code { padding: 1px 6px; border-radius: var(--radius-sm); background: var(--fill); color: var(--ink); font-family: var(--mono); font-size: var(--text-xs); }
.vault-tag { margin-left: 6px; padding: 0 6px; border-radius: var(--radius-full); background: var(--fill); color: var(--muted); font-size: var(--text-xs); }
.vault-pill { flex: none; padding: 2px 10px; border-radius: var(--radius-full); background: var(--fill); color: var(--muted); font-size: var(--text-xs); font-weight: 550; white-space: nowrap; }
.vault-pill.signed_in { background: var(--ok-soft); color: var(--ok); }
.vault-pill.signed_out { background: var(--warn-soft); color: var(--warn-ink); box-shadow: inset 0 0 0 1px var(--warn); }
.vault-card > .inline-error { margin: 0; }
.vault-body { display: grid; gap: 8px; }
.vault-link { color: var(--accent); font-weight: 600; text-decoration: underline; text-underline-offset: 2px; overflow-wrap: anywhere; }
.vault-link:hover { color: var(--accent-hover); }
.vault-names { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.vault-names li { padding: 2px 10px; border-radius: var(--radius-full); background: var(--fill); color: var(--ink); font-size: var(--text-sm); overflow-wrap: anywhere; }
.vault-foot { margin: 0; padding-top: 10px; border-top: 1px solid var(--line); color: var(--muted); font-size: var(--text-xs); }
@media (pointer: coarse) { .vault .small-button { min-height: 44px; } }
</style>
