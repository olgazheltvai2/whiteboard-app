// Cloud storage via GitHub REST API + WebP image compression + private asset cache

import { IMAGE_LIMITS, STORAGE_KEYS, isGitHubConfigured } from './config.js';

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

function guessMime(path) {
  const p = path.toLowerCase();
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.gif')) return 'image/gif';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  return 'image/webp';
}

export class StorageService {
  constructor(config) {
    this.config = config;
    this.shaCache = new Map();
    this.assetUrlCache = new Map();
    this.pendingUploads = new Set();
  }

  setConfig(config) {
    this.config = config;
    this.shaCache.clear();
  }

  isCloudReady() {
    return isGitHubConfigured(this.config);
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

  async _getFileMeta(path) {
    const res = await fetch(this._contentsUrl(path, true), {
      headers: this._headers(),
      cache: 'no-store'
    });
    if (res.status === 404) return { exists: false };
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

  async _getBlobBase64(sha) {
    const { owner, repo } = this.config;
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${sha}`;
    const res = await fetch(url, { headers: this._headers(), cache: 'no-store' });
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

    // Retry once on SHA conflict (e.g., edited from another device)
    if (res.status === 409 || res.status === 422) {
      const meta = await this._getFileMeta(path);
      const freshSha = meta.exists ? meta.data.sha : undefined;
      res = await doPut(freshSha);
    }

    if (!res.ok) {
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

    // Cache locally for instant rendering
    this.assetUrlCache.set(assetPath, compressed.localUrl);

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

    // Local fallback: embed as data URL when GitHub is not connected yet
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

  async resolveAssetUrl(assetPath, inlineFallback = null) {
    if (!assetPath) return inlineFallback;
    if (this.assetUrlCache.has(assetPath)) {
      return this.assetUrlCache.get(assetPath);
    }
    if (inlineFallback) {
      this.assetUrlCache.set(assetPath, inlineFallback);
      return inlineFallback;
    }
    if (!this.isCloudReady()) return null;

    const meta = await this._getFileMeta(assetPath);
    if (!meta.exists) return null;

    let rawBase64 = meta.data.content;
    if (!rawBase64 && meta.data.sha) {
      rawBase64 = await this._getBlobBase64(meta.data.sha);
    }
    const blob = base64ToBlob(rawBase64, guessMime(assetPath));
    const url = URL.createObjectURL(blob);
    this.assetUrlCache.set(assetPath, url);
    return url;
  }
}
