// Helpers shared by novel sources: turn a site's chapter markup into clean XHTML
// paragraphs, and (see upload/epub.ts) bundle them into an EPUB for atsu.moe/upload.
import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

export const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const DROP = new Set(['script', 'style', 'ins', 'iframe', 'noscript', 'form', 'button', 'nav', 'svg', 'link', 'meta']);
const BLOCK_PASS = new Set(['div', 'section', 'article', 'main', 'center', 'span', 'font', 'a', 'ul', 'ol', 'li', 'table', 'tbody', 'tr', 'td', 'figure', 'figcaption']);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** Zero-width and non-breaking junk some sites sprinkle in as watermarks or spacing. */
const cleanText = (s: string) => s.replace(/[​-‍⁠﻿]/g, '').replace(/ /g, ' ');

function inline(node: AnyNode, imgs?: ImageSink): string {
  if (node.type === 'text') return escapeXml(cleanText(node.data));
  if (node.type !== 'tag') return '';
  const el = node as Element;
  const name = el.name.toLowerCase();
  if (DROP.has(name)) return '';
  if (name === 'br') return '<br/>';
  if (name === 'img') return imgs ? imgs(el) : '';
  const inner = el.children.map((c) => inline(c, imgs)).join('');
  if (name === 'em' || name === 'i') return inner.trim() ? `<em>${inner}</em>` : inner;
  if (name === 'strong' || name === 'b') return inner.trim() ? `<strong>${inner}</strong>` : inner;
  return inner;
}

/** Called for each <img> met inline; returns the XHTML to emit (or '' to drop it). */
export type ImageSink = (img: Element) => string;

const hasContent = (xhtml: string) => xhtml.replace(/<br\/>/g, '').replace(/<[^>]+>/g, '').trim().length > 0 || /<img /.test(xhtml);

/**
 * Convert the children of a chapter container into well-formed XHTML block elements. Only paragraphs,
 * headings, quotes, rules and (optionally) images survive; ads, scripts, empty paragraphs and layout
 * wrappers are dropped.
 */
export function chapterXhtml($: cheerio.CheerioAPI, container: cheerio.Cheerio<AnyNode>, imgs?: ImageSink): string {
  const out: string[] = [];
  let loose = '';
  const flush = () => {
    if (hasContent(loose)) out.push(`<p>${loose.trim()}</p>`);
    loose = '';
  };
  const walk = (nodes: AnyNode[]) => {
    for (const node of nodes) {
      if (node.type === 'text') {
        loose += inline(node, imgs);
        continue;
      }
      if (node.type !== 'tag') continue;
      const el = node as Element;
      const name = el.name.toLowerCase();
      if (DROP.has(name)) continue;
      if (name === 'br') {
        flush();
      } else if (name === 'p' || name === 'blockquote') {
        flush();
        const inner = el.children.map((c) => inline(c, imgs)).join('').trim();
        if (hasContent(inner)) out.push(`<${name}>${inner}</${name}>`);
      } else if (HEADINGS.has(name)) {
        flush();
        const inner = el.children.map((c) => inline(c, imgs)).join('').trim();
        if (hasContent(inner)) out.push(`<h2>${inner}</h2>`);
      } else if (name === 'hr') {
        flush();
        out.push('<hr/>');
      } else if (name === 'img') {
        loose += inline(el, imgs);
        flush();
      } else if (BLOCK_PASS.has(name)) {
        // Treat unknown wrappers as transparent; sites nest <p> inside many levels of <div>.
        const hasBlocks = $(el).find('p, h1, h2, h3, h4, h5, h6, blockquote, hr, br').length > 0;
        if (hasBlocks || name === 'div' || name === 'section' || name === 'article') {
          flush();
          walk(el.children);
          flush();
        } else {
          loose += inline(el, imgs);
        }
      } else {
        loose += inline(el, imgs);
      }
    }
  };
  walk(container.toArray().flatMap((c) => (c.type === 'tag' ? (c as Element).children : [])));
  flush();
  return out.join('\n');
}

/** "Chapter 12.5: Title" / "Vol. 3 Chapter 12" → 12.5 / 12. Null when there is no chapter number. */
export function chapterNumberFrom(...texts: string[]): number | null {
  for (const t of texts) {
    const m = t.match(/(?:chapter|chap\.?|ch\.?|episode|ep\.?)[\s_-]*#?(\d+(?:[._-]\d+)?)/i);
    if (m) return Number(m[1]!.replace(/[_-]/, '.'));
  }
  return null;
}

/** The chapter title without a leading "Chapter N:" so the EPUB shows one clean heading. */
export const stripChapterPrefix = (title: string) => title.replace(/^\s*(?:chapter|chap\.?|ch\.?)\s*#?\d+(?:\.\d+)?\s*[:.\-–—]?\s*/i, '').trim();
