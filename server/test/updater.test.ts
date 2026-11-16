import { describe, expect, it } from 'vitest';
import { compareSemver, Updater } from '../src/updater.ts';
import { buildApp } from '../src/app.ts';

describe('Updater', () => {
  it('compares semver strings accurately', () => {
    expect(compareSemver('0.2.0', '0.1.0')).toBe(1);
    expect(compareSemver('0.1.0', '0.1.0')).toBe(0);
    expect(compareSemver('0.1.0', '0.1.1')).toBe(-1);
    expect(compareSemver('v1.0.0', '0.9.9')).toBe(1);
  });

  it('reports remote commit and version from GitHub API', async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/commits/master')) {
        return new Response(
          JSON.stringify({ sha: 'abcdef1234567890', commit: { message: '[feat] newer release\n\ndetails' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/package.json')) {
        return new Response(JSON.stringify({ version: '0.2.0' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    };

    const updater = new Updater({ fetchImpl: fakeFetch });
    const status = await updater.check(true);
    expect(status.latestCommit).toBe('abcdef1');
    expect(status.latestVersion).toBe('0.2.0');
    expect(status.latestMessage).toBe('[feat] newer release');
    expect(status.updateAvailable).toBe(true);
    expect(status.error).toBeNull();
  });

  it('exposes GET /api/server/update on the Fastify app', async () => {
    const { app } = buildApp({
      dbFile: ':memory:',
      background: false,
      logger: false,
      fetchImpl: async () => new Response('rate limited', { status: 429 }),
    });
    const res = await app.inject({ method: 'GET', url: '/api/server/update?refresh=1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currentVersion).toBeTypeOf('string');
    expect(body.error).toContain('429');
    await app.close();
  });
});
