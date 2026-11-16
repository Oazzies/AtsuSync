import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Downloads a .zip (Windows) or .tar.gz (Unix) archive and extracts it into `destDir`. */
export async function downloadAndExtractArchive(
  url: string,
  destDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  const isZip = process.platform === 'win32';
  const archivePath = join(destDir, isZip ? 'runtime.zip' : 'runtime.tar.gz');
  const tmpPath = `${archivePath}.tmp`;

  const res = await fetchImpl(url, { headers: { 'user-agent': 'AtsuSync' } });
  if (!res.ok) {
    throw new Error(`Failed to download runtime (${url}): HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(tmpPath, buf);
  renameSync(tmpPath, archivePath);

  try {
    if (isZip) {
      await execFileAsync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`],
        { timeout: 180_000 },
      );
    } else {
      await execFileAsync('tar', ['-xzf', archivePath, '-C', destDir], { timeout: 180_000 });
    }
  } finally {
    rmSync(archivePath, { force: true });
  }
}

/** Recursively searches `dir` (up to `maxDepth`) for a file matching `fileName`. */
export function findFileRecursive(dir: string, fileName: string, maxDepth = 4): string | null {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return full;
      if (entry.isDirectory() && maxDepth > 0) {
        const found = findFileRecursive(full, fileName, maxDepth - 1);
        if (found) return found;
      }
    }
  } catch {
    // ignore missing/unreadable dirs
  }
  return null;
}
