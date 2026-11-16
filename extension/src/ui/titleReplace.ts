export interface ReplaceOptions {
  matchCase: boolean;
  useRegex: boolean;
}

export interface ReplaceResult {
  next: string;
  count: number;
  changed: boolean;
}

export interface PublishedTitlePreview {
  totalInputs: number;
  matchingInputs: number;
  totalOccurrences: number;
  sample: { before: string; after: string } | null;
}

const HOST_SELECTOR = '#atsusync-extension-host';
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search']);
const EXCLUDED_HINT_RE = /\b(search|filter|chapter\s*(num|no|#)?|number|vol(ume)?|url|link|group)\b/i;
const COMPETING_HEADING_RE = /^(drafts?|pending|review|in\s+review|queue|upload)(\s*\(\d+\))?$/i;

export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildReplaceRegex(find: string, opts: ReplaceOptions): RegExp | null {
  if (!find) return null;
  const flags = opts.matchCase ? 'g' : 'gi';
  const pattern = opts.useRegex ? find : escapeRegExp(find);
  return new RegExp(pattern, flags);
}

export function applyTextReplace(text: string, find: string, replace: string, opts: ReplaceOptions): ReplaceResult {
  const regex = buildReplaceRegex(find, opts);
  if (!regex) return { next: text, count: 0, changed: false };

  let count = 0;
  let next: string;
  if (opts.useRegex) {
    const matches = text.match(regex);
    count = matches ? matches.length : 0;
    next = count > 0 ? text.replace(regex, replace) : text;
  } else {
    next = text.replace(regex, () => {
      count++;
      return replace;
    });
  }

  return { next, count, changed: next !== text };
}

function isVisibleEditableTextInput(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el.closest(HOST_SELECTOR)) return false;
  if (el instanceof HTMLInputElement) {
    if (!TEXT_INPUT_TYPES.has(el.type.toLowerCase())) return false;
    if (el.disabled || el.readOnly) return false;
  } else if (el instanceof HTMLTextAreaElement) {
    if (el.disabled || el.readOnly) return false;
  } else {
    return false;
  }
  return el.getClientRects().length > 0;
}

function getInputHints(el: HTMLInputElement | HTMLTextAreaElement): string {
  return [
    el.getAttribute('placeholder'),
    el.getAttribute('aria-label'),
    el.getAttribute('name'),
    el.id,
    el.getAttribute('data-testid'),
  ]
    .filter(Boolean)
    .join(' ');
}

function isExcludedInput(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  const hints = getInputHints(el);
  if (!hints) return false;
  if (/title/i.test(hints)) return false;
  return EXCLUDED_HINT_RE.test(hints);
}

function isExplicitTitleInput(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  return /title/i.test(getInputHints(el));
}

function hasCompetingSectionHeading(container: Element): boolean {
  const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"], summary, legend');
  for (const h of headings) {
    if (h.closest(HOST_SELECTOR)) continue;
    const text = (h.textContent ?? '').trim();
    if (COMPETING_HEADING_RE.test(text)) return true;
  }
  return false;
}

function findPublishedContainer(doc: Document): Element | null {
  const candidates = doc.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"], summary, legend, button, [role="tab"], span, div');
  const exactMatches: Element[] = [];
  const partialMatches: Element[] = [];

  for (const el of candidates) {
    if (el.closest(HOST_SELECTOR)) continue;
    const text = (el.textContent ?? '').trim();
    if (!text || text.length > 50) continue;
    if (/^published(\s+chapters?)?(\s*\(\d+\))?$/i.test(text)) {
      exactMatches.push(el);
    } else if (/\bpublished\b/i.test(text) && el.children.length === 0) {
      partialMatches.push(el);
    }
  }

  for (const heading of [...exactMatches, ...partialMatches]) {
    let cur: Element | null = heading.parentElement;
    let best: Element | null = null;
    for (let depth = 0; depth < 6 && cur && cur !== doc.body && cur !== doc.documentElement; depth++) {
      if (hasCompetingSectionHeading(cur)) break;
      const inputs = Array.from(cur.querySelectorAll('input, textarea')).filter(isVisibleEditableTextInput);
      if (inputs.length > 0) {
        best = cur;
      }
      cur = cur.parentElement;
    }
    if (best) return best;
  }

  return null;
}

/**
 * Locate editable title inputs in the Published section of atsu.moe/upload.
 * Falls back to explicit title inputs in an active tabpanel or on the page.
 */
export function findPublishedTitleInputs(doc: Document = document): (HTMLInputElement | HTMLTextAreaElement)[] {
  const container = findPublishedContainer(doc);
  if (container) {
    const inputs = Array.from(container.querySelectorAll('input, textarea'))
      .filter(isVisibleEditableTextInput)
      .filter((el) => !isExcludedInput(el));
    const explicit = inputs.filter(isExplicitTitleInput);
    return explicit.length > 0 ? explicit : inputs;
  }

  const activePanel = doc.querySelector('[role="tabpanel"]:not([hidden])');
  const scope = activePanel ?? doc;
  const allInputs = Array.from(scope.querySelectorAll('input, textarea')).filter(isVisibleEditableTextInput);
  return allInputs.filter(isExplicitTitleInput);
}

export function previewPublishedTitleReplace(
  find: string,
  replace: string,
  opts: ReplaceOptions,
  doc: Document = document,
): PublishedTitlePreview {
  const inputs = findPublishedTitleInputs(doc);
  let matchingInputs = 0;
  let totalOccurrences = 0;
  let sample: { before: string; after: string } | null = null;

  if (find) {
    for (const input of inputs) {
      const res = applyTextReplace(input.value, find, replace, opts);
      if (res.changed) {
        matchingInputs++;
        totalOccurrences += res.count;
        if (!sample) {
          sample = { before: input.value, after: res.next };
        }
      }
    }
  }

  return {
    totalInputs: inputs.length,
    matchingInputs,
    totalOccurrences,
    sample,
  };
}

function setNativeInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export function replaceAllPublishedTitles(
  find: string,
  replace: string,
  opts: ReplaceOptions,
  doc: Document = document,
): { updatedInputs: number; totalOccurrences: number; totalInputs: number } {
  const inputs = findPublishedTitleInputs(doc);
  let updatedInputs = 0;
  let totalOccurrences = 0;

  for (const input of inputs) {
    const res = applyTextReplace(input.value, find, replace, opts);
    if (res.changed) {
      setNativeInputValue(input, res.next);
      updatedInputs++;
      totalOccurrences += res.count;
    }
  }

  return {
    updatedInputs,
    totalOccurrences,
    totalInputs: inputs.length,
  };
}

export interface TitleSnapshotEntry {
  el: HTMLInputElement | HTMLTextAreaElement;
  value: string;
}

export interface TitleInspection {
  total: number;
  empty: number;
  duplicates: number;
  whitespaceIssues: number;
  titles: string[];
}

const MINOR_TITLE_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'by',
  'for',
  'from',
  'in',
  'into',
  'nor',
  'of',
  'on',
  'or',
  'out',
  'so',
  'the',
  'to',
  'up',
  'with',
  'yet',
]);

export function captureTitleSnapshot(doc: Document = document): TitleSnapshotEntry[] {
  return findPublishedTitleInputs(doc).map((el) => ({ el, value: el.value }));
}

export function restoreTitleSnapshot(snapshot: TitleSnapshotEntry[]): number {
  let restored = 0;
  for (const entry of snapshot) {
    if (!entry.el.isConnected) continue;
    if (entry.el.value !== entry.value) {
      setNativeInputValue(entry.el, entry.value);
      restored++;
    }
  }
  return restored;
}

export function applyBatchTitleTransform(
  transform: (value: string, index: number) => string,
  doc: Document = document,
): { updatedInputs: number; totalInputs: number; snapshot: TitleSnapshotEntry[] } {
  const inputs = findPublishedTitleInputs(doc);
  const snapshot: TitleSnapshotEntry[] = [];
  let updatedInputs = 0;

  inputs.forEach((input, idx) => {
    const prev = input.value;
    const next = transform(prev, idx);
    if (next !== prev) {
      snapshot.push({ el: input, value: prev });
      setNativeInputValue(input, next);
      updatedInputs++;
    }
  });

  return {
    updatedInputs,
    totalInputs: inputs.length,
    snapshot,
  };
}

export function trimTitleSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function stripTitleTags(text: string): string {
  return trimTitleSpaces(text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' '));
}

export function toTitleCase(text: string): string {
  const cleaned = trimTitleSpaces(text);
  if (!cleaned) return '';
  const words = cleaned.split(' ');
  return words
    .map((word, idx) => {
      const lower = word.toLowerCase();
      if (idx > 0 && idx < words.length - 1 && MINOR_TITLE_WORDS.has(lower)) {
        return lower;
      }
      return lower.replace(/^([^a-zA-Z0-9]*)([a-zA-Z])/, (_, prefix: string, ch: string) => `${prefix}${ch.toUpperCase()}`);
    })
    .join(' ');
}

export function toSentenceCase(text: string): string {
  const cleaned = trimTitleSpaces(text).toLowerCase();
  if (!cleaned) return '';
  return cleaned.replace(/^([^a-zA-Z0-9]*)([a-zA-Z])/, (_, prefix: string, ch: string) => `${prefix}${ch.toUpperCase()}`);
}

export function inspectPublishedTitles(doc: Document = document): TitleInspection {
  const inputs = findPublishedTitleInputs(doc);
  const titles = inputs.map((el) => el.value);
  let empty = 0;
  let whitespaceIssues = 0;
  const seen = new Map<string, number>();

  for (const raw of titles) {
    const trimmed = raw.trim();
    if (!trimmed) {
      empty++;
      continue;
    }
    if (raw !== trimmed || /\s{2,}/.test(raw)) {
      whitespaceIssues++;
    }
    const key = trimmed.toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  let duplicates = 0;
  for (const count of seen.values()) {
    if (count > 1) duplicates += count - 1;
  }

  return {
    total: inputs.length,
    empty,
    duplicates,
    whitespaceIssues,
    titles,
  };
}
