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
