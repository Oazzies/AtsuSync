import sharp from 'sharp';

export interface PageFile {
  name: string;
  bytes: Uint8Array;
  /** How many source images were glued into this page (1 = untouched). */
  parts?: number;
}

/** A page this short can't stand alone: Atsumaru rejects it ("Page 2 is only 800 by 65"). */
export const SLIVER_MAX_HEIGHT = 150;
/** The page it continues must be at least this many times taller, so real short pages aren't touched. */
const SLIVER_HOST_RATIO = 4;

export interface Dims {
  width: number;
  height: number;
}

export const dimsOf = async (bytes: Uint8Array): Promise<Dims | null> => {
  try {
    const { width, height } = await sharp(bytes).metadata();
    return width && height ? { width, height } : null;
  } catch {
    return null;
  }
};

export const ext = (name: string) => name.split('.').pop()?.toLowerCase() ?? 'jpg';

/** PNG, JPEG, GIF, WebP or AVIF magic bytes. */
export function looksLikeImage(b: Uint8Array): boolean {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  return (
    at(0, 0x89, 0x50, 0x4e, 0x47) ||
    at(0, 0xff, 0xd8, 0xff) ||
    at(0, 0x47, 0x49, 0x46) ||
    (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) ||
    at(4, 0x66, 0x74, 0x79, 0x70)
  );
}

/**
 * Stack images top to bottom into one. Narrower/wider ones are scaled to the first image's width.
 * The result keeps PNG/WebP when the first image is one, and is JPEG otherwise.
 */
export async function stitchVertical(inputs: Uint8Array[], firstName: string): Promise<{ bytes: Uint8Array; ext: string }> {
  const first = await dimsOf(inputs[0]!);
  if (!first) throw new Error('Cannot read image to stitch');
  const parts: { input: Buffer; height: number }[] = [];
  for (const bytes of inputs) {
    const d = await dimsOf(bytes);
    if (!d) throw new Error('Cannot read image to stitch');
    if (d.width === first.width) parts.push({ input: Buffer.from(bytes), height: d.height });
    else {
      const input = await sharp(bytes).resize({ width: first.width }).toBuffer();
      parts.push({ input, height: (await dimsOf(input))!.height });
    }
  }
  let top = 0;
  const layers = parts.map((p) => {
    const layer = { input: p.input, top, left: 0 };
    top += p.height;
    return layer;
  });
  const joined = sharp({ create: { width: first.width, height: top, channels: 3, background: '#ffffff' } }).composite(layers);
  const e = ext(firstName);
  if (e === 'png') return { bytes: await joined.png().toBuffer(), ext: 'png' };
  if (e === 'webp') return { bytes: await joined.webp({ quality: 95 }).toBuffer(), ext: 'webp' };
  return { bytes: await joined.jpeg({ quality: 95 }).toBuffer(), ext: 'jpg' };
}

/** Rename to 001.ext, 002.ext, … */
export const renumber = (files: PageFile[]): PageFile[] => {
  const pad = Math.max(3, String(files.length).length);
  return files.map((f, i) => ({ ...f, name: `${String(i + 1).padStart(pad, '0')}.${ext(f.name)}` }));
};

/**
 * Some sources cut a tall page into a full-size image plus a thin leftover strip (e.g. 800×1067
 * followed by 800×65). Atsumaru refuses the strip, so glue each one back onto the page before it,
 * then renumber so names stay contiguous. Pages that don't look like slivers are never re-encoded.
 */
export async function mergeSliverPages(files: PageFile[]): Promise<{ files: PageFile[]; merged: number }> {
  const dims = await Promise.all(files.map((f) => dimsOf(f.bytes)));
  const out: { file: PageFile; dims: Dims | null }[] = [];
  let merged = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const d = dims[i]!;
    const prev = out.at(-1);
    const isSliver = d && d.height < SLIVER_MAX_HEIGHT;
    if (isSliver && prev?.dims && prev.dims.width === d.width && prev.dims.height >= d.height * SLIVER_HOST_RATIO) {
      const joined = await stitchVertical([prev.file.bytes, file.bytes], prev.file.name);
      prev.file = { name: `${prev.file.name.replace(/\.\w+$/, '')}.${joined.ext}`, bytes: joined.bytes, parts: (prev.file.parts ?? 1) + (file.parts ?? 1) };
      prev.dims = { width: d.width, height: prev.dims.height + d.height };
      merged++;
    } else {
      out.push({ file, dims: d });
    }
  }

  if (merged === 0) return { files, merged };
  return { files: renumber(out.map((o) => o.file)), merged };
}
