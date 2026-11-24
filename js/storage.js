// Cloud storage via GitHub REST API + WebP image compression + IndexedDB persistent cache + concurrency queue

import { IMAGE_LIMITS, STORAGE_KEYS, isGitHubConfigured } from './config.js';

const IDB_NAME = 'whiteboard_asset_cache_v1';
const IDB_STORE = 'assets';
const MAX_CONCURRENT_ASSET_FETCHES = 6;

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToUtf8(b64) {
  const clean = b64.replace(/\s/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBlob(b64, mime = 'image/webp') {
  const clean = b64.replace(/\s/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

function guessMime(path) {
  const p = String(path || '').toLowerCase();
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.gif')) return 'image/gif';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  return 'image/webp';
}

// Lightweight IndexedDB wrapper for caching private GitHub image Blobs on disk
class AssetDiskCache {
  constructor() {
    this._dbPromise = null;
  }

  _open() {
    if (this._dbPromise) return this._dbPromise;
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    this._dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE, { keyPath: 'key' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this._dbPromise;
  }

  async get(key) {
    const db = await this._open();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result?.blob || null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async put(key, blob) {
    const db = await this._open();
    if (!db || !blob) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        store.put({ key, blob, ts: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }
}

export class StorageService {
  constructor(config) {
    this.config = config;
    this.shaCache = new Map();
    this.assetUrlCache = new Map();
    this.assetBlobCache = new Map();
    this.assetDataUrlCache = new Map();
    this.pendingUploads = new Set();
    this.remoteAssetResolver = null;
    this.diskCache = new AssetDiskCache();
    this.onRateLimit = null;

    // Concurrency queue & deduplication for lazy GitHub image fetching
    this._inFlightAssets = new Map();
    this._fetchQueue = [];
    this._activeFetches = 0;
    this._rateLimitedUntil = 0;
  }

  setRemoteAssetResolver(fn) {
    this.remoteAssetResolver = fn;
  }

  setRateLimitHandler(fn) {
    this.onRateLimit = fn;
  }

  getRepoKey() {
    if (!this.isCloudReady()) return 'local';
    return `${this.config.owner}/${this.config.repo}/${this.config.branch || 'main'}`;
  }

  _diskKey(assetPath) {
    return `${this.getRepoKey()}::${assetPath}`;
  }

  setConfig(config) {
    this.config = config;
    this.shaCache.clear();
    this.assetUrlCache.clear();
    this.assetBlobCache.clear();
    this.assetDataUrlCache.clear();
    this._rateLimitedUntil = 0;
  }

  isCloudReady() {
    return isGitHubConfigured(this.config);
  }

  hasCachedAsset(assetPath) {
    return Boolean(assetPath && this.assetUrlCache.has(assetPath));
  }

  getCachedAssetUrl(assetPath) {
    return assetPath ? (this.assetUrlCache.get(assetPath) || null) : null;
  }

  _headers(isJson = false) {
    const h = {
      Authorization: `Bearer ${this.config.token}`,
      Accept: 'application/vnd.github+json'
    };
    if (isJson) h['Content-Type'] = 'application/json';
    return h;
  }

  _contentsUrl(path, includeRef = false) {
    const { owner, repo, branch } = this.config;
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
    return includeRef ? `${base}?ref=${encodeURIComponent(branch)}` : base;
  }

  _checkRateLimitResponse(res) {
    if (res.status === 429 || (res.status === 403 && res.headers.get('X-RateLimit-Remaining') === '0')) {
      const resetEpoch = Number(res.headers.get('X-RateLimit-Reset') || 0);
      const waitMs = resetEpoch > 0 ? Math.max(15000, resetEpoch * 1000 - Date.now()) : 60000;
      const now = Date.now();
      const firstNotice = now > this._rateLimitedUntil;
      this._rateLimitedUntil = now + Math.min(waitMs, 10 * 60 * 1000);
      if (firstNotice && this.onRateLimit) {
        this.onRateLimit(Math.ceil(waitMs / 60000));
      }
      return true;
    }
    return false;
  }

  async testConnection(testCfg) {
    const cfg = testCfg || this.config;
    if (!isGitHubConfigured(cfg)) {
      return { ok: false, message: 'Заповніть логін, назву репозиторію та токен.' };
    }
    try {
      const url = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: 'application/vnd.github+json'
        },
        cache: 'no-store'
      });
      if (res.status === 401) {
        return { ok: false, message: 'Токен недійсний або скопійований не повністю (401).' };
      }
      if (res.status === 404) {
        return { ok: false, message: 'Репозиторій не знайдено або токен не має до нього доступу (404).' };
      }
      if (!res.ok) {
        return { ok: false, message: `Помилка GitHub API: ${res.status}` };
      }
      const data = await res.json();
      const canPush = data.permissions ? data.permissions.push : true;
      if (!canPush) {
        return { ok: false, message: 'Репозиторій знайдено, але немає права на запис (Contents: Read and write).' };
      }
      return {
        ok: true,
        message: `Підключено до ${data.full_name} (${data.private ? 'приватний' : 'публічний'})!`
      };
    } catch (err) {
      return { ok: false, message: `Немає зв'язку з GitHub: ${err.message}` };
    }
  }

  async _getFileMeta(path, signal = null) {
    const opts = {
      headers: this._headers(),
      cache: 'no-store'
    };
    if (signal) opts.signal = signal;
    const res = await fetch(this._contentsUrl(path, true), opts);
    if (res.status === 404) return { exists: false };
    this._checkRateLimitResponse(res);
    if (!res.ok) throw new Error(`GitHub GET ${path} failed (${res.status})`);
    const data = await res.json();
    if (data.sha) this.shaCache.set(path, data.sha);
    return { exists: true, data };
  }

  async getJson(path) {
    const meta = await this._getFileMeta(path);
    if (!meta.exists) return null;
    let rawBase64 = meta.data.content;
    if (!rawBase64 && meta.data.sha) {
      rawBase64 = await this._getBlobBase64(meta.data.sha);
    }
    return JSON.parse(base64ToUtf8(rawBase64));
  }

  async _getBlobBase64(sha, signal = null) {
    const { owner, repo } = this.config;
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${sha}`;
    const opts = { headers: this._headers(), cache: 'no-store' };
    if (signal) opts.signal = signal;
    const res = await fetch(url, opts);
    this._checkRateLimitResponse(res);
    if (!res.ok) throw new Error(`GitHub Blob ${sha} failed (${res.status})`);
    const data = await res.json();
    return data.content;
  }

  async putBase64(path, base64Content, message) {
    let sha = this.shaCache.get(path);
    if (!sha) {
      try {
        const meta = await this._getFileMeta(path);
        if (meta.exists) sha = meta.data.sha;
      } catch {
        // Ignore if file doesn't exist yet
      }
    }

    const doPut = async (currentSha) => {
      const body = {
        message,
        content: base64Content,
        branch: this.config.branch
      };
      if (currentSha) body.sha = currentSha;
      return fetch(this._contentsUrl(path, false), {
        method: 'PUT',
        headers: this._headers(true),
        body: JSON.stringify(body)
      });
    };

    let res = await doPut(sha);

    if (res.status === 409 || res.status === 422) {
      const meta = await this._getFileMeta(path);
      const freshSha = meta.exists ? meta.data.sha : undefined;
      res = await doPut(freshSha);
    }

    if (!res.ok) {
      this._checkRateLimitResponse(res);
      const text = await res.text();
      throw new Error(`GitHub PUT ${path} failed (${res.status}): ${text}`);
    }

    const saved = await res.json();
    if (saved.content && saved.content.sha) {
      this.shaCache.set(path, saved.content.sha);
    }
    return saved;
  }

  async putJson(path, obj, message) {
    const b64 = utf8ToBase64(JSON.stringify(obj));
    return this.putBase64(path, b64, message);
  }

  async deleteFile(path, message) {
    let sha = this.shaCache.get(path);
    if (!sha) {
      const meta = await this._getFileMeta(path);
      if (!meta.exists) return;
      sha = meta.data.sha;
    }
    const res = await fetch(this._contentsUrl(path, false), {
      method: 'DELETE',
      headers: this._headers(true),
      body: JSON.stringify({
        message,
        sha,
        branch: this.config.branch
      })
    });
    if (res.ok || res.status === 404) {
      this.shaCache.delete(path);
    }
  }

  // --- High-level Board Index & Board CRUD ---

  async loadIndex() {
    if (!this.isCloudReady()) {
      const raw = localStorage.getItem(STORAGE_KEYS.LOCAL_INDEX);
      return raw ? JSON.parse(raw) : { version: 1, boards: [] };
    }
    const idx = await this.getJson('index.json');
    return idx || { version: 1, boards: [] };
  }

  async saveIndex(indexObj) {
    if (!this.isCloudReady()) {
      localStorage.setItem(STORAGE_KEYS.LOCAL_INDEX, JSON.stringify(indexObj));
      return;
    }
    await this.putJson('index.json', indexObj, 'Update boards index');
  }

  async loadBoard(boardId) {
    if (!this.isCloudReady()) {
      const raw = localStorage.getItem(STORAGE_KEYS.LOCAL_BOARD_PREFIX + boardId);
      return raw ? JSON.parse(raw) : null;
    }
    return this.getJson(`boards/${boardId}.json`);
  }

  async saveBoard(boardData) {
    await this.waitForPendingUploads();
    if (!this.isCloudReady()) {
      localStorage.setItem(STORAGE_KEYS.LOCAL_BOARD_PREFIX + boardData.id, JSON.stringify(boardData));
      return;
    }
    await this.putJson(`boards/${boardData.id}.json`, boardData, `Save board ${boardData.title || boardData.id}`);
  }

  async deleteBoard(boardId) {
    if (!this.isCloudReady()) {
      localStorage.removeItem(STORAGE_KEYS.LOCAL_BOARD_PREFIX + boardId);
      return;
    }
    await this.deleteFile(`boards/${boardId}.json`, `Delete board ${boardId}`);
  }

  // --- Image Compression & Private Asset Handling ---

  async compressImage(fileOrBlob) {
    const bitmap = await createImageBitmap(fileOrBlob);
    let { width, height } = bitmap;
    const maxDim = IMAGE_LIMITS.MAX_DIMENSION;

    if (width > maxDim || height > maxDim) {
      const scale = maxDim / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    let blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/webp', IMAGE_LIMITS.WEBP_QUALITY)
    );
    let ext = 'webp';

    if (!blob || blob.type !== 'image/webp') {
      blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      ext = 'png';
    }

    const buffer = await blob.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    const localUrl = URL.createObjectURL(blob);

    return { blob, base64, localUrl, width, height, ext };
  }

  async uploadImage(fileOrBlob) {
    const compressed = await this.compressImage(fileOrBlob);
    const fileName = `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.${compressed.ext}`;
    const assetPath = `assets/${fileName}`;

    // Cache in memory & IndexedDB immediately
    const dataUrlForLive = `data:image/${compressed.ext};base64,${compressed.base64}`;
    this.assetUrlCache.set(assetPath, compressed.localUrl);
    this.assetBlobCache.set(assetPath, compressed.blob);
    this.assetDataUrlCache.set(assetPath, dataUrlForLive);
    this.diskCache.put(this._diskKey(assetPath), compressed.blob).catch(() => {});

    if (this.isCloudReady()) {
      const uploadPromise = this.putBase64(assetPath, compressed.base64, `Add image ${fileName}`)
        .finally(() => this.pendingUploads.delete(uploadPromise));
      this.pendingUploads.add(uploadPromise);
      return {
        assetPath,
        localUrl: compressed.localUrl,
        width: compressed.width,
        height: compressed.height,
        uploadPromise
      };
    }

    const dataUrl = `data:image/${compressed.ext};base64,${compressed.base64}`;
    this.assetUrlCache.set(assetPath, dataUrl);
    return {
      assetPath,
      inlineDataUrl: dataUrl,
      localUrl: dataUrl,
      width: compressed.width,
      height: compressed.height,
      uploadPromise: Promise.resolve()
    };
  }

  async waitForPendingUploads() {
    if (this.pendingUploads.size > 0) {
      await Promise.allSettled([...this.pendingUploads]);
    }
  }

  // --- Concurrency-limited Queue for GitHub Asset Fetching ---

  _enqueueFetch(taskFn, signal = null) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }

      const entry = { taskFn, signal, resolve, reject, cancelled: false };

      if (signal) {
        const onAbort = () => {
          entry.cancelled = true;
          const idx = this._fetchQueue.indexOf(entry);
          if (idx !== -1) {
            this._fetchQueue.splice(idx, 1);
            reject(new DOMException('Aborted', 'AbortError'));
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this._fetchQueue.push(entry);
      this._drainFetchQueue();
    });
  }

  _drainFetchQueue() {
    while (this._activeFetches < MAX_CONCURRENT_ASSET_FETCHES && this._fetchQueue.length > 0) {
      const entry = this._fetchQueue.shift();
      if (!entry || entry.cancelled || (entry.signal && entry.signal.aborted)) {
        continue;
      }
      this._activeFetches += 1;
      Promise.resolve()
        .then(() => entry.taskFn(entry.signal))
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this._activeFetches -= 1;
          this._drainFetchQueue();
        });
    }
  }

  async resolveAssetFromCacheOnly(assetPath, inlineFallback = null) {
    if (!assetPath) return inlineFallback;
    if (this.assetUrlCache.has(assetPath)) {
      return this.assetUrlCache.get(assetPath);
    }
    if (inlineFallback) {
      this.assetUrlCache.set(assetPath, inlineFallback);
      this.assetDataUrlCache.set(assetPath, inlineFallback);
      return inlineFallback;
    }
    const diskBlob = await this.diskCache.get(this._diskKey(assetPath));
    if (diskBlob) {
      const url = URL.createObjectURL(diskBlob);
      this.assetBlobCache.set(assetPath, diskBlob);
      this.assetUrlCache.set(assetPath, url);
      return url;
    }
    return null;
  }

  async resolveAssetUrl(assetPath, inlineFallback = null, { signal = null } = {}) {
    if (!assetPath) return inlineFallback;
    if (this.assetUrlCache.has(assetPath)) {
      return this.assetUrlCache.get(assetPath);
    }
    if (inlineFallback) {
      this.assetUrlCache.set(assetPath, inlineFallback);
      this.assetDataUrlCache.set(assetPath, inlineFallback);
      return inlineFallback;
    }

    // Live student mode: fetch from temporary Firebase room assets
    if (this.remoteAssetResolver) {
      const remoteUrl = await this.remoteAssetResolver(assetPath);
      if (remoteUrl) {
        this.assetUrlCache.set(assetPath, remoteUrl);
        this.assetDataUrlCache.set(assetPath, remoteUrl);
        return remoteUrl;
      }
    }

    // Persistent laptop disk cache (IndexedDB) — 0 GitHub API requests!
    const diskBlob = await this.diskCache.get(this._diskKey(assetPath));
    if (diskBlob) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const url = URL.createObjectURL(diskBlob);
      this.assetBlobCache.set(assetPath, diskBlob);
      this.assetUrlCache.set(assetPath, url);
      return url;
    }

    if (!this.isCloudReady()) return null;
    if (Date.now() < this._rateLimitedUntil) {
      throw new Error('GitHub rate limit pause');
    }

    // Deduplicate simultaneous requests for the exact same assetPath
    if (this._inFlightAssets.has(assetPath)) {
      return this._inFlightAssets.get(assetPath);
    }

    const fetchPromise = this._enqueueFetch(async (sig) => {
      const meta = await this._getFileMeta(assetPath, sig);
      if (!meta.exists) return null;

      let rawBase64 = meta.data.content;
      if (!rawBase64 && meta.data.sha) {
        rawBase64 = await this._getBlobBase64(meta.data.sha, sig);
      }
      const mime = guessMime(assetPath);
      const cleanB64 = rawBase64.replace(/\s/g, '');
      const blob = base64ToBlob(cleanB64, mime);
      const url = URL.createObjectURL(blob);

      this.assetBlobCache.set(assetPath, blob);
      this.assetUrlCache.set(assetPath, url);
      this.assetDataUrlCache.set(assetPath, `data:${mime};base64,${cleanB64}`);
      this.diskCache.put(this._diskKey(assetPath), blob).catch(() => {});
      return url;
    }, signal).finally(() => {
      this._inFlightAssets.delete(assetPath);
    });

    this._inFlightAssets.set(assetPath, fetchPromise);
    return fetchPromise;
  }

  async getAssetBlob(assetPath, inlineFallback = null) {
    if (assetPath && this.assetBlobCache.has(assetPath)) {
      return this.assetBlobCache.get(assetPath);
    }
    const url = await this.resolveAssetUrl(assetPath, inlineFallback);
    if (!url) return null;
    if (assetPath && this.assetBlobCache.has(assetPath)) {
      return this.assetBlobCache.get(assetPath);
    }
    const res = await fetch(url);
    const blob = await res.blob();
    if (assetPath) this.assetBlobCache.set(assetPath, blob);
    return blob;
  }

  // Always converts to image/png Blob because OS clipboard ClipboardItem universally requires image/png
  async getAssetPngBlob(assetPath, inlineFallback = null) {
    const blob = await this.getAssetBlob(assetPath, inlineFallback);
    if (!blob) return null;
    if (blob.type === 'image/png') return blob;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  async getAssetDataUrl(assetPath, inlineFallback = null) {
    if (!assetPath) return inlineFallback;
    if (this.assetDataUrlCache.has(assetPath)) {
      return this.assetDataUrlCache.get(assetPath);
    }
    if (inlineFallback) {
      this.assetDataUrlCache.set(assetPath, inlineFallback);
      return inlineFallback;
    }
    const blob = await this.getAssetBlob(assetPath, inlineFallback);
    if (!blob) return null;
    const dataUrl = await blobToDataUrl(blob);
    this.assetDataUrlCache.set(assetPath, dataUrl);
    return dataUrl;
  }
}
