// Opt-in smoke test against the real sites: `npm run test:live`. Makes ~4 requests.
import { describe, expect, it } from 'vitest';
import { nuviatoon } from '../src/sources/adapters/nuviatoon.ts';
import { SourceHttp } from '../src/sources/http.ts';
import { AtsuClient } from '../src/atsu/client.ts';

describe('live', () => {
  const http = new SourceHttp();
  http.configureHost('nuviatoon.net', nuviatoon.rateLimit);

  it('nuviatoon search + series still parse', async () => {
    const hits = await nuviatoon.search('Heart Aching', http);
    expect(hits.some((h) => h.url.endsWith('/comics/heart-aching'))).toBe(true);
    await expect(http.assertAllowed('https://nuviatoon.net/search?q=x')).rejects.toThrow(/robots/);
    const s = await nuviatoon.getSeries('https://nuviatoon.net/comics/heart-aching', http);
    expect(s.chapters.length).toBeGreaterThan(30);
  }, 30_000);

  it('atsu forum still returns posts', async () => {
    const page = await new AtsuClient(() => '').listPosts(0);
    expect(page.posts.length).toBeGreaterThan(0);
  }, 30_000);
});
