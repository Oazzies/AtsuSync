<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { AtsuSeriesState, DownloadJob, Link, LinkChapter, MangaBaka } from '@atsusync/shared';
import { api, useServerEvents } from '../api';
import Icon from './Icon.vue';
import { attachJobsToUploadPage, downloadJobToDisk } from './uploadHelpers';

const props = defineProps<{ link: Link; isUploadPage?: boolean }>();
const emit = defineEmits<{ unlinked: []; updated: [] }>();

const chapters = ref<LinkChapter[]>([]);
const atsu = ref<AtsuSeriesState | null>(null);
const mangabaka = ref<MangaBaka | null>(null);
const jobs = ref<DownloadJob[]>([]);
const selected = ref(new Set<number>());
const showAll = ref(false);
const autoUpload = ref(false);
let attachingAuto = false;
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const visibleChapters = computed(() => {
  const list = showAll.value ? chapters.value : chapters.value.filter((c) => !c.onAtsu && c.state !== 'uploaded' && c.state !== 'skipped');
  return [...list].sort((a, b) => b.number - a.number);
});

const missingCount = computed(() => chapters.value.filter((c) => !c.onAtsu && c.state !== 'uploaded' && c.state !== 'skipped').length);
const activeJobs = computed(() => jobs.value.filter((j) => j.state === 'queued' || j.state === 'downloading'));
const readyJobs = computed(() => jobs.value.filter((j) => j.state === 'done'));

function formatSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

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
watch(() => props.link.id, () => {
  autoUpload.value = false;
  notice.value = null;
  void load();
});

watch(autoUpload, (on) => {
  if (on) void maybeAutoAttach();
});

useServerEvents((ev) => {
  if (ev.type === 'job' && ev.job.linkId === props.link.id) {
    const idx = jobs.value.findIndex((j) => j.id === ev.job.id);
    if (idx >= 0) jobs.value[idx] = ev.job;
    else jobs.value.unshift(ev.job);
    if (ev.job.state === 'done' || ev.job.state === 'failed') {
      void load().then(() => {
        if (ev.job.state === 'done') void maybeAutoAttach();
      });
    }
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
  notice.value = null;
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
  notice.value = null;
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

async function skipSelected() {
  if (!selected.value.size) return;
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    await api.setChapterState([...selected.value], 'skipped');
    selected.value = new Set();
    await load();
    emit('updated');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function attachOneReady(job: DownloadJob) {
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    await attachJobsToUploadPage([job]);
    jobs.value = jobs.value.filter((j) => j.id !== job.id);
    notice.value = `Attached ${job.chapterLabel} to page`;
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function attachAllReady() {
  const list = [...readyJobs.value];
  if (!list.length || attachingAuto) return;
  attachingAuto = true;
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    const attachedIds = new Set(await attachJobsToUploadPage(list));
    jobs.value = jobs.value.filter((j) => !attachedIds.has(j.id));
    notice.value = `Attached ${attachedIds.size} file${attachedIds.size === 1 ? '' : 's'} to page`;
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
    attachingAuto = false;
  }
}

async function maybeAutoAttach() {
  if (!autoUpload.value || !props.isUploadPage) return;
  if (readyJobs.value.length > 0 && activeJobs.value.length === 0) {
    await attachAllReady();
  }
}

async function saveReady(job: DownloadJob) {
  busy.value = true;
  error.value = null;
  try {
    await downloadJobToDisk(job);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function removeReady(job: DownloadJob) {
  busy.value = true;
  error.value = null;
  try {
    await api.deleteDownload(job.id);
    jobs.value = jobs.value.filter((j) => j.id !== job.id);
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function clearReady() {
  busy.value = true;
  error.value = null;
  try {
    await api.clearDownloads(props.link.id);
    await load();
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
  if (id) return `https://atsu.moe/upload?manga=${encodeURIComponent(id)}`;
  const mbId = mangabaka.value?.id;
  if (mbId) return `https://atsu.moe/upload?mb=${encodeURIComponent(String(mbId))}`;
  return 'https://atsu.moe/upload';
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
    <div v-if="notice" class="as-ok">{{ notice }}</div>

    <!-- Per-link Ready Downloads / Upload space -->
    <div v-if="readyJobs.length || activeJobs.length" class="as-card" style="background: var(--slate3); padding: 10px; gap: 8px">
      <div class="as-row">
        <span class="as-title" style="font-size: 13px">Ready to Upload ({{ readyJobs.length }})</span>
        <div class="as-row-wrap">
          <button v-if="isUploadPage && readyJobs.length > 0" class="as-btn primary sm" :disabled="busy" @click="attachAllReady">
            <Icon name="upload" /> Attach All
          </button>
          <a v-else-if="readyJobs.length > 0" class="as-btn good sm" :href="uploadUrl"><Icon name="upload" /> Open Upload</a>
          <button v-if="readyJobs.length > 0" class="as-btn sm" :disabled="busy" title="Clear ready downloads for this source" @click="clearReady">
            Clear
          </button>
        </div>
      </div>

      <label v-if="isUploadPage" class="as-check-label">
        <input v-model="autoUpload" type="checkbox" />
        <span>Upload when downloaded</span>
      </label>

      <div v-if="activeJobs.length" class="as-muted">
        Downloading {{ activeJobs.length }} chapter{{ activeJobs.length === 1 ? '' : 's' }}…
      </div>

      <div v-if="readyJobs.length" class="as-list" style="max-height: 180px">
        <div v-for="j in readyJobs" :key="j.id" class="as-chap" style="padding: 6px 8px">
          <div style="min-width: 0; flex: 1">
            <div class="as-chap-name" :title="j.chapterLabel">{{ j.chapterLabel }}</div>
            <div v-if="formatSize(j.fileSize)" class="as-muted">{{ formatSize(j.fileSize) }}</div>
          </div>
          <div class="as-row-wrap">
            <button v-if="isUploadPage" class="as-btn primary sm" :disabled="busy" @click="attachOneReady(j)">
              <Icon name="upload" /> Attach
            </button>
            <button class="as-btn sm" :disabled="busy" title="Save file to disk" @click="saveReady(j)">
              <Icon name="download" /> Save
            </button>
            <button class="as-btn icon sm" :disabled="busy" title="Remove" aria-label="Remove" @click="removeReady(j)">
              <Icon name="x" />
            </button>
          </div>
        </div>
      </div>
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
      <button class="as-btn" :disabled="busy" @click="skipSelected">Skip</button>
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
