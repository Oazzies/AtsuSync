<script setup lang="ts">
import { computed, ref } from 'vue';
import { toast } from 'vue-sonner';
import { Download, Loader2, Search, X } from 'lucide-vue-next';
import type { SourceSeriesHit } from '@atsusync/shared';
import { api } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';

const props = defineProps<{ linkId: number; seriesTitle: string }>();
const emit = defineEmits<{ queued: []; close: [] }>();

type Other = Awaited<ReturnType<typeof api.otherSeries>>;

const query = ref(props.seriesTitle);
const pasted = ref('');
const results = ref<Awaited<ReturnType<typeof api.searchOtherSources>>>([]);
const searching = ref(false);
const loading = ref(false);
const other = ref<Other | null>(null);
const selected = ref(new Set<number>());
const numbersText = ref('');
const busy = ref(false);

const chapters = computed(() => [...(other.value?.chapters ?? [])].reverse());

async function search() {
  searching.value = true;
  try {
    results.value = await api.searchOtherSources(props.linkId, query.value.trim() || undefined);
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    searching.value = false;
  }
}

async function open(url: string) {
  loading.value = true;
  try {
    other.value = await api.otherSeries(props.linkId, url);
    selected.value = new Set();
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    loading.value = false;
  }
}
const pick = (h: SourceSeriesHit) => open(h.url);

function toggle(n: number, on: boolean) {
  const s = new Set(selected.value);
  on ? s.add(n) : s.delete(n);
  selected.value = s;
}

/** "12, 45-47" → select those chapter numbers (only ones the other site has). */
function applyNumbers() {
  const have = new Set(other.value?.chapters.map((c) => c.number));
  const s = new Set(selected.value);
  for (const part of numbersText.value.split(/[,\s]+/).filter(Boolean)) {
    const [a, b] = part.split('-').map(Number);
    if (a === undefined || !Number.isFinite(a)) continue;
    const hi = b !== undefined && Number.isFinite(b) ? b : a;
    for (const c of have) if (c >= a && c <= hi) s.add(c);
  }
  selected.value = s;
  numbersText.value = '';
}

async function download() {
  if (!other.value || !selected.value.size) return;
  busy.value = true;
  try {
    const jobs = await api.fetchFrom(props.linkId, other.value.url, [...selected.value]);
    toast.success(`Downloading ${jobs.length} chapter(s) from ${other.value.sourceName}`);
    emit('queued');
    other.value = null;
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Card class="gap-3 p-4">
    <div class="flex items-center gap-2">
      <h2 class="font-medium">Download from another source</h2>
      <span class="text-xs text-muted-foreground">Fetches chapters without linking that site; they replace the chapter on this link.</span>
      <div class="flex-1" />
      <Button variant="ghost" size="icon" class="size-7" @click="emit('close')"><X class="size-4" /></Button>
    </div>

    <template v-if="!other">
      <form class="flex flex-wrap gap-2" @submit.prevent="search">
        <Input v-model="query" class="min-w-48 flex-1" placeholder="Series title" />
        <Button type="submit" variant="outline" :disabled="searching">
          <Loader2 v-if="searching" class="size-4 animate-spin" /><Search v-else class="size-4" /> Search sources
        </Button>
      </form>
      <form class="flex flex-wrap gap-2" @submit.prevent="pasted.trim() && open(pasted.trim())">
        <Input v-model="pasted" class="min-w-48 flex-1" placeholder="…or paste a series URL from any supported site" />
        <Button type="submit" variant="outline" :disabled="loading || !pasted.trim()">Open</Button>
      </form>
      <div v-for="r in results" :key="r.sourceId" class="text-sm">
        <div class="font-medium">{{ r.sourceName }}</div>
        <p v-if="r.error" class="text-destructive">{{ r.error }}</p>
        <p v-else-if="!r.hits.length" class="text-muted-foreground">No results</p>
        <ul v-else class="mt-1 space-y-1">
          <li v-for="h in r.hits" :key="h.url">
            <button class="text-left hover:underline" :disabled="loading" @click="pick(h)">{{ h.title }}</button>
          </li>
        </ul>
      </div>
    </template>

    <template v-else>
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-medium">{{ other.title }}</span>
        <Badge variant="outline">{{ other.sourceName }}</Badge>
        <Button variant="ghost" size="sm" @click="other = null">Pick another</Button>
        <div class="flex-1" />
        <form class="flex gap-2" @submit.prevent="applyNumbers">
          <Input v-model="numbersText" class="h-8 w-40" placeholder="Select: 12, 45-47" />
        </form>
        <span class="text-sm text-muted-foreground">{{ selected.size }} selected</span>
        <Button size="sm" :disabled="busy || !selected.size" @click="download"><Download class="size-4" /> Download selected</Button>
      </div>
      <div class="max-h-72 divide-y overflow-auto rounded-md border">
        <label v-for="c in chapters" :key="c.number" class="flex cursor-pointer items-center gap-3 px-3 py-1.5 text-sm">
          <Checkbox :model-value="selected.has(c.number)" :disabled="c.locked" @update:model-value="(v) => toggle(c.number, !!v)" />
          <span>{{ c.label }}</span>
          <Badge v-if="!c.inLink" variant="outline">not on this link</Badge>
        </label>
      </div>
    </template>
  </Card>
</template>
