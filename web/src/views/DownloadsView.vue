<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import { CheckCheck, ChevronDown, ChevronRight, Download, ExternalLink, RotateCcw, X } from 'lucide-vue-next';
import type { DownloadJob } from '@atsusync/shared';
import { api, fmtAgo, useServerEvents } from '@/api/client';
import PageHeader from '@/components/PageHeader.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';

const router = useRouter();
const jobs = ref<DownloadJob[]>([]);
const error = ref<string | null>(null);
const open = ref(new Set<number>());

async function load() {
  try {
    jobs.value = await api.downloads();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

useServerEvents((e) => {
  if (e.type !== 'job') return;
  const i = jobs.value.findIndex((j) => j.id === e.job.id);
  if (i === -1) jobs.value.unshift(e.job);
  else jobs.value[i] = e.job;
});

const active = (j: DownloadJob) => !['done', 'failed', 'cancelled'].includes(j.state);
const fmtSize = (bytes: number | null) => (bytes == null ? '' : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
function toggle(id: number) {
  const s = new Set(open.value);
  s.has(id) ? s.delete(id) : s.add(id);
  open.value = s;
}

async function markUploaded(j: DownloadJob) {
  try {
    await api.setChapterState([j.chapterId], 'uploaded');
    toast.success(`Marked ${j.seriesTitle} ${j.chapterLabel} as uploaded`);
  } catch (e) {
    toast.error((e as Error).message);
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      title="Downloads"
      description="Chapters are fetched from the source and saved as ZIPs. Download one, then add it on Atsumaru's upload page (“Add archive”) and submit it yourself."
    />
    <div v-if="error" class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{{ error }}</div>
    <Card v-if="!jobs.length">
      <CardContent class="py-10 text-center text-sm text-muted-foreground">Nothing downloaded yet. Pick chapters on a linked series.</CardContent>
    </Card>

    <div class="space-y-3">
      <Card v-for="j in jobs" :key="j.id" class="gap-3 py-4">
        <CardContent class="space-y-3">
          <div class="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="icon" class="size-7" @click="toggle(j.id)">
              <ChevronDown v-if="open.has(j.id)" class="size-4" /><ChevronRight v-else class="size-4" />
            </Button>
            <button class="font-medium hover:underline" @click="router.push(`/links/${j.linkId}`)">{{ j.seriesTitle }}</button>
            <span>{{ j.chapterLabel }}</span>
            <span class="text-xs text-muted-foreground">from {{ j.sourceName }}</span>
            <StatusBadge :status="j.state" />
            <span v-if="j.fileSize" class="text-xs text-muted-foreground">{{ fmtSize(j.fileSize) }}</span>
            <div class="flex-1" />
            <span class="text-xs text-muted-foreground">{{ fmtAgo(j.updatedAt) }}</span>
            <Button v-if="active(j)" variant="ghost" size="sm" @click="api.cancelDownload(j.id)"><X class="size-4" /> Cancel</Button>
            <Button v-if="j.state === 'failed' || j.state === 'cancelled'" variant="outline" size="sm" @click="api.retryDownload(j.id)">
              <RotateCcw class="size-4" /> Retry
            </Button>
            <template v-if="j.state === 'done'">
              <Button as="a" :href="j.uploadUrl" target="_blank" rel="noopener" variant="outline" size="sm">
                Atsumaru upload page <ExternalLink class="size-3" />
              </Button>
              <Button variant="outline" size="sm" title="After you submitted it on atsu.moe" @click="markUploaded(j)">
                <CheckCheck class="size-4" /> Mark uploaded
              </Button>
              <Button as="a" :href="api.downloadFileUrl(j.id)" download size="sm"><Download class="size-4" /> Download ZIP</Button>
            </template>
          </div>
          <div v-if="active(j) && j.total" class="flex items-center gap-3">
            <Progress :model-value="(j.progress / j.total) * 100" class="h-1.5" />
            <span class="text-xs text-muted-foreground tabular-nums">{{ j.progress }}/{{ j.total }}</span>
          </div>
          <p v-if="j.error" class="text-sm text-destructive">{{ j.error }}</p>
          <pre v-if="open.has(j.id)" class="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">{{ j.log.join('\n') }}</pre>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
