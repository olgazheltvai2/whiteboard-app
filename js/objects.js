// Board objects: Images, Text, Sticky Notes, Drag, Resize, Rotate, Lock, Z-Order

import { IMAGE_LIMITS, NOTE_COLORS, uid } from './config.js';

export class ObjectsManager {
  constructor({ layerEl, toolbarEl, viewport, storage, onMutate, getTool }) {
    this.layerEl = layerEl;
    this.toolbarEl = toolbarEl;
    this.viewport = viewport;
    this.storage = storage;
    this.onMutate = onMutate;
    this.getTool = getTool;

    this.objects = [];
    this.selectedId = null;
    this.editingId = null;
    this.domMap = new Map();

    this.interaction = null;
    this._bindGlobalPointer();
  }

  setObjects(list) {
    this.objects = Array.isArray(list) ? list : [];
    this.selectedId = null;
    this.editingId = null;
    this.renderAll();
  }

  getObjects() {
    return this.objects;
  }

  getSelected() {
    return this.objects.find((o) => o.id === this.selectedId) || null;
  }

  select(id) {
    if (this.editingId && this.editingId !== id) {
      this.stopEditing();
    }
    this.selectedId = id;
    this._updateSelectionVisuals();
    this._renderContextBar();
  }

  clearSelection() {
    this.select(null);
  }

  nextZIndex() {
    if (!this.objects.length) return 1;
    return Math.max(...this.objects.map((o) => o.zIndex || 1)) + 1;
  }

  minZIndex() {
    if (!this.objects.length) return 1;
    return Math.min(...this.objects.map((o) => o.zIndex || 1)) - 1;
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
      zIndex: this.nextZIndex(),
      locked: false,
      assetPath: uploaded.assetPath,
      aspectRatio: uploaded.width / uploaded.height
    };
    if (uploaded.inlineDataUrl) {
      obj.inlineDataUrl = uploaded.inlineDataUrl;
    }

    this.objects.push(obj);
    this._mountObject(obj);
    this.select(obj.id);
    this.onMutate('add-image');
    return { obj, uploadPromise: uploaded.uploadPromise };
  }

  addTextAt(worldPoint, defaultColor = '#f3f5f9') {
    const obj = {
      id: uid('txt'),
      type: 'text',
      x: Math.round(worldPoint.x - 110),
      y: Math.round(worldPoint.y - 24),
      w: 240,
      h: 72,
      rotation: 0,
      zIndex: this.nextZIndex(),
      locked: false,
      text: '',
      fontSize: 22,
      color: defaultColor
    };
    this.objects.push(obj);
    this._mountObject(obj);
    this.select(obj.id);
    this.startEditing(obj.id);
    this.onMutate('add-text');
    return obj;
  }

  addNoteAt(worldPoint) {
    const palette = NOTE_COLORS[this.objects.length % NOTE_COLORS.length];
    const obj = {
      id: uid('note'),
      type: 'note',
      x: Math.round(worldPoint.x - 105),
      y: Math.round(worldPoint.y - 95),
      w: 210,
      h: 190,
      rotation: 0,
      zIndex: this.nextZIndex(),
      locked: false,
      text: '',
      fontSize: 18,
      bg: palette.bg,
      color: palette.text
    };
    this.objects.push(obj);
    this._mountObject(obj);
    this.select(obj.id);
    this.startEditing(obj.id);
    this.onMutate('add-note');
    return obj;
  }

  duplicateSelected() {
    const src = this.getSelected();
    if (!src) return;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = uid(src.type);
    copy.x += 26;
    copy.y += 26;
    copy.locked = false;
    copy.zIndex = this.nextZIndex();
    this.objects.push(copy);
    this._mountObject(copy);
    this.select(copy.id);
    this.onMutate('duplicate');
  }

  deleteSelected() {
    const src = this.getSelected();
    if (!src || src.locked) return;
    this.objects = this.objects.filter((o) => o.id !== src.id);
    const el = this.domMap.get(src.id);
    if (el) el.remove();
    this.domMap.delete(src.id);
    this.select(null);
    this.onMutate('delete');
  }

  toggleLockSelected() {
    const obj = this.getSelected();
    if (!obj) return;
    obj.locked = !obj.locked;
    this._updateObjectEl(obj);
    this._renderContextBar();
    this.onMutate('toggle-lock');
  }

  bringToFrontSelected() {
    const obj = this.getSelected();
    if (!obj) return;
    obj.zIndex = this.nextZIndex();
    this._updateObjectEl(obj);
    this.onMutate('z-front');
  }

  sendToBackSelected() {
    const obj = this.getSelected();
    if (!obj) return;
    obj.zIndex = this.minZIndex();
    this._updateObjectEl(obj);
    this.onMutate('z-back');
  }

  renderAll() {
    this.layerEl.innerHTML = '';
    this.domMap.clear();
    const sorted = [...this.objects].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
    for (const obj of sorted) {
      this._mountObject(obj);
    }
    this._updateSelectionVisuals();
    this._renderContextBar();
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

      ta.addEventListener('input', () => {
        obj.text = ta.value;
      });
      ta.addEventListener('blur', () => {
        if (this.editingId === obj.id) {
          this.stopEditing();
        }
      });

      wrap.appendChild(ta);
      el.appendChild(wrap);
    }

    // Lock badge
    const lockBadge = document.createElement('div');
    lockBadge.className = 'lock-indicator hidden';
    lockBadge.textContent = '🔒';
    el.appendChild(lockBadge);

    // Handles container
    for (const pos of ['nw', 'ne', 'sw', 'se']) {
      const h = document.createElement('div');
      h.className = `resize-handle ${pos} hidden`;
      h.dataset.handle = pos;
      el.appendChild(h);
    }
    const rot = document.createElement('div');
    rot.className = 'rotate-handle hidden';
    rot.dataset.handle = 'rotate';
    el.appendChild(rot);

    // Events
    el.addEventListener('pointerdown', (e) => this._onObjectPointerDown(e, obj));
    el.addEventListener('dblclick', (e) => {
      if (this.getTool() !== 'select') return;
      if ((obj.type === 'text' || obj.type === 'note') && !obj.locked) {
        e.stopPropagation();
        this.startEditing(obj.id);
      }
    });

    this.layerEl.appendChild(el);
    this.domMap.set(obj.id, el);
    this._updateObjectEl(obj);
  }

  _updateObjectEl(obj) {
    const el = this.domMap.get(obj.id);
    if (!el) return;

    el.style.left = `${obj.x}px`;
    el.style.top = `${obj.y}px`;
    el.style.width = `${obj.w}px`;
    el.style.height = `${obj.h}px`;
    el.style.zIndex = String(obj.zIndex || 1);
    el.style.transform = obj.rotation ? `rotate(${obj.rotation}deg)` : '';

    el.classList.toggle('locked', Boolean(obj.locked));
    const lockBadge = el.querySelector('.lock-indicator');
    if (lockBadge) lockBadge.classList.toggle('hidden', !obj.locked);

    if (obj.type === 'note') {
      const wrap = el.querySelector('.board-obj-note');
      const ta = el.querySelector('.board-obj-editable');
      if (wrap) wrap.style.backgroundColor = obj.bg || '#fff3a1';
      if (ta) {
        ta.style.color = obj.color || '#1f2328';
        ta.style.fontSize = `${obj.fontSize || 18}px`;
      }
    } else if (obj.type === 'text') {
      const ta = el.querySelector('.board-obj-editable');
      if (ta) {
        ta.style.color = obj.color || 'var(--default-text-color)';
        ta.style.fontSize = `${obj.fontSize || 22}px`;
      }
    }

    this._updateHandlesForEl(el, obj);
  }

  _updateHandlesForEl(el, obj) {
    const show = obj.id === this.selectedId && !obj.locked && this.editingId !== obj.id;
    el.querySelectorAll('.resize-handle, .rotate-handle').forEach((h) => {
      h.classList.toggle('hidden', !show);
    });
  }

  _updateSelectionVisuals() {
    for (const obj of this.objects) {
      const el = this.domMap.get(obj.id);
      if (!el) continue;
      el.classList.toggle('selected', obj.id === this.selectedId);
      el.classList.toggle('editing', obj.id === this.editingId);
      this._updateHandlesForEl(el, obj);
    }
  }

  startEditing(id) {
    const obj = this.objects.find((o) => o.id === id);
    if (!obj || obj.locked) return;
    this.editingId = id;
    this._updateSelectionVisuals();
    const el = this.domMap.get(id);
    const ta = el?.querySelector('.board-obj-editable');
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }

  stopEditing() {
    if (!this.editingId) return;
    const prevId = this.editingId;
    this.editingId = null;
    this._updateSelectionVisuals();
    const obj = this.objects.find((o) => o.id === prevId);
    if (obj && obj.type === 'text' && !obj.text.trim()) {
      // Remove completely empty text box
      this.objects = this.objects.filter((o) => o.id !== prevId);
      const el = this.domMap.get(prevId);
      if (el) el.remove();
      this.domMap.delete(prevId);
      if (this.selectedId === prevId) this.select(null);
    }
    this.onMutate('edit-text');
  }

  _onObjectPointerDown(e, obj) {
    if (e.button !== 0) return;
    if (this.getTool() !== 'select' || this.viewport.spacePressed) return;
    if (this.editingId === obj.id) {
      e.stopPropagation();
      return;
    }

    e.stopPropagation();
    this.select(obj.id);

    if (obj.locked) return;

    const handle = e.target.dataset?.handle;
    if (handle === 'rotate') {
      const cx = obj.x + obj.w / 2;
      const cy = obj.y + obj.h / 2;
      const pt = this.viewport.screenToWorld(e.clientX, e.clientY);
      const startAngle = Math.atan2(pt.y - cy, pt.x - cx) * (180 / Math.PI);
      this.interaction = {
        mode: 'rotate',
        obj,
        cx,
        cy,
        startAngle,
        origRotation: obj.rotation || 0,
        moved: false
      };
      return;
    }

    if (handle) {
      this.interaction = {
        mode: 'resize',
        handle,
        obj,
        startClientX: e.clientX,
        startClientY: e.clientY,
        origX: obj.x,
        origY: obj.y,
        origW: obj.w,
        origH: obj.h,
        moved: false
      };
      return;
    }

    this.interaction = {
      mode: 'drag',
      obj,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origX: obj.x,
      origY: obj.y,
      moved: false
    };
  }

  _bindGlobalPointer() {
    window.addEventListener('pointermove', (e) => {
      if (!this.interaction) return;
      const it = this.interaction;
      const obj = it.obj;

      if (it.mode === 'drag') {
        const dx = (e.clientX - it.startClientX) / this.viewport.zoom;
        const dy = (e.clientY - it.startClientY) / this.viewport.zoom;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) it.moved = true;
        obj.x = Math.round(it.origX + dx);
        obj.y = Math.round(it.origY + dy);
        this._updateObjectEl(obj);
      } else if (it.mode === 'resize') {
        const dx = (e.clientX - it.startClientX) / this.viewport.zoom;
        const dy = (e.clientY - it.startClientY) / this.viewport.zoom;
        it.moved = true;

        let newX = it.origX;
        let newY = it.origY;
        let newW = it.origW;
        let newH = it.origH;
        const keepRatio = obj.type === 'image' && !e.shiftKey;
        const ratio = obj.aspectRatio || (it.origW / it.origH);

        if (it.handle.includes('e')) newW = Math.max(40, it.origW + dx);
        if (it.handle.includes('s')) newH = Math.max(36, it.origH + dy);
        if (it.handle.includes('w')) {
          newW = Math.max(40, it.origW - dx);
          newX = it.origX + (it.origW - newW);
        }
        if (it.handle.includes('n')) {
          newH = Math.max(36, it.origH - dy);
          newY = it.origY + (it.origH - newH);
        }

        if (keepRatio) {
          const adjustedH = Math.max(30, Math.round(newW / ratio));
          if (it.handle.includes('n')) {
            newY = it.origY + (it.origH - adjustedH);
          }
          newH = adjustedH;
        }

        obj.x = Math.round(newX);
        obj.y = Math.round(newY);
        obj.w = Math.round(newW);
        obj.h = Math.round(newH);
        this._updateObjectEl(obj);
      } else if (it.mode === 'rotate') {
        const pt = this.viewport.screenToWorld(e.clientX, e.clientY);
        const angle = Math.atan2(pt.y - it.cy, pt.x - it.cx) * (180 / Math.PI);
        let next = Math.round(it.origRotation + (angle - it.startAngle));
        if (e.shiftKey) next = Math.round(next / 15) * 15;
        obj.rotation = next;
        it.moved = true;
        this._updateObjectEl(obj);
      }
    });

    window.addEventListener('pointerup', () => {
      if (!this.interaction) return;
      const moved = this.interaction.moved;
      this.interaction = null;
      if (moved) {
        this.onMutate('transform');
      }
    });
  }

  _renderContextBar() {
    const obj = this.getSelected();
    if (!obj) {
      this.toolbarEl.classList.add('hidden');
      this.toolbarEl.innerHTML = '';
      return;
    }

    this.toolbarEl.classList.remove('hidden');
    this.toolbarEl.innerHTML = '';

    const addBtn = (label, title, onClick, cls = '') => {
      const btn = document.createElement('button');
      btn.className = `ctx-btn ${cls}`;
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
      this.toolbarEl.appendChild(btn);
    };

    addBtn(
      obj.locked ? '🔓 Розблокувати' : '🔒 Закріпити',
      'Заблокувати, щоб не рухалося під час вправи',
      () => this.toggleLockSelected(),
      obj.locked ? 'active' : ''
    );

    if (!obj.locked) {
      addBtn('⬆️', 'На передній план', () => this.bringToFrontSelected());
      addBtn('⬇️', 'На задній план (під інші картинки)', () => this.sendToBackSelected());

      if (obj.type === 'text' || obj.type === 'note') {
        addBtn('A−', 'Зменшити шрифт', () => {
          obj.fontSize = Math.max(12, (obj.fontSize || 18) - 2);
          this._updateObjectEl(obj);
          this.onMutate('font-size');
        });
        addBtn('A+', 'Збільшити шрифт', () => {
          obj.fontSize = Math.min(72, (obj.fontSize || 18) + 2);
          this._updateObjectEl(obj);
          this.onMutate('font-size');
        });
      }

      if (obj.type === 'note') {
        NOTE_COLORS.forEach((c) => {
          const sw = document.createElement('button');
          sw.className = 'ctx-color';
          sw.style.backgroundColor = c.bg;
          sw.title = 'Колір стікера';
          sw.addEventListener('click', (e) => {
            e.stopPropagation();
            obj.bg = c.bg;
            obj.color = c.text;
            this._updateObjectEl(obj);
            this.onMutate('note-color');
          });
          this.toolbarEl.appendChild(sw);
        });
      }

      if (obj.type === 'text') {
        ['#f3f5f9', '#18202c', '#ff5c5c', '#ffe066', '#4cd964', '#5b8def'].forEach((col) => {
          const sw = document.createElement('button');
          sw.className = 'ctx-color';
          sw.style.backgroundColor = col;
          sw.title = 'Колір тексту';
          sw.addEventListener('click', (e) => {
            e.stopPropagation();
            obj.color = col;
            this._updateObjectEl(obj);
            this.onMutate('text-color');
          });
          this.toolbarEl.appendChild(sw);
        });
      }

      addBtn('📋', 'Дублювати (Ctrl+D)', () => this.duplicateSelected());
      addBtn('🗑️', 'Видалити (Delete)', () => this.deleteSelected(), 'danger');
    }
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
