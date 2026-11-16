import type { ServerEvent } from '@atsusync/shared';
import type { BgRequest, BgResponse } from './api';

const API_BASE = 'http://127.0.0.1:4517/api';
let lastSyncedCookie = '';
let cookieSyncTimer: ReturnType<typeof setTimeout> | null = null;

async function callServer<T>(method: string, path: string, body?: unknown): Promise<BgResponse<T>> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: (data as { error?: string }).error ?? `${res.status} ${res.statusText}`,
      };
    }
    return { ok: true, data: data as T };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 0,
      error: msg.includes('Failed to fetch') ? 'AtsuSync server offline (run npm start)' : msg,
    };
  }
}

const FILE_CHUNK_BYTES = 3 * 1024 * 1024; // 3 MiB binary -> ~4 MiB base64, well under Chrome's 64 MiB IPC limit

function uint8ToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const sliceSize = 0x8000;
  for (let i = 0; i < bytes.length; i += sliceSize) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + sliceSize)));
  }
  return btoa(parts.join(''));
}

function parseFilename(disp: string): string {
  const utf8 = disp.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].trim());
    } catch {
      /* fall through */
    }
  }
  const basic = disp.match(/filename="?([^";]+)"?/i);
  return basic?.[1] ?? 'chapter.zip';
}

async function streamFileToPort(port: chrome.runtime.Port, path: string): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}${path}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      port.postMessage({ type: 'error', error: (data as { error?: string }).error ?? `${res.status} ${res.statusText}` });
      return;
    }
    const filename = parseFilename(res.headers.get('content-disposition') ?? '');
    const mime = res.headers.get('content-type') ?? 'application/zip';
    const buf = new Uint8Array(await res.arrayBuffer());
    port.postMessage({ type: 'meta', filename, mime, totalBytes: buf.byteLength });
    for (let offset = 0; offset < buf.byteLength; offset += FILE_CHUNK_BYTES) {
      const chunk = buf.subarray(offset, Math.min(offset + FILE_CHUNK_BYTES, buf.byteLength));
      port.postMessage({ type: 'chunk', b64: uint8ToBase64(chunk) });
    }
    port.postMessage({ type: 'end' });
  } catch (err) {
    try {
      port.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    } catch {
      /* port already closed */
    }
  }
}

async function readAtsuCookieHeader(): Promise<string> {
  const cookies = await chrome.cookies.getAll({ url: 'https://atsu.moe' });
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function syncAtsuCookies(force = false): Promise<BgResponse<unknown>> {
  const header = await readAtsuCookieHeader();
  if (!header) return { ok: false, error: 'No atsu.moe cookies found (sign in on atsu.moe first)' };
  if (!force && header === lastSyncedCookie) {
    return callServer('GET', '/settings');
  }
  const res = await callServer('PUT', '/settings', { atsuCookie: header });
  if (res.ok) lastSyncedCookie = header;
  return res;
}

function scheduleCookieSync(): void {
  if (cookieSyncTimer) clearTimeout(cookieSyncTimer);
  cookieSyncTimer = setTimeout(() => {
    cookieSyncTimer = null;
    void syncAtsuCookies(false);
  }, 500);
}

chrome.cookies.onChanged.addListener((info) => {
  if (info.cookie.domain.includes('atsu.moe')) {
    scheduleCookieSync();
  }
});

// Broadcast server SSE events to open side panels and atsu.moe tabs.
async function broadcastEvent(event: ServerEvent): Promise<void> {
  chrome.runtime.sendMessage({ type: 'serverEvent', event }).catch(() => {});
  const tabs = await chrome.tabs.query({ url: ['https://atsu.moe/*'] }).catch(() => []);
  for (const tab of tabs) {
    if (tab.id !== undefined) {
      chrome.tabs.sendMessage(tab.id, { type: 'serverEvent', event }).catch(() => {});
    }
  }

  const iconUrl = chrome.runtime.getURL('icons/icon-120.png');
  if (event.type === 'new_chapters') {
    chrome.notifications.create(`new-${event.linkId}-${Date.now()}`, {
      type: 'basic',
      iconUrl,
      title: `${event.seriesTitle}: ${event.labels.length} new chapter${event.labels.length === 1 ? '' : 's'}`,
      message: event.labels.slice(0, 3).join(', '),
    });
  } else if (event.type === 'chapters_unlocked') {
    chrome.notifications.create(`unlocked-${event.linkId}-${Date.now()}`, {
      type: 'basic',
      iconUrl,
      title: `${event.seriesTitle}: ${event.labels.length} unlocked`,
      message: event.labels.slice(0, 3).join(', '),
    });
  } else if (event.type === 'downloads_complete') {
    chrome.notifications.create(`dl-done-${event.linkId}-${Date.now()}`, {
      type: 'basic',
      iconUrl,
      title: `${event.seriesTitle}: All chapters downloaded`,
      message: `${event.count} chapter ZIP${event.count === 1 ? '' : 's'} ready to attach on upload`,
    });
  }
}

let eventLoopRunning = false;
async function startEventStream(): Promise<void> {
  if (eventLoopRunning) return;
  eventLoopRunning = true;
  while (eventLoopRunning) {
    try {
      const res = await fetch(`${API_BASE}/events`);
      if (!res.ok || !res.body) throw new Error('SSE unavailable');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                const ev = JSON.parse(line.slice(6)) as ServerEvent;
                void broadcastEvent(ev);
              } catch {
                /* ignore malformed */
              }
            }
          }
        }
      }
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void syncAtsuCookies(true);
  void startEventStream();
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void syncAtsuCookies(true);
  void startEventStream();
});

const sidePanelPorts = new Map<number, chrome.runtime.Port>();

function broadcastSidePanelState(windowId: number, open: boolean) {
  chrome.tabs.query({ windowId }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id !== undefined) {
        void chrome.tabs.sendMessage(tab.id, { type: 'sidePanelState', open }).catch(() => {});
      }
    }
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    let windowId: number | null = null;
    port.onMessage.addListener((msg: { type?: string; windowId?: number }) => {
      if (msg?.type === 'init' && typeof msg.windowId === 'number') {
        windowId = msg.windowId;
        sidePanelPorts.set(windowId, port);
        broadcastSidePanelState(windowId, true);
      }
    });
    port.onDisconnect.addListener(() => {
      if (windowId !== null && sidePanelPorts.get(windowId) === port) {
        sidePanelPorts.delete(windowId);
        broadcastSidePanelState(windowId, false);
      }
    });
    return;
  }
  if (port.name !== 'fetchFile') return;
  void startEventStream();
  port.onMessage.addListener((msg: { path?: string }) => {
    if (msg?.path) void streamFileToPort(port, msg.path);
  });
});

chrome.runtime.onMessage.addListener((msg: BgRequest, sender, sendResponse) => {
  void startEventStream();
  if (msg.type === 'api') {
    void callServer(msg.method, msg.path, msg.body).then(sendResponse);
    return true;
  }
  if (msg.type === 'syncCookies') {
    void syncAtsuCookies(true).then(sendResponse);
    return true;
  }
  if (msg.type === 'toggleSidePanel') {
    const winId = sender.tab?.windowId;
    if (winId !== undefined) {
      const openPort = sidePanelPorts.get(winId);
      if (openPort) {
        try {
          openPort.postMessage({ type: 'close' });
        } catch {
          sidePanelPorts.delete(winId);
          void chrome.sidePanel.open({ windowId: winId });
        }
      } else {
        void chrome.sidePanel.open({ windowId: winId });
      }
    }
    sendResponse({ ok: true, data: null });
    return false;
  }
  if (msg.type === 'getSidePanelState') {
    const winId = sender.tab?.windowId;
    sendResponse({ ok: true, data: winId !== undefined && sidePanelPorts.has(winId) });
    return false;
  }
  return false;
});
