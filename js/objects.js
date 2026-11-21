// Board objects: Images, Text (with Propysy/cursive fonts), Sticky Notes + Live Sync updates

import { IMAGE_LIMITS, NOTE_COLORS, getFontPreset, uid } from './config.js';

export class ObjectsManager {
  constructor({ layerEl, viewport, storage, onMutate, onEditStateChange, getNextZIndex }) {
    this.layerEl = layerEl;
    this.viewport = viewport;
    this.storage = storage;
    this.onMutate = onMutate;
    this.onEditStateChange = onEditStateChange || (() => {});
    this.getNextZIndex = getNextZIndex || (() => this._localMaxZ() + 1);

    this.objects = [];
    this.editingId = null;
    this.domMap = new Map();
  }

  _localMaxZ() {
    if (!this.objects.length) return 0;
    return Math.max(...this.objects.map((o) => o.zIndex || 1));
  }

  setObjects(list) {
    this.editingId = null;
    this.objects = Array.isArray(list) ? list : [];
    this.renderAll();
  }

  getObjects() {
    return this.objects;
  }

  getById(id) {
    return this.objects.find((o) => o.id === id) || null;
  }

  isEditing() {
    return Boolean(this.editingId);
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
    this._mountObject(obj);
    this.onMutate('add-image', { changedObjectIds: [obj.id] });
    return { obj, uploadPromise: uploaded.uploadPromise };
  }

  addTextAt(worldPoint, defaultColor = '#f3f5f9', initialText = '', fontFamily = 'sans') {
    const lines = initialText ? initialText.split('\n').length : 1;
    const w = initialText ? Math.min(520, Math.max(240, initialText.length * 12)) : 280;
    const h = Math.max(70, lines * 36 + 24);
    const obj = {
      id: uid('txt'),
      type: 'text',
      x: Math.round(worldPoint.x - w / 2),
      y: Math.round(worldPoint.y - 28),
      w,
      h,
      rotation: 0,
      zIndex: this.getNextZIndex(),
      locked: false,
      text: initialText,
      fontSize: (fontFamily === 'propysy' || fontFamily === 'propysy-bold') ? 28 : 22,
      fontFamily: fontFamily || 'sans',
      color: defaultColor
    };
    this.objects.push(obj);
    this._mountObject(obj);
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
    this._mountObject(obj);
    this.onMutate('add-note', { changedObjectIds: [obj.id] });
    return obj;
  }

  addRawObjects(list) {
    for (const obj of list) {
      this.objects.push(obj);
      this._mountObject(obj);
    }
  }

  removeIds(idSet) {
    let removed = false;
    this.objects = this.objects.filter((o) => {
      if (idSet.has(o.id)) {
        const el = this.domMap.get(o.id);
        if (el) el.remove();
        this.domMap.delete(o.id);
        if (this.editingId === o.id) this.editingId = null;
        removed = true;
        return false;
      }
      return true;
    });
    return removed;
  }

  // Flicker-free remote synchronization from Firebase
  applyRemoteMap(remoteMap, { skipIds = new Set(), isTeacher = true } = {}) {
    const incomingIds = new Set(Object.keys(remoteMap || {}));

    // Remove objects deleted remotely
    for (const obj of [...this.objects]) {
      if (!incomingIds.has(obj.id) && !skipIds.has(obj.id)) {
        this.removeIds(new Set([obj.id]));
      }
    }

    // Add or update in place
    for (const [id, remoteObj] of Object.entries(remoteMap || {})) {
      if (!remoteObj || !remoteObj.id) continue;
      if (skipIds.has(id)) continue;

      const existing = this.getById(id);
      if (existing) {
        // If user is currently editing this text box, only interrupt if teacher locked it
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
        this._mountObject(copy);
      }
    }
  }

  renderAll() {
    this.layerEl.innerHTML = '';
    this.domMap.clear();
    const sorted = [...this.objects].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
    for (const obj of sorted) {
      this._mountObject(obj);
    }
  }

  _mountObject(obj) {
    const el = document.createElement('div');
    el.className = 'board-obj';
    el.dataset.id = obj.id;

    if (obj.type === 'image') {
      const placeholder = document.createElement('div');
      placeholder.className = 'board-obj-loading';
      placeholder.textContent = 'Завантаження...';
      el.appendChild(placeholder);

      this.storage.resolveAssetUrl(obj.assetPath, obj.inlineDataUrl).then((url) => {
        if (!url || !el.isConnected) return;
        const img = document.createElement('img');
        img.className = 'board-obj-img';
        img.src = url;
        img.draggable = false;
        placeholder.replaceWith(img);
      }).catch(() => {
        placeholder.textContent = '⚠️ Не вдалося завантажити';
      });
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
        if (obj.type === 'text' && ta.scrollHeight > ta.clientHeight) {
          obj.h = Math.max(obj.h, ta.scrollHeight + 16);
          this.updateObjectEl(obj);
        }
      });

      ta.addEventListener('blur', () => {
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

    this.layerEl.appendChild(el);
    this.domMap.set(obj.id, el);
    this.updateObjectEl(obj);
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

    if (obj.type === 'note' || obj.type === 'text') {
      const preset = getFontPreset(obj.fontFamily || 'sans');
      const ta = el.querySelector('.board-obj-editable');
      if (obj.type === 'note') {
        const wrap = el.querySelector('.board-obj-note');
        if (wrap) wrap.style.backgroundColor = obj.bg || '#fff3a1';
      }
      if (ta) {
        ta.style.color = obj.type === 'note'
          ? (obj.color || '#1f2328')
          : (obj.color || 'var(--default-text-color)');
        ta.style.fontFamily = preset.family;
        ta.style.fontWeight = String(preset.weight || 400);
        ta.style.lineHeight = String(preset.lineHeight);
        ta.style.fontSize = `${Math.round((obj.fontSize || (obj.type === 'note' ? 18 : 22)) * preset.sizeScale)}px`;
        if (ta.value !== (obj.text || '')) ta.value = obj.text || '';
      }
    }
  }

  startEditing(id) {
    const obj = this.getById(id);
    if (!obj || obj.locked || (obj.type !== 'text' && obj.type !== 'note')) return false;

    if (this.editingId && this.editingId !== id) {
      this.stopEditing();
    }

    this.editingId = id;
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
    const sorted = [...this.objects].sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0));
    for (const o of sorted) {
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
        return o;
      }
    }
    return null;
  }

  getBounds() {
    if (!this.objects.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const o of this.objects) {
      minX = Math.min(minX, o.x);
      minY = Math.min(minY, o.y);
      maxX = Math.max(maxX, o.x + o.w);
      maxY = Math.max(maxY, o.y + o.h);
    }
    return { minX, minY, maxX, maxY };
  }
}
