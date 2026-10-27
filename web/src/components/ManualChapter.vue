<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import { ArrowDown, ArrowUp, Link2, Loader2, Package, Trash2, Upload, X } from 'lucide-vue-next';
import { api, type DraftPreviewPage, type DraftView } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

const props = defineProps<{ linkId: number; suggestedNumber?: number }>();
const emit = defineEmits<{ saved: []; close: [] }>();

const draft = ref<DraftView | null>(null);
const preview = ref<DraftPreviewPage[]>([]);
const previewVersion = ref(0);
const previewing = ref(false);
const uploading = ref<{ done: number; total: number } | null>(null);
const saving = ref(false);
const dragging = ref(false);

// A number input's v-model yields a number once typed in, and '' when empty.
const number = ref<string | number>(props.suggestedNumber ?? '');
const label = ref('');
const autoJoin = ref(true);

const pages = computed(() => draft.value?.pages ?? []);
const numberValue = computed(() => (String(number.value).trim() === '' ? NaN : Number(number.value)));
const canSave = computed(() => !!draft.value && pages.value.length > 0 && Number.isFinite(numberValue.value) && numberValue.value >= 0 && !uploading.value && !saving.value);
const fmtSize = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
const joinedCount = computed(() => preview.value.filter((p) => p.parts > 1).length);

onMounted(async () => {
  try {
    draft.value = await api.createDraft();
  } catch (e) {
    toast.error((e as Error).message);
  }
});
onBeforeUnmount(() => {
  if (draft.value) void api.discardDraft(draft.value.id).catch(() => {});
});

// Re-render the stitched result whenever the pages, their order, joins or the auto-join option change.
let previewTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => [JSON.stringify(pages.value.map((p) => [p.id, p.joinPrev])), autoJoin.value, uploading.value === null] as const,
  ([, , idle]) => {
    clearTimeout(previewTimer);
    if (!idle) return;
    previewTimer = setTimeout(refreshPreview, 250);
  },
);
async function refreshPreview() {
  if (!draft.value || pages.value.length === 0) {
    preview.value = [];
    return;
  }
  previewing.value = true;
  try {
    preview.value = await api.draftPreview(draft.value.id, autoJoin.value);
    previewVersion.value++;
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    previewing.value = false;
  }
}

async function addFiles(list: FileList | File[]) {
  if (!draft.value) return;
  const files = [...list].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif)$/i.test(f.name));
  if (!files.length) return toast.error('Those are not image files');
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  uploading.value = { done: 0, total: files.length };
  try {
    for (const f of files) {
      draft.value = await api.addDraftPage(draft.value.id, f);
      uploading.value = { done: uploading.value.done + 1, total: files.length };
    }
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    uploading.value = null;
  }
}
function onPick(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files) void addFiles(input.files);
  input.value = '';
}
function onDrop(e: DragEvent) {
  dragging.value = false;
  if (e.dataTransfer?.files) void addFiles(e.dataTransfer.files);
}

async function guard(fn: () => Promise<DraftView>) {
  try {
    draft.value = await fn();
  } catch (e) {
    toast.error((e as Error).message);
  }
}
const move = (i: number, by: number) => {
  const ids = pages.value.map((p) => p.id);
  const j = i + by;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  return guard(() => api.updateDraft(draft.value!.id, { order: ids }));
};
const toggleJoin = (id: string, on: boolean) => guard(() => api.updateDraft(draft.value!.id, { joins: { [id]: on } }));
const remove = (id: string) => guard(() => api.removeDraftPage(draft.value!.id, id));
const sortByName = () => guard(() => api.updateDraft(draft.value!.id, { sortByName: true }));

async function save() {
  if (!draft.value || !canSave.value) return;
  saving.value = true;
  try {
    const job = await api.commitDraft(draft.value.id, { linkId: props.linkId, number: numberValue.value, label: label.value.trim(), autoJoin: autoJoin.value });
    draft.value = null; // the server deleted it
    toast.success(`Saved ${job.chapterLabel} (${job.total} pages)`);
    emit('saved');
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Card class="gap-0 py-0">
    <div class="flex flex-wrap items-center gap-2 border-b p-3">
      <h2 class="font-medium">Add chapter by hand</h2>
      <span class="text-sm text-muted-foreground">Upload saved images; they are stitched and zipped like a scraped chapter.</span>
      <div class="flex-1" />
      <Button variant="ghost" size="sm" @click="emit('close')"><X class="size-4" /> Close</Button>
    </div>

    <div class="grid gap-4 p-3 sm:grid-cols-[8rem_1fr_auto] sm:items-end">
      <div class="space-y-1.5">
        <Label for="mc-number">Chapter number</Label>
        <Input id="mc-number" v-model="number" type="number" step="0.1" min="0" placeholder="e.g. 122" />
      </div>
      <div class="space-y-1.5">
        <Label for="mc-label">Chapter name</Label>
        <Input id="mc-label" v-model="label" :placeholder="Number.isFinite(numberValue) ? `Chapter ${numberValue}` : 'Chapter N'" />
      </div>
      <div class="flex items-center gap-2 pb-2 text-sm">
        <Switch id="mc-auto" v-model="autoJoin" />
        <Label for="mc-auto" class="font-normal" title="Glue thin leftover strips (under 150 px tall) onto the page above them">Join thin strips</Label>
      </div>
    </div>

    <div class="px-3 pb-3">
      <label
        class="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed p-6 text-sm text-muted-foreground transition-colors hover:bg-muted/50"
        :class="dragging && 'bg-muted/50'"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <Upload class="size-5" />
        <span v-if="uploading"><Loader2 class="mr-1 inline size-4 animate-spin" /> Uploading {{ uploading.done }}/{{ uploading.total }}…</span>
        <span v-else>Drop images here or click to choose (JPG, PNG, WebP, GIF, AVIF)</span>
        <input type="file" accept="image/*" multiple class="sr-only" :disabled="!draft || !!uploading" @change="onPick" />
      </label>
    </div>

    <div v-if="pages.length" class="grid gap-4 border-t p-3 lg:grid-cols-2">
      <div class="space-y-2">
        <div class="flex items-center gap-2">
          <h3 class="text-sm font-medium">Uploaded ({{ pages.length }})</h3>
          <div class="flex-1" />
          <Button variant="outline" size="sm" @click="sortByName">Sort by name</Button>
        </div>
        <div class="max-h-[32rem] space-y-1.5 overflow-auto pr-1">
          <div v-for="(p, i) in pages" :key="p.id" class="flex items-center gap-2 rounded-md border p-1.5">
            <img :src="api.draftPageUrl(draft!.id, p.id)" loading="lazy" class="h-14 w-10 shrink-0 rounded-sm bg-muted object-cover object-top" alt="" />
            <div class="min-w-0 flex-1 text-sm">
              <div class="truncate font-medium">{{ p.name }}</div>
              <div class="text-xs text-muted-foreground">{{ p.width }}×{{ p.height }} · {{ fmtSize(p.size) }}</div>
            </div>
            <Button
              v-if="i > 0"
              :variant="p.joinPrev ? 'secondary' : 'ghost'"
              size="icon"
              class="size-7"
              :title="p.joinPrev ? 'Joined to the image above (click to split)' : 'Join to the image above'"
              @click="toggleJoin(p.id, !p.joinPrev)"
            >
              <Link2 class="size-4" />
            </Button>
            <Button variant="ghost" size="icon" class="size-7" :disabled="i === 0" @click="move(i, -1)"><ArrowUp class="size-4" /></Button>
            <Button variant="ghost" size="icon" class="size-7" :disabled="i === pages.length - 1" @click="move(i, 1)"><ArrowDown class="size-4" /></Button>
            <Button variant="ghost" size="icon" class="size-7" @click="remove(p.id)"><Trash2 class="size-4" /></Button>
          </div>
        </div>
      </div>

      <div class="space-y-2">
        <div class="flex items-center gap-2">
          <h3 class="text-sm font-medium">Result ({{ preview.length }} pages)</h3>
          <span v-if="joinedCount" class="text-xs text-muted-foreground">{{ joinedCount }} stitched</span>
          <Loader2 v-if="previewing" class="size-4 animate-spin text-muted-foreground" />
        </div>
        <div class="max-h-[32rem] overflow-auto rounded-md border bg-muted/30 p-2">
          <div v-for="p in preview" :key="p.index" class="mb-3 last:mb-0">
            <div class="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span class="font-medium text-foreground">{{ p.name }}</span>
              <span>{{ p.width }}×{{ p.height }}</span>
              <span v-if="p.parts > 1">· {{ p.parts }} images stitched</span>
            </div>
            <img :src="api.draftPreviewUrl(draft!.id, p.index, autoJoin, previewVersion)" loading="lazy" class="w-full max-w-sm rounded-sm border bg-background" alt="" />
          </div>
          <p v-if="!preview.length" class="p-4 text-center text-sm text-muted-foreground">Preview appears here.</p>
        </div>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2 border-t p-3">
      <p class="text-sm text-muted-foreground">
        Saved under chapter <strong>{{ Number.isFinite(numberValue) ? numberValue : '?' }}</strong>; an existing chapter with that number is filled in and its old ZIP replaced.
      </p>
      <div class="flex-1" />
      <Button :disabled="!canSave" @click="save">
        <Loader2 v-if="saving" class="size-4 animate-spin" /><Package v-else class="size-4" /> Save as ZIP
      </Button>
    </div>
  </Card>
</template>
