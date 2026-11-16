<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import AlertBanner from './AlertBanner.vue';
import Icon from './Icon.vue';
import {
  applyBatchTitleTransform,
  inspectPublishedTitles,
  previewPublishedTitleReplace,
  restoreTitleSnapshot,
  stripTitleTags,
  toSentenceCase,
  toTitleCase,
  trimTitleSpaces,
  type PublishedTitlePreview,
  type TitleInspection,
  type TitleSnapshotEntry,
} from './titleReplace';

const props = defineProps<{
  open: boolean;
  routeKind: 'request' | 'manga' | 'upload' | 'other';
}>();

const emit = defineEmits<{
  close: [];
}>();

// Floating window position/size (persisted independently from the main dock)
const TOOLS_BOUNDS_KEY = 'atsusync_tools_bounds';
const SCRATCHPAD_KEY = 'atsusync_tools_scratchpad';
const MIN_W = 280;
const MIN_H = 220;

const toolsEl = ref<HTMLElement | null>(null);
const bodyEl = ref<HTMLElement | null>(null);
const dragging = ref(false);

function defaultToolsBounds() {
  const width = 350;
  return {
    x: Math.max(12, window.innerWidth - 380 - width - 32),
    y: 88,
    width,
    height: null as number | null,
  };
}

const toolsBounds = ref<{ x: number; y: number; width: number; height: number | null }>(defaultToolsBounds());

function clampBounds(b: { x: number; y: number; width: number; height: number | null }) {
  const maxW = Math.max(MIN_W, Math.min(760, window.innerWidth - 24));
  const width = Math.min(Math.max(b.width, MIN_W), maxW);
  const maxH = Math.max(MIN_H, window.innerHeight - 24);
  const height = b.height === null ? null : Math.min(Math.max(b.height, MIN_H), maxH);
  const x = Math.min(Math.max(8, b.x), Math.max(8, window.innerWidth - width - 8));
  const y = Math.min(Math.max(8, b.y), Math.max(8, window.innerHeight - 60));
  return { x, y, width, height };
}

function saveBounds() {
  try {
    void chrome.storage?.local?.set({ [TOOLS_BOUNDS_KEY]: toolsBounds.value });
  } catch {
    /* ignore */
  }
}

const toolsStyle = computed(() => {
  const b = toolsBounds.value;
  return {
    left: `${b.x}px`,
    top: `${b.y}px`,
    right: 'auto',
    width: `${b.width}px`,
    ...(b.height !== null ? { height: `${b.height}px` } : { maxHeight: `${Math.max(MIN_H, window.innerHeight - b.y - 16)}px` }),
  };
});

function startDrag(e: PointerEvent) {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement | null)?.closest('button, a, input, textarea')) return;
  e.preventDefault();
  dragging.value = true;
  const startX = e.clientX;
  const startY = e.clientY;
  const origX = toolsBounds.value.x;
  const origY = toolsBounds.value.y;

  const onMove = (ev: PointerEvent) => {
    toolsBounds.value = clampBounds({
      ...toolsBounds.value,
      x: origX + (ev.clientX - startX),
      y: origY + (ev.clientY - startY),
    });
  };
  const onUp = () => {
    dragging.value = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    saveBounds();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

type ResizeDir = 'w' | 'e' | 's' | 'sw' | 'se';
function startResize(dir: ResizeDir, e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  const startY = e.clientY;
  const orig = { ...toolsBounds.value };
  const origH = orig.height ?? toolsEl.value?.getBoundingClientRect().height ?? 420;

  const onMove = (ev: PointerEvent) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    let { x, y, width, height } = orig;

    if (dir === 'w' || dir === 'sw') {
      const maxW = Math.max(MIN_W, Math.min(760, window.innerWidth - 24));
      const nextW = Math.min(Math.max(orig.width - dx, MIN_W), maxW);
      x = orig.x + (orig.width - nextW);
      width = nextW;
    }
    if (dir === 'e' || dir === 'se') {
      width = orig.width + dx;
    }
    if (dir === 's' || dir === 'sw' || dir === 'se') {
      height = origH + dy;
    }
    toolsBounds.value = clampBounds({ x, y, width, height });
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    saveBounds();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function onDockWheel(e: WheelEvent) {
  const el = bodyEl.value;
  if (!el) return;
  const target = e.target as Node | null;
  if (target && !el.contains(target)) {
    e.preventDefault();
    return;
  }
  const canScroll = el.scrollHeight > el.clientHeight + 1;
  if (!canScroll) {
    e.preventDefault();
    return;
  }
  const atTop = el.scrollTop <= 0 && e.deltaY < 0;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1 && e.deltaY > 0;
  if (atTop || atBottom) {
    e.preventDefault();
  }
}

function onWindowResize() {
  toolsBounds.value = clampBounds(toolsBounds.value);
}

// Feedback & shared undo history
const toolError = ref<string | null>(null);
const toolNotice = ref<string | null>(null);
let toolNoticeTimer: ReturnType<typeof setTimeout> | null = null;
watch(toolNotice, (val) => {
  if (toolNoticeTimer) {
    clearTimeout(toolNoticeTimer);
    toolNoticeTimer = null;
  }
  if (val) {
    toolNoticeTimer = setTimeout(() => {
      toolNotice.value = null;
      toolNoticeTimer = null;
    }, 4500);
  }
});
const undoStack = ref<TitleSnapshotEntry[][]>([]);

function pushUndo(snapshot: TitleSnapshotEntry[]) {
  if (snapshot.length === 0) return;
  const next = [...undoStack.value, snapshot];
  if (next.length > 20) next.shift();
  undoStack.value = next;
}

function runUndo() {
  const prev = undoStack.value[undoStack.value.length - 1];
  if (!prev) return;
  undoStack.value = undoStack.value.slice(0, -1);
  const restored = restoreTitleSnapshot(prev);
  toolError.value = null;
  toolNotice.value =
    restored > 0
      ? `Undid changes across ${restored} title field${restored === 1 ? '' : 's'}.`
      : 'Nothing to restore (fields are no longer on the page).';
  refreshAllTitleViews();
}

// 1. Find & Replace
const showReplace = ref(true);
const findTitleText = ref('');
const replaceTitleText = ref('');
const replaceMatchCase = ref(false);
const replaceUseRegex = ref(false);
const titlePreview = ref<PublishedTitlePreview | null>(null);
const replaceRegexError = ref<string | null>(null);

function refreshTitlePreview() {
  if (!props.open || !showReplace.value) {
    titlePreview.value = null;
    replaceRegexError.value = null;
    return;
  }
  try {
    replaceRegexError.value = null;
    titlePreview.value = previewPublishedTitleReplace(findTitleText.value, replaceTitleText.value, {
      matchCase: replaceMatchCase.value,
      useRegex: replaceUseRegex.value,
    });
  } catch (e) {
    replaceRegexError.value = e instanceof Error ? e.message : String(e);
    titlePreview.value = null;
  }
}

watch([() => props.open, () => props.routeKind, showReplace, findTitleText, replaceTitleText, replaceMatchCase, replaceUseRegex], refreshTitlePreview);

function runMassTitleReplace() {
  if (!findTitleText.value) return;
  toolError.value = null;
  toolNotice.value = null;
  try {
    const preview = previewPublishedTitleReplace(findTitleText.value, replaceTitleText.value, {
      matchCase: replaceMatchCase.value,
      useRegex: replaceUseRegex.value,
    });
    if (preview.totalInputs === 0) {
      toolError.value = 'No editable title fields found on this page.';
      return;
    }
    if (preview.matchingInputs === 0) {
      toolNotice.value = `No matches found across ${preview.totalInputs} title field${preview.totalInputs === 1 ? '' : 's'}.`;
      return;
    }

    const flags = replaceMatchCase.value ? 'g' : 'gi';
    const pattern = replaceUseRegex.value
      ? findTitleText.value
      : findTitleText.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(pattern, flags);

    const res = applyBatchTitleTransform((val) => val.replace(regex, replaceTitleText.value));
    pushUndo(res.snapshot);
    toolNotice.value = `Replaced ${preview.totalOccurrences} occurrence${preview.totalOccurrences === 1 ? '' : 's'} across ${res.updatedInputs} title${res.updatedInputs === 1 ? '' : 's'}.`;
    refreshAllTitleViews();
  } catch (e) {
    toolError.value = e instanceof Error ? e.message : String(e);
  }
}

// 2. Title Formatter (Case, Cleanup, Prefix/Suffix)
const showFormatter = ref(false);
const prefixText = ref('');
const suffixText = ref('');

function runBatchFormat(label: string, transform: (val: string, idx: number) => string) {
  toolError.value = null;
  toolNotice.value = null;
  const res = applyBatchTitleTransform(transform);
  if (res.totalInputs === 0) {
    toolError.value = 'No editable title fields found on this page.';
    return;
  }
  if (res.updatedInputs === 0) {
    toolNotice.value = `${label}: all ${res.totalInputs} field${res.totalInputs === 1 ? '' : 's'} already clean.`;
    return;
  }
  pushUndo(res.snapshot);
  toolNotice.value = `${label}: updated ${res.updatedInputs} of ${res.totalInputs} title${res.totalInputs === 1 ? '' : 's'}.`;
  refreshAllTitleViews();
}

function applyAffixes() {
  if (!prefixText.value && !suffixText.value) return;
  runBatchFormat('Prefix / Suffix', (val, idx) => {
    const n = String(idx + 1);
    const pre = prefixText.value.replace(/\{n\}/g, n);
    const suf = suffixText.value.replace(/\{n\}/g, n);
    return `${pre}${val}${suf}`;
  });
}

// 3. Title Inspector & Export
const showInspector = ref(false);
const inspection = ref<TitleInspection | null>(null);
const copiedTitles = ref(false);

function refreshInspection() {
  if (!props.open || !showInspector.value) {
    inspection.value = null;
    return;
  }
  inspection.value = inspectPublishedTitles();
}

watch([() => props.open, () => props.routeKind, showInspector], refreshInspection);

async function copyAllTitles() {
  const info = inspectPublishedTitles();
  inspection.value = info;
  if (info.total === 0) {
    toolError.value = 'No editable title fields found on this page.';
    return;
  }
  try {
    await navigator.clipboard.writeText(info.titles.join('\n'));
    copiedTitles.value = true;
    toolError.value = null;
    toolNotice.value = `Copied ${info.total} title${info.total === 1 ? '' : 's'} to clipboard.`;
    setTimeout(() => {
      copiedTitles.value = false;
    }, 1800);
  } catch (e) {
    toolError.value = e instanceof Error ? e.message : 'Failed to copy to clipboard.';
  }
}

function refreshAllTitleViews() {
  refreshTitlePreview();
  refreshInspection();
}

// 4. Scratchpad (persisted in chrome.storage.local)
const showScratchpad = ref(false);
const scratchpad = ref('');
const copiedScratch = ref(false);

watch(scratchpad, (val) => {
  try {
    void chrome.storage?.local?.set({ [SCRATCHPAD_KEY]: val });
  } catch {
    /* ignore */
  }
});

async function copyScratchpad() {
  if (!scratchpad.value) return;
  try {
    await navigator.clipboard.writeText(scratchpad.value);
    copiedScratch.value = true;
    setTimeout(() => {
      copiedScratch.value = false;
    }, 1500);
  } catch {
    /* ignore */
  }
}

onMounted(async () => {
  try {
    const stored = await chrome.storage?.local?.get([TOOLS_BOUNDS_KEY, SCRATCHPAD_KEY]);
    const saved = stored?.[TOOLS_BOUNDS_KEY] as { x: number; y: number; width: number; height: number | null } | undefined;
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number' && typeof saved.width === 'number') {
      toolsBounds.value = clampBounds({ x: saved.x, y: saved.y, width: saved.width, height: null });
    }
    if (typeof stored?.[SCRATCHPAD_KEY] === 'string') {
      scratchpad.value = stored[SCRATCHPAD_KEY] as string;
    }
  } catch {
    /* ignore */
  }
  window.addEventListener('resize', onWindowResize);
  refreshAllTitleViews();
});

onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize);
  if (toolNoticeTimer) clearTimeout(toolNoticeTimer);
});
</script>

<template>
  <div v-if="open" ref="toolsEl" class="as-dock as-tools-dock" :style="toolsStyle" @wheel="onDockWheel">
    <div class="as-resize as-resize-w" @pointerdown="startResize('w', $event)" />
    <div class="as-resize as-resize-e" @pointerdown="startResize('e', $event)" />
    <div class="as-resize as-resize-s" @pointerdown="startResize('s', $event)" />
    <div class="as-resize as-resize-sw" @pointerdown="startResize('sw', $event)" />
    <div class="as-resize as-resize-se" @pointerdown="startResize('se', $event)" />

    <div class="as-header" :class="{ dragging }" @pointerdown="startDrag">
      <div class="as-brand">
        <span class="as-wordmark">Atsu<span>Sync</span></span>
        <span class="as-badge indigo">Tools</span>
      </div>
      <div class="as-header-actions">
        <button
          v-if="undoStack.length > 0"
          class="as-btn icon"
          :title="`Undo last title edit (${undoStack.length})`"
          aria-label="Undo last title edit"
          @click="runUndo"
        >
          <Icon name="undo" />
        </button>
        <button class="as-btn icon" title="Close Tools" aria-label="Close Tools" @click="emit('close')">
          <Icon name="x" />
        </button>
      </div>
    </div>

    <div ref="bodyEl" class="as-body">
      <!-- 1. Find & Replace -->
      <div class="as-card">
        <div class="as-row">
          <span class="as-tool-head">
            <Icon name="search" />
            <span class="as-title">Find &amp; Replace</span>
          </span>
          <button
            class="as-icon-btn"
            :title="showReplace ? 'Collapse' : 'Expand'"
            :aria-label="showReplace ? 'Collapse' : 'Expand'"
            :aria-expanded="showReplace"
            @click="showReplace = !showReplace"
          >
            <Icon name="chevronDown" class="as-chevron" :class="{ open: showReplace }" />
          </button>
        </div>

        <template v-if="showReplace">
          <input
            v-model="findTitleText"
            class="as-input"
            placeholder="Find text…"
            @keyup.enter="runMassTitleReplace"
          />
          <input
            v-model="replaceTitleText"
            class="as-input"
            placeholder="Replace with (leave empty to remove)…"
            @keyup.enter="runMassTitleReplace"
          />
          <div class="as-row">
            <div class="as-row-wrap">
              <label class="as-check-label">
                <input v-model="replaceMatchCase" type="checkbox" />
                <span>Match case</span>
              </label>
              <label class="as-check-label">
                <input v-model="replaceUseRegex" type="checkbox" />
                <span>Regex</span>
              </label>
            </div>
            <button class="as-btn icon sm" title="Rescan title fields" aria-label="Rescan title fields" @click="refreshAllTitleViews">
              <Icon name="refresh" />
            </button>
          </div>

          <AlertBanner v-if="replaceRegexError" kind="error" :message="replaceRegexError" />
          <div v-else-if="titlePreview" class="as-muted">
            {{ titlePreview.totalInputs }} title field{{ titlePreview.totalInputs === 1 ? '' : 's' }} found
            <template v-if="findTitleText">
              · {{ titlePreview.matchingInputs }} matching ({{ titlePreview.totalOccurrences }} occurrence{{ titlePreview.totalOccurrences === 1 ? '' : 's' }})
            </template>
          </div>

          <div v-if="titlePreview?.sample" class="as-chap" style="flex-direction: column; align-items: stretch; gap: 2px; padding: 8px 10px">
            <div class="as-muted" style="text-decoration: line-through; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" :title="titlePreview.sample.before">
              {{ titlePreview.sample.before }}
            </div>
            <div class="as-chap-name" :title="titlePreview.sample.after">
              {{ titlePreview.sample.after || '(empty)' }}
            </div>
          </div>

          <div class="as-row">
            <button
              class="as-btn primary"
              style="flex: 1"
              :disabled="!findTitleText || !!replaceRegexError || (titlePreview?.matchingInputs ?? 0) === 0"
              @click="runMassTitleReplace"
            >
              <Icon name="edit" /> Replace All
            </button>
            <button
              v-if="undoStack.length > 0"
              class="as-btn"
              title="Undo last batch edit"
              @click="runUndo"
            >
              <Icon name="undo" /> Undo
            </button>
          </div>
        </template>
      </div>

      <!-- 2. Title Formatter -->
      <div class="as-card">
        <div class="as-row">
          <span class="as-tool-head">
            <Icon name="broom" />
            <span class="as-title">Title Formatter</span>
          </span>
          <button
            class="as-icon-btn"
            :title="showFormatter ? 'Collapse' : 'Expand'"
            :aria-label="showFormatter ? 'Collapse' : 'Expand'"
            :aria-expanded="showFormatter"
            @click="showFormatter = !showFormatter"
          >
            <Icon name="chevronDown" class="as-chevron" :class="{ open: showFormatter }" />
          </button>
        </div>

        <template v-if="showFormatter">
          <div class="as-tools-grid">
            <button class="as-btn sm" @click="runBatchFormat('Trim Spaces', trimTitleSpaces)">Trim Spaces</button>
            <button class="as-btn sm" @click="runBatchFormat('Title Case', toTitleCase)">Title Case</button>
            <button class="as-btn sm" @click="runBatchFormat('Sentence Case', toSentenceCase)">Sentence Case</button>
            <button class="as-btn sm" @click="runBatchFormat('Strip [Tags]', stripTitleTags)">Strip [Tags]</button>
          </div>

          <div class="as-row" style="gap: 6px">
            <input
              v-model="prefixText"
              class="as-input"
              placeholder="Prefix ({n} = #)…"
              @keyup.enter="applyAffixes"
            />
            <input
              v-model="suffixText"
              class="as-input"
              placeholder="Suffix…"
              @keyup.enter="applyAffixes"
            />
          </div>

          <div class="as-row">
            <button
              class="as-btn sm primary"
              style="flex: 1"
              :disabled="!prefixText && !suffixText"
              @click="applyAffixes"
            >
              <Icon name="plus" /> Apply Prefix / Suffix
            </button>
            <button class="as-btn sm danger" @click="runBatchFormat('Clear All', () => '')">
              <Icon name="trash" /> Clear
            </button>
          </div>
        </template>
      </div>

      <!-- 3. Title Inspector & Export -->
      <div class="as-card">
        <div class="as-row">
          <span class="as-tool-head">
            <Icon name="listCheck" />
            <span class="as-title">Title Inspector &amp; Export</span>
          </span>
          <button
            class="as-icon-btn"
            :title="showInspector ? 'Collapse' : 'Expand'"
            :aria-label="showInspector ? 'Collapse' : 'Expand'"
            :aria-expanded="showInspector"
            @click="showInspector = !showInspector"
          >
            <Icon name="chevronDown" class="as-chevron" :class="{ open: showInspector }" />
          </button>
        </div>

        <template v-if="showInspector">
          <div v-if="inspection" class="as-stat-grid">
            <div class="as-stat">
              <span class="as-stat-val">{{ inspection.total }}</span>
              <span class="as-stat-lbl">Fields</span>
            </div>
            <div class="as-stat">
              <span class="as-stat-val" :class="{ warn: inspection.empty > 0 }">{{ inspection.empty }}</span>
              <span class="as-stat-lbl">Empty</span>
            </div>
            <div class="as-stat">
              <span class="as-stat-val" :class="{ bad: inspection.duplicates > 0 }">{{ inspection.duplicates }}</span>
              <span class="as-stat-lbl">Dupes</span>
            </div>
            <div class="as-stat">
              <span class="as-stat-val" :class="{ warn: inspection.whitespaceIssues > 0 }">{{ inspection.whitespaceIssues }}</span>
              <span class="as-stat-lbl">Spaces</span>
            </div>
          </div>

          <div class="as-row">
            <button class="as-btn sm" style="flex: 1" :disabled="(inspection?.total ?? 0) === 0" @click="copyAllTitles">
              <Icon :name="copiedTitles ? 'check' : 'copy'" />
              {{ copiedTitles ? 'Copied!' : 'Copy All Titles' }}
            </button>
            <button class="as-btn icon sm" title="Rescan titles" aria-label="Rescan titles" @click="refreshInspection">
              <Icon name="refresh" />
            </button>
          </div>
        </template>
      </div>

      <!-- 4. Scratchpad -->
      <div class="as-card">
        <div class="as-row">
          <span class="as-tool-head">
            <Icon name="note" />
            <span class="as-title">Notes</span>
          </span>
          <button
            class="as-icon-btn"
            :title="showScratchpad ? 'Collapse' : 'Expand'"
            :aria-label="showScratchpad ? 'Collapse' : 'Expand'"
            :aria-expanded="showScratchpad"
            @click="showScratchpad = !showScratchpad"
          >
            <Icon name="chevronDown" class="as-chevron" :class="{ open: showScratchpad }" />
          </button>
        </div>

        <template v-if="showScratchpad">
          <textarea
            v-model="scratchpad"
            class="as-textarea"
            placeholder="Quick notes, regex patterns, group names, chapter lists…"
          />
          <div class="as-row">
            <button class="as-btn sm" style="flex: 1" :disabled="!scratchpad" @click="copyScratchpad">
              <Icon :name="copiedScratch ? 'check' : 'copy'" />
              {{ copiedScratch ? 'Copied!' : 'Copy Notes' }}
            </button>
            <button class="as-btn sm ghost" :disabled="!scratchpad" @click="scratchpad = ''">
              Clear
            </button>
          </div>
        </template>
      </div>
    </div>

    <div v-if="toolError || toolNotice" class="as-toast-stack">
      <AlertBanner
        v-if="toolError"
        kind="error"
        variant="toast"
        dismissible
        :message="toolError"
        @dismiss="toolError = null"
      />
      <AlertBanner
        v-if="toolNotice"
        kind="ok"
        variant="toast"
        dismissible
        :message="toolNotice"
        @dismiss="toolNotice = null"
      />
    </div>
  </div>
</template>
