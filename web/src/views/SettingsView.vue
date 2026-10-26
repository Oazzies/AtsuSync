<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { SettingsView } from '@atsusync/shared';
import { api } from '../api/client';

const emit = defineEmits<{ changed: [] }>();
const s = ref<SettingsView | null>(null);
const cookie = ref('');
const msg = ref<string | null>(null);
const saving = ref(false);
const groups = ref<{ id: string; name: string }[]>([]);
const canPublish = ref<boolean | null>(null);

async function load() {
  s.value = await api.settings();
  if (s.value.atsuUser) {
    const g = await api.atsuGroups().catch(() => null);
    groups.value = g?.groups ?? [];
    canPublish.value = g?.canPublish ?? null;
  }
}

async function save() {
  if (!s.value) return;
  saving.value = true;
  msg.value = null;
  try {
    s.value = await api.saveSettings({
      dryRun: s.value.dryRun,
      defaultCheckIntervalMin: Number(s.value.defaultCheckIntervalMin),
      atsuGroupId: s.value.atsuGroupId,
      ...(cookie.value.trim() ? { atsuCookie: cookie.value.trim() } : {}),
    });
    cookie.value = '';
    msg.value = 'Saved.';
    await load();
    emit('changed');
  } catch (e) {
    msg.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

async function clearCookie() {
  s.value = await api.saveSettings({ atsuCookie: '' });
}

onMounted(load);
</script>

<template>
  <div v-if="s" class="stack" style="max-width: 720px">
    <h1>Settings</h1>

    <div class="panel stack">
      <h2>Atsumaru session</h2>
      <div class="row">
        <span v-if="s.atsuUser" class="badge ok">Logged in as {{ s.atsuUser }}</span>
        <span v-else-if="s.atsuCookieSet" class="badge err">Cookie set but not accepted — it may have expired</span>
        <span v-else class="badge warn">Not set</span>
        <button v-if="s.atsuCookieSet" class="ghost danger" @click="clearCookie">Clear</button>
      </div>
      <div class="muted small">
        Log in on atsu.moe in your browser, open DevTools → Network, click any <code>/api/</code> request and copy the whole
        <code>cookie</code> request header. It is stored only in the local database and never shown again here.
      </div>
      <textarea v-model="cookie" rows="3" placeholder="Paste cookie header…" />
    </div>

    <div class="panel stack">
      <h2>Uploading</h2>
      <label class="row">
        <input v-model="s.dryRun" type="checkbox" />
        <span><strong>Dry run</strong> — download and hash pages, but don't send anything to Atsumaru.</span>
      </label>
      <label class="stack" style="gap: 4px">
        <span class="small muted">Upload as</span>
        <select v-model="s.atsuGroupId">
          <option value="">Just me</option>
          <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
        </select>
        <span v-if="!s.atsuUser" class="small muted">Set the cookie first to load your Atsumaru groups.</span>
        <span v-else-if="canPublish === false" class="small muted">Your uploads go to Atsumaru's review queue before they're published.</span>
      </label>
      <label class="stack" style="gap: 4px">
        <span class="small muted">Default check interval for new links</span>
        <select v-model.number="s.defaultCheckIntervalMin">
          <option v-for="m in [15, 30, 60, 120, 360, 720, 1440]" :key="m" :value="m">{{ m < 60 ? `${m} min` : `${m / 60} h` }}</option>
        </select>
      </label>
    </div>

    <div class="row">
      <button class="primary" :disabled="saving" @click="save">Save</button>
      <span v-if="msg" class="small">{{ msg }}</span>
    </div>
  </div>
</template>
