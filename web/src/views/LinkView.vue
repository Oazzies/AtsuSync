<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import { ArrowLeft, CheckCheck, ChevronDown, ChevronRight, Download, DownloadCloud, ExternalLink, Lock, Plus, RefreshCw, RotateCcw, SkipForward, Trash2, X } from 'lucide-vue-next';
import type { DownloadJob, LinkChapter } from '@atsusync/shared';
import { api, fmtAgo, fmtRanges, useAsync, useServerEvents } from '@/api/client';
import KindBadge from '@/components/KindBadge.vue';
import FetchFromOther from '@/components/FetchFromOther.vue';
import ManualChapter from '@/components/ManualChapter.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { tone } from '@/lib/tone';

const props = defineProps<{ id: number }>();
const emit = defineEmits<{ changed: [] }>();
const router = useRouter();

const { data, error, loading, run } = useAsync(() => api.link(props.id));
const selected = ref(new Set<number>());
const busy = ref(false);
const filter = ref<'missing' | 'all'>('missing');
const jobs = ref<DownloadJob[]>([]);
const openLogs = ref(new Set<number>());
const building = ref(false);
const fetching = ref(false);

const activeJob = (j: DownloadJob) => !['done', 'failed', 'cancelled'].includes(j.state);
const fmtSize = (bytes: number | null) => (bytes == null ? '' : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const readyJobs = computed(() => jobs.value.filter((j) => j.state === 'done'));
const activeCount = computed(() => jobs.value.filter(activeJob).length);
async function loadJobs() {
  try {
    jobs.value = await api.downloads(props.id);
  } catch (e) {
    toast.error((e as Error).message);
  }
}
function toggleLog(id: number) {
  const s = new Set(openLogs.value);
  s.has(id) ? s.delete(id) : s.add(id);
  openLogs.value = s;
}

const INTERVALS = [15, 30, 60, 120, 360, 720, 1440];
const fmtInterval = (m: number) => (m < 60 ? `${m} min` : `${m / 60} h`);

const link = computed(() => data.value?.link);
const chapters = computed(() => {
  const all = [...(data.value?.chapters ?? [])].reverse();
  return filter.value === 'missing' ? all.filter((c) => !c.onAtsu && c.state !== 'uploaded' && c.state !== 'skipped') : all;
});
const downloadable = (c: LinkChapter) => !c.locked && !c.url.startsWith('manual:') && !c.onAtsu && c.state !== 'queued' && c.state !== 'uploaded';
// Everything on this page that can still be fetched, whatever the current filter or selection.
const allDownloadable = computed(() => (data.value?.chapters ?? []).filter((c) => downloadable(c) && c.state !== 'skipped'));
const allSelected = computed(() => chapters.value.some(downloadable) && chapters.value.filter(downloadable).every((c) => selected.value.has(c.id)));

// Pre-select new chapters Atsumaru doesn't have yet.
watch(data, (d) => {
  selected.value = new Set((d?.chapters ?? []).filter((c) => c.state === 'pending' && downloadable(c)).map((c) => c.id));
});

function toggle(id: number, on: boolean) {
  const s = new Set(selected.value);
  on ? s.add(id) : s.delete(id);
  selected.value = s;
}
function toggleAll(on: boolean) {
  selected.value = on ? new Set(chapters.value.filter(downloadable).map((c) => c.id)) : new Set();
}

async function act(fn: () => Promise<unknown>) {
  busy.value = true;
  try {
    await fn();
    await run();
    emit('changed');
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    busy.value = false;
  }
}

const download = () =>
  act(async () => {
    const created = await api.download([...selected.value]);
    toast.success(`Downloading ${created.length} chapter(s)`);
    await loadJobs();
  });
const downloadAll = () =>
  act(async () => {
    const created = await api.download(allDownloadable.value.map((c) => c.id));
    toast.success(`Downloading ${created.length} chapter(s)`);
    await loadJobs();
  });
/** Trigger a browser download for every finished ZIP, one after another. */
async function saveAllReady() {
  for (const j of readyJobs.value) {
    const a = document.createElement('a');
    a.href = api.downloadFileUrl(j.id);
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
    await new Promise((r) => setTimeout(r, 400));
  }
}
const clearDownloads = () => {
  const n = jobs.value.filter((j) => !activeJob(j)).length;
  if (!confirm(`Delete ${n} finished download(s) and their ZIP files? Chapters marked uploaded stay uploaded.`)) return;
  return act(async () => {
    const r = await api.clearDownloads(props.id);
    toast.success(`Cleared ${r.jobs} download(s), deleted ${r.files} file(s)`);
    await loadJobs();
  });
};
async function fetchQueued() {
  await run();
  await loadJobs();
  emit('changed');
}
async function manualSaved() {
  building.value = false;
  await run();
  await loadJobs();
  emit('changed');
}
async function markJobUploaded(j: DownloadJob) {
  await act(() => api.setChapterState([j.chapterId], 'uploaded'));
  await loadJobs();
}
const markUploaded = () =>
  act(async () => {
    await api.setChapterState([...selected.value], 'uploaded');
    toast('Marked as uploaded');
  });
const skip = () => act(async () => {
  await api.setChapterState([...selected.value], 'skipped');
  toast('Marked as skipped');
});
const checkNow = () => act(async () => {
  const r = await api.checkLink(props.id);
  toast(r.added ? `${r.added} new chapter(s) found` : 'No new chapters');
});
const setWatch = (watch: boolean) => act(() => api.updateLink(props.id, { watch }));
const setInterval_ = (v: unknown) => act(() => api.updateLink(props.id, { checkIntervalMin: Number(v) }));
async function remove() {
  if (!confirm('Remove this link and its chapter history?')) return;
  const requestId = link.value?.requestId;
  await api.deleteLink(props.id);
  emit('changed');
  await router.push(requestId ? `/requests/${requestId}` : '/tracked');
}

useServerEvents((e) => {
  if (e.type === 'job' && e.job.linkId === props.id) {
    const i = jobs.value.findIndex((j) => j.id === e.job.id);
    if (i === -1) jobs.value.unshift(e.job);
    else jobs.value[i] = e.job;
  }
  const mine =
    (e.type === 'job' && e.job.linkId === props.id && ['done', 'failed', 'cancelled'].includes(e.job.state)) ||
    ((e.type === 'new_chapters' || e.type === 'chapters_unlocked') && e.linkId === props.id);
  if (mine) void run();
});

onMounted(() => {
  void run();
  void loadJobs();
});
</script>

<template>
  <div class="space-y-6">
    <Button
      v-if="link"
      variant="ghost"
      size="sm"
      class="-ml-2 text-muted-foreground"
      @click="router.push(`/requests/${link.requestId}`)"
    >
      <ArrowLeft class="size-4" /> {{ link.requestTitle }}
    </Button>
    <div v-if="error" class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{{ error }}</div>
    <Skeleton v-if="loading && !data" class="h-40 w-full" />

    <template v-if="link && data">
      <div class="flex flex-wrap items-start gap-4">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <h1 class="text-2xl font-semibold tracking-tight">{{ link.seriesTitle }}</h1>
            <KindBadge :kind="link.sourceKind" />
          </div>
          <p class="text-sm text-muted-foreground">
            {{ link.sourceName }} · checked {{ fmtAgo(link.lastCheckedAt) }}
            <span v-if="link.lastError" class="text-destructive"> · {{ link.lastError }}</span>
          </p>
        </div>
        <Button as="a" :href="link.seriesUrl" target="_blank" rel="noopener" variant="outline">
          Open on {{ link.sourceName }} <ExternalLink class="size-4" />
        </Button>
        <Button variant="outline" :disabled="busy" @click="checkNow"><RefreshCw class="size-4" /> Check now</Button>
        <Button variant="ghost" class="text-destructive" @click="remove"><Trash2 class="size-4" /> Unlink</Button>
      </div>

      <div class="grid gap-4 md:grid-cols-2">
        <Card class="py-4">
          <CardContent class="text-sm">
            <template v-if="data.atsu?.found">
              Atsumaru has <strong>{{ data.atsu.total }}</strong> chapters
              <span class="text-muted-foreground">({{ fmtRanges(data.atsu.ranges) || 'none' }})</span>;
              {{ link.sourceName }} has <strong>{{ data.chapters.length }}</strong>.
              <Badge v-if="data.atsu.waiting.length" variant="outline" :class="tone('warning')" class="ml-1">
                in review: {{ fmtRanges(data.atsu.waiting) }}
              </Badge>
            </template>
            <span v-else class="text-muted-foreground">
              {{ data.atsu?.error ?? 'Series not on Atsumaru yet' }}, so every chapter counts as missing.
            </span>
          </CardContent>
        </Card>
        <Card class="py-4">
          <CardContent class="flex flex-wrap items-center gap-3 text-sm">
            <Switch id="watch" :model-value="link.watch" @update:model-value="setWatch" />
            <Label for="watch" class="font-normal">Watch for new chapters every</Label>
            <Select :model-value="String(link.checkIntervalMin)" :disabled="!link.watch" @update:model-value="setInterval_">
              <SelectTrigger class="h-8 w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="m in INTERVALS" :key="m" :value="String(m)">{{ fmtInterval(m) }}</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      </div>

      <ManualChapter v-if="building" :link-id="id" @saved="manualSaved" @close="building = false" />

      <FetchFromOther v-if="fetching" :link-id="id" :series-title="link.seriesTitle" @queued="fetchQueued" @close="fetching = false" />

      <Card class="py-0">
        <div class="flex flex-wrap items-center gap-2 border-b p-3">
          <Tabs v-model="filter">
            <TabsList>
              <TabsTrigger value="missing">Missing on Atsumaru</TabsTrigger>
              <TabsTrigger value="all">All chapters</TabsTrigger>
            </TabsList>
          </Tabs>
          <div class="flex-1" />
          <Button variant="outline" size="sm" :disabled="fetching" @click="fetching = true"><DownloadCloud class="size-4" /> From another source</Button>
          <Button variant="outline" size="sm" :disabled="building" @click="building = true"><Plus class="size-4" /> Add chapter</Button>
          <Button variant="outline" size="sm" :disabled="busy || !allDownloadable.length" @click="downloadAll">
            <DownloadCloud class="size-4" /> Download all ({{ allDownloadable.length }})
          </Button>
          <span class="text-sm text-muted-foreground">{{ selected.size }} selected</span>
          <Button variant="outline" size="sm" :disabled="busy || !selected.size" @click="skip"><SkipForward class="size-4" /> Skip</Button>
          <Button variant="outline" size="sm" :disabled="busy || !selected.size" title="After you uploaded them on atsu.moe" @click="markUploaded">
            <CheckCheck class="size-4" /> Mark uploaded
          </Button>
          <Button size="sm" :disabled="busy || !selected.size" @click="download">
            <Download class="size-4" /> Download selected
          </Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="w-10 pl-4"><Checkbox :model-value="allSelected" @update:model-value="(v) => toggleAll(!!v)" /></TableHead>
              <TableHead>Chapter</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Atsumaru</TableHead>
              <TableHead>First seen</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="c in chapters" :key="c.id" :data-state="selected.has(c.id) ? 'selected' : undefined">
              <TableCell class="pl-4">
                <Checkbox :model-value="selected.has(c.id)" :disabled="!downloadable(c)" @update:model-value="(v) => toggle(c.id, !!v)" />
              </TableCell>
              <TableCell class="font-medium">
                {{ c.label }}
                <Badge v-if="c.locked" variant="outline" :class="tone('warning')" class="ml-1" title="Paid or early access on the source">
                  <Lock class="size-3" /> Locked
                </Badge>
              </TableCell>
              <TableCell><StatusBadge :status="c.state" /></TableCell>
              <TableCell>
                <Badge v-if="c.onAtsu" variant="outline" :class="tone('success')">Has it</Badge>
                <span v-else class="text-xs text-muted-foreground">missing</span>
              </TableCell>
              <TableCell class="text-xs text-muted-foreground">{{ fmtAgo(c.firstSeenAt) }}</TableCell>
              <TableCell class="text-right">
                <Button as="a" :href="c.url" target="_blank" rel="noopener" variant="ghost" size="sm">Read <ExternalLink class="size-3" /></Button>
              </TableCell>
            </TableRow>
            <TableRow v-if="!chapters.length">
              <TableCell colspan="6" class="py-10 text-center text-sm text-muted-foreground">
                Nothing missing. Atsumaru is up to date with this source.
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Card>

      <Card v-if="jobs.length" class="gap-0 py-0">
        <div class="flex flex-wrap items-center gap-2 border-b p-3">
          <h2 class="font-medium">Downloads</h2>
          <span v-if="activeCount" class="text-sm text-muted-foreground">{{ activeCount }} in progress</span>
          <div class="flex-1" />
          <Button v-if="jobs.length > activeCount" variant="outline" size="sm" :disabled="busy" @click="clearDownloads">
            <Trash2 class="size-4" /> Clear finished
          </Button>
          <Button v-if="readyJobs.length > 1" size="sm" @click="saveAllReady">
            <Download class="size-4" /> Save all ZIPs ({{ readyJobs.length }})
          </Button>
        </div>
        <div class="divide-y">
          <div v-for="j in jobs" :key="j.id" class="space-y-2 p-3">
            <div class="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="icon" class="size-7" @click="toggleLog(j.id)">
                <ChevronDown v-if="openLogs.has(j.id)" class="size-4" /><ChevronRight v-else class="size-4" />
              </Button>
              <span class="font-medium">{{ j.chapterLabel }}</span>
              <StatusBadge :status="j.state" />
              <span v-if="j.fileSize" class="text-xs text-muted-foreground">{{ fmtSize(j.fileSize) }}</span>
              <div class="flex-1" />
              <span class="text-xs text-muted-foreground">{{ fmtAgo(j.updatedAt) }}</span>
              <Button v-if="activeJob(j)" variant="ghost" size="sm" @click="api.cancelDownload(j.id)"><X class="size-4" /> Cancel</Button>
              <Button v-if="j.state === 'failed' || j.state === 'cancelled'" variant="outline" size="sm" @click="api.retryDownload(j.id)">
                <RotateCcw class="size-4" /> Retry
              </Button>
              <template v-if="j.state === 'done'">
                <Button as="a" :href="j.uploadUrl" target="_blank" rel="noopener" variant="outline" size="sm">
                  Atsumaru upload page <ExternalLink class="size-3" />
                </Button>
                <Button variant="outline" size="sm" title="After you submitted it on atsu.moe" @click="markJobUploaded(j)">
                  <CheckCheck class="size-4" /> Mark uploaded
                </Button>
                <Button as="a" :href="api.downloadFileUrl(j.id)" download size="sm"><Download class="size-4" /> ZIP</Button>
              </template>
            </div>
            <div v-if="activeJob(j) && j.total" class="flex items-center gap-3">
              <Progress :model-value="(j.progress / j.total) * 100" class="h-1.5" />
              <span class="text-xs text-muted-foreground tabular-nums">{{ j.progress }}/{{ j.total }}</span>
            </div>
            <p v-if="j.error" class="text-sm text-destructive">{{ j.error }}</p>
            <pre v-if="openLogs.has(j.id)" class="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">{{ j.log.join('\n') }}</pre>
          </div>
        </div>
      </Card>
    </template>
  </div>
</template>
