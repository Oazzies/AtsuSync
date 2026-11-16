<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { AtsuSeriesState, DownloadJob, Link, LinkChapter, MangaBaka } from '@atsusync/shared';
import { api, useServerEvents } from '../api';
import AlertBanner from './AlertBanner.vue';
import Icon from './Icon.vue';
import { attachJobsToUploadPage, downloadJobToDisk } from './uploadHelpers';

const props = defineProps<{ link: Link; isUploadPage?: boolean }>();
const emit = defineEmits<{ unlinked: [id: number]; updated: [] }>();

const chapters = ref<LinkChapter[]>([]);
const atsu = ref<AtsuSeriesState | null>(null);
const mangabaka = ref<MangaBaka | null>(null);
const jobs = ref<DownloadJob[]>([]);
const selected = ref(new Set<number>());
const lastClickedId = ref<number | null>(null);
const showAll = ref(false);
const sectionCollapsed = ref(false);
const downloadsCollapsed = ref(false);
const autoUpload = ref(false);
let attachingAuto = false;
const busy = ref(false);
const loading = ref(true);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

watch(notice, (val) => {
  if (noticeTimer) {
    clearTimeout(noticeTimer);
    noticeTimer = null;
  }
  if (val) {
    noticeTimer = setTimeout(() => {
      notice.value = null;
      noticeTimer = null;
    }, 4500);
  }
});

const visibleChapters = computed(() => {
  const list = showAll.value ? chapters.value : chapters.value.filter((c) => !c.onAtsu && c.state !== 'uploaded' && c.state !== 'skipped');
  return [...list].sort((a, b) => b.number - a.number);
});

const missingCount = computed(() => chapters.value.filter((c) => !c.onAtsu && c.state !== 'uploaded' && c.state !== 'skipped').length);
const allVisibleSelected = computed(
  () => visibleChapters.value.length > 0 && visibleChapters.value.every((c) => selected.value.has(c.id)),
);
const activeJobs = computed(() =>
  jobs.value
    .filter((j) => j.state === 'queued' || j.state === 'downloading')
    .sort((a, b) => (a.state === b.state ? a.id - b.id : a.state === 'downloading' ? -1 : 1)),
);
const downloadingCount = computed(() => activeJobs.value.filter((j) => j.state === 'downloading').length);
const queuedCount = computed(() => activeJobs.value.filter((j) => j.state === 'queued').length);
const readyJobs = computed(() => jobs.value.filter((j) => j.state === 'done'));
const failedJobs = computed(() => jobs.value.filter((j) => j.state === 'failed'));
const jobByChapter = computed(() => {
  const map = new Map<number, DownloadJob>();
  for (const j of jobs.value) {
    if (!map.has(j.chapterId)) map.set(j.chapterId, j);
  }
  return map;
});

function jobPercent(j: DownloadJob): number {
  if (j.total <= 0) return 0;
  return Math.min(100, Math.round((j.progress / j.total) * 100));
}

function latestLog(j: DownloadJob): string {
  const last = j.log[j.log.length - 1];
  if (last) return last.replace(/^\d{2}:\d{2}:\d{2}\s+/, '');
  return j.state === 'queued' ? 'Waiting in queue…' : 'Starting…';
}

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
    if (selected.value.size > 0) {
      const validIds = new Set(detail.chapters.map((c) => c.id));
      selected.value = new Set([...selected.value].filter((id) => validIds.has(id)));
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => props.link.id, () => {
  autoUpload.value = false;
  sectionCollapsed.value = false;
  downloadsCollapsed.value = false;
  selected.value = new Set();
  lastClickedId.value = null;
  notice.value = null;
  loading.value = true;
  void load();
});

watch(autoUpload, (on) => {
  if (on) void maybeAutoAttach();
});

async function refreshDownloads() {
  try {
    jobs.value = await api.downloads(props.link.id);
  } catch {
    /* ignore transient refresh errors */
  }
}

useServerEvents((ev) => {
  if (ev.type === 'job' && ev.job.linkId === props.link.id) {
    const idx = jobs.value.findIndex((j) => j.id === ev.job.id);
    if (idx >= 0) jobs.value[idx] = ev.job;
    else jobs.value.unshift(ev.job);
    if (ev.job.state === 'done') {
      const ch = chapters.value.find((c) => c.id === ev.job.chapterId);
      if (ch) ch.state = 'downloaded';
      void refreshDownloads().then(() => maybeAutoAttach());
    } else if (ev.job.state === 'failed' || ev.job.state === 'cancelled') {
      void load();
    }
  } else if ((ev.type === 'new_chapters' || ev.type === 'chapters_unlocked') && ev.linkId === props.link.id) {
    void load();
  }
});

function onLabelMouseDown(event: MouseEvent) {
  if (event.shiftKey) event.preventDefault();
}

function toggleChapter(id: number, event: MouseEvent) {
  const next = new Set(selected.value);
  const shouldSelect = !next.has(id);

  if (event.shiftKey && lastClickedId.value !== null) {
    const list = visibleChapters.value;
    const start = list.findIndex((c) => c.id === lastClickedId.value);
    const end = list.findIndex((c) => c.id === id);
    if (start !== -1 && end !== -1) {
      const [from, to] = start < end ? [start, end] : [end, start];
      for (let i = from; i <= to; i++) {
        const item = list[i];
        if (!item) continue;
        if (shouldSelect) next.add(item.id);
        else next.delete(item.id);
      }
      selected.value = next;
      lastClickedId.value = id;
      return;
    }
  }

  if (shouldSelect) next.add(id);
  else next.delete(id);
  selected.value = next;
  lastClickedId.value = id;
}

function selectMissing() {
  selected.value = new Set(chapters.value.filter((c) => !c.onAtsu && !c.locked && (c.state === 'known' || c.state === 'pending')).map((c) => c.id));
  lastClickedId.value = null;
}

function toggleSelectAll() {
  if (allVisibleSelected.value) {
    selected.value = new Set();
  } else {
    selected.value = new Set(visibleChapters.value.map((c) => c.id));
  }
  lastClickedId.value = null;
}

function clearSelection() {
  selected.value = new Set();
  lastClickedId.value = null;
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

async function cancelJob(job: DownloadJob) {
  busy.value = true;
  error.value = null;
  try {
    await api.cancelDownload(job.id);
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function cancelAllActive() {
  const list = [...activeJobs.value];
  if (!list.length) return;
  busy.value = true;
  error.value = null;
  try {
    await Promise.all(list.map((j) => api.cancelDownload(j.id)));
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function retryJob(job: DownloadJob) {
  busy.value = true;
  error.value = null;
  try {
    await api.retryDownload(job.id);
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function retryAllFailed() {
  const list = [...failedJobs.value];
  if (!list.length) return;
  busy.value = true;
  error.value = null;
  try {
    await Promise.all(list.map((j) => api.retryDownload(j.id)));
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
    emit('unlinked', props.link.id);
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
    <div class="as-row" style="align-items: flex-start">
      <div style="min-width: 0; flex: 1">
        <div class="as-title" :title="link.seriesTitle">{{ link.seriesTitle }}</div>
        <div class="as-muted">
          {{ link.sourceName }} · {{ missingCount }} missing / {{ chapters.length }}
          <template v-if="mangabaka?.totalChapters != null"> · MB: {{ mangabaka.totalChapters }} ch</template>
        </div>
      </div>
      <button
        class="as-icon-btn"
        :title="sectionCollapsed ? 'Expand' : 'Collapse'"
        :aria-label="sectionCollapsed ? 'Expand' : 'Collapse'"
        :aria-expanded="!sectionCollapsed"
        @click="sectionCollapsed = !sectionCollapsed"
      >
        <Icon name="chevronDown" class="as-chevron" :class="{ open: !sectionCollapsed }" />
      </button>
    </div>

    <template v-if="!sectionCollapsed">
    <div class="as-row-wrap">
      <button class="as-btn sm" :disabled="busy" @click="checkNow"><Icon name="refresh" /> Check</button>
      <button class="as-btn danger sm" :disabled="busy" @click="unlink"><Icon name="unlink" /> Unlink</button>
    </div>
    <AlertBanner v-if="error" kind="error" dismissible :message="error" @dismiss="error = null" />
    <AlertBanner v-if="notice" kind="ok" dismissible :message="notice" @dismiss="notice = null" />

    <!-- Per-link Downloads / Ready to Upload space -->
    <div v-if="readyJobs.length || activeJobs.length || failedJobs.length" class="as-subcard">
      <div class="as-row" style="align-items: flex-start">
        <span class="as-title" style="font-size: 13px; flex: 1; min-width: 0">
          <template v-if="readyJobs.length || !activeJobs.length">Ready to Upload ({{ readyJobs.length }})</template>
          <template v-else>Downloads ({{ activeJobs.length }})</template>
        </span>
        <button
          class="as-icon-btn"
          :title="downloadsCollapsed ? 'Expand' : 'Collapse'"
          :aria-label="downloadsCollapsed ? 'Expand' : 'Collapse'"
          :aria-expanded="!downloadsCollapsed"
          @click="downloadsCollapsed = !downloadsCollapsed"
        >
          <Icon name="chevronDown" class="as-chevron" :class="{ open: !downloadsCollapsed }" />
        </button>
      </div>

      <template v-if="!downloadsCollapsed">
      <div v-if="readyJobs.length > 0 || activeJobs.length > 0 || failedJobs.length > 0" class="as-row-wrap">
        <button v-if="isUploadPage && readyJobs.length > 0" class="as-btn primary sm" :disabled="busy" @click="attachAllReady">
          <Icon name="upload" /> Attach All
        </button>
        <a v-else-if="readyJobs.length > 0" class="as-btn good sm" :href="uploadUrl"><Icon name="upload" /> Open Upload</a>
        <button v-if="activeJobs.length > 0" class="as-btn sm" :disabled="busy" title="Cancel all active downloads for this source" @click="cancelAllActive">
          Cancel All
        </button>
        <button v-if="readyJobs.length > 0 || failedJobs.length > 0" class="as-btn sm" :disabled="busy" title="Clear finished and failed downloads for this source" @click="clearReady">
          Clear
        </button>
      </div>
      <label v-if="isUploadPage" class="as-check-label">
        <input v-model="autoUpload" type="checkbox" />
        <span>Upload when downloaded</span>
      </label>

      <div v-if="activeJobs.length" style="display: flex; flex-direction: column; gap: 6px">
        <div class="as-muted">
          <template v-if="downloadingCount">{{ downloadingCount }} downloading</template>
          <template v-if="downloadingCount && queuedCount"> · </template>
          <template v-if="queuedCount">{{ queuedCount }} queued</template>
        </div>
        <div v-if="loading && chapters.length === 0" class="as-list" aria-busy="true" aria-label="Loading chapters">
      <div v-for="n in 4" :key="`skel-ch-${n}`" class="as-chap" aria-hidden="true">
        <div class="as-skel" style="width: 16px; height: 16px; border-radius: 4px" />
        <div class="as-skel as-skel-line" :style="{ width: `${55 + (n % 3) * 14}%` }" />
        <div class="as-skel as-skel-pill" style="margin-left: auto; width: 48px" />
      </div>
    </div>

    <div v-else class="as-list">
          <div v-for="j in activeJobs" :key="j.id" class="as-job">
            <div class="as-row" style="gap: 6px">
              <span class="as-chap-name" :title="j.chapterLabel">{{ j.chapterLabel }}</span>
              <div class="as-row-wrap" style="gap: 6px; flex-shrink: 0">
                <span class="as-muted" style="font-variant-numeric: tabular-nums">
                  <template v-if="j.state === 'downloading' && j.total > 0">{{ j.progress }}/{{ j.total }} ({{ jobPercent(j) }}%)</template>
                  <template v-else-if="j.state === 'downloading'">Resolving…</template>
                  <template v-else>Queued</template>
                </span>
                <button class="as-btn icon sm" :disabled="busy" title="Cancel download" aria-label="Cancel download" @click="cancelJob(j)">
                  <Icon name="x" />
                </button>
              </div>
            </div>
            <div v-if="j.state === 'downloading'" class="as-progress">
              <div class="as-progress-bar" :class="{ indeterminate: j.total <= 0 }" :style="j.total > 0 ? { width: `${jobPercent(j)}%` } : undefined" />
            </div>
            <div class="as-job-log" :title="latestLog(j)">{{ latestLog(j) }}</div>
          </div>
        </div>
      </div>

      <div v-if="failedJobs.length" style="display: flex; flex-direction: column; gap: 6px">
        <div class="as-row">
          <span class="as-muted" style="color: var(--red)">Failed ({{ failedJobs.length }})</span>
          <button v-if="failedJobs.length > 1" class="as-btn sm" :disabled="busy" @click="retryAllFailed">
            <Icon name="refresh" /> Retry All
          </button>
        </div>
        <div v-if="loading && chapters.length === 0" class="as-list" aria-busy="true" aria-label="Loading chapters">
      <div v-for="n in 4" :key="`skel-ch-${n}`" class="as-chap" aria-hidden="true">
        <div class="as-skel" style="width: 16px; height: 16px; border-radius: 4px" />
        <div class="as-skel as-skel-line" :style="{ width: `${55 + (n % 3) * 14}%` }" />
        <div class="as-skel as-skel-pill" style="margin-left: auto; width: 48px" />
      </div>
    </div>

    <div v-else class="as-list">
          <div v-for="j in failedJobs" :key="j.id" class="as-job">
            <div class="as-row" style="gap: 6px">
              <span class="as-chap-name" :title="j.chapterLabel">{{ j.chapterLabel }}</span>
              <div class="as-row-wrap" style="gap: 4px; flex-shrink: 0">
                <button class="as-btn sm" :disabled="busy" title="Retry download" @click="retryJob(j)">
                  <Icon name="refresh" /> Retry
                </button>
                <button class="as-btn icon sm" :disabled="busy" title="Dismiss" aria-label="Dismiss" @click="removeReady(j)">
                  <Icon name="x" />
                </button>
              </div>
            </div>
            <div class="as-job-error">{{ j.error || 'Download failed' }}</div>
          </div>
        </div>
      </div>

      <div v-if="readyJobs.length" class="as-list">
        <div v-for="j in readyJobs" :key="j.id" class="as-chap" style="padding: 6px 8px; flex-wrap: wrap">
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
      </template>
    </div>

    <div class="as-subcard">
      <div class="as-row">
        <span class="as-title" style="font-size: 13px">
          <template v-if="loading && chapters.length === 0">Chapters</template>
          <template v-else>{{ showAll ? `All chapters (${chapters.length})` : `Missing (${missingCount})` }}</template>
          <span v-if="selected.size" class="as-muted" style="font-weight: 400"> · {{ selected.size }} selected</span>
        </span>
        <button v-if="chapters.length > missingCount || showAll" class="as-btn ghost sm" @click="showAll = !showAll">
          {{ showAll ? 'Missing only' : `Show all (${chapters.length})` }}
        </button>
      </div>

      <div v-if="visibleChapters.length > 0 || selected.size > 0" class="as-chap-toolbar">
        <div class="as-row-wrap" style="gap: 4px">
          <button class="as-btn sm" @click="selectMissing">Select missing</button>
          <button v-if="visibleChapters.length > 0" class="as-btn sm" @click="toggleSelectAll">
            {{ allVisibleSelected ? 'Deselect all' : 'Select all' }}
          </button>
          <button v-if="selected.size && !allVisibleSelected" class="as-btn ghost sm" @click="clearSelection">Clear</button>
        </div>
        <div class="as-row-wrap" style="gap: 4px; margin-left: auto">
          <button class="as-btn sm" :disabled="busy || !selected.size" @click="skipSelected">Skip</button>
          <button class="as-btn primary sm" :disabled="busy || !selected.size" @click="downloadSelected"><Icon name="download" /> Download</button>
        </div>
      </div>

      <div v-if="loading && chapters.length === 0" class="as-list" aria-busy="true" aria-label="Loading chapters">
        <div v-for="n in 4" :key="`skel-ch-${n}`" class="as-chap" aria-hidden="true">
          <div class="as-skel" style="width: 16px; height: 16px; border-radius: 4px" />
          <div class="as-skel as-skel-line" :style="{ width: `${55 + (n % 3) * 14}%` }" />
          <div class="as-skel as-skel-pill" style="margin-left: auto; width: 48px" />
        </div>
      </div>

      <div v-else class="as-list">
        <div
          v-for="c in visibleChapters"
          :key="c.id"
          class="as-chap"
          title="Tip: Shift+click to select a range"
        >
          <label @mousedown="onLabelMouseDown">
            <input type="checkbox" :checked="selected.has(c.id)" @click="toggleChapter(c.id, $event)" />
            <span class="as-chap-name">{{ c.label }}</span>
          </label>
          <span v-if="c.locked" class="as-badge amber">locked</span>
          <span v-else-if="c.onAtsu" class="as-badge green">on atsu</span>
          <span v-else-if="c.state === 'downloaded'" class="as-badge indigo">zip ready</span>
          <span v-else-if="jobByChapter.get(c.id)?.state === 'downloading'" class="as-badge indigo">
            {{ jobByChapter.get(c.id)!.total > 0 ? `${jobByChapter.get(c.id)!.progress}/${jobByChapter.get(c.id)!.total}` : 'resolving…' }}
          </span>
          <span v-else-if="c.state === 'queued'" class="as-badge indigo">queued</span>
          <span v-else-if="c.state === 'uploaded'" class="as-badge green">uploaded</span>
          <span v-else-if="c.state === 'skipped'" class="as-badge">skipped</span>
          <span v-else-if="jobByChapter.get(c.id)?.state === 'failed'" class="as-badge red" :title="jobByChapter.get(c.id)?.error ?? 'Failed'">failed</span>
        </div>
        <div v-if="!visibleChapters.length" class="as-muted" style="padding: 4px 2px">
          {{ showAll ? 'No chapters found.' : 'No missing chapters left.' }}
        </div>
      </div>
    </div>
    </template>
  </div>
</template>
