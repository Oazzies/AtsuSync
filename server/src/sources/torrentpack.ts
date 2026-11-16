// Turns the files a torrent (or any file host) delivers into what the pipeline bundles:
// numbered page images for comics, or a ready-made ebook for novels.
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import type { FetchedChapter } from './types.ts';
import type { DownloadedFile, TorrentFile } from './torrent.ts';

export const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']);
export const EBOOK_EXTS = new Set(['epub', 'pdf', 'docx', 'txt', 'md']);
export const ZIP_EXTS = new Set(['cbz', 'zip']);
/** Recognised but can't be unpacked here; reported with a clear message instead of "no files". */
export const UNSUPPORTED_EXTS = new Set(['cbr', 'rar', '7z', 'cb7']);

export const extOf = (path: string) => {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m ? m[1]!.toLowerCase() : '';
};
const basename = (path: string) => path.split('/').pop() ?? path;
const stemOf = (path: string) => basename(path).replace(/\.[a-z0-9]+$/i, '');

/** Sort "2.jpg" before "10.jpg", the way a file browser does. */
export const naturalCompare = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

const isJunk = (path: string) => path.split('/').some((seg) => seg === '__MACOSX' || seg.startsWith('.') || /^thumbs\.db$/i.test(seg));
const isUsable = (path: string) => {
  const e = extOf(path);
  return !isJunk(path) && (IMAGE_EXTS.has(e) || EBOOK_EXTS.has(e) || ZIP_EXTS.has(e) || UNSUPPORTED_EXTS.has(e));
};
/** Release notes and the like that ship next to the real files; never a chapter. */
const isNote = (path: string) => /^(readme|info|credits?|notes?)\b/i.test(stemOf(path)) && !IMAGE_EXTS.has(extOf(path));

/** The chapter number a file or folder name announces ("c012", "Chapter 12.5", "… 012 (Digital)"), or null. */
export function chapterNumberIn(name: string): number | null {
  const s = name.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  const tagged = /(?:^|[\s_.\-#])(?:c|ch|chap|chapter)[\s._-]*0*(\d+(?:\.\d+)?)(?!\d)/i.exec(s);
  if (tagged) return Number(tagged[1]);
  const volume = /(?:^|[\s_\-#])v(?:ol(?:ume)?)?[\s._-]*0*(\d+(?:\.\d+)?)(?!\d)/i.exec(s);
  if (volume) return Number(volume[1]);
  const trailing = /(?:^|[\s_\-#])0*(\d+(?:\.\d+)?)\s*$/.exec(s.trim());
  return trailing ? Number(trailing[1]) : null;
}

/**
 * Which files of a torrent belong to a chapter. With a chapter number (a pack of many chapters), only files or
 * folders named for that number; without one (a single-chapter release), every usable file.
 */
export function pickChapterFiles(files: TorrentFile[], chapter: number | null): number[] {
  const usable = files.map((f, i) => ({ f, i })).filter(({ f }) => isUsable(f.path) && !isNote(f.path));
  if (chapter === null) return usable.map(({ i }) => i);
  const hit = usable.filter(({ f }) => {
    const segs = f.path.split('/');
    const file = segs.pop()!;
    // Page images are named by page, so only their folders can name the chapter.
    if (!IMAGE_EXTS.has(extOf(file)) && chapterNumberIn(stemOf(file)) === chapter) return true;
    return segs.some((seg) => chapterNumberIn(seg) === chapter);
  });
  // A "pack" that actually holds one archive (e.g. a mislabeled range) is still that chapter.
  if (hit.length === 0 && usable.length === 1) return [usable[0]!.i];
  return hit.map(({ i }) => i);
}

/** Pages in reading order from image files and CBZ/ZIP archives, renamed 001.jpg, 002.jpg… */
export function buildChapter(downloaded: DownloadedFile[], read: (path: string) => Uint8Array = (p) => readFileSync(p)): FetchedChapter {
  const files = downloaded.filter((d) => isUsable(d.path)).sort((a, b) => naturalCompare(a.path, b.path));
  if (files.length === 0) throw new Error('The torrent contained no images, archives or ebooks');

  const ebook = files.filter((f) => EBOOK_EXTS.has(extOf(f.path)));
  const images: { path: string; bytes: Uint8Array }[] = [];
  const unsupported: string[] = [];
  for (const f of files) {
    const e = extOf(f.path);
    if (IMAGE_EXTS.has(e)) images.push({ path: f.path, bytes: read(f.diskPath) });
    else if (ZIP_EXTS.has(e)) {
      const entries = unzipSync(read(f.diskPath), { filter: (z) => !isJunk(z.name) && IMAGE_EXTS.has(extOf(z.name)) });
      for (const name of Object.keys(entries).sort(naturalCompare)) images.push({ path: `${f.path}/${name}`, bytes: entries[name]! });
    } else if (UNSUPPORTED_EXTS.has(e)) unsupported.push(basename(f.path));
  }

  if (images.length === 0 && ebook.length > 0) {
    // Several ebooks in one chapter's files: the biggest is the real one (the rest are samples).
    const best = ebook.map((f) => ({ f, bytes: read(f.diskPath) })).sort((a, b) => b.bytes.length - a.bytes.length)[0]!;
    return { type: 'ebook', ext: extOf(best.f.path), bytes: best.bytes };
  }
  if (images.length === 0) {
    if (unsupported.length) throw new Error(`${unsupported[0]} is a ${extOf(unsupported[0]!).toUpperCase()} archive, which AtsuSync can't unpack; pick another release`);
    throw new Error('The torrent contained no page images');
  }
  const width = Math.max(3, String(images.length).length);
  return {
    type: 'pages',
    files: images.map((img, i) => ({ name: `${String(i + 1).padStart(width, '0')}.${extOf(img.path) === 'jpeg' ? 'jpg' : extOf(img.path)}`, bytes: img.bytes })),
  };
}
