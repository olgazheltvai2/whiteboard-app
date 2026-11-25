// Unified Selection, Marquee, Multi-Drag/Resize, Z-Layering, Font Picker, Grouping & Cross-Tab/Cross-Account Clipboard

import { CLIPBOARD_MARKER_PREFIX, DRAW_COLORS, FONT_PRESETS, MARKER_COLORS, NOTE_COLORS, STORAGE_KEYS, uid } from './config.js';

function boxesIntersect(a, b) {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

function escapeHtmlAttr(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function encodeObjPayload(obj) {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function decodeObjPayload(b64) {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function extractFirstUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0].replace(/[),.;]+$/, '') : null;
}

export class SelectionManager {
  constructor({
    viewportEl,
    selectionBoxEl,
    outlinesEl,
    marqueeEl,
    toolbarEl,
    viewport,
    objects,
    drawing,
    storage,
    onMutate,
    onLiveTransform,
    onToast,
    isTeacher = () => true,
    canEditObjects = () => true,
    canWriteText = () => true,
    getNextZIndex,
    getMinZIndex,
    getCurrentBoardId = () => null,
    getAnchorObjectId = () => null,
    onToggleAnchor = () => {},
    onEditMarker = () => {},
    onSendSelectedToMarker = () => {},
    onOpenMarkersMenu = () => {},
    onSelectionChange = () => {}
  }) {
    this.viewportEl = viewportEl;
    this.selectionBoxEl = selectionBoxEl;
    this.outlinesEl = outlinesEl;
    this.marqueeEl = marqueeEl;
    this.toolbarEl = toolbarEl;
    this.viewport = viewport;
    this.objects = objects;
    this.drawing = drawing;
    this.storage = storage;
    this.onMutate = onMutate;
    this.onLiveTransform = onLiveTransform || (() => {});
    this.onToast = onToast;
    this.isTeacher = isTeacher;
    this.canEditObjects = canEditObjects;
    this.canWriteText = canWriteText;
    this.getNextZIndex = getNextZIndex;
    this.getMinZIndex = getMinZIndex;
    this.getCurrentBoardId = getCurrentBoardId;
    this.getAnchorObjectId = getAnchorObjectId;
    this.onToggleAnchor = onToggleAnchor;
    this.onEditMarker = onEditMarker;
    this.onSendSelectedToMarker = onSendSelectedToMarker;
    this.onOpenMarkersMenu = onOpenMarkersMenu;
    this.onSelectionChange = onSelectionChange;

    this.selectedIds = new Set();
    this.markerPickerOpen = false;
    this.interaction = null;
    this.clipboard = null;
    this.clipboardStamp = null;
    this.pasteCount = 0;
    this._lastLiveSyncAt = 0;

    this._bindEvents();
  }

  cancelActiveInteraction() {
    if (!this.interaction) return;
    const it = this.interaction;
    this.interaction = null;
    if (it.mode === 'marquee') {
      this.marqueeEl.classList.add('hidden');
      this.selectedIds = new Set(it.baseSelection);
      this.render();
      return;
    }
    if (it.snapshots && it.moved) {
      for (const entry of it.snapshots) {
        Object.assign(entry.item, entry.snap);
        if (entry.kind === 'object') this.objects.updateObjectEl(entry.item);
        else this.drawing.updateStrokeEl(entry.item);
      }
      this.renderOverlayOnly();
    } else if (it.obj && it.moved) {
      it.obj.rotation = it.origRotation;
      this.objects.updateObjectEl(it.obj);
      this.renderOverlayOnly();
    }
  }

  _emitLiveTransform(it) {
    const now = Date.now();
    if (now - this._lastLiveSyncAt < 65) return;
    this._lastLiveSyncAt = now;
    const changedObjectIds = [];
    const changedStrokeIds = [];
    if (it.snapshots) {
      it.snapshots.forEach((s) => {
        if (s.kind === 'object') changedObjectIds.push(s.item.id);
        else changedStrokeIds.push(s.item.id);
      });
    } else if (it.obj) {
      changedObjectIds.push(it.obj.id);
    }
    this.onLiveTransform({ changedObjectIds, changedStrokeIds });
  }

  getActiveInteractionIds() {
    const ids = new Set();
    if (!this.interaction) return ids;
    if (this.interaction.snapshots) {
      this.interaction.snapshots.forEach((s) => ids.add(s.item.id));
    }
    if (this.interaction.obj) {
      ids.add(this.interaction.obj.id);
    }
    return ids;
  }

  getItem(id) {
    const obj = this.objects.getById(id);
    if (obj) return { kind: 'object', data: obj };
    const str = this.drawing.getById(id);
    if (str) return { kind: 'stroke', data: str };
    return null;
  }

  getSelectedItems() {
    const items = [];
    for (const id of this.selectedIds) {
      const it = this.getItem(id);
      if (it) items.push(it);
    }
    return items;
  }

  getAllItems() {
    return [
      ...this.objects.getObjects().map((data) => ({ kind: 'object', data })),
      ...this.drawing.getStrokes().map((data) => ({ kind: 'stroke', data }))
    ];
  }

  getItemBounds(item) {
    return item.kind === 'object'
      ? this.objects.getObjectBounds(item.data)
      : this.drawing.getStrokeBounds(item.data);
  }

  expandWithGroups(idsIterable) {
    const result = new Set(idsIterable);
    const groupIds = new Set();

    for (const id of result) {
      const it = this.getItem(id);
      if (it && it.data.groupId) groupIds.add(it.data.groupId);
    }
    if (groupIds.size > 0) {
      for (const it of this.getAllItems()) {
        if (it.data.groupId && groupIds.has(it.data.groupId)) {
          if (this.isTeacher() || !it.data.locked) {
            result.add(it.data.id);
          }
        }
      }
    }
    return result;
  }

  selectOnly(idsIterable) {
    if (this.objects.isEditing()) {
      const arr = [...idsIterable];
      if (!(arr.length === 1 && arr[0] === this.objects.editingId)) {
        this.objects.stopEditing();
      }
    }
    const filtered = [...idsIterable].filter((id) => {
      const it = this.getItem(id);
      return it && (this.isTeacher() || !it.data.locked);
    });
    this.markerPickerOpen = false;
    this.selectedIds = this.expandWithGroups(filtered);
    this.render();
  }

  toggleItemSelection(id) {
    if (this.objects.isEditing()) this.objects.stopEditing();
    const it = this.getItem(id);
    if (!it || (!this.isTeacher() && it.data.locked)) return;
    const expanded = this.expandWithGroups([id]);
    const allPresent = [...expanded].every((x) => this.selectedIds.has(x));
    if (allPresent) {
      expanded.forEach((x) => this.selectedIds.delete(x));
    } else {
      expanded.forEach((x) => this.selectedIds.add(x));
    }
    this.render();
  }

  clear() {
    if (this.objects.isEditing()) this.objects.stopEditing();
    this.markerPickerOpen = false;
    this.selectedIds.clear();
    this.render();
  }

  selectAll() {
    if (!this.canEditObjects()) return;
    if (this.objects.isEditing()) this.objects.stopEditing();
    const ids = [];
    for (const it of this.getAllItems()) {
      if (!it.data.locked) ids.push(it.data.id);
    }
    this.selectedIds = new Set(ids);
    this.render();
  }

  pruneMissing() {
    for (const id of [...this.selectedIds]) {
      const it = this.getItem(id);
      if (!it || (!this.isTeacher() && it.data.locked)) {
        this.selectedIds.delete(id);
      }
    }
    this.render();
  }

  hitTestWorld(wx, wy) {
    const hitStroke = this.drawing.hitTest(wx, wy);
    const hitObj = this.objects.hitTest(wx, wy);

    const candidates = [];
    if (hitStroke) candidates.push({ kind: 'stroke', data: hitStroke });
    if (hitObj) candidates.push({ kind: 'object', data: hitObj });

    const allowed = this.isTeacher()
      ? candidates
      : candidates.filter((c) => !c.data.locked);

    if (!allowed.length) return null;
    if (allowed.length === 1) return allowed[0];

    allowed.sort((a, b) => {
      const lockDiff = (a.data.locked ? 1 : 0) - (b.data.locked ? 1 : 0);
      if (lockDiff !== 0) return lockDiff;
      return (b.data.zIndex ?? 0) - (a.data.zIndex ?? 0);
    });
    return allowed[0];
  }

  handleViewportPointerDown(e) {
    if (!this.canEditObjects()) return;
    const worldPt = this.viewport.screenToWorld(e.clientX, e.clientY);
    const hit = this.hitTestWorld(worldPt.x, worldPt.y);

    if (!hit) {
      if (!e.shiftKey) this.clear();
      if (e.pointerType === 'touch') {
        this.viewport.startPan(e.clientX, e.clientY, e.pointerId, false);
        return;
      }
      this._startMarquee(e.clientX, e.clientY, e.shiftKey);
      return;
    }

    if (e.shiftKey) {
      this.toggleItemSelection(hit.data.id);
      return;
    }

    if (!this.selectedIds.has(hit.data.id)) {
      this.selectOnly([hit.data.id]);
    }

    const movable = this.getSelectedItems().filter((it) => !it.data.locked);
    if (movable.length > 0) {
      this._startDrag(e.clientX, e.clientY, movable);
    }
  }

  _startMarquee(startClientX, startClientY, additive) {
    const rect = this.viewportEl.getBoundingClientRect();
    const baseSelection = additive ? new Set(this.selectedIds) : new Set();
    this.interaction = {
      mode: 'marquee',
      startClientX,
      startClientY,
      vpLeft: rect.left,
      vpTop: rect.top,
      baseSelection
    };
    this.marqueeEl.classList.remove('hidden');
    this._updateMarqueeBox(startClientX, startClientY, startClientX, startClientY);
  }

  _updateMarqueeBox(x1, y1, x2, y2) {
    const rect = this.viewportEl.getBoundingClientRect();
    const left = Math.min(x1, x2) - rect.left;
    const top = Math.min(y1, y2) - rect.top;
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);
    this.marqueeEl.style.left = `${left}px`;
    this.marqueeEl.style.top = `${top}px`;
    this.marqueeEl.style.width = `${width}px`;
    this.marqueeEl.style.height = `${height}px`;
  }

  _startDrag(clientX, clientY, movableItems) {
    const snapshots = movableItems.map((it) => ({
      kind: it.kind,
      item: it.data,
      snap: JSON.parse(JSON.stringify(it.data))
    }));
    this.interaction = {
      mode: 'drag',
      startClientX: clientX,
      startClientY: clientY,
      snapshots,
      moved: false
    };
  }

  _startResize(clientX, clientY, handle) {
    const movable = this.getSelectedItems().filter((it) => !it.data.locked);
    if (!movable.length) return;
    const origBox = this.getSelectionBounds(movable);
    if (!origBox) return;

    const snapshots = movable.map((it) => ({
      kind: it.kind,
      item: it.data,
      snap: JSON.parse(JSON.stringify(it.data))
    }));

    this.interaction = {
      mode: 'resize',
      handle,
      startClientX: clientX,
      startClientY: clientY,
      origBox,
      snapshots,
      singleImageRatio:
        movable.length === 1 && movable[0].kind === 'object' && movable[0].data.type === 'image'
          ? (movable[0].data.aspectRatio || movable[0].data.w / movable[0].data.h)
          : null,
      moved: false
    };
  }

  _startRotate(clientX, clientY) {
    const items = this.getSelectedItems();
    if (items.length !== 1 || items[0].kind !== 'object' || items[0].data.locked) return;
    const obj = items[0].data;
    const cx = obj.x + obj.w / 2;
    const cy = obj.y + obj.h / 2;
    const pt = this.viewport.screenToWorld(clientX, clientY);
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
  }

  _bindEvents() {
    this.selectionBoxEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (this.viewport.spacePressed || this.viewport.isPinching || !this.canEditObjects()) return;
      if (e.pointerType !== 'touch') e.stopPropagation();
      else e._handledBySelectionBox = true;

      const handle = e.target.dataset?.handle;
      if (handle === 'rotate') {
        this._startRotate(e.clientX, e.clientY);
        return;
      }
      if (handle) {
        this._startResize(e.clientX, e.clientY, handle);
        return;
      }

      if (e.shiftKey) {
        const pt = this.viewport.screenToWorld(e.clientX, e.clientY);
        const hit = this.hitTestWorld(pt.x, pt.y);
        if (hit) this.toggleItemSelection(hit.data.id);
        return;
      }

      const movable = this.getSelectedItems().filter((it) => !it.data.locked);
      if (movable.length > 0) {
        this._startDrag(e.clientX, e.clientY, movable);
      }
    });

    this.viewportEl.addEventListener('dblclick', (e) => {
      if (!this.canEditObjects() && !this.canWriteText()) return;
      if (e.target.closest('#object-toolbar')) return;
      if (e.target.closest('.board-obj.editing .board-obj-editable')) return;
      const pt = this.viewport.screenToWorld(e.clientX, e.clientY);
      const hitObj = this.objects.hitTest(pt.x, pt.y);
      if (!hitObj || hitObj.locked) return;
      if (hitObj.type === 'marker' && this.isTeacher()) {
        e.preventDefault();
        e.stopPropagation();
        this.selectOnly([hitObj.id]);
        this.onEditMarker(hitObj.id);
        return;
      }
      const canOpen = (hitObj.type === 'text' && this.canWriteText()) || (hitObj.type === 'note' && this.canEditObjects());
      if (canOpen) {
        e.preventDefault();
        e.stopPropagation();
        if (this.canEditObjects()) this.selectOnly([hitObj.id]);
        this.objects.startEditing(hitObj.id);
      }
    });

    window.addEventListener('pointermove', (e) => {
      if (!this.interaction || this.viewport.isPinching) return;
      const it = this.interaction;

      if (it.mode === 'marquee') {
        this._updateMarqueeBox(it.startClientX, it.startClientY, e.clientX, e.clientY);
        const p1 = this.viewport.screenToWorld(it.startClientX, it.startClientY);
        const p2 = this.viewport.screenToWorld(e.clientX, e.clientY);
        const mBox = {
          minX: Math.min(p1.x, p2.x),
          minY: Math.min(p1.y, p2.y),
          maxX: Math.max(p1.x, p2.x),
          maxY: Math.max(p1.y, p2.y)
        };
        const found = new Set(it.baseSelection);
        for (const item of this.getAllItems()) {
          if (item.data.locked) continue;
          if (boxesIntersect(mBox, this.getItemBounds(item))) {
            found.add(item.data.id);
          }
        }
        this.selectedIds = this.expandWithGroups(found);
        this.render();
      } else if (it.mode === 'drag') {
        const dx = (e.clientX - it.startClientX) / this.viewport.zoom;
        const dy = (e.clientY - it.startClientY) / this.viewport.zoom;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) it.moved = true;

        for (const entry of it.snapshots) {
          if (entry.kind === 'object') {
            entry.item.x = Math.round(entry.snap.x + dx);
            entry.item.y = Math.round(entry.snap.y + dy);
            this.objects.updateObjectEl(entry.item);
          } else {
            this.drawing.applyTranslationFromSnapshot(entry.item, entry.snap, dx, dy);
          }
        }
        this.renderOverlayOnly();
        if (it.moved) this._emitLiveTransform(it);
      } else if (it.mode === 'resize') {
        const dx = (e.clientX - it.startClientX) / this.viewport.zoom;
        const dy = (e.clientY - it.startClientY) / this.viewport.zoom;
        it.moved = true;

        const ob = it.origBox;
        const origW = Math.max(10, ob.maxX - ob.minX);
        const origH = Math.max(10, ob.maxY - ob.minY);
        let minX = ob.minX, minY = ob.minY, maxX = ob.maxX, maxY = ob.maxY;

        if (it.handle.includes('e')) maxX = Math.max(ob.minX + 24, ob.maxX + dx);
        if (it.handle.includes('s')) maxY = Math.max(ob.minY + 24, ob.maxY + dy);
        if (it.handle.includes('w')) minX = Math.min(ob.maxX - 24, ob.minX + dx);
        if (it.handle.includes('n')) minY = Math.min(ob.maxY - 24, ob.minY + dy);

        if (it.singleImageRatio && !e.shiftKey) {
          const nw = maxX - minX;
          const nh = Math.max(24, nw / it.singleImageRatio);
          if (it.handle.includes('n')) minY = maxY - nh;
          else maxY = minY + nh;
        } else if (it.snapshots.length > 1 && e.shiftKey) {
          const ratio = origW / origH;
          const nw = maxX - minX;
          const nh = Math.max(24, nw / ratio);
          if (it.handle.includes('n')) minY = maxY - nh;
          else maxY = minY + nh;
        }

        const newBox = { minX, minY, maxX, maxY };
        const scaleX = (newBox.maxX - newBox.minX) / origW;
        const scaleY = (newBox.maxY - newBox.minY) / origH;

        for (const entry of it.snapshots) {
          if (entry.kind === 'object') {
            const s = entry.snap;
            entry.item.x = Math.round(newBox.minX + (s.x - ob.minX) * scaleX);
            entry.item.y = Math.round(newBox.minY + (s.y - ob.minY) * scaleY);
            entry.item.w = Math.max(24, Math.round(s.w * scaleX));
            entry.item.h = Math.max(24, Math.round(s.h * scaleY));
            this.objects.updateObjectEl(entry.item);
          } else {
            this.drawing.applyScaleFromSnapshot(entry.item, entry.snap, ob, newBox);
          }
        }
        this.renderOverlayOnly();
        if (it.moved) this._emitLiveTransform(it);
      } else if (it.mode === 'rotate') {
        const pt = this.viewport.screenToWorld(e.clientX, e.clientY);
        const angle = Math.atan2(pt.y - it.cy, pt.x - it.cx) * (180 / Math.PI);
        let next = Math.round(it.origRotation + (angle - it.startAngle));
        if (e.shiftKey) next = Math.round(next / 15) * 15;
        it.obj.rotation = next;
        it.moved = true;
        this.objects.updateObjectEl(it.obj);
        this.renderOverlayOnly();
        if (it.moved) this._emitLiveTransform(it);
      }
    });

    window.addEventListener('pointerup', () => {
      if (!this.interaction) return;
      const it = this.interaction;
      this.interaction = null;

      if (it.mode === 'marquee') {
        this.marqueeEl.classList.add('hidden');
        this.render();
      } else if (it.moved) {
        const changedObjectIds = [];
        const changedStrokeIds = [];
        if (it.snapshots) {
          it.snapshots.forEach((s) => {
            if (s.kind === 'object') changedObjectIds.push(s.item.id);
            else changedStrokeIds.push(s.item.id);
          });
        } else if (it.obj) {
          changedObjectIds.push(it.obj.id);
        }
        this.render();
        this.onMutate(it.mode, { changedObjectIds, changedStrokeIds });
      }
    });
  }

  _collectMutationMeta(items) {
    return {
      changedObjectIds: items.filter((i) => i.kind === 'object').map((i) => i.data.id),
      changedStrokeIds: items.filter((i) => i.kind === 'stroke').map((i) => i.data.id)
    };
  }

  canGroup(items) {
    const unlocked = items.filter((it) => !it.data.locked);
    if (unlocked.length < 2) return false;
    const gids = new Set(unlocked.map((it) => it.data.groupId || null));
    if (gids.size === 1 && !gids.has(null)) return false;
    return true;
  }

  hasAnyGroup(items) {
    return items.some((it) => Boolean(it.data.groupId));
  }

  isSingleGroup(items) {
    if (items.length < 2) return false;
    const first = items[0].data.groupId;
    return Boolean(first) && items.every((it) => it.data.groupId === first);
  }

  groupSelected() {
    if (!this.canEditObjects()) return;
    const items = this.getSelectedItems().filter((it) => !it.data.locked);
    if (items.length < 2) return;
    const gid = uid('grp');
    for (const it of items) {
      it.data.groupId = gid;
    }
    this.render();
    this.onMutate('group', this._collectMutationMeta(items));
    this.onToast('Елементи згруповано');
  }

  ungroupSelected() {
    if (!this.canEditObjects()) return;
    const items = this.getSelectedItems();
    const touched = [];
    for (const it of items) {
      if (it.data.groupId && !it.data.locked) {
        delete it.data.groupId;
        touched.push(it);
      }
    }
    if (touched.length) {
      this.render();
      this.onMutate('ungroup', this._collectMutationMeta(touched));
      this.onToast('Групу розгруповано');
    }
  }

  toggleLockSelected() {
    if (!this.isTeacher()) return;
    const items = this.getSelectedItems();
    if (!items.length) return;
    const allLocked = items.every((it) => it.data.locked);
    const nextState = !allLocked;
    for (const it of items) {
      it.data.locked = nextState;
      if (it.kind === 'object') this.objects.updateObjectEl(it.data);
    }
    this.render();
    this.onMutate('toggle-lock', this._collectMutationMeta(items));
  }

  deleteSelected() {
    if (!this.canEditObjects()) return false;
    const items = this.getSelectedItems().filter((it) => !it.data.locked);
    if (!items.length) return false;
    const objIds = new Set(items.filter((i) => i.kind === 'object').map((i) => i.data.id));
    const strIds = new Set(items.filter((i) => i.kind === 'stroke').map((i) => i.data.id));
    const r1 = objIds.size ? this.objects.removeIds(objIds) : false;
    const r2 = strIds.size ? this.drawing.removeIds(strIds) : false;
    if (r1 || r2) {
      items.forEach((i) => this.selectedIds.delete(i.data.id));
      this.render();
      this.onMutate('delete', {
        deletedObjectIds: [...objIds],
        deletedStrokeIds: [...strIds]
      });
      return true;
    }
    return false;
  }

  bringToFrontSelected() {
    if (!this.canEditObjects()) return;
    const unlocked = this.getSelectedItems().filter((i) => !i.data.locked);
    if (!unlocked.length) return;
    unlocked.sort((a, b) => (a.data.zIndex ?? 0) - (b.data.zIndex ?? 0));
    let z = this.getNextZIndex();
    for (const it of unlocked) {
      it.data.zIndex = z++;
      if (it.kind === 'object') this.objects.updateObjectEl(it.data);
      else this.drawing.updateStrokeEl(it.data);
    }
    this.onMutate('z-front', this._collectMutationMeta(unlocked));
  }

  sendToBackSelected() {
    if (!this.canEditObjects()) return;
    const unlocked = this.getSelectedItems().filter((i) => !i.data.locked);
    if (!unlocked.length) return;
    unlocked.sort((a, b) => (b.data.zIndex ?? 0) - (a.data.zIndex ?? 0));
    let z = this.getMinZIndex();
    for (const it of unlocked) {
      it.data.zIndex = z--;
      if (it.kind === 'object') this.objects.updateObjectEl(it.data);
      else this.drawing.updateStrokeEl(it.data);
    }
    this.onMutate('z-back', this._collectMutationMeta(unlocked));
  }

  // --- Cross-Tab & Cross-Account Clipboard ---

  hasClipboard() {
    return Boolean(this.clipboard && (this.clipboard.objects.length || this.clipboard.strokes.length));
  }

  async _writeImageToSystemClipboard(obj) {
    if (!navigator.clipboard || typeof navigator.clipboard.write !== 'function' || typeof ClipboardItem === 'undefined') {
      return false;
    }

    const repoKey = this.storage ? this.storage.getRepoKey() : 'local';
    const metaPayload = encodeObjPayload({
      repoKey,
      sourceBoardId: this.getCurrentBoardId(),
      assetPath: obj.assetPath || '',
      w: obj.w,
      h: obj.h,
      rotation: obj.rotation || 0,
      aspectRatio: obj.aspectRatio || (obj.w / Math.max(1, obj.h))
    });
    const htmlStr = `<img data-wb-img="${escapeHtmlAttr(metaPayload)}" alt="whiteboard-image" />`;

    const pngBlobPromise = this.storage.getAssetPngBlob(obj.assetPath, obj.inlineDataUrl);

    try {
      // Promise-based ClipboardItem keeps the user gesture active in Chrome/Edge!
      const itemWithMeta = new ClipboardItem({
        'image/png': pngBlobPromise,
        'text/html': new Blob([htmlStr], { type: 'text/html' })
      });
      await navigator.clipboard.write([itemWithMeta]);
      return true;
    } catch {
      try {
        const pngBlob = await pngBlobPromise;
        if (!pngBlob) return false;
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
        return true;
      } catch {
        return false;
      }
    }
  }

  copySelected(clipboardEvent = null) {
    if (!this.canEditObjects()) return false;
    const items = this.getSelectedItems().filter((i) => this.isTeacher() || !i.data.locked);
    if (!items.length) return false;

    const objs = items.filter((i) => i.kind === 'object').map((i) => JSON.parse(JSON.stringify(i.data)));
    const strs = items.filter((i) => i.kind === 'stroke').map((i) => JSON.parse(JSON.stringify(i.data)));

    this.clipboard = { objects: objs, strokes: strs };
    this.pasteCount = 0;
    const stamp = `${CLIPBOARD_MARKER_PREFIX}${Date.now()}`;
    this.clipboardStamp = stamp;

    const repoKey = this.storage ? this.storage.getRepoKey() : 'local';
    const sourceBoardId = this.getCurrentBoardId();

    // Save shared clipboard for multi-tab paste within the same browser profile
    try {
      localStorage.setItem(STORAGE_KEYS.SHARED_CLIPBOARD, JSON.stringify({
        stamp,
        repoKey,
        sourceBoardId,
        ts: Date.now(),
        payload: this.clipboard
      }));
    } catch {
      // Ignore quota errors
    }

    // CASE 1: Single Image -> write real PNG Blob to OS clipboard (works across monitors, browsers & accounts!)
    if (objs.length === 1 && strs.length === 0 && objs[0].type === 'image') {
      const imgObj = objs[0];
      if (clipboardEvent) clipboardEvent.preventDefault();
      this._writeImageToSystemClipboard(imgObj).then((ok) => {
        if (ok) {
          this.onToast('🖼️ Фото скопійовано (можна вставити на будь-яку дошку)');
        } else {
          this.onToast('Скопійовано у буфер дошки');
        }
      });
      return true;
    }

    // CASE 2: Single Text or Note -> write CLEAN plain text + styled HTML metadata (works everywhere!)
    if (objs.length === 1 && strs.length === 0 && (objs[0].type === 'text' || objs[0].type === 'note')) {
      const textObj = objs[0];
      const cleanText = textObj.text || '';
      const meta = encodeObjPayload({
        sourceBoardId,
        obj: textObj
      });
      const htmlStr = `<span data-wb-obj="${escapeHtmlAttr(meta)}">${escapeHtmlAttr(cleanText)}</span>`;

      if (clipboardEvent && clipboardEvent.clipboardData) {
        clipboardEvent.clipboardData.setData('text/plain', cleanText);
        clipboardEvent.clipboardData.setData('text/html', htmlStr);
        clipboardEvent.preventDefault();
      } else if (navigator.clipboard && typeof navigator.clipboard.write === 'function' && typeof ClipboardItem !== 'undefined') {
        const item = new ClipboardItem({
          'text/plain': new Blob([cleanText], { type: 'text/plain' }),
          'text/html': new Blob([htmlStr], { type: 'text/html' })
        });
        navigator.clipboard.write([item]).catch(() => {
          navigator.clipboard.writeText?.(cleanText).catch(() => {});
        });
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cleanText).catch(() => {});
      }

      this.onToast('📋 Текст скопійовано');
      return true;
    }

    // CASE 3: Multi-item or strokes
    const textFallback = objs
      .filter((o) => (o.type === 'text' || o.type === 'note') && o.text)
      .map((o) => o.text)
      .join('\n\n') || stamp;
    const htmlMulti = `<span data-wb-multi="${escapeHtmlAttr(stamp)}">${escapeHtmlAttr(textFallback)}</span>`;

    if (clipboardEvent && clipboardEvent.clipboardData) {
      clipboardEvent.clipboardData.setData('text/plain', textFallback);
      clipboardEvent.clipboardData.setData('text/html', htmlMulti);
      clipboardEvent.preventDefault();
    } else if (navigator.clipboard && typeof navigator.clipboard.write === 'function' && typeof ClipboardItem !== 'undefined') {
      const item = new ClipboardItem({
        'text/plain': new Blob([textFallback], { type: 'text/plain' }),
        'text/html': new Blob([htmlMulti], { type: 'text/html' })
      });
      navigator.clipboard.write([item]).catch(() => {
        navigator.clipboard.writeText?.(stamp).catch(() => {});
      });
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(stamp).catch(() => {});
    }

    this.onToast(`Скопійовано (${items.length})`);
    return true;
  }

  cutSelected(clipboardEvent = null) {
    if (!this.copySelected(clipboardEvent)) return false;
    this.deleteSelected();
    return true;
  }

  pasteInternal(customPayload = null, { centerInViewport = false } = {}) {
    if (!this.canEditObjects()) return false;
    const payload = customPayload || this.clipboard;
    if (!payload || (!payload.objects.length && !payload.strokes.length)) return false;

    if (!customPayload) this.pasteCount += 1;
    let dx = customPayload ? 26 : 26 * this.pasteCount;
    let dy = dx;

    if (centerInViewport) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const o of payload.objects || []) {
        minX = Math.min(minX, o.x);
        minY = Math.min(minY, o.y);
        maxX = Math.max(maxX, o.x + o.w);
        maxY = Math.max(maxY, o.y + o.h);
      }
      for (const s of payload.strokes || []) {
        const b = this.drawing.getStrokeBounds(s);
        minX = Math.min(minX, b.minX);
        minY = Math.min(minY, b.minY);
        maxX = Math.max(maxX, b.maxX);
        maxY = Math.max(maxY, b.maxY);
      }
      if (isFinite(minX) && isFinite(minY)) {
        const center = this.viewport.getCenterWorld();
        dx = Math.round(center.x - (minX + maxX) / 2);
        dy = Math.round(center.y - (minY + maxY) / 2);
      }
    }

    const groupRemap = new Map();
    const remapGroup = (gid) => {
      if (!gid) return undefined;
      if (!groupRemap.has(gid)) groupRemap.set(gid, uid('grp'));
      return groupRemap.get(gid);
    };

    const newIds = [];
    const newObjs = [];
    const newStrokes = [];
    let nextZ = this.getNextZIndex();

    for (const src of payload.objects || []) {
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = uid(copy.type);
      copy.x = Math.round(copy.x + dx);
      copy.y = Math.round(copy.y + dy);
      copy.locked = false;
      copy.zIndex = nextZ++;
      if (copy.groupId) copy.groupId = remapGroup(copy.groupId);
      newObjs.push(copy);
      newIds.push(copy.id);
    }

    for (const src of payload.strokes || []) {
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = uid(copy.points ? 'str' : 'shp');
      copy.locked = false;
      copy.zIndex = nextZ++;
      if (copy.groupId) copy.groupId = remapGroup(copy.groupId);
      this.drawing.translateStrokeInPlace(copy, dx, dy);
      newStrokes.push(copy);
      newIds.push(copy.id);
    }

    if (newObjs.length) this.objects.addRawObjects(newObjs);
    if (newStrokes.length) this.drawing.addRawStrokes(newStrokes);

    this.selectOnly(newIds);
    this.onMutate('paste', {
      changedObjectIds: newObjs.map((o) => o.id),
      changedStrokeIds: newStrokes.map((s) => s.id)
    });
    return true;
  }

  duplicateSelected() {
    if (!this.canEditObjects()) return;
    const items = this.getSelectedItems().filter((i) => this.isTeacher() || !i.data.locked);
    if (!items.length) return;
    const payload = {
      objects: items.filter((i) => i.kind === 'object').map((i) => JSON.parse(JSON.stringify(i.data))),
      strokes: items.filter((i) => i.kind === 'stroke').map((i) => JSON.parse(JSON.stringify(i.data)))
    };
    this.pasteInternal(payload, { centerInViewport: false });
  }

  // --- Rendering Overlay & Context Toolbar ---

  getSelectionBounds(items) {
    if (!items.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of items) {
      const b = this.getItemBounds(it);
      minX = Math.min(minX, b.minX);
      minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX);
      maxY = Math.max(maxY, b.maxY);
    }
    return { minX, minY, maxX, maxY };
  }

  render() {
    this.renderOverlayOnly();
    this._renderContextBar();
    this.onSelectionChange();
  }

  renderOverlayOnly() {
    this.outlinesEl.innerHTML = '';

    if (this.objects.isEditing()) {
      this.selectionBoxEl.classList.add('hidden');
      return;
    }

    const items = this.getSelectedItems();
    if (!items.length) {
      this.selectionBoxEl.classList.add('hidden');
      return;
    }

    if (items.length > 1) {
      for (const it of items) {
        const b = this.getItemBounds(it);
        const outline = document.createElement('div');
        outline.className = `sel-item-outline ${it.data.locked ? 'locked' : ''}`;
        outline.style.left = `${b.minX}px`;
        outline.style.top = `${b.minY}px`;
        outline.style.width = `${b.maxX - b.minX}px`;
        outline.style.height = `${b.maxY - b.minY}px`;
        if (it.kind === 'object' && it.data.rotation) {
          outline.style.transform = `rotate(${it.data.rotation}deg)`;
        }
        this.outlinesEl.appendChild(outline);
      }
    }

    const bounds = this.getSelectionBounds(items);
    const allLocked = items.every((i) => i.data.locked);
    const singleObj = items.length === 1 && items[0].kind === 'object' ? items[0].data : null;

    this.selectionBoxEl.classList.remove('hidden');
    this.selectionBoxEl.classList.toggle('locked', allLocked);
    this.selectionBoxEl.classList.toggle('grouped', this.isSingleGroup(items));

    this.selectionBoxEl.style.left = `${bounds.minX}px`;
    this.selectionBoxEl.style.top = `${bounds.minY}px`;
    this.selectionBoxEl.style.width = `${Math.max(12, bounds.maxX - bounds.minX)}px`;
    this.selectionBoxEl.style.height = `${Math.max(12, bounds.maxY - bounds.minY)}px`;
    this.selectionBoxEl.style.transform = singleObj && singleObj.rotation ? `rotate(${singleObj.rotation}deg)` : '';

    const onlyMarkers = items.every((i) => i.kind === 'object' && i.data.type === 'marker');
    this.selectionBoxEl.querySelectorAll('.resize-handle').forEach((h) => {
      h.classList.toggle('hidden', allLocked || onlyMarkers);
    });
    const rotHandle = this.selectionBoxEl.querySelector('.rotate-handle');
    if (rotHandle) {
      rotHandle.classList.toggle('hidden', !(singleObj && !singleObj.locked && singleObj.type !== 'marker'));
    }
  }

  _renderEditingBar(obj) {
    this.toolbarEl.classList.remove('hidden');
    this.toolbarEl.innerHTML = '';

    const sel = document.createElement('select');
    sel.className = 'ctx-select';
    sel.title = 'Шрифт';
    FONT_PRESETS.forEach((fp) => {
      const opt = document.createElement('option');
      opt.value = fp.id;
      opt.textContent = fp.label;
      sel.appendChild(opt);
    });
    sel.value = obj.fontFamily || 'sans';
    sel.addEventListener('pointerdown', (e) => e.stopPropagation());
    sel.addEventListener('change', (e) => {
      e.stopPropagation();
      obj.fontFamily = sel.value;
      this.objects.updateObjectEl(obj);
      this.objects.autoFitTextHeight(obj);
      this.onMutate('font-family', { changedObjectIds: [obj.id] });
      this.objects.startEditing(obj.id);
    });
    this.toolbarEl.appendChild(sel);

    const addEditBtn = (label, title, onClick, cls = '') => {
      const btn = document.createElement('button');
      btn.className = `ctx-btn ${cls}`;
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
      this.toolbarEl.appendChild(btn);
    };

    addEditBtn('A−', 'Зменшити шрифт', () => {
      obj.fontSize = Math.max(12, (obj.fontSize || 22) - 2);
      this.objects.updateObjectEl(obj);
      this.objects.autoFitTextHeight(obj);
      this.onMutate('font-size', { changedObjectIds: [obj.id] });
    });

    addEditBtn('A+', 'Збільшити шрифт', () => {
      obj.fontSize = Math.min(72, (obj.fontSize || 22) + 2);
      this.objects.updateObjectEl(obj);
      this.objects.autoFitTextHeight(obj);
      this.onMutate('font-size', { changedObjectIds: [obj.id] });
    });

    if (obj.type === 'text') {
      DRAW_COLORS.forEach((col) => {
        const sw = document.createElement('button');
        sw.className = 'ctx-color';
        sw.style.backgroundColor = col;
        sw.title = 'Колір тексту';
        sw.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        sw.addEventListener('click', (e) => {
          e.stopPropagation();
          obj.color = col;
          this.objects.updateObjectEl(obj);
          this.onMutate('recolor', { changedObjectIds: [obj.id] });
        });
        this.toolbarEl.appendChild(sw);
      });
    }

    addEditBtn('🗑️', 'Видалити напис', () => {
      const id = obj.id;
      this.objects.editingId = null;
      this.objects.removeIds(new Set([id]));
      this.selectedIds.delete(id);
      this.render();
      this.onMutate('delete', { deletedObjectIds: [id] });
    }, 'danger');

    addEditBtn('✓ Готово', 'Завершити введення', () => {
      this.objects.stopEditing();
    }, 'accent');
  }

  _renderContextBar() {
    if (this.objects.isEditing()) {
      const editingObj = this.objects.getById(this.objects.editingId);
      if (editingObj && !editingObj.locked) {
        this._renderEditingBar(editingObj);
        return;
      }
      this.toolbarEl.classList.add('hidden');
      this.toolbarEl.innerHTML = '';
      return;
    }

    const items = this.getSelectedItems();
    if (!items.length || !this.canEditObjects()) {
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
        btn.blur();
        onClick();
      });
      this.toolbarEl.appendChild(btn);
    };

    if (items.length > 1) {
      const cnt = document.createElement('span');
      cnt.className = 'ctx-count';
      cnt.textContent = `Вибрано: ${items.length}`;
      this.toolbarEl.appendChild(cnt);
    }

    const allLocked = items.every((i) => i.data.locked);
    const unlocked = items.filter((i) => !i.data.locked);
    const singleObj = items.length === 1 && items[0].kind === 'object' ? items[0].data : null;

    // Dedicated clean context bar when a single Marker is selected
    if (singleObj && singleObj.type === 'marker' && this.isTeacher()) {
      const tag = document.createElement('span');
      tag.className = 'ctx-count';
      tag.textContent = `🚩 Мітка «${singleObj.label || '1'}»`;
      this.toolbarEl.appendChild(tag);

      if (!singleObj.locked) {
        addBtn('✏️ Назва', 'Змінити номер або назву мітки (подвійний клік)', () => {
          this.onEditMarker(singleObj.id);
        }, 'accent');

        MARKER_COLORS.forEach((col) => {
          const sw = document.createElement('button');
          sw.className = 'ctx-color';
          sw.style.backgroundColor = col;
          sw.title = 'Колір мітки';
          sw.addEventListener('click', (e) => {
            e.stopPropagation();
            sw.blur();
            this.objects.updateMarkerProps(singleObj.id, { color: col });
            this.render();
          });
          this.toolbarEl.appendChild(sw);
        });
      }

      addBtn(
        allLocked ? '🔓 Розблокувати' : '🔒 Закріпити',
        'Закріпити мітку на місці або зробити її рухомою',
        () => this.toggleLockSelected(),
        allLocked ? 'active' : ''
      );

      if (!singleObj.locked) {
        addBtn('🗑️', 'Видалити мітку (Delete)', () => this.deleteSelected(), 'danger');
      }
      return;
    }

    // Prominent "Send to Marker" button for fast sorting on giant boards
    const hasMovableNonMarker = unlocked.some((i) => !(i.kind === 'object' && i.data.type === 'marker'));
    if (this.isTeacher() && hasMovableNonMarker) {
      addBtn(
        this.markerPickerOpen ? '🚩 До мітки ▴' : '🚩 До мітки ▾',
        'Перенести виділене прямо до обраної мітки на дошці',
        () => {
          this.markerPickerOpen = !this.markerPickerOpen;
          this._renderContextBar();
        },
        this.markerPickerOpen ? 'anchor-active' : 'accent'
      );
    }

    if (singleObj && (singleObj.type === 'text' || singleObj.type === 'note')) {
      if (!singleObj.locked) {
        addBtn('✏️ Писати', 'Редагувати текст (або подвійний клік / Enter)', () => {
          this.objects.startEditing(singleObj.id);
        }, 'accent');
      }
      addBtn('📋 Текст', 'Скопіювати чистий текст/шлях у буфер (Ctrl+C)', () => {
        this.copySelected();
      });
      const foundUrl = extractFirstUrl(singleObj.text);
      if (foundUrl) {
        addBtn('🔗 Відкрити', `Відкрити посилання: ${foundUrl}`, () => {
          window.open(foundUrl, '_blank', 'noopener');
        }, 'accent');
      }
    }

    if (singleObj && singleObj.type === 'image') {
      addBtn('📋 Фото', 'Скопіювати фото (вставиться навіть на іншому акаунті / браузері)', () => {
        this.copySelected();
      }, 'accent');
      if (this.isTeacher()) {
        const isAnchor = this.getAnchorObjectId() === singleObj.id;
        addBtn(
          isAnchor ? '🎯 Головне фото' : '🎯 Якір',
          isAnchor
            ? 'Зняти прив’язку головного фото'
            : 'Зробити це фото точкою повернення для кнопки 🎯',
          () => this.onToggleAnchor(singleObj.id),
          isAnchor ? 'anchor-active' : ''
        );
      }
    }

    if (this.canGroup(items)) {
      addBtn('🧩 Згрупувати', 'Об’єднати вибране в групу (Ctrl+G)', () => this.groupSelected(), 'accent');
    }
    if (this.hasAnyGroup(items)) {
      addBtn('🔓 Розгрупувати', 'Роз’єднати групу (Ctrl+Shift+G)', () => this.ungroupSelected());
    }

    if (this.isTeacher()) {
      addBtn(
        allLocked ? '🔓 Розблокувати' : '🔒 Закріпити',
        'Заблокувати, щоб не рухалося під час вправи',
        () => this.toggleLockSelected(),
        allLocked ? 'active' : ''
      );
    }

    if (unlocked.length > 0) {
      addBtn('⬆️', 'На передній план (поверх усього)', () => this.bringToFrontSelected());
      addBtn('⬇️', 'На задній план (під усе)', () => this.sendToBackSelected());

      const unlockedObjs = unlocked.filter((i) => i.kind === 'object');
      const unlockedStrokes = unlocked.filter((i) => i.kind === 'stroke');

      const textItems = unlockedObjs.filter((i) => i.data.type === 'text' || i.data.type === 'note');
      if (textItems.length > 0 && textItems.length === unlocked.length) {
        const sel = document.createElement('select');
        sel.className = 'ctx-select';
        sel.title = 'Вибрати шрифт (включно з прописним)';
        FONT_PRESETS.forEach((fp) => {
          const opt = document.createElement('option');
          opt.value = fp.id;
          opt.textContent = fp.label;
          sel.appendChild(opt);
        });
        sel.value = textItems[0].data.fontFamily || 'sans';
        sel.addEventListener('pointerdown', (e) => e.stopPropagation());
        sel.addEventListener('change', (e) => {
          e.stopPropagation();
          const val = sel.value;
          sel.blur();
          textItems.forEach((i) => {
            i.data.fontFamily = val;
            this.objects.updateObjectEl(i.data);
            this.objects.autoFitTextHeight(i.data);
          });
          this.renderOverlayOnly();
          this.onMutate('font-family', this._collectMutationMeta(textItems));
        });
        this.toolbarEl.appendChild(sel);

        addBtn('A−', 'Зменшити шрифт', () => {
          textItems.forEach((i) => {
            i.data.fontSize = Math.max(12, (i.data.fontSize || 18) - 2);
            this.objects.updateObjectEl(i.data);
            this.objects.autoFitTextHeight(i.data);
          });
          this.renderOverlayOnly();
          this.onMutate('font-size', this._collectMutationMeta(textItems));
        });
        addBtn('A+', 'Збільшити шрифт', () => {
          textItems.forEach((i) => {
            i.data.fontSize = Math.min(72, (i.data.fontSize || 18) + 2);
            this.objects.updateObjectEl(i.data);
            this.objects.autoFitTextHeight(i.data);
          });
          this.renderOverlayOnly();
          this.onMutate('font-size', this._collectMutationMeta(textItems));
        });
      }

      if (unlocked.every((i) => i.kind === 'object' && i.data.type === 'note')) {
        NOTE_COLORS.forEach((c) => {
          const sw = document.createElement('button');
          sw.className = 'ctx-color';
          sw.style.backgroundColor = c.bg;
          sw.title = 'Колір стікера';
          sw.addEventListener('click', (e) => {
            e.stopPropagation();
            sw.blur();
            unlocked.forEach((i) => {
              i.data.bg = c.bg;
              i.data.color = c.text;
              this.objects.updateObjectEl(i.data);
            });
            this.onMutate('note-color', this._collectMutationMeta(unlocked));
          });
          this.toolbarEl.appendChild(sw);
        });
      }

      if (
        unlocked.every((i) => i.kind === 'object' && i.data.type === 'text') ||
        unlockedStrokes.length === unlocked.length
      ) {
        DRAW_COLORS.forEach((col) => {
          const sw = document.createElement('button');
          sw.className = 'ctx-color';
          sw.style.backgroundColor = col;
          sw.title = 'Змінити колір';
          sw.addEventListener('click', (e) => {
            e.stopPropagation();
            sw.blur();
            unlocked.forEach((i) => {
              i.data.color = col;
              if (i.kind === 'object') this.objects.updateObjectEl(i.data);
              else this.drawing.updateStrokeEl(i.data);
            });
            this.onMutate('recolor', this._collectMutationMeta(unlocked));
          });
          this.toolbarEl.appendChild(sw);
        });
      }

      if (!(singleObj && (singleObj.type === 'image' || singleObj.type === 'text' || singleObj.type === 'note'))) {
        addBtn('📋', 'Копіювати (Ctrl+C)', () => this.copySelected());
      }
      addBtn('➕', 'Дублювати (Ctrl+D)', () => this.duplicateSelected());
      addBtn('🗑️', 'Видалити (Delete)', () => this.deleteSelected(), 'danger');
    }

    if (this.isTeacher() && hasMovableNonMarker && this.markerPickerOpen) {
      const picker = document.createElement('div');
      picker.className = 'ctx-marker-picker';
      const targetMarkers = this.objects.getMarkers().filter((m) => !this.selectedIds.has(m.id));

      if (!targetMarkers.length) {
        const hint = document.createElement('span');
        hint.className = 'ctx-marker-hint';
        hint.textContent = 'На цій дошці ще немає міток.';
        const btnNew = document.createElement('button');
        btnNew.className = 'ctx-btn accent';
        btnNew.textContent = '+ Створити мітку';
        btnNew.addEventListener('click', (e) => {
          e.stopPropagation();
          this.markerPickerOpen = false;
          this._renderContextBar();
          this.onOpenMarkersMenu();
        });
        picker.append(hint, btnNew);
      } else {
        targetMarkers.forEach((m) => {
          const chip = document.createElement('button');
          chip.className = 'ctx-marker-chip';
          chip.style.borderColor = m.color || '#ef4444';
          chip.title = `Перенести виділене до мітки «${m.label}»`;

          const dot = document.createElement('span');
          dot.className = 'marker-dot';
          dot.style.backgroundColor = m.color || '#ef4444';

          const txt = document.createElement('span');
          txt.textContent = m.label || '1';

          chip.append(dot, txt);
          chip.addEventListener('click', (e) => {
            e.stopPropagation();
            this.markerPickerOpen = false;
            this.onSendSelectedToMarker(m.id);
          });
          picker.appendChild(chip);
        });
      }
      this.toolbarEl.appendChild(picker);
    }
  }
}
