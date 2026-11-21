// Infinite canvas pan, zoom, background grid (incl. Propysy) & camera sync

export class ViewportController {
  constructor(viewportEl, worldEl, onZoomChange = () => {}, onViewChange = () => {}) {
    this.viewportEl = viewportEl;
    this.worldEl = worldEl;
    this.onZoomChange = onZoomChange;
    this.onViewChange = onViewChange;

    this.x = 0;
    this.y = 0;
    this.zoom = 1;
    this.minZoom = 0.15;
    this.maxZoom = 4.5;
    this.cameraLocked = false;

    this.isPanning = false;
    this.panStartX = 0;
    this.panStartY = 0;
    this.panOriginX = 0;
    this.panOriginY = 0;
    this.spacePressed = false;

    this._bindEvents();
    this.apply(false);
  }

  setCameraLocked(locked) {
    this.cameraLocked = Boolean(locked);
    if (this.cameraLocked && this.isPanning) {
      this.endPan();
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

    this.viewportEl.addEventListener('contextmenu', (e) => {
      if (this._didRightDrag) {
        e.preventDefault();
        this._didRightDrag = false;
      }
    });
  }

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

  movePan(clientX, clientY) {
    if (!this.isPanning || this.cameraLocked) return;
    const dx = clientX - this.panStartX;
    const dy = clientY - this.panStartY;
    if (this._isRightPan && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      this._didRightDrag = true;
    }
    this.x = this.panOriginX + dx;
    this.y = this.panOriginY + dy;
    this.apply(true);
  }

  endPan() {
    if (!this.isPanning) return;
    this.isPanning = false;
    this._panPointerId = null;
    this.viewportEl.classList.remove('cursor-panning');
  }

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

  setCenterWorld(cx, cy, zoom = 1, notify = false) {
    const rect = this.viewportEl.getBoundingClientRect();
    const clamped = Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
    const nx = rect.width / 2 - cx * clamped;
    const ny = rect.height / 2 - cy * clamped;
    this.setView(nx, ny, clamped, notify);
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
    const pad = 64;
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

  setBackground(theme = 'dark', pattern = 'dots') {
    this.viewportEl.classList.remove(
      'bg-dark', 'bg-light',
      'pattern-none', 'pattern-dots', 'pattern-grid', 'pattern-lines', 'pattern-propysy'
    );
    this.viewportEl.classList.add(theme === 'light' ? 'bg-light' : 'bg-dark');
    this.viewportEl.classList.add(`pattern-${pattern || 'dots'}`);
  }
}
