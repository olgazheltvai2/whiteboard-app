// Board objects: Images, Text (Propysy/cursive), Sticky Notes + Viewport Virtualization & Lazy Loading

import { IMAGE_LIMITS, MARKER_COLORS, NOTE_COLORS, getFontPreset, uid } from './config.js';

const VIRTUALIZE_THRESHOLD = 180;
const MAX_UNCACHED_IMAGES_PER_VIEW = 95;
const MIN_IMAGE_SCREEN_PX = 20;

export class ObjectsManager {
  constructor({
    layerEl,
    viewport,
    storage,
    onMutate,
    onLiveObjectUpdate,
    onEditStateChange,
    getNextZIndex,
    getSelectedIds = () => new Set(),
    getAnchorObjectId = () => null,
    onMarkersChange = () => {}
  }) {
    this.layerEl = layerEl;
    this.viewport = viewport;
    this.storage = storage;
    this.onMutate = onMutate;
    this.onLiveObjectUpdate = onLiveObjectUpdate || (() => {});
    this.onEditStateChange = onEditStateChange || (() => {});
    this.getNextZIndex = getNextZIndex || (() => this._localMaxZ() + 1);
    this.getSelectedIds = getSelectedIds;
    this.getAnchorObjectId = getAnchorObjectId;
    this.onMarkersChange = onMarkersChange;

    this.objects = [];
    this.objectMap = new Map();
    this.editingId = null;
    this.domMap = new Map();
    this.abortMap = new Map();
    this._lastTextEmitAt = 0;
    this._syncTimer = null;
    this._rafScheduled = false;

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => this.autoFitVisibleTexts());
    }
  }

  _rebuildObjectMap() {
    this.objectMap.clear();
    for (const o of this.objects) {
      this.objectMap.set(o.id, o);
    }
  }

  _localMaxZ() {
    if (!this.objects.length) return 0;
    let m = 0;
    for (const o of this.objects) {
      if ((o.zIndex || 1) > m) m = o.zIndex || 1;
    }
    return m;
  }

  isVirtualized() {
    return this.objects.length > VIRTUALIZE_THRESHOLD;
  }

  setObjects(list) {
    this.editingId = null;
    this._abortAllPending();
    this.objects = Array.isArray(list) ? list : [];
    this._rebuildObjectMap();
    this.renderAll();
    this.onMarkersChange();
  }

  getObjects() {
    return this.objects;
  }

  getById(id) {
    return this.objectMap.get(id) || null;
  }

  isEditing() {
    return Boolean(this.editingId);
  }

  _abortAllPending() {
    for (const ctrl of this.abortMap.values()) {
      try { ctrl.abort(); } catch {}
    }
    this.abortMap.clear();
  }

  _unmountObject(id) {
    const ctrl = this.abortMap.get(id);
    if (ctrl) {
      try { ctrl.abort(); } catch {}
      this.abortMap.delete(id);
    }
    const el = this.domMap.get(id);
    if (el) {
      el.remove();
      this.domMap.delete(id);
    }
  }

  async addImageFromFile(file, worldPoint = null) {
    const center = worldPoint || this.viewport.getCenterWorld();
    const uploaded = await this.storage.uploadImage(file);

    const maxW = IMAGE_LIMITS.INITIAL_DISPLAY_MAX_WIDTH;
    const scale = uploaded.width > maxW ? maxW / uploaded.width : 1;
    const w = Math.max(80, Math.round(uploaded.width * scale));
    const h = Math.max(60, Math.round(uploaded.height * scale));

    const obj = {
      id: uid('img'),
      type: 'image',
      x: Math.round(center.x - w / 2),
      y: Math.round(center.y - h / 2),
      w,
      h,
      rotation: 0,
      zIndex: this.getNextZIndex(),
      locked: false,
      assetPath: uploaded.assetPath,
      aspectRatio: uploaded.width / uploaded.height
    };
    if (uploaded.inlineDataUrl) {
      obj.inlineDataUrl = uploaded.inlineDataUrl;
    }

    this.objects.push(obj);
    this.objectMap.set(obj.id, obj);
    this._mountObject(obj, { allowNetwork: true });
    this.onMutate('add-image', { changedObjectIds: [obj.id] });
    return { obj, uploadPromise: uploaded.uploadPromise };
  }

  addTextAt(worldPoint, defaultColor = '#f3f5f9', initialText = '', fontFamily = 'sans') {
    const isPropysy = fontFamily === 'propysy' || fontFamily === 'propysy-bold';
    const preset = getFontPreset(fontFamily || 'sans');
    const baseSize = isPropysy ? 28 : 22;
    const renderPx = Math.round(baseSize * preset.sizeScale);
    const lines = initialText ? initialText.split('\n').length : 1;
    const longestLine = initialText
      ? Math.max(...initialText.split('\n').map((l) => l.length))
      : 0;
    const w = initialText
      ? Math.min(620, Math.max(260, longestLine * Math.round(renderPx * 0.56) + 52))
      : (isPropysy ? 320 : 280);
    const vertPad = renderPx * ((preset.padTop || 0.15) + (preset.padBottom || 0.2));
    const h = Math.max(
      isPropysy ? 140 : 76,
      Math.ceil(lines * renderPx * preset.lineHeight + vertPad + 20)
    );
    const obj = {
      id: uid('txt'),
      type: 'text',
      x: Math.round(worldPoint.x - w / 2),
      y: Math.round(worldPoint.y - h / 2),
      w,
      h,
      rotation: 0,
      zIndex: this.getNextZIndex(),
      locked: false,
      text: initialText,
      fontSize: baseSize,
      fontFamily: fontFamily || 'sans',
      color: defaultColor
    };
    this.objects.push(obj);
    this.objectMap.set(obj.id, obj);
    this._mountObject(obj, { allowNetwork: true });
    this.autoFitTextHeight(obj);
    this.onMutate('add-text', { changedObjectIds: [obj.id] });
    return obj;
  }

  addNoteAt(worldPoint, fontFamily = 'sans') {
    const palette = NOTE_COLORS[this.objects.length % NOTE_COLORS.length];
    const obj = {
      id: uid('note'),
      type: 'note',
      x: Math.round(worldPoint.x - 105),
      y: Math.round(worldPoint.y - 95),
      w: 210,
      h: 190,
      rotation: 0,
      zIndex: this.getNextZIndex(),
      locked: false,
      text: '',
      fontSize: (fontFamily === 'propysy' || fontFamily === 'propysy-bold') ? 24 : 18,
      fontFamily: fontFamily || 'sans',
      bg: palette.bg,
      color: palette.text
    };
    this.objects.push(obj);
    this.objectMap.set(obj.id, obj);
    this._mountObject(obj, { allowNetwork: true });
    this.onMutate('add-note', { changedObjectIds: [obj.id] });
    return obj;
  }


  getMarkers() {
    return this.objects
      .filter((o) => o.type === 'marker')
      .sort((a, b) => {
        const ao = typeof a.order === 'number' ? a.order : Infinity;
        const bo = typeof b.order === 'number' ? b.order : Infinity;
        if (ao !== bo) return ao - bo;
        return String(a.label || '').localeCompare(String(b.label || ''), 'uk', { numeric: true, sensitivity: 'base' });
      });
  }

  getNextMarkerLabel() {
    const usedNums = new Set();
    for (const o of this.objects) {
      if (o.type !== 'marker') continue;
      const n = Number(String(o.label || '').trim());
      if (Number.isInteger(n) && n > 0) usedNums.add(n);
    }
    let next = 1;
    while (usedNums.has(next)) next += 1;
    return String(next);
  }

  _calcMarkerWidth(label) {
    const len = String(label || '').trim().length;
    return Math.max(92, Math.min(340, Math.round(len * 11.5 + 62)));
  }

  addMarkerAt(worldPoint, label = '', color = '') {
    const cleanLabel = String(label || '').trim() || this.getNextMarkerLabel();
    const existingMarkers = this.getMarkers();
    const maxOrder = existingMarkers.reduce((m, mk, idx) => Math.max(m, typeof mk.order === 'number' ? mk.order : idx), -1);
    const chosenColor = color || MARKER_COLORS[existingMarkers.length % MARKER_COLORS.length];
    const w = this._calcMarkerWidth(cleanLabel);
    const h = 44;
    const obj = {
      id: uid('mrk'),
      type: 'marker',
      x: Math.round(worldPoint.x - w / 2),
      y: Math.round(worldPoint.y - h / 2),
      w,
      h,
      rotation: 0,
      zIndex: this.getNextZIndex(),
      locked: false,
      label: cleanLabel,
      color: chosenColor,
      order: maxOrder + 1
    };
    this.objects.push(obj);
    this.objectMap.set(obj.id, obj);
    this._mountObject(obj, { allowNetwork: true });
    this.onMarkersChange();
    this.onMutate('add-marker', { changedObjectIds: [obj.id] });
    return obj;
  }


  reorderMarker(draggedId, targetId, position = 'before') {
    if (!draggedId || !targetId || draggedId === targetId) return false;
    const list = this.getMarkers();
    const fromIdx = list.findIndex((m) => m.id === draggedId);
    const targetIdx = list.findIndex((m) => m.id === targetId);
    if (fromIdx === -1 || targetIdx === -1) return false;

    const [moved] = list.splice(fromIdx, 1);
    let insertIdx = list.findIndex((m) => m.id === targetId);
    if (insertIdx === -1) {
      list.push(moved);
    } else {
      if (position === 'after') insertIdx += 1;
      list.splice(insertIdx, 0, moved);
    }

    list.forEach((m, idx) => {
      m.order = idx;
    });

    this.onMarkersChange();
    this.onMutate('reorder-markers', { changedObjectIds: list.map((m) => m.id) });
    return true;
  }

  updateMarkerProps(id, { label, color }) {
    const obj = this.getById(id);
    if (!obj || obj.type !== 'marker') return false;
    if (typeof label === 'string') {
      const clean = label.trim() || this.getNextMarkerLabel();
      obj.label = clean;
      obj.w = this._calcMarkerWidth(clean);
    }
    if (typeof color === 'string' && color) {
      obj.color = color;
    }
    this.updateObjectEl(obj);
    this.onMarkersChange();
    this.onMutate('edit-marker', { changedObjectIds: [obj.id] });
    return true;
  }

  addRawObjects(list) {
    let hasMarker = false;
    for (const obj of list) {
      if (obj.type === 'marker') hasMarker = true;
      this.objects.push(obj);
      this.objectMap.set(obj.id, obj);
      this._mountObject(obj, { allowNetwork: true });
      if (obj.type === 'text') this.autoFitTextHeight(obj);
    }
    if (hasMarker) this.onMarkersChange();
  }

  removeIds(idSet) {
    let removed = false;
    let removedMarker = false;
    this.objects = this.objects.filter((o) => {
      if (idSet.has(o.id)) {
        if (o.type === 'marker') removedMarker = true;
        this._unmountObject(o.id);
        this.objectMap.delete(o.id);
        if (this.editingId === o.id) this.editingId = null;
        removed = true;
        return false;
      }
      return true;
    });
    if (removedMarker) this.onMarkersChange();
    return removed;
  }

  // Flicker-free remote synchronization from Firebase
  applyRemoteMap(remoteMap, { skipIds = new Set(), isTeacher = true } = {}) {
    const incomingIds = new Set(Object.keys(remoteMap || {}));

    for (const obj of [...this.objects]) {
      if (!incomingIds.has(obj.id) && !skipIds.has(obj.id)) {
        this.removeIds(new Set([obj.id]));
      }
    }

    for (const [id, remoteObj] of Object.entries(remoteMap || {})) {
      if (!remoteObj || !remoteObj.id) continue;
      if (skipIds.has(id)) continue;

      const existing = this.getById(id);
      if (existing) {
        if (this.editingId === id) {
          if (remoteObj.locked && !isTeacher) {
            this.editingId = null;
            this.onEditStateChange(false, id);
          } else {
            continue;
          }
        }
        Object.assign(existing, remoteObj);
        if (!remoteObj.groupId) delete existing.groupId;
        this.updateObjectEl(existing);
      } else {
        const copy = JSON.parse(JSON.stringify(remoteObj));
        this.objects.push(copy);
        this.objectMap.set(copy.id, copy);
        this._mountObject(copy, { allowNetwork: true });
      }
    }
  }

  renderAll() {
    this._abortAllPending();
    this.layerEl.innerHTML = '';
    this.domMap.clear();

    if (!this.isVirtualized()) {
      const sorted = [...this.objects].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
      for (const obj of sorted) {
        this._mountObject(obj, { allowNetwork: true });
      }
      requestAnimationFrame(() => this.autoFitVisibleTexts());
    } else {
      this.syncVisibleObjects();
    }
  }

  scheduleViewportSync() {
    if (!this.objects.length) return;
    if (!this.isVirtualized()) return;
    if (this._syncTimer) clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => {
      this._syncTimer = null;
      if (!this._rafScheduled) {
        this._rafScheduled = true;
        requestAnimationFrame(() => {
          this._rafScheduled = false;
          this.syncVisibleObjects();
        });
      }
    }, 65);
  }

  syncVisibleObjects() {
    if (!this.isVirtualized()) return;
    const vis = this.viewport.getVisibleWorldRect(0.4);
    const zoom = this.viewport.zoom;
    const selected = this.getSelectedIds();

    const shouldKeep = new Set();
    const visibleImages = [];

    for (const o of this.objects) {
      const forced = o.id === this.editingId || selected.has(o.id);
      const inView =
        o.x + o.w >= vis.minX &&
        o.x <= vis.maxX &&
        o.y + o.h >= vis.minY &&
        o.y <= vis.maxY;

      if (!forced && !inView) continue;

      // At extreme zoom-out, skip mounting microscopic text boxes (keeps 60fps on 10,000+ item boards)
      if (!forced && o.type === 'text' && (o.fontSize || 16) * zoom < 3.5 && o.h * zoom < 6) {
        continue;
      }

      shouldKeep.add(o.id);
      if (o.type === 'image') {
        const distSq = Math.pow(o.x + o.w / 2 - vis.cx, 2) + Math.pow(o.y + o.h / 2 - vis.cy, 2);
        visibleImages.push({ obj: o, distSq, forced });
      }
    }

    // Unmount offscreen DOM nodes & cancel their queued network requests
    for (const id of [...this.domMap.keys()]) {
      if (!shouldKeep.has(id)) {
        this._unmountObject(id);
      }
    }

    // Decide which visible images are allowed to fetch from GitHub (prioritize closest to screen center)
    visibleImages.sort((a, b) => a.distSq - b.distSq);
    const allowNetworkIds = new Set();
    let uncachedCount = 0;

    for (const entry of visibleImages) {
      const o = entry.obj;
      const onScreenDim = Math.max(o.w * zoom, o.h * zoom);
      const alreadyCached = this.storage.hasCachedAsset(o.assetPath) || Boolean(o.inlineDataUrl);
      if (alreadyCached || entry.forced) {
        allowNetworkIds.add(o.id);
      } else if (onScreenDim >= MIN_IMAGE_SCREEN_PX && uncachedCount < MAX_UNCACHED_IMAGES_PER_VIEW) {
        allowNetworkIds.add(o.id);
        uncachedCount += 1;
      }
    }

    // Mount newly visible nodes or trigger lazy load on previously idle placeholders
    for (const id of shouldKeep) {
      const o = this.objectMap.get(id);
      if (!o) continue;
      const allowNet = o.type !== 'image' || allowNetworkIds.has(id);
      if (!this.domMap.has(id)) {
        this._mountObject(o, { allowNetwork: allowNet });
        if (o.type === 'text') this.autoFitTextHeight(o);
      } else if (o.type === 'image' && allowNet) {
        this._ensureImageLoaded(o, this.domMap.get(id), true);
      }
    }
  }

  _ensureImageLoaded(obj, el, allowNetwork) {
    if (!el || !el.isConnected) return;
    if (el.dataset.imgState === 'loaded' || el.dataset.imgState === 'loading') return;

    const placeholder = el.querySelector('.board-obj-loading');
    if (!placeholder) return;

    const attachImg = (url) => {
      if (!url || !el.isConnected) return;
      el.dataset.imgState = 'loaded';
      const img = document.createElement('img');
      img.className = 'board-obj-img';
      img.src = url;
      img.draggable = false;
      img.decoding = 'async';
      placeholder.replaceWith(img);
    };

    // Fast path: already in RAM
    const memUrl = this.storage.getCachedAssetUrl(obj.assetPath) || obj.inlineDataUrl;
    if (memUrl) {
      attachImg(memUrl);
      return;
    }

    if (!allowNetwork) {
      // Still check IndexedDB disk cache (0 GitHub API calls!)
      this.storage.resolveAssetFromCacheOnly(obj.assetPath, obj.inlineDataUrl).then((cachedUrl) => {
        if (cachedUrl && el.isConnected && el.dataset.imgState !== 'loaded') {
          attachImg(cachedUrl);
        }
      }).catch(() => {});
      placeholder.classList.add('lazy-idle');
      placeholder.textContent = '🔍';
      el.dataset.imgState = 'idle';
      return;
    }

    el.dataset.imgState = 'loading';
    placeholder.classList.remove('lazy-idle');
    placeholder.textContent = 'Завантаження...';

    const ctrl = new AbortController();
    this.abortMap.set(obj.id, ctrl);

    this.storage.resolveAssetUrl(obj.assetPath, obj.inlineDataUrl, { signal: ctrl.signal }).then((url) => {
      this.abortMap.delete(obj.id);
      if (!url || !el.isConnected) return;
      attachImg(url);
    }).catch((err) => {
      this.abortMap.delete(obj.id);
      if (err && err.name === 'AbortError') {
        if (el.isConnected) el.dataset.imgState = 'idle';
        return;
      }
      if (el.isConnected) {
        el.dataset.imgState = 'error';
        placeholder.textContent = '⚠️ Не вдалося завантажити';
      }
    });
  }

  _mountObject(obj, { allowNetwork = true } = {}) {
    const el = document.createElement('div');
    el.className = 'board-obj';
    el.dataset.id = obj.id;

    if (obj.type === 'image') {
      const placeholder = document.createElement('div');
      placeholder.className = 'board-obj-loading';
      placeholder.textContent = allowNetwork ? 'Завантаження...' : '🔍';
      if (!allowNetwork) placeholder.classList.add('lazy-idle');
      el.appendChild(placeholder);
    } else if (obj.type === 'marker') {
      el.classList.add('is-marker');
      const pill = document.createElement('div');
      pill.className = 'board-obj-marker';
      const icon = document.createElement('span');
      icon.className = 'board-obj-marker-icon';
      icon.textContent = '🚩';
      const txt = document.createElement('span');
      txt.className = 'board-obj-marker-text';
      txt.textContent = obj.label || '1';
      pill.append(icon, txt);
      el.appendChild(pill);
    } else if (obj.type === 'note' || obj.type === 'text') {
      const wrap = document.createElement('div');
      wrap.className = obj.type === 'note' ? 'board-obj-note' : 'board-obj-text';

      const ta = document.createElement('textarea');
      ta.className = 'board-obj-editable';
      ta.placeholder = obj.type === 'note' ? 'Напишіть на стікері...' : 'Введіть текст...';
      ta.value = obj.text || '';
      ta.spellcheck = false;

      ta.addEventListener('pointerdown', (e) => {
        if (this.editingId === obj.id) {
          e.stopPropagation();
        }
      });

      ta.addEventListener('input', () => {
        obj.text = ta.value;
        if (obj.type === 'text') {
          this.autoFitTextHeight(obj);
        }
        const now = Date.now();
        if (now - this._lastTextEmitAt >= 160) {
          this._lastTextEmitAt = now;
          this.onLiveObjectUpdate(obj.id);
        }
      });

      ta.addEventListener('blur', (e) => {
        if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('#object-toolbar')) {
          return;
        }
        if (this.editingId === obj.id) {
          this.stopEditing();
        }
      });

      wrap.appendChild(ta);
      el.appendChild(wrap);
    }

    const lockBadge = document.createElement('div');
    lockBadge.className = 'lock-indicator hidden';
    lockBadge.textContent = '🔒';
    el.appendChild(lockBadge);

    if (obj.type === 'image') {
      const anchorBadge = document.createElement('div');
      anchorBadge.className = 'anchor-indicator hidden';
      anchorBadge.textContent = '🎯';
      anchorBadge.title = 'Головне фото (якір дошки)';
      el.appendChild(anchorBadge);
    }

    this.layerEl.appendChild(el);
    this.domMap.set(obj.id, el);
    this.updateObjectEl(obj);

    if (obj.type === 'image') {
      this._ensureImageLoaded(obj, el, allowNetwork);
    }
  }

  refreshAnchorBadges() {
    const anchorId = this.getAnchorObjectId();
    for (const [id, el] of this.domMap.entries()) {
      const badge = el.querySelector('.anchor-indicator');
      if (badge) {
        badge.classList.toggle('hidden', id !== anchorId);
      }
    }
  }

  updateObjectEl(obj) {
    const el = this.domMap.get(obj.id);
    if (!el) return;

    el.style.left = `${obj.x}px`;
    el.style.top = `${obj.y}px`;
    el.style.width = `${obj.w}px`;
    el.style.height = `${obj.h}px`;
    el.style.zIndex = String(obj.zIndex ?? 1);
    el.style.transform = obj.rotation ? `rotate(${obj.rotation}deg)` : '';

    el.classList.toggle('locked', Boolean(obj.locked));
    el.classList.toggle('editing', this.editingId === obj.id);

    const lockBadge = el.querySelector('.lock-indicator');
    if (lockBadge) lockBadge.classList.toggle('hidden', !obj.locked);

    const anchorBadge = el.querySelector('.anchor-indicator');
    if (anchorBadge) {
      anchorBadge.classList.toggle('hidden', obj.id !== this.getAnchorObjectId());
    }

    if (obj.type === 'marker') {
      const pill = el.querySelector('.board-obj-marker');
      if (pill) {
        pill.style.backgroundColor = obj.color || '#ef4444';
        const txt = pill.querySelector('.board-obj-marker-text');
        if (txt) txt.textContent = obj.label || '1';
      }
    }

    if (obj.type === 'note' || obj.type === 'text') {
      const preset = getFontPreset(obj.fontFamily || 'sans');
      const ta = el.querySelector('.board-obj-editable');
      if (obj.type === 'note') {
        const wrap = el.querySelector('.board-obj-note');
        if (wrap) wrap.style.backgroundColor = obj.bg || '#fff3a1';
      }
      if (ta) {
        const renderPx = Math.round((obj.fontSize || (obj.type === 'note' ? 18 : 22)) * preset.sizeScale);
        ta.style.color = obj.type === 'note'
          ? (obj.color || '#1f2328')
          : (obj.color || 'var(--default-text-color)');
        ta.style.fontFamily = preset.family;
        ta.style.fontWeight = String(preset.weight || 400);
        ta.style.lineHeight = String(preset.lineHeight);
        ta.style.fontSize = `${renderPx}px`;
        const pt = Math.round(renderPx * (preset.padTop ?? 0.15));
        const pb = Math.round(renderPx * (preset.padBottom ?? 0.2));
        const px = Math.round(renderPx * (preset.padX ?? 0.18));
        ta.style.padding = `${pt}px ${px}px ${pb}px ${px}px`;
        if (ta.value !== (obj.text || '')) ta.value = obj.text || '';
      }
    }
  }

  autoFitTextHeight(obj) {
    if (!obj || obj.type !== 'text') return false;
    const el = this.domMap.get(obj.id);
    const ta = el?.querySelector('.board-obj-editable');
    if (!ta) return false;
    const preset = getFontPreset(obj.fontFamily || 'sans');
    const renderPx = Math.round((obj.fontSize || 22) * preset.sizeScale);
    const minSingleLine = Math.ceil(
      renderPx * preset.lineHeight +
      renderPx * ((preset.padTop ?? 0.15) + (preset.padBottom ?? 0.2)) + 16
    );
    const overhead = Math.max(8, el.offsetHeight - ta.clientHeight);
    const scrollNeed = ta.scrollHeight > ta.clientHeight ? ta.scrollHeight + overhead + 6 : 0;
    const needed = Math.max(minSingleLine, scrollNeed);
    if (needed > obj.h) {
      obj.h = needed;
      el.style.height = `${obj.h}px`;
      return true;
    }
    return false;
  }

  autoFitVisibleTexts() {
    for (const id of this.domMap.keys()) {
      const o = this.objectMap.get(id);
      if (o && o.type === 'text') this.autoFitTextHeight(o);
    }
  }

  autoFitAllTexts() {
    this.autoFitVisibleTexts();
  }

  startEditing(id) {
    const obj = this.getById(id);
    if (!obj || obj.locked || (obj.type !== 'text' && obj.type !== 'note')) return false;

    if (this.editingId && this.editingId !== id) {
      this.stopEditing();
    }

    this.editingId = id;
    if (!this.domMap.has(id)) {
      this._mountObject(obj, { allowNetwork: true });
    }
    this.updateObjectEl(obj);
    this.onEditStateChange(true, id);

    const el = this.domMap.get(id);
    const ta = el?.querySelector('.board-obj-editable');
    if (ta) {
      const focusTextarea = () => {
        if (this.editingId !== id) return;
        ta.focus();
        const len = ta.value.length;
        ta.setSelectionRange(len, len);
      };
      focusTextarea();
      requestAnimationFrame(focusTextarea);
    }
    return true;
  }

  stopEditing() {
    if (!this.editingId) return;
    const prevId = this.editingId;
    this.editingId = null;

    let deletedId = null;
    const obj = this.getById(prevId);
    if (obj) {
      const el = this.domMap.get(prevId);
      const ta = el?.querySelector('.board-obj-editable');
      if (ta) obj.text = ta.value;

      if (obj.type === 'text' && !obj.text.trim()) {
        this.removeIds(new Set([prevId]));
        deletedId = prevId;
      } else {
        this.updateObjectEl(obj);
      }
    }

    this.onEditStateChange(false, prevId);
    this.onMutate('edit-text', deletedId ? { deletedObjectIds: [deletedId] } : { changedObjectIds: [prevId] });
  }

  getObjectBounds(obj) {
    return {
      minX: obj.x,
      minY: obj.y,
      maxX: obj.x + obj.w,
      maxY: obj.y + obj.h
    };
  }

  hitTest(wx, wy) {
    // Only test candidates near cursor (instant even with 10,000 objects!)
    let best = null;
    let bestZ = -Infinity;
    for (const o of this.objects) {
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      let lx = wx;
      let ly = wy;
      if (o.rotation) {
        const rad = (-o.rotation * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const dx = wx - cx;
        const dy = wy - cy;
        lx = cx + dx * cos - dy * sin;
        ly = cy + dx * sin + dy * cos;
      }
      if (lx >= o.x && lx <= o.x + o.w && ly >= o.y && ly <= o.y + o.h) {
        const z = o.zIndex ?? 0;
        if (z >= bestZ) {
          bestZ = z;
          best = o;
        }
      }
    }
    return best;
  }

  // Finds explicit anchor image OR the median-central image on the board (resistant to outliers)
  findCentralAnchorObject(anchorId = null) {
    if (anchorId) {
      const pinned = this.getById(anchorId);
      if (pinned) return { obj: pinned, isPinned: true };
    }
    const images = this.objects.filter((o) => o.type === 'image');
    const nonMarkers = this.objects.filter((o) => o.type !== 'marker');
    const pool = images.length > 0 ? images : (nonMarkers.length > 0 ? nonMarkers : this.objects);
    if (!pool.length) return null;

    const cxs = pool.map((o) => o.x + o.w / 2).sort((a, b) => a - b);
    const cys = pool.map((o) => o.y + o.h / 2).sort((a, b) => a - b);
    const medX = cxs[Math.floor(cxs.length / 2)];
    const medY = cys[Math.floor(cys.length / 2)];

    let best = pool[0];
    let bestDist = Infinity;
    for (const o of pool) {
      const dx = (o.x + o.w / 2) - medX;
      const dy = (o.y + o.h / 2) - medY;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = o;
      }
    }
    return { obj: best, isPinned: false };
  }


  ensureMounted(obj) {
    if (!obj) return;
    if (!this.domMap.has(obj.id)) {
      this._mountObject(obj, { allowNetwork: true });
    } else {
      this.updateObjectEl(obj);
    }
  }

  getBounds() {
    if (!this.objects.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const o of this.objects) {
      if (o.x < minX) minX = o.x;
      if (o.y < minY) minY = o.y;
      if (o.x + o.w > maxX) maxX = o.x + o.w;
      if (o.y + o.h > maxY) maxY = o.y + o.h;
    }
    return { minX, minY, maxX, maxY };
  }
}
