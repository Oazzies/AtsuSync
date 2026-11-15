<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { AtsuSeriesState, DownloadJob, Link, LinkChapter, MangaBaka } from '@atsusync/shared';
import { api, useServerEvents } from '../api';
import Icon from './Icon.vue';

const props = defineProps<{ link: Link }>();
const emit = defineEmits<{ unlinked: []; updated: [] }>();

const chapters = ref<LinkChapter[]>([]);
const atsu = ref<AtsuSeriesState | null>(null);
const mangabaka = ref<MangaBaka | null>(null);
const jobs = ref<DownloadJob[]>([]);
const selected = ref(new Set<number>());
const showAll = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);

const visibleChapters = computed(() => {
  const list = showAll.value ? chapters.value : chapters.value.filter((c) => !c.onAtsu && c.state !== 'uploaded' && c.state !== 'skipped');
  return [...list].sort((a, b) => b.number - a.number);
});

const missingCount = computed(() => chapters.value.filter((c) => !c.onAtsu && c.state !== 'uploaded' && c.state !== 'skipped').length);
const readyJobs = computed(() => jobs.value.filter((j) => j.state === 'done'));

async function load() {
  error.value = null;
  try {
    const [detail, dl] = await Promise.all([api.link(props.link.id), api.downloads(props.link.id)]);
    chapters.value = detail.chapters;
    atsu.value = detail.atsu;
    mangabaka.value = detail.mangabaka ?? null;
    jobs.value = dl;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(load);
watch(() => props.link.id, load);

useServerEvents((ev) => {
  if (ev.type === 'job' && ev.job.linkId === props.link.id) {
    const idx = jobs.value.findIndex((j) => j.id === ev.job.id);
    if (idx >= 0) jobs.value[idx] = ev.job;
    else jobs.value.unshift(ev.job);
    if (ev.job.state === 'done' || ev.job.state === 'failed') void load();
  } else if ((ev.type === 'new_chapters' || ev.type === 'chapters_unlocked') && ev.linkId === props.link.id) {
    void load();
  }
});

function toggle(id: number) {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

function selectMissing() {
  selected.value = new Set(chapters.value.filter((c) => !c.onAtsu && !c.locked && (c.state === 'known' || c.state === 'pending')).map((c) => c.id));
}

async function checkNow() {
  busy.value = true;
  error.value = null;
  try {
    await api.checkLink(props.link.id);
    await load();
    emit('updated');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function downloadSelected() {
  if (!selected.value.size) return;
  busy.value = true;
  error.value = null;
  try {
    await api.download([...selected.value]);
    selected.value = new Set();
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function setSelectedState(state: 'skipped' | 'uploaded') {
  if (!selected.value.size) return;
  busy.value = true;
  error.value = null;
  try {
    await api.setChapterState([...selected.value], state);
    selected.value = new Set();
    await load();
    emit('updated');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function unlink() {
  busy.value = true;
  try {
    await api.deleteLink(props.link.id);
    emit('unlinked');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

const uploadUrl = computed(() => {
  const id = props.link.atsuMangaId ?? atsu.value?.mangaId;
  return id ? `https://atsu.moe/upload?manga=${encodeURIComponent(id)}` : 'https://atsu.moe/upload';
});
</script>

<template>
  <div class="as-card">
    <div class="as-row">
      <div style="min-width: 0">
        <div class="as-title" :title="link.seriesTitle">{{ link.seriesTitle }}</div>
        <div class="as-muted">
          {{ link.sourceName }} · {{ missingCount }} missing / {{ chapters.length }}
          <template v-if="mangabaka?.totalChapters != null"> · MB: {{ mangabaka.totalChapters }} ch</template>
        </div>
      </div>
      <div class="as-row-wrap">
        <button class="as-btn" :disabled="busy" @click="checkNow"><Icon name="refresh" /> Check</button>
        <button class="as-btn danger" :disabled="busy" @click="unlink"><Icon name="unlink" /> Unlink</button>
      </div>
    </div>

    <div v-if="error" class="as-error">{{ error }}</div>

    <div v-if="readyJobs.length" class="as-ok as-row">
      <span>{{ readyJobs.length }} ZIP{{ readyJobs.length === 1 ? '' : 's' }} ready</span>
      <a class="as-btn good" :href="uploadUrl"><Icon name="upload" /> Open Upload</a>
    </div>

    <div class="as-row">
      <div class="as-row-wrap">
        <button class="as-btn" @click="selectMissing">Select missing</button>
        <button class="as-btn" @click="showAll = !showAll">{{ showAll ? 'Missing only' : 'Show all' }}</button>
      </div>
      <span v-if="selected.size" class="as-muted">{{ selected.size }} selected</span>
    </div>

    <div v-if="selected.size" class="as-row-wrap">
      <button class="as-btn primary" :disabled="busy" @click="downloadSelected"><Icon name="download" /> Download</button>
      <button class="as-btn" :disabled="busy" @click="setSelectedState('skipped')">Skip</button>
      <button class="as-btn" :disabled="busy" @click="setSelectedState('uploaded')">Mark uploaded</button>
    </div>

    <div class="as-list">
      <div v-for="c in visibleChapters" :key="c.id" class="as-chap">
        <label>
          <input type="checkbox" :checked="selected.has(c.id)" @change="toggle(c.id)" />
          <span class="as-chap-name">{{ c.label }}</span>
        </label>
        <span v-if="c.locked" class="as-badge amber">locked</span>
        <span v-else-if="c.onAtsu" class="as-badge green">on atsu</span>
        <span v-else-if="c.state === 'downloaded'" class="as-badge indigo">zip ready</span>
        <span v-else-if="c.state === 'queued'" class="as-badge indigo">queued</span>
        <span v-else-if="c.state === 'uploaded'" class="as-badge green">uploaded</span>
        <span v-else-if="c.state === 'skipped'" class="as-badge">skipped</span>
      </div>
      <div v-if="!visibleChapters.length" class="as-muted" style="padding: 6px 2px">
        No missing chapters left.
      </div>
    </div>
  </div>
</template>
