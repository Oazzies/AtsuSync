import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { mergeSliverPages, type PageFile } from '../src/upload/fixups.ts';

const img = async (name: string, width: number, height: number): Promise<PageFile> => ({
  name,
  bytes: await sharp({ create: { width, height, channels: 3, background: '#888' } }).jpeg().toBuffer(),
});
const size = async (f: PageFile) => {
  const m = await sharp(f.bytes).metadata();
  return [m.width, m.height];
};

describe('mergeSliverPages', () => {
  it('joins thin leftover strips onto the page before them and renumbers', async () => {
    const input = [
      await img('001.jpg', 800, 1067),
      await img('002.jpg', 800, 65),
      await img('003.jpg', 800, 1067),
      await img('004.jpg', 800, 65),
      await img('005.jpg', 800, 1067),
    ];
    const { files, merged } = await mergeSliverPages(input);
    expect(merged).toBe(2);
    expect(files.map((f) => f.name)).toEqual(['001.jpg', '002.jpg', '003.jpg']);
    expect(await size(files[0]!)).toEqual([800, 1132]);
    expect(await size(files[2]!)).toEqual([800, 1067]);
  });

  it('leaves pages untouched when nothing needs fixing', async () => {
    const input = [await img('001.jpg', 800, 1067), await img('002.jpg', 800, 1000)];
    const out = await mergeSliverPages(input);
    expect(out.merged).toBe(0);
    expect(out.files).toBe(input);
  });

  it('does not merge a short page with a different width, or a short page after a short page', async () => {
    const input = [await img('001.jpg', 800, 1067), await img('002.jpg', 640, 65), await img('003.jpg', 640, 65)];
    expect((await mergeSliverPages(input)).merged).toBe(0);
  });
});
