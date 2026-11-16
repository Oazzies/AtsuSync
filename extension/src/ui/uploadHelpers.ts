import type { DownloadJob } from '@atsusync/shared';
import { api, fetchDownloadFile } from '../api';

/** Finds the chapter dropzone file input, skipping cover image and folder inputs. */
export function findUploadFileInput(): HTMLInputElement {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'));
  const input = inputs.find((el) => !el.webkitdirectory && el.accept !== 'image/*');
  if (!input) {
    throw new Error('Could not find file input on this page — use Save ZIP instead');
  }
  return input;
}

/** Prevents attaching an EPUB to a Comic-mode dropzone (which unpacks it as image pages and fails). */
export function assertUploadModeCompatible(input: HTMLInputElement, filename: string): void {
  if (!/\.epub$/i.test(filename)) return;
  const acceptsEpub = input.accept.split(',').some((t) => t.trim().toLowerCase() === '.epub');
  const hasComicFolderInput = !!document.querySelector('input[type="file"][webkitdirectory]');
  if (!acceptsEpub && (hasComicFolderInput || input.accept.trim() !== '')) {
    throw new Error(
      'This atsu.moe upload page is in Comic mode (expects image ZIPs, not EPUBs). Set the series Medium to "Novel" on atsu.moe before attaching.',
    );
  }
}

function toFile(bytes: Uint8Array, filename: string, mime: string): File {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new File([copy.buffer], filename, { type: mime });
}

/** Attaches one or more finished jobs to the current atsu.moe upload page and marks them uploaded. */
export async function attachJobsToUploadPage(jobs: DownloadJob[]): Promise<number[]> {
  if (!jobs.length) return [];
  const input = findUploadFileInput();
  const attached: number[] = [];

  if (input.multiple) {
    const dt = new DataTransfer();
    for (const job of jobs) {
      const { bytes, filename, mime } = await fetchDownloadFile(job.id);
      assertUploadModeCompatible(input, filename);
      dt.items.add(toFile(bytes, filename, mime));
    }
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await api.setChapterState(
      jobs.map((j) => j.chapterId),
      'uploaded',
    );
    return jobs.map((j) => j.id);
  }

  for (const job of jobs) {
    const { bytes, filename, mime } = await fetchDownloadFile(job.id);
    assertUploadModeCompatible(input, filename);
    const dt = new DataTransfer();
    dt.items.add(toFile(bytes, filename, mime));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await api.setChapterState([job.chapterId], 'uploaded');
    attached.push(job.id);
  }
  return attached;
}

/** Triggers a browser download for a finished job's ZIP/EPUB. */
export async function downloadJobToDisk(job: DownloadJob): Promise<void> {
  const { bytes, filename, mime } = await fetchDownloadFile(job.id);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
