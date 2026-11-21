// Vector SVG drawing layer: Pen, Highlighter, Shapes, Eraser + Select/Move/Scale support

import { uid } from './config.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function buildSmoothPath(points) {
  if (!points || points.length === 0) return '';
  if (points.length === 1) {
    const [x, y] = points[0];
    return `M ${x} ${y} L ${x + 0.1} ${y + 0.1}`;
  }
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const mx = (points[i][0] + points[i + 1][0]) / 2;
    const my = (points[i][1] + points[i + 1][1]) / 2;
    d += ` Q ${points[i][0]} ${points[i][1]} ${mx} ${my}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last[0]} ${last[1]}`;
  return d;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  }
  const nx = x1 + t * dx;
  const ny = y1 + t * dy;
  return Math.hypot(px - nx, py - ny);
}

export class DrawingManager {
  constructor({ strokesGroup, activeGroup, viewport, onMutate }) {
    this.strokesGroup = strokesGroup;
    this.activeGroup = activeGroup;
    this.viewport = viewport;
    this.onMutate = onMutate;

    this.strokes = [];
    this.elMap = new Map();
    this.color = '#ff5c5c';
    this.width = 5;

    this.currentStroke = null;
    this.isErasing = false;
    this.erasedAny = false;
  }

  setStrokes(list) {
    this.strokes = Array.isArray(list) ? list : [];
    this.renderAll();
  }

  getStrokes() {
    return this.strokes;
  }

  getById(id) {
    return this.strokes.find((s) => s.id === id) || null;
  }

  setColor(c) {
    this.color = c;
  }

  setWidth(w) {
    this.width = w;
  }

  addRawStrokes(list) {
    for (const s of list) {
      this.strokes.push(s);
      const el = this._createSvgElement(s);
      if (el) {
        this.strokesGroup.appendChild(el);
        this.elMap.set(s.id, el);
      }
    }
  }

  removeIds(idSet) {
    let removed = false;
    this.strokes = this.strokes.filter((s) => {
      if (idSet.has(s.id)) {
        const el = this.elMap.get(s.id);
        if (el) el.remove();
        this.elMap.delete(s.id);
        removed = true;
        return false;
      }
      return true;
    });
    return removed;
  }

  clearAllDrawings() {
    if (!this.strokes.length) return false;
    this.strokes = [];
    this.renderAll();
    this.onMutate('clear-drawings');
    return true;
  }

  startPointer(tool, worldPt) {
    if (tool === 'eraser') {
      this.isErasing = true;
      this.erasedAny = false;
      this._eraseAt(worldPt.x, worldPt.y);
      return;
    }

    const x = Math.round(worldPt.x * 10) / 10;
    const y = Math.round(worldPt.y * 10) / 10;

    if (tool === 'pen' || tool === 'highlighter') {
      this.currentStroke = {
        id: uid('str'),
        kind: tool,
        color: this.color,
        width: tool === 'highlighter' ? Math.max(18, this.width * 3.5) : this.width,
        opacity: tool === 'highlighter' ? 0.36 : 1,
        locked: false,
        points: [[x, y]]
      };
    } else if (['line', 'arrow', 'rect', 'ellipse'].includes(tool)) {
      this.currentStroke = {
        id: uid('shp'),
        kind: tool,
        color: this.color,
        width: this.width,
        opacity: 1,
        locked: false,
        x1: x,
        y1: y,
        x2: x,
        y2: y
      };
    }

    this._renderActive();
  }

  movePointer(worldPt) {
    if (this.isErasing) {
      this._eraseAt(worldPt.x, worldPt.y);
      return;
    }
    if (!this.currentStroke) return;

    const x = Math.round(worldPt.x * 10) / 10;
    const y = Math.round(worldPt.y * 10) / 10;

    if (this.currentStroke.points) {
      const pts = this.currentStroke.points;
      const prev = pts[pts.length - 1];
      const minStep = Math.max(1.5, 2.2 / this.viewport.zoom);
      if (Math.hypot(x - prev[0], y - prev[1]) >= minStep) {
        pts.push([x, y]);
        this._renderActive();
      }
    } else {
      this.currentStroke.x2 = x;
      this.currentStroke.y2 = y;
      this._renderActive();
    }
  }

  endPointer() {
    if (this.isErasing) {
      this.isErasing = false;
      if (this.erasedAny) {
        this.erasedAny = false;
        this.onMutate('erase');
      }
      return;
    }
    if (!this.currentStroke) return;

    const finished = this.currentStroke;
    this.currentStroke = null;
    this.activeGroup.innerHTML = '';

    // Ignore accidental zero-size shapes
    if (!finished.points) {
      if (Math.hypot(finished.x2 - finished.x1, finished.y2 - finished.y1) < 3) {
        return;
      }
    }

    this.strokes.push(finished);
    const el = this._createSvgElement(finished);
    if (el) {
      this.strokesGroup.appendChild(el);
      this.elMap.set(finished.id, el);
    }
    this.onMutate('draw');
  }

  _eraseAt(wx, wy) {
    const radius = Math.max(12, 16 / this.viewport.zoom);
    let removed = false;

    this.strokes = this.strokes.filter((s) => {
      if (s.locked) return true;
      const hit = this.hitTestStroke(s, wx, wy, radius);
      if (hit) removed = true;
      return !hit;
    });

    if (removed) {
      this.erasedAny = true;
      this.renderAll();
    }
  }

  hitTest(wx, wy) {
    const radius = Math.max(8, 10 / this.viewport.zoom);
    // Search from topmost stroke backward
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      if (this.hitTestStroke(this.strokes[i], wx, wy, radius)) {
        return this.strokes[i];
      }
    }
    return null;
  }

  hitTestStroke(s, wx, wy, radius) {
    const tol = radius + (s.width || 4) / 2;
    if (s.points) {
      if (s.points.length === 1) {
        return Math.hypot(wx - s.points[0][0], wy - s.points[0][1]) <= tol;
      }
      for (let i = 0; i < s.points.length - 1; i++) {
        const d = distToSegment(wx, wy, s.points[i][0], s.points[i][1], s.points[i + 1][0], s.points[i + 1][1]);
        if (d <= tol) return true;
      }
      return false;
    }

    if (s.kind === 'line' || s.kind === 'arrow') {
      return distToSegment(wx, wy, s.x1, s.y1, s.x2, s.y2) <= tol;
    }

    if (s.kind === 'rect') {
      const minX = Math.min(s.x1, s.x2);
      const maxX = Math.max(s.x1, s.x2);
      const minY = Math.min(s.y1, s.y2);
      const maxY = Math.max(s.y1, s.y2);
      const edges = [
        [minX, minY, maxX, minY],
        [maxX, minY, maxX, maxY],
        [maxX, maxY, minX, maxY],
        [minX, maxY, minX, minY]
      ];
      return edges.some(([a, b, c, d]) => distToSegment(wx, wy, a, b, c, d) <= tol);
    }

    if (s.kind === 'ellipse') {
      const cx = (s.x1 + s.x2) / 2;
      const cy = (s.y1 + s.y2) / 2;
      const rx = Math.max(1, Math.abs(s.x2 - s.x1) / 2);
      const ry = Math.max(1, Math.abs(s.y2 - s.y1) / 2);
      const norm = Math.hypot((wx - cx) / rx, (wy - cy) / ry);
      const avgR = (rx + ry) / 2;
      return Math.abs(norm - 1) * avgR <= tol;
    }

    return false;
  }

  getStrokeBounds(s) {
    const pad = Math.max(6, (s.width || 4) / 2 + 2);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    if (s.points) {
      for (const [x, y] of s.points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    } else {
      minX = Math.min(s.x1, s.x2);
      maxX = Math.max(s.x1, s.x2);
      minY = Math.min(s.y1, s.y2);
      maxY = Math.max(s.y1, s.y2);
    }
    return {
      minX: minX - pad,
      minY: minY - pad,
      maxX: maxX + pad,
      maxY: maxY + pad
    };
  }

  applyTranslationFromSnapshot(stroke, origSnap, dx, dy) {
    if (stroke.points && origSnap.points) {
      stroke.points = origSnap.points.map(([x, y]) => [
        Math.round((x + dx) * 10) / 10,
        Math.round((y + dy) * 10) / 10
      ]);
    } else {
      stroke.x1 = Math.round((origSnap.x1 + dx) * 10) / 10;
      stroke.y1 = Math.round((origSnap.y1 + dy) * 10) / 10;
      stroke.x2 = Math.round((origSnap.x2 + dx) * 10) / 10;
      stroke.y2 = Math.round((origSnap.y2 + dy) * 10) / 10;
    }
    this.updateStrokeEl(stroke);
  }

  applyScaleFromSnapshot(stroke, origSnap, origBox, newBox) {
    const ow = Math.max(1, origBox.maxX - origBox.minX);
    const oh = Math.max(1, origBox.maxY - origBox.minY);
    const nw = Math.max(8, newBox.maxX - newBox.minX);
    const nh = Math.max(8, newBox.maxY - newBox.minY);
    const mapX = (x) => Math.round((newBox.minX + ((x - origBox.minX) / ow) * nw) * 10) / 10;
    const mapY = (y) => Math.round((newBox.minY + ((y - origBox.minY) / oh) * nh) * 10) / 10;

    if (stroke.points && origSnap.points) {
      stroke.points = origSnap.points.map(([x, y]) => [mapX(x), mapY(y)]);
    } else {
      stroke.x1 = mapX(origSnap.x1);
      stroke.y1 = mapY(origSnap.y1);
      stroke.x2 = mapX(origSnap.x2);
      stroke.y2 = mapY(origSnap.y2);
    }
    this.updateStrokeEl(stroke);
  }

  translateStrokeInPlace(stroke, dx, dy) {
    if (stroke.points) {
      stroke.points = stroke.points.map(([x, y]) => [
        Math.round((x + dx) * 10) / 10,
        Math.round((y + dy) * 10) / 10
      ]);
    } else {
      stroke.x1 = Math.round((stroke.x1 + dx) * 10) / 10;
      stroke.y1 = Math.round((stroke.y1 + dy) * 10) / 10;
      stroke.x2 = Math.round((stroke.x2 + dx) * 10) / 10;
      stroke.y2 = Math.round((stroke.y2 + dy) * 10) / 10;
    }
  }

  updateStrokeEl(s) {
    const oldEl = this.elMap.get(s.id);
    const newEl = this._createSvgElement(s);
    if (!newEl) return;
    if (oldEl && oldEl.parentNode) {
      oldEl.replaceWith(newEl);
    } else {
      this.strokesGroup.appendChild(newEl);
    }
    this.elMap.set(s.id, newEl);
  }

  _renderActive() {
    this.activeGroup.innerHTML = '';
    if (!this.currentStroke) return;
    const el = this._createSvgElement(this.currentStroke);
    if (el) this.activeGroup.appendChild(el);
  }

  renderAll() {
    this.strokesGroup.innerHTML = '';
    this.elMap.clear();
    const frag = document.createDocumentFragment();
    for (const s of this.strokes) {
      const el = this._createSvgElement(s);
      if (el) {
        frag.appendChild(el);
        this.elMap.set(s.id, el);
      }
    }
    this.strokesGroup.appendChild(frag);
  }

  _createSvgElement(s) {
    if (s.points) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', buildSmoothPath(s.points));
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', s.color);
      path.setAttribute('stroke-width', s.width);
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('stroke-opacity', s.opacity ?? 1);
      return path;
    }

    if (s.kind === 'line') {
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', s.x1);
      line.setAttribute('y1', s.y1);
      line.setAttribute('x2', s.x2);
      line.setAttribute('y2', s.y2);
      line.setAttribute('stroke', s.color);
      line.setAttribute('stroke-width', s.width);
      line.setAttribute('stroke-linecap', 'round');
      return line;
    }

    if (s.kind === 'arrow') {
      const g = document.createElementNS(SVG_NS, 'g');
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', s.x1);
      line.setAttribute('y1', s.y1);
      line.setAttribute('x2', s.x2);
      line.setAttribute('y2', s.y2);
      line.setAttribute('stroke', s.color);
      line.setAttribute('stroke-width', s.width);
      line.setAttribute('stroke-linecap', 'round');
      g.appendChild(line);

      const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      const headLen = Math.max(12, s.width * 3.2);
      const a1 = angle - Math.PI / 6;
      const a2 = angle + Math.PI / 6;
      const p1x = s.x2 - headLen * Math.cos(a1);
      const p1y = s.y2 - headLen * Math.sin(a1);
      const p2x = s.x2 - headLen * Math.cos(a2);
      const p2y = s.y2 - headLen * Math.sin(a2);

      const head = document.createElementNS(SVG_NS, 'path');
      head.setAttribute('d', `M ${p1x} ${p1y} L ${s.x2} ${s.y2} L ${p2x} ${p2y}`);
      head.setAttribute('fill', 'none');
      head.setAttribute('stroke', s.color);
      head.setAttribute('stroke-width', s.width);
      head.setAttribute('stroke-linecap', 'round');
      head.setAttribute('stroke-linejoin', 'round');
      g.appendChild(head);
      return g;
    }

    if (s.kind === 'rect') {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', Math.min(s.x1, s.x2));
      rect.setAttribute('y', Math.min(s.y1, s.y2));
      rect.setAttribute('width', Math.abs(s.x2 - s.x1));
      rect.setAttribute('height', Math.abs(s.y2 - s.y1));
      rect.setAttribute('rx', 4);
      rect.setAttribute('fill', 'none');
      rect.setAttribute('stroke', s.color);
      rect.setAttribute('stroke-width', s.width);
      return rect;
    }

    if (s.kind === 'ellipse') {
      const el = document.createElementNS(SVG_NS, 'ellipse');
      el.setAttribute('cx', (s.x1 + s.x2) / 2);
      el.setAttribute('cy', (s.y1 + s.y2) / 2);
      el.setAttribute('rx', Math.abs(s.x2 - s.x1) / 2);
      el.setAttribute('ry', Math.abs(s.y2 - s.y1) / 2);
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', s.color);
      el.setAttribute('stroke-width', s.width);
      return el;
    }

    return null;
  }

  getBounds() {
    if (!this.strokes.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of this.strokes) {
      const b = this.getStrokeBounds(s);
      minX = Math.min(minX, b.minX);
      minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX);
      maxY = Math.max(maxY, b.maxY);
    }
    return { minX, minY, maxX, maxY };
  }
}
