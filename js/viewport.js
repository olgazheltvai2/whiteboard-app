function hexToRgb(hex) {
  const clean = String(hex || '').trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16)
  };
}

// Infinite canvas: mouse wheel, 2-finger pinch-zoom & pan, cross-device camera fitting

export class ViewportController {
  constructor(viewportEl, worldEl, onZoomChange = () => {}, onViewChange = () => {}) {
    this.viewportEl = viewportEl;
    this.worldEl = worldEl;
    this.onZoomChange = onZoomChange;
    this.onViewChange = onViewChange;

    this.x = 0;
    this.y = 0;
    this.zoom = 1;
    this.minZoom = 0.02;
    this.maxZoom = 4.5;
    this.cameraLocked = false;

    this.isPanning = false;
    this._panPointerId = null;
    this.panStartX = 0;
    this.panStartY = 0;
    this.panOriginX = 0;
    this.panOriginY = 0;
    this.spacePressed = false;

    // Multi-touch pinch state
    this.isPinching = false;
    this._pinchData = null;

    this._bindEvents();
    this.apply(false);
  }

  setCameraLocked(locked) {
    this.cameraLocked = Boolean(locked);
    if (this.cameraLocked) {
      this.endPan();
      this.endPinch();
    }
  }

  _bindEvents() {
    this.viewportEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.cameraLocked) return;
      const rect = this.viewportEl.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      const delta = -e.deltaY;
      const factor = e.ctrlKey ? Math.exp(delta * 0.01) : (delta > 0 ? 1.1 : 1 / 1.1);
      this.zoomAt(sx, sy, this.zoom * factor);
    }, { passive: false });

    // Prevent native Safari iPad pinch-to-zoom page distortion
    this.viewportEl.addEventListener('gesturestart', (e) => e.preventDefault());
    this.viewportEl.addEventListener('gesturechange', (e) => e.preventDefault());
    this.viewportEl.addEventListener('gestureend', (e) => e.preventDefault());

    this.viewportEl.addEventListener('contextmenu', (e) => {
      if (this._didRightDrag) {
        e.preventDefault();
        this._didRightDrag = false;
      }
    });
  }

  // --- Single-pointer Pan ---

  startPan(clientX, clientY, pointerId, isRightButton = false) {
    if (this.cameraLocked) return;
    this.isPanning = true;
    this._panPointerId = pointerId;
    this._isRightPan = isRightButton;
    this._didRightDrag = false;
    this.panStartX = clientX;
    this.panStartY = clientY;
    this.panOriginX = this.x;
    this.panOriginY = this.y;
    this.viewportEl.classList.add('cursor-panning');
  }

  movePan(clientX, clientY, pointerId = null) {
    if (!this.isPanning || this.cameraLocked) return;
    if (pointerId !== null && this._panPointerId !== null && pointerId !== this._panPointerId) return;
    const dx = clientX - this.panStartX;
    const dy = clientY - this.panStartY;
    if (this._isRightPan && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      this._didRightDrag = true;
    }
    this.x = this.panOriginX + dx;
    this.y = this.panOriginY + dy;
    this.apply(true);
  }

  endPan(pointerId = null) {
    if (!this.isPanning) return;
    if (pointerId !== null && this._panPointerId !== null && pointerId !== this._panPointerId) return;
    this.isPanning = false;
    this._panPointerId = null;
    this.viewportEl.classList.remove('cursor-panning');
  }

  // --- Two-Finger Pinch Zoom + Pan (Tablets & Phones) ---

  startPinch(p1, p2) {
    if (this.cameraLocked) return;
    this.endPan();
    const rect = this.viewportEl.getBoundingClientRect();
    const mx = (p1.x + p2.x) / 2 - rect.left;
    const my = (p1.y + p2.y) / 2 - rect.top;
    const dist = Math.max(10, Math.hypot(p2.x - p1.x, p2.y - p1.y));
    const worldAnchorX = (mx - this.x) / this.zoom;
    const worldAnchorY = (my - this.y) / this.zoom;

    this.isPinching = true;
    this._pinchData = {
      startDist: dist,
      startZoom: this.zoom,
      worldAnchorX,
      worldAnchorY
    };
  }

  movePinch(p1, p2) {
    if (!this.isPinching || !this._pinchData || this.cameraLocked) return;
    const rect = this.viewportEl.getBoundingClientRect();
    const mx = (p1.x + p2.x) / 2 - rect.left;
    const my = (p1.y + p2.y) / 2 - rect.top;
    const dist = Math.max(10, Math.hypot(p2.x - p1.x, p2.y - p1.y));

    const ratio = dist / this._pinchData.startDist;
    const nextZoom = Math.min(this.maxZoom, Math.max(this.minZoom, this._pinchData.startZoom * ratio));

    this.zoom = nextZoom;
    this.x = mx - this._pinchData.worldAnchorX * nextZoom;
    this.y = my - this._pinchData.worldAnchorY * nextZoom;
    this.apply(true);
  }

  endPinch() {
    this.isPinching = false;
    this._pinchData = null;
  }

  // --- Zoom & Cross-Device Camera Fitting ---

  zoomAt(screenX, screenY, nextZoom) {
    if (this.cameraLocked) return;
    const clamped = Math.min(this.maxZoom, Math.max(this.minZoom, nextZoom));
    const ratio = clamped / this.zoom;
    this.x = screenX - (screenX - this.x) * ratio;
    this.y = screenY - (screenY - this.y) * ratio;
    this.zoom = clamped;
    this.apply(true);
  }

  zoomCenter(factor) {
    if (this.cameraLocked) return;
    const rect = this.viewportEl.getBoundingClientRect();
    this.zoomAt(rect.width / 2, rect.height / 2, this.zoom * factor);
  }

  resetZoom() {
    if (this.cameraLocked) return;
    const rect = this.viewportEl.getBoundingClientRect();
    this.zoomAt(rect.width / 2, rect.height / 2, 1);
  }

  setView(x, y, zoom = 1, notify = false) {
    this.x = x;
    this.y = y;
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
    this.apply(notify);
  }

  // Returns teacher's full visible world area so phones & tablets fit the exact same content!
  getCameraState() {
    const rect = this.viewportEl.getBoundingClientRect();
    const w = Math.max(100, rect.width);
    const h = Math.max(100, rect.height);
    return {
      cx: (w / 2 - this.x) / this.zoom,
      cy: (h / 2 - this.y) / this.zoom,
      viewW: w / this.zoom,
      viewH: h / this.zoom,
      zoom: this.zoom
    };
  }

  // Fits the teacher's visible world rectangle neatly into ANY student screen (phone / tablet / PC)
  fitWorldRect(cx, cy, viewW, viewH, fallbackZoom = 1) {
    const rect = this.viewportEl.getBoundingClientRect();
    const sw = Math.max(100, rect.width);
    const sh = Math.max(100, rect.height);

    let targetZoom = fallbackZoom;
    if (viewW > 40 && viewH > 40) {
      // Leave tiny breathing room (0.96) so edges aren't cut off by bottom toolbar
      targetZoom = Math.min((sw * 0.98) / viewW, (sh * 0.94) / viewH);
    }
    const clamped = Math.min(this.maxZoom, Math.max(this.minZoom, targetZoom));
    const nx = sw / 2 - cx * clamped;
    const ny = sh / 2 - cy * clamped;
    this.setView(nx, ny, clamped, false);
  }

  centerOnOrigin() {
    const rect = this.viewportEl.getBoundingClientRect();
    this.setView(rect.width / 2, rect.height / 2, 1, true);
  }

  fitBounds(bounds) {
    if (this.cameraLocked) return;
    const rect = this.viewportEl.getBoundingClientRect();
    if (!bounds) {
      this.centerOnOrigin();
      return;
    }
    const pad = Math.min(56, Math.min(rect.width, rect.height) * 0.12);
    const bw = Math.max(bounds.maxX - bounds.minX, 120);
    const bh = Math.max(bounds.maxY - bounds.minY, 120);
    const z = Math.min(
      (rect.width - pad * 2) / bw,
      (rect.height - pad * 2) / bh,
      1.5
    );
    const clamped = Math.max(this.minZoom, z);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    this.setView(rect.width / 2 - cx * clamped, rect.height / 2 - cy * clamped, clamped, true);
  }

  screenToWorld(clientX, clientY) {
    const rect = this.viewportEl.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.x) / this.zoom,
      y: (clientY - rect.top - this.y) / this.zoom
    };
  }

  getCenterWorld() {
    const rect = this.viewportEl.getBoundingClientRect();
    return {
      x: (rect.width / 2 - this.x) / this.zoom,
      y: (rect.height / 2 - this.y) / this.zoom
    };
  }

  getVisibleWorldRect(marginRatio = 0.5) {
    const rect = this.viewportEl.getBoundingClientRect();
    const w = Math.max(100, rect.width);
    const h = Math.max(100, rect.height);
    const minX = -this.x / this.zoom;
    const minY = -this.y / this.zoom;
    const viewW = w / this.zoom;
    const viewH = h / this.zoom;
    const padX = viewW * marginRatio;
    const padY = viewH * marginRatio;
    return {
      minX: minX - padX,
      minY: minY - padY,
      maxX: minX + viewW + padX,
      maxY: minY + viewH + padY,
      cx: minX + viewW / 2,
      cy: minY + viewH / 2,
      viewW,
      viewH
    };
  }

  focusOnRect(x, y, w, h, { maxZoom = 1.05, minTargetZoom = 0.25, fillRatio = 0.52 } = {}) {
    if (this.cameraLocked) return;
    const rect = this.viewportEl.getBoundingClientRect();
    const sw = Math.max(200, rect.width);
    const sh = Math.max(200, rect.height);
    const bw = Math.max(60, w);
    const bh = Math.max(60, h);
    const targetZ = Math.min((sw * fillRatio) / bw, (sh * fillRatio) / bh, maxZoom);
    const clamped = Math.min(this.maxZoom, Math.max(minTargetZoom, targetZ));
    const cx = x + w / 2;
    const cy = y + h / 2;
    this.setView(sw / 2 - cx * clamped, sh / 2 - cy * clamped, clamped, true);
  }

  apply(notify = true) {
    this.worldEl.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.zoom})`;
    const gridPx = Math.max(10, 32 * this.zoom);
    const linePx = Math.max(14, 38 * this.zoom);
    const propW = Math.max(12, 34 * this.zoom);
    const propH = Math.max(24, 72 * this.zoom);
    this.viewportEl.style.setProperty('--grid-x', `${this.x}px`);
    this.viewportEl.style.setProperty('--grid-y', `${this.y}px`);
    this.viewportEl.style.setProperty('--grid-size', `${gridPx}px`);
    this.viewportEl.style.setProperty('--line-size', `${linePx}px`);
    this.viewportEl.style.setProperty('--propysy-w', `${propW}px`);
    this.viewportEl.style.setProperty('--propysy-h', `${propH}px`);
    this.onZoomChange(this.zoom);
    if (notify) this.onViewChange();
  }

  setBackground(theme = 'dark', pattern = 'dots', bgStyle = null) {
    const t = theme === 'light' ? 'light' : 'dark';
    const p = pattern || 'dots';
    this.viewportEl.classList.remove(
      'bg-dark', 'bg-light',
      'pattern-none', 'pattern-dots', 'pattern-grid', 'pattern-lines', 'pattern-propysy'
    );
    this.viewportEl.classList.add(t === 'light' ? 'bg-light' : 'bg-dark');
    this.viewportEl.classList.add(`pattern-${p}`);

    if (p === 'none') {
      this.viewportEl.style.backgroundImage = 'none';
      return;
    }

    const customHex = bgStyle && typeof bgStyle.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(bgStyle.color.trim())
      ? bgStyle.color.trim()
      : '';
    const defaultHex = p === 'propysy'
      ? (t === 'light' ? '#4a86cf' : '#99b9e6')
      : (t === 'light' ? '#334155' : '#e2e8f0');
    const hex = customHex || defaultHex;
    const rgb = hexToRgb(hex) || { r: 148, g: 163, b: 184 };

    const rawOp = bgStyle && typeof bgStyle.opacity === 'number' ? bgStyle.opacity : 0.34;
    const opacity = Math.min(1, Math.max(0.08, rawOp));

    const rawThick = bgStyle && typeof bgStyle.thickness === 'number' ? bgStyle.thickness : 1.5;
    const thick = Math.min(4.5, Math.max(0.8, rawThick));

    const rgba = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity.toFixed(2)})`;

    if (p === 'dots') {
      const r = Math.max(1.0, Number((thick * 0.95).toFixed(2)));
      const fade = Number((r + 0.45).toFixed(2));
      this.viewportEl.style.backgroundImage = `radial-gradient(circle, ${rgba} ${r}px, transparent ${fade}px)`;
    } else if (p === 'grid') {
      this.viewportEl.style.backgroundImage =
        `linear-gradient(to right, ${rgba} ${thick}px, transparent ${thick}px), ` +
        `linear-gradient(to bottom, ${rgba} ${thick}px, transparent ${thick}px)`;
    } else if (p === 'lines') {
      this.viewportEl.style.backgroundImage = `linear-gradient(to bottom, ${rgba} ${thick}px, transparent ${thick}px)`;
    } else if (p === 'propysy') {
      const encHex = hex.replace('#', '%23');
      const mainOp = Math.min(1, Math.max(0.1, opacity)).toFixed(2);
      const slantOp = Math.min(1, Math.max(0.08, opacity * 0.65)).toFixed(2);
      const subOp = Math.min(1, Math.max(0.06, opacity * 0.48)).toFixed(2);
      const mainW = thick.toFixed(2);
      const slantW = Math.max(0.7, thick * 0.8).toFixed(2);
      const subW = Math.max(0.6, thick * 0.65).toFixed(2);
      this.viewportEl.style.backgroundImage =
        `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='34' height='72' viewBox='0 0 34 72'%3E` +
        `%3Cline x1='34' y1='0' x2='0' y2='72' stroke='${encHex}' stroke-opacity='${slantOp}' stroke-width='${slantW}'/%3E` +
        `%3Cline x1='0' y1='24' x2='34' y2='24' stroke='${encHex}' stroke-opacity='${mainOp}' stroke-width='${mainW}'/%3E` +
        `%3Cline x1='0' y1='48' x2='34' y2='48' stroke='${encHex}' stroke-opacity='${mainOp}' stroke-width='${mainW}'/%3E` +
        `%3Cline x1='0' y1='71.5' x2='34' y2='71.5' stroke='${encHex}' stroke-opacity='${subOp}' stroke-width='${subW}'/%3E` +
        `%3C/svg%3E")`;
    }
  }
}
