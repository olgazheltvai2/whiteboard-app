// Unified Selection, Marquee, Multi-Drag/Resize, Z-Layering (Objects + Drawings), Font Picker & Grouping

import { CLIPBOARD_MARKER_PREFIX, DRAW_COLORS, FONT_PRESETS, NOTE_COLORS, uid } from './config.js';

function boxesIntersect(a, b) {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
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
    onMutate,
    onLiveTransform,
    onToast,
    isTeacher = () => true,
    canEditObjects = () => true,
    getNextZIndex,
    getMinZIndex
  }) {
    this.viewportEl = viewportEl;
    this.selectionBoxEl = selectionBoxEl;
    this.outlinesEl = outlinesEl;
    this.marqueeEl = marqueeEl;
    this.toolbarEl = toolbarEl;
    this.viewport = viewport;
    this.objects = objects;
    this.drawing = drawing;
    this.onMutate = onMutate;
    this.onLiveTransform = onLiveTransform || (() => {});
    this.onToast = onToast;
    this.isTeacher = isTeacher;
    this.canEditObjects = canEditObjects;
    this.getNextZIndex = getNextZIndex;
    this.getMinZIndex = getMinZIndex;

    this.selectedIds = new Set();
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
    // Restore original positions if a 2-finger pinch interrupted a 1-frame accidental drag
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

  // Respect actual visual zIndex between objects & strokes!
  hitTestWorld(wx, wy) {
    const hitStroke = this.drawing.hitTest(wx, wy);
    const hitObj = this.objects.hitTest(wx, wy);

    const candidates = [];
    if (hitStroke) candidates.push({ kind: 'stroke', data: hitStroke });
    if (hitObj) candidates.push({ kind: 'object', data: hitObj });

    // Students cannot select locked items at all
    const allowed = this.isTeacher()
      ? candidates
      : candidates.filter((c) => !c.data.locked);

    if (!allowed.length) return null;
    if (allowed.length === 1) return allowed[0];

    // Prefer unlocked over locked; if both unlocked (or both locked), pick higher zIndex!
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
      // On touch screens (tablets/phones), dragging empty space smoothly pans the board!
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
      // Let touch pointerdown bubble to app touch-tracker for 2-finger pinch detection
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
      if (!this.canEditObjects()) return;
      if (e.target.closest('#object-toolbar')) return;
      if (e.target.closest('.board-obj.editing .board-obj-editable')) return;
      const pt = this.viewport.screenToWorld(e.clientX, e.clientY);
      const hitObj = this.objects.hitTest(pt.x, pt.y);
      if (hitObj && (hitObj.type === 'text' || hitObj.type === 'note') && !hitObj.locked) {
        e.preventDefault();
        e.stopPropagation();
        this.selectOnly([hitObj.id]);
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

  // Works for BOTH objects AND drawings (pen, highlighter, shapes)!
  bringToFrontSelected() {
    if (!this.canEditObjects()) return;
    const unlocked = this.getSelectedItems().filter((i) => !i.data.locked);
    if (!unlocked.length) return;
    // Preserve relative order among selected items
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

  // --- Clipboard ---

  hasClipboard() {
    return Boolean(this.clipboard && (this.clipboard.objects.length || this.clipboard.strokes.length));
  }

  copySelected(clipboardEvent = null) {
    if (!this.canEditObjects()) return false;
    const items = this.getSelectedItems().filter((i) => this.isTeacher() || !i.data.locked);
    if (!items.length) return false;

    this.clipboard = {
      objects: items.filter((i) => i.kind === 'object').map((i) => JSON.parse(JSON.stringify(i.data))),
      strokes: items.filter((i) => i.kind === 'stroke').map((i) => JSON.parse(JSON.stringify(i.data)))
    };
    this.pasteCount = 0;
    this.clipboardStamp = `${CLIPBOARD_MARKER_PREFIX}${Date.now()}`;

    if (clipboardEvent && clipboardEvent.clipboardData) {
      clipboardEvent.clipboardData.setData('text/plain', this.clipboardStamp);
      clipboardEvent.preventDefault();
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(this.clipboardStamp).catch(() => {});
    }

    this.onToast(`Скопійовано (${items.length})`);
    return true;
  }

  cutSelected(clipboardEvent = null) {
    if (!this.copySelected(clipboardEvent)) return false;
    this.deleteSelected();
    return true;
  }

  pasteInternal(customPayload = null) {
    if (!this.canEditObjects()) return false;
    const payload = customPayload || this.clipboard;
    if (!payload || (!payload.objects.length && !payload.strokes.length)) return false;

    if (!customPayload) this.pasteCount += 1;
    const offset = customPayload ? 26 : 26 * this.pasteCount;

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

    for (const src of payload.objects) {
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = uid(copy.type);
      copy.x += offset;
      copy.y += offset;
      copy.locked = false;
      copy.zIndex = nextZ++;
      if (copy.groupId) copy.groupId = remapGroup(copy.groupId);
      newObjs.push(copy);
      newIds.push(copy.id);
    }

    for (const src of payload.strokes) {
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = uid(copy.points ? 'str' : 'shp');
      copy.locked = false;
      copy.zIndex = nextZ++;
      if (copy.groupId) copy.groupId = remapGroup(copy.groupId);
      this.drawing.translateStrokeInPlace(copy, offset, offset);
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
    this.pasteInternal(payload);
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

    this.selectionBoxEl.querySelectorAll('.resize-handle').forEach((h) => {
      h.classList.toggle('hidden', allLocked);
    });
    const rotHandle = this.selectionBoxEl.querySelector('.rotate-handle');
    if (rotHandle) {
      rotHandle.classList.toggle('hidden', !(singleObj && !singleObj.locked));
    }
  }

  _renderContextBar() {
    const items = this.getSelectedItems();
    if (!items.length || this.objects.isEditing() || !this.canEditObjects()) {
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

    if (singleObj && !singleObj.locked && (singleObj.type === 'text' || singleObj.type === 'note')) {
      addBtn('✏️ Писати', 'Редагувати текст (або подвійний клік / Enter)', () => {
        this.objects.startEditing(singleObj.id);
      }, 'accent');
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
      // Z-Order buttons now work for BOTH images/text AND pen/marker/shapes!
      addBtn('⬆️', 'На передній план (поверх усього)', () => this.bringToFrontSelected());
      addBtn('⬇️', 'На задній план (під усе)', () => this.sendToBackSelected());

      const unlockedObjs = unlocked.filter((i) => i.kind === 'object');
      const unlockedStrokes = unlocked.filter((i) => i.kind === 'stroke');

      // Font family & size for text/note
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
          });
          this.onMutate('font-family', this._collectMutationMeta(textItems));
        });
        this.toolbarEl.appendChild(sel);

        addBtn('A−', 'Зменшити шрифт', () => {
          textItems.forEach((i) => {
            i.data.fontSize = Math.max(12, (i.data.fontSize || 18) - 2);
            this.objects.updateObjectEl(i.data);
          });
          this.onMutate('font-size', this._collectMutationMeta(textItems));
        });
        addBtn('A+', 'Збільшити шрифт', () => {
          textItems.forEach((i) => {
            i.data.fontSize = Math.min(72, (i.data.fontSize || 18) + 2);
            this.objects.updateObjectEl(i.data);
          });
          this.onMutate('font-size', this._collectMutationMeta(textItems));
        });
      }

      // Note colors
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

      // Text or Stroke colors
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

      addBtn('📋', 'Копіювати (Ctrl+C)', () => this.copySelected());
      addBtn('➕', 'Дублювати (Ctrl+D)', () => this.duplicateSelected());
      addBtn('🗑️', 'Видалити (Delete)', () => this.deleteSelected(), 'danger');
    }
  }
}
