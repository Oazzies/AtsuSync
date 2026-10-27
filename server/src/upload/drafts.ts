import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dimsOf, ext, looksLikeImage, mergeSliverPages, renumber, stitchVertical, type PageFile } from './fixups.ts';

/** One image the user uploaded for a hand-built chapter. */
export interface DraftPage {
  id: string;
  name: string;
  width: number;
  height: number;
  size: number;
  /** Glue this image onto the bottom of the one before it. */
  joinPrev: boolean;
}

export interface DraftView {
  id: string;
  pages: DraftPage[];
}

export interface PreviewPage {
  index: number;
  name: string;
  width: number;
  height: number;
  /** How many uploaded images this page is made of. */
  parts: number;
}

interface Draft {
  id: string;
  pages: (DraftPage & { file: string })[];
  version: number;
  built?: { key: string; files: PageFile[] };
}

const MAX_AGE_MS = 24 * 60 * 60_000;
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
export const mimeFor = (name: string) => MIME[ext(name)] ?? 'application/octet-stream';

/** Natural order, so "page 2" sorts before "page 10". */
export const naturalCompare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

/**
 * Working area for building a chapter from images the user supplies (e.g. saved from a browser).
 * Images live on disk under `<dir>/<draftId>/`; ordering and join flags live in memory. Drafts are
 * disposable: they are deleted on commit/discard and anything older than a day is swept on start.
 */
export class Drafts {
  private drafts = new Map<string, Draft>();

  constructor(private dir: string) {
    this.sweep();
  }

  create(): DraftView {
    const id = randomUUID();
    mkdirSync(join(this.dir, id), { recursive: true });
    this.drafts.set(id, { id, pages: [], version: 0 });
    return this.view(this.mustGet(id));
  }

  get(id: string): DraftView {
    return this.view(this.mustGet(id));
  }

  async addPage(id: string, name: string, bytes: Uint8Array): Promise<DraftView> {
    const d = this.mustGet(id);
    if (!looksLikeImage(bytes)) throw bad(`${name} is not an image I can read (PNG, JPG, WebP, GIF or AVIF)`);
    const dims = await dimsOf(bytes);
    if (!dims) throw bad(`${name} could not be decoded`);
    const pageId = randomUUID();
    const file = join(this.dir, id, `${pageId}.${ext(name).replace(/[^a-z0-9]/g, '') || 'jpg'}`);
    writeFileSync(file, bytes);
    d.pages.push({ id: pageId, name, width: dims.width, height: dims.height, size: bytes.length, joinPrev: false, file });
    this.touch(d);
    return this.view(d);
  }

  removePage(id: string, pageId: string): DraftView {
    const d = this.mustGet(id);
    const i = d.pages.findIndex((p) => p.id === pageId);
    if (i === -1) throw bad('Page not found', 404);
    rmSync(d.pages[i]!.file, { force: true });
    d.pages.splice(i, 1);
    this.touch(d);
    return this.view(d);
  }

  /** `order`: page ids in the wanted order (any omitted ones keep their place at the end). `joins`: page id → joinPrev. */
  update(id: string, patch: { order?: string[]; joins?: Record<string, boolean>; sortByName?: boolean }): DraftView {
    const d = this.mustGet(id);
    if (patch.sortByName) d.pages.sort((a, b) => naturalCompare(a.name, b.name));
    if (patch.order) {
      const rank = new Map(patch.order.map((pid, i) => [pid, i]));
      d.pages.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
    }
    if (patch.joins) for (const p of d.pages) if (p.id in patch.joins) p.joinPrev = !!patch.joins[p.id];
    this.touch(d);
    return this.view(d);
  }

  pageFile(id: string, pageId: string): { bytes: Uint8Array; name: string } {
    const p = this.mustGet(id).pages.find((x) => x.id === pageId);
    if (!p) throw bad('Page not found', 404);
    return { bytes: readFileSync(p.file), name: p.name };
  }

  /** The pages as they would end up in the ZIP: manual joins first, then (optionally) the automatic strip fix. */
  async build(id: string, opts: { autoJoin: boolean }): Promise<PageFile[]> {
    const d = this.mustGet(id);
    const key = `${d.version}:${opts.autoJoin}`;
    if (d.built?.key === key) return d.built.files;
    if (d.pages.length === 0) throw bad('Add at least one page');

    const groups: (DraftPage & { file: string })[][] = [];
    for (const p of d.pages) {
      if (p.joinPrev && groups.length) groups.at(-1)!.push(p);
      else groups.push([p]);
    }
    let files: PageFile[] = [];
    for (const g of groups) {
      if (g.length === 1) {
        files.push({ name: g[0]!.name, bytes: readFileSync(g[0]!.file), parts: 1 });
        continue;
      }
      const joined = await stitchVertical(g.map((p) => readFileSync(p.file)), g[0]!.name);
      files.push({ name: `${g[0]!.name.replace(/\.\w+$/, '')}.${joined.ext}`, bytes: joined.bytes, parts: g.length });
    }
    if (opts.autoJoin) files = (await mergeSliverPages(files)).files;
    files = renumber(files);
    d.built = { key, files };
    return files;
  }

  async preview(id: string, opts: { autoJoin: boolean }): Promise<PreviewPage[]> {
    const files = await this.build(id, opts);
    return Promise.all(
      files.map(async (f, index) => {
        const dims = (await dimsOf(f.bytes))!;
        return { index, name: f.name, width: dims.width, height: dims.height, parts: f.parts ?? 1 };
      }),
    );
  }

  async previewImage(id: string, index: number, opts: { autoJoin: boolean }): Promise<PageFile> {
    const f = (await this.build(id, opts))[index];
    if (!f) throw bad('Page not found', 404);
    return f;
  }

  discard(id: string) {
    this.drafts.delete(id);
    rmSync(join(this.dir, id), { recursive: true, force: true });
  }

  private mustGet(id: string): Draft {
    const d = this.drafts.get(id);
    if (!d) throw bad('That draft expired or does not exist; start a new one', 404);
    return d;
  }

  private touch(d: Draft) {
    d.version++;
    d.built = undefined;
  }

  private view(d: Draft): DraftView {
    return { id: d.id, pages: d.pages.map(({ file: _file, ...p }) => p) };
  }

  /** Drafts don't survive a restart (their order lives in memory), so leftover folders are just clutter. */
  private sweep() {
    if (!existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir)) {
      const p = join(this.dir, name);
      try {
        if (Date.now() - statSync(p).mtimeMs > MAX_AGE_MS || !this.drafts.has(name)) rmSync(p, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
