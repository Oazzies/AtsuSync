import { createHash } from 'node:crypto';
import { escapeXml } from '../sources/novel.ts';
import { createZip } from './zip.ts';

export interface EpubImage {
  /** The `src` used in the chapter XHTML. */
  src: string;
  bytes: Uint8Array;
  mediaType: string;
}

export interface EpubInput {
  /** Series title (dc:title is "<series> - <chapter>"). */
  seriesTitle: string;
  chapterTitle: string;
  /** Well-formed XHTML block content (see chapterXhtml). */
  bodyHtml: string;
  images?: EpubImage[];
  language?: string;
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

/** The media type for an image, from the response header, falling back to magic bytes. */
export function imageMediaType(bytes: Uint8Array, header: string | null): string | null {
  const h = header?.split(';')[0]?.trim().toLowerCase();
  if (h && EXT[h]) return h;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[8] === 0x57) return 'image/webp';
  return null;
}

/**
 * A minimal, valid EPUB 3 holding one chapter. Atsumaru's upload page takes .epub for novels;
 * everything is stored uncompressed (the mimetype entry must be first and uncompressed anyway).
 */
export function createEpub(input: EpubInput): Buffer {
  const lang = input.language ?? 'en';
  const title = `${input.seriesTitle} - ${input.chapterTitle}`;
  const id = `urn:uuid:${uuidFrom(title + input.bodyHtml.length)}`;
  const images = input.images ?? [];

  let body = input.bodyHtml;
  const imageEntries = images.map((img, i) => {
    const name = `images/img-${String(i + 1).padStart(3, '0')}.${EXT[img.mediaType] ?? 'jpg'}`;
    body = body.split(`src="${escapeXml(img.src)}"`).join(`src="${name}"`);
    return { name, img };
  });

  const chapter = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}">
<head><meta charset="utf-8"/><title>${escapeXml(input.chapterTitle)}</title></head>
<body>
<h1>${escapeXml(input.chapterTitle)}</h1>
${body}
</body>
</html>
`;
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}">
<head><meta charset="utf-8"/><title>${escapeXml(title)}</title></head>
<body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">${escapeXml(input.chapterTitle)}</a></li></ol></nav></body>
</html>
`;
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${id}</dc:identifier>
<dc:title>${escapeXml(title)}</dc:title>
<dc:language>${lang}</dc:language>
<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
${imageEntries.map((e, i) => `<item id="img${i + 1}" href="${e.name}" media-type="${e.img.mediaType}"/>`).join('\n')}
</manifest>
<spine><itemref idref="chapter"/></spine>
</package>
`;
  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`;
  const text = (s: string) => new TextEncoder().encode(s);
  return createZip([
    { name: 'mimetype', bytes: text('application/epub+zip') },
    { name: 'META-INF/container.xml', bytes: text(container) },
    { name: 'OEBPS/content.opf', bytes: text(opf) },
    { name: 'OEBPS/nav.xhtml', bytes: text(nav) },
    { name: 'OEBPS/chapter.xhtml', bytes: text(chapter) },
    ...imageEntries.map((e) => ({ name: `OEBPS/${e.name}`, bytes: e.img.bytes })),
  ]);
}

function uuidFrom(seed: string): string {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
