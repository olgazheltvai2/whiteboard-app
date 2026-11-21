// Main application controller: wires all modules, hotkeys, copy/paste & autosave

import {
  CLIPBOARD_MARKER_PREFIX,
  DRAW_COLORS,
  DRAW_WIDTHS,
  STORAGE_KEYS,
  loadGitHubConfig,
  saveGitHubConfig
} from './config.js';
import { StorageService } from './storage.js';
import { HistoryManager } from './history.js';
import { ViewportController } from './viewport.js';
import { ObjectsManager } from './objects.js';
import { DrawingManager } from './drawing.js';
import { SelectionManager } from './selection.js';
import { BoardsManager } from './boards.js';

const $ = (id) => document.getElementById(id);

class WhiteboardApp {
  constructor() {
    this.ghConfig = loadGitHubConfig();
    this.storage = new StorageService(this.ghConfig);

    this.currentTool = 'select';
    this.currentBoard = null;
    this.isDirty = false;
    this.isSaving = false;
    this.autosaveTimer = null;
    this.modalBoardMode = 'create';
    this.modalBoardEditId = null;

    this._initModules();
    this._initUI();
    this._bindEvents();
    this._boot();
  }

  _initModules() {
    this.viewport = new ViewportController(
      $('viewport'),
      $('world'),
      (zoom) => {
        $('btn-zoom-reset').textContent = `${Math.round(zoom * 100)}%`;
      }
    );

    this.history = new HistoryManager(60, () => {
      $('btn-undo').disabled = !this.history.canUndo();
      $('btn-redo').disabled = !this.history.canRedo();
    });

    this.objects = new ObjectsManager({
      layerEl: $('objects-layer'),
      viewport: this.viewport,
      storage: this.storage,
      onMutate: () => this._onBoardMutated(),
      onEditStateChange: () => {
        if (this.selection) this.selection.render();
      }
    });

    this.drawing = new DrawingManager({
      strokesGroup: $('strokes-group'),
      activeGroup: $('active-stroke-group'),
      viewport: this.viewport,
      onMutate: () => this._onBoardMutated()
    });

    this.selection = new SelectionManager({
      viewportEl: $('viewport'),
      selectionBoxEl: $('selection-box'),
      outlinesEl: $('selection-items-outlines'),
      marqueeEl: $('marquee-box'),
      toolbarEl: $('object-toolbar'),
      viewport: this.viewport,
      objects: this.objects,
      drawing: this.drawing,
      onMutate: () => this._onBoardMutated(),
      onToast: (msg) => this.toast(msg)
    });

    this.boards = new BoardsManager({
      listEl: $('boards-list'),
      filtersEl: $('folder-filters'),
      searchEl: $('board-search'),
      datalistEl: $('folders-datalist'),
      storage: this.storage,
      onSelectBoard: (id) => this.openBoard(id),
      onToast: (msg) => this.toast(msg)
    });
  }

  _initUI() {
    const swatchesEl = $('color-swatches');
    DRAW_COLORS.forEach((col) => {
      const btn = document.createElement('button');
      btn.className = `swatch-btn ${col === this.drawing.color ? 'active' : ''}`;
      btn.style.backgroundColor = col;
      btn.title = col;
      btn.addEventListener('click', () => {
        btn.blur();
        this.drawing.setColor(col);
        swatchesEl.querySelectorAll('.swatch-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
      swatchesEl.appendChild(btn);
    });

    const widthsEl = $('width-swatches');
    DRAW_WIDTHS.forEach((w) => {
      const btn = document.createElement('button');
      btn.className = `width-btn ${w.size === this.drawing.width ? 'active' : ''}`;
      btn.title = `Товщина ${w.id.toUpperCase()}`;
      const dot = document.createElement('span');
      dot.className = 'width-dot';
      dot.style.width = `${w.dot}px`;
      dot.style.height = `${w.dot}px`;
      btn.appendChild(dot);
      btn.addEventListener('click', () => {
        btn.blur();
        this.drawing.setWidth(w.size);
        widthsEl.querySelectorAll('.width-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
      widthsEl.appendChild(btn);
    });
  }

  _bindEvents() {
    const toggleSidebar = (e) => {
      e?.currentTarget?.blur();
      $('sidebar').classList.toggle('collapsed');
    };
    $('btn-open-sidebar').addEventListener('click', toggleSidebar);
    $('btn-toggle-sidebar-inner').addEventListener('click', toggleSidebar);

    document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        btn.blur();
        this.setTool(btn.dataset.tool);
      });
    });

    $('btn-undo').addEventListener('click', (e) => { e.currentTarget.blur(); this.undo(); });
    $('btn-redo').addEventListener('click', (e) => { e.currentTarget.blur(); this.redo(); });

    $('btn-upload-image').addEventListener('click', (e) => {
      e.currentTarget.blur();
      $('image-file-input').click();
    });
    $('image-file-input').addEventListener('change', async (e) => {
      const files = [...(e.target.files || [])];
      e.target.value = '';
      for (const file of files) {
        await this._handleImageInsert(file);
      }
    });

    $('btn-zoom-in').addEventListener('click', (e) => { e.currentTarget.blur(); this.viewport.zoomCenter(1.2); });
    $('btn-zoom-out').addEventListener('click', (e) => { e.currentTarget.blur(); this.viewport.zoomCenter(1 / 1.2); });
    $('btn-zoom-reset').addEventListener('click', (e) => { e.currentTarget.blur(); this.viewport.resetZoom(); });
    $('btn-zoom-fit').addEventListener('click', (e) => { e.currentTarget.blur(); this.fitContent(); });

    $('btn-bg-theme').addEventListener('click', (e) => {
      e.currentTarget.blur();
      if (!this.currentBoard) return;
      this.currentBoard.bgTheme = this.currentBoard.bgTheme === 'light' ? 'dark' : 'light';
      this._applyBoardBgUI();
      this._markDirty();
    });

    $('select-bg-pattern').addEventListener('change', (e) => {
      e.currentTarget.blur();
      if (!this.currentBoard) return;
      this.currentBoard.bgPattern = e.target.value;
      this._applyBoardBgUI();
      this._markDirty();
    });

    $('current-board-title').addEventListener('change', async (e) => {
      if (!this.currentBoard) return;
      const val = e.target.value.trim() || 'Без назви';
      this.currentBoard.title = val;
      e.target.value = val;
      await this.boards.updateBoardMeta(this.currentBoard.id, { title: val });
      this._markDirty();
    });

    $('btn-save-now').addEventListener('click', (e) => { e.currentTarget.blur(); this.saveCurrentBoard(true); });
    $('btn-clear-drawings').addEventListener('click', (e) => {
      e.currentTarget.blur();
      if (this.drawing.clearAllDrawings()) {
        this.selection.pruneMissing();
        this.toast('Малюнки очищено (Ctrl+Z щоб повернути)');
      }
    });

    $('btn-new-board').addEventListener('click', () => this._openBoardModal('create'));
    window.addEventListener('open-board-modal', (e) => {
      this._openBoardModal(e.detail.mode, e.detail.board);
    });
    $('btn-confirm-board').addEventListener('click', () => this._confirmBoardModal());
    $('input-board-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._confirmBoardModal();
    });

    $('btn-open-settings').addEventListener('click', () => this._openSettingsModal());
    $('btn-test-github').addEventListener('click', () => this._testGitHubFromModal());
    $('btn-save-settings').addEventListener('click', () => this._saveSettingsFromModal());

    document.querySelectorAll('.modal-close').forEach((btn) => {
      btn.addEventListener('click', () => $(btn.dataset.close).classList.add('hidden'));
    });

    // Viewport Pointer Interactions
    const vp = $('viewport');
    vp.addEventListener('pointerdown', (e) => this._onViewportPointerDown(e));
    window.addEventListener('pointermove', (e) => this._onViewportPointerMove(e));
    window.addEventListener('pointerup', () => this._onViewportPointerUp());

    // Drag & Drop images onto viewport
    vp.addEventListener('dragover', (e) => e.preventDefault());
    vp.addEventListener('drop', async (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
      const pt = this.viewport.screenToWorld(e.clientX, e.clientY);
      for (const f of files) {
        await this._handleImageInsert(f, pt);
      }
    });

    // Native Copy / Cut / Paste for board items + external images/text
    window.addEventListener('copy', (e) => {
      if (this._isTypingInInput(document.activeElement) || this.objects.isEditing()) return;
      if (this.selection.selectedIds.size > 0) {
        this._copyHandled = true;
        this.selection.copySelected(e);
      }
    });

    window.addEventListener('cut', (e) => {
      if (this._isTypingInInput(document.activeElement) || this.objects.isEditing()) return;
      if (this.selection.selectedIds.size > 0) {
        this._cutHandled = true;
        this.selection.cutSelected(e);
      }
    });

    window.addEventListener('paste', async (e) => {
      if (this._isTypingInInput(document.activeElement) || this.objects.isEditing()) return;
      this._pasteHandled = true;

      const items = [...(e.clipboardData?.items || [])];
      const imgItem = items.find((it) => it.type.startsWith('image/'));
      if (imgItem) {
        e.preventDefault();
        const file = imgItem.getAsFile();
        if (file) await this._handleImageInsert(file);
        return;
      }

      const plain = e.clipboardData?.getData('text/plain') || '';
      if (plain.startsWith(CLIPBOARD_MARKER_PREFIX) && this.selection.hasClipboard()) {
        e.preventDefault();
        this.selection.pasteInternal();
        return;
      }

      if (plain.trim()) {
        e.preventDefault();
        const defColor = this.currentBoard?.bgTheme === 'light' ? '#18202c' : '#f3f5f9';
        const obj = this.objects.addTextAt(this.viewport.getCenterWorld(), defColor, plain.trim());
        this.setTool('select', { keepSelection: true });
        this.selection.selectOnly([obj.id]);
        this.toast('Текст вставлено на дошку');
        return;
      }

      if (this.selection.hasClipboard()) {
        e.preventDefault();
        this.selection.pasteInternal();
      }
    });

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => this._onKeyDown(e));
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.viewport.spacePressed = false;
        this._updateViewportCursor();
      }
    });

    window.addEventListener('beforeunload', (e) => {
      if (this.isDirty || this.isSaving) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  async _boot() {
    this.setStatus(this.storage.isCloudReady() ? 'saving' : 'local',
      this.storage.isCloudReady() ? 'Завантаження...' : 'Локальний режим');

    try {
      const list = await this.boards.loadList();
      if (list.length === 0) {
        const first = await this.boards.createBoard('Моя перша дошка', '');
        await this.openBoard(first.id, first);
      } else {
        const lastId = localStorage.getItem(STORAGE_KEYS.LAST_BOARD);
        const target = list.find((b) => b.id === lastId) ? lastId : list[0].id;
        await this.openBoard(target);
      }
      if (!this.storage.isCloudReady()) {
        this._openSettingsModal();
      }
    } catch (err) {
      console.error(err);
      this.setStatus('error', 'Помилка GitHub');
      this.toast(`Помилка підключення: ${err.message}`);
      this._openSettingsModal();
    }
  }

  async openBoard(boardId, preloadedData = null) {
    if (this.currentBoard && this.isDirty) {
      await this.saveCurrentBoard(false);
    }

    this.setStatus('saving', 'Відкриття...');
    try {
      const data = preloadedData || (await this.storage.loadBoard(boardId));
      if (!data) {
        this.toast('Не вдалося знайти файл дошки');
        return;
      }

      this.currentBoard = data;
      localStorage.setItem(STORAGE_KEYS.LAST_BOARD, boardId);
      this.boards.setActiveId(boardId);

      $('current-board-title').value = data.title || 'Без назви';
      const folderBadge = $('current-board-folder');
      if (data.folder) {
        folderBadge.textContent = `📁 ${data.folder}`;
        folderBadge.classList.remove('hidden');
      } else {
        folderBadge.classList.add('hidden');
      }

      this._applyBoardBgUI();
      this.objects.setObjects(data.objects || []);
      this.drawing.setStrokes(data.strokes || []);
      this.selection.clear();

      if (data.viewport) {
        this.viewport.setView(data.viewport.x, data.viewport.y, data.viewport.zoom);
      } else {
        this.viewport.centerOnOrigin();
      }

      this.history.reset(this._getSnapshot());
      this.isDirty = false;
      this._updateEmptyHint();
      this.setStatus(this.storage.isCloudReady() ? 'saved' : 'local',
        this.storage.isCloudReady() ? 'Збережено ✓' : 'Локально');
    } catch (err) {
      console.error(err);
      this.setStatus('error', 'Помилка завантаження');
      this.toast(`Не вдалося відкрити дошку: ${err.message}`);
    }
  }

  _applyBoardBgUI() {
    const theme = this.currentBoard?.bgTheme || 'dark';
    const pattern = this.currentBoard?.bgPattern || 'dots';
    this.viewport.setBackground(theme, pattern);
    $('btn-bg-theme').textContent = theme === 'light' ? '☀️ Світлий' : '🌑 Темний';
    $('select-bg-pattern').value = pattern;
  }

  _updateEmptyHint() {
    const empty = this.objects.getObjects().length === 0 && this.drawing.getStrokes().length === 0;
    $('empty-hint').classList.toggle('hidden', !empty);
  }

  _getSnapshot() {
    return {
      objects: this.objects.getObjects(),
      strokes: this.drawing.getStrokes()
    };
  }

  _restoreSnapshot(snap) {
    if (!snap) return;
    this.objects.setObjects(snap.objects);
    this.drawing.setStrokes(snap.strokes);
    this.selection.pruneMissing();
    this._updateEmptyHint();
    this._markDirty();
  }

  undo() {
    const prev = this.history.undo();
    if (prev) this._restoreSnapshot(prev);
  }

  redo() {
    const next = this.history.redo();
    if (next) this._restoreSnapshot(next);
  }

  _onBoardMutated() {
    this.history.push(this._getSnapshot());
    this._updateEmptyHint();
    this._markDirty();
  }

  _markDirty() {
    this.isDirty = true;
    this.setStatus('dirty', 'Є зміни...');
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      this.saveCurrentBoard(false);
    }, 2400);
  }

  async saveCurrentBoard(manual = false) {
    if (!this.currentBoard) return;
    if (this.isSaving) return;

    clearTimeout(this.autosaveTimer);
    this.isSaving = true;
    this.setStatus('saving', 'Збереження...');

    try {
      this.currentBoard.objects = this.objects.getObjects();
      this.currentBoard.strokes = this.drawing.getStrokes();
      this.currentBoard.viewport = {
        x: Math.round(this.viewport.x),
        y: Math.round(this.viewport.y),
        zoom: Number(this.viewport.zoom.toFixed(3))
      };
      this.currentBoard.updatedAt = new Date().toISOString();

      await this.storage.saveBoard(this.currentBoard);
      await this.boards.touchBoard(this.currentBoard.id);

      this.isDirty = false;
      this.setStatus(this.storage.isCloudReady() ? 'saved' : 'local',
        this.storage.isCloudReady() ? 'Збережено ✓' : 'Збережено локально');
      if (manual) this.toast('Дошку збережено!');
    } catch (err) {
      console.error(err);
      this.setStatus('error', 'Помилка збереження');
      this.toast(`Помилка збереження: ${err.message}`);
    } finally {
      this.isSaving = false;
    }
  }

  async _handleImageInsert(file, worldPoint = null) {
    try {
      this.toast('Вставляю картинку...');
      const { obj, uploadPromise } = await this.objects.addImageFromFile(file, worldPoint);
      this.setTool('select', { keepSelection: true });
      this.selection.selectOnly([obj.id]);
      if (this.storage.isCloudReady()) {
        await uploadPromise;
        this.toast('Картинку збережено в хмару ✓');
      }
    } catch (err) {
      console.error(err);
      this.toast(`Помилка вставки картинки: ${err.message}`);
    }
  }

  setTool(tool, { keepSelection = false } = {}) {
    this.currentTool = tool;
    if (tool !== 'select' && !keepSelection) {
      this.selection.clear();
    }
    document.querySelectorAll('.tool-btn[data-tool]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === tool);
    });
    const showDrawOpts = ['pen', 'highlighter', 'line', 'arrow', 'rect', 'ellipse'].includes(tool);
    $('draw-options').classList.toggle('hidden', !showDrawOpts);
    this._updateViewportCursor();
  }

  _updateViewportCursor() {
    const vp = $('viewport');
    vp.classList.remove('cursor-pan', 'cursor-draw', 'cursor-eraser', 'cursor-text');
    if (this.viewport.spacePressed || this.currentTool === 'pan') {
      vp.classList.add('cursor-pan');
    } else if (['pen', 'highlighter', 'line', 'arrow', 'rect', 'ellipse'].includes(this.currentTool)) {
      vp.classList.add('cursor-draw');
    } else if (this.currentTool === 'eraser') {
      vp.classList.add('cursor-eraser');
    } else if (this.currentTool === 'text' || this.currentTool === 'note') {
      vp.classList.add('cursor-text');
    }
  }

  _onViewportPointerDown(e) {
    if (e.target.closest('#object-toolbar')) return;

    // If clicking inside an actively editing textarea, let user edit text normally
    if (e.target.closest('.board-obj.editing .board-obj-editable')) return;

    // Blur stray focus from topbar/sidebar inputs or buttons
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }

    // Middle click, right click, Space+click, or Pan tool -> pan
    if (e.button === 1 || e.button === 2 || this.viewport.spacePressed || this.currentTool === 'pan') {
      e.preventDefault();
      this.viewport.startPan(e.clientX, e.clientY, e.pointerId, e.button === 2);
      return;
    }

    if (e.button !== 0) return;

    const worldPt = this.viewport.screenToWorld(e.clientX, e.clientY);

    if (this.currentTool === 'text') {
      e.preventDefault();
      const defColor = this.currentBoard?.bgTheme === 'light' ? '#18202c' : '#f3f5f9';
      const obj = this.objects.addTextAt(worldPt, defColor);
      this.setTool('select', { keepSelection: true });
      this.selection.selectOnly([obj.id]);
      this.objects.startEditing(obj.id);
      return;
    }

    if (this.currentTool === 'note') {
      e.preventDefault();
      const obj = this.objects.addNoteAt(worldPt);
      this.setTool('select', { keepSelection: true });
      this.selection.selectOnly([obj.id]);
      this.objects.startEditing(obj.id);
      return;
    }

    if (this.currentTool === 'select') {
      this.selection.handleViewportPointerDown(e);
      return;
    }

    // Drawing tools
    this._isDrawingPointer = true;
    this.drawing.startPointer(this.currentTool, worldPt);
  }

  _onViewportPointerMove(e) {
    if (this.viewport.isPanning) {
      this.viewport.movePan(e.clientX, e.clientY);
      return;
    }
    if (this._isDrawingPointer) {
      const worldPt = this.viewport.screenToWorld(e.clientX, e.clientY);
      this.drawing.movePointer(worldPt);
    }
  }

  _onViewportPointerUp() {
    if (this.viewport.isPanning) {
      this.viewport.endPan();
      return;
    }
    if (this._isDrawingPointer) {
      this._isDrawingPointer = false;
      this.drawing.endPointer();
    }
  }

  fitContent() {
    const b1 = this.objects.getBounds();
    const b2 = this.drawing.getBounds();
    if (!b1 && !b2) {
      this.viewport.centerOnOrigin();
      return;
    }
    const merged = {
      minX: Math.min(b1?.minX ?? Infinity, b2?.minX ?? Infinity),
      minY: Math.min(b1?.minY ?? Infinity, b2?.minY ?? Infinity),
      maxX: Math.max(b1?.maxX ?? -Infinity, b2?.maxX ?? -Infinity),
      maxY: Math.max(b1?.maxY ?? -Infinity, b2?.maxY ?? -Infinity)
    };
    this.viewport.fitBounds(merged);
  }

  _isTypingInInput(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  _onKeyDown(e) {
    if (e.key === 'Escape') {
      if (this.objects.isEditing()) {
        this.objects.stopEditing();
        return;
      }
      this.selection.clear();
      $('modal-settings').classList.add('hidden');
      $('modal-board').classList.add('hidden');
      return;
    }

    if (this._isTypingInInput(e.target) || this.objects.isEditing()) return;

    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.code === 'KeyS') {
      e.preventDefault();
      this.saveCurrentBoard(true);
      return;
    }
    if (ctrl && e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (ctrl && e.code === 'KeyY') {
      e.preventDefault();
      this.redo();
      return;
    }
    if (ctrl && e.code === 'KeyD') {
      e.preventDefault();
      this.selection.duplicateSelected();
      return;
    }
    if (ctrl && e.code === 'KeyA') {
      e.preventDefault();
      this.setTool('select', { keepSelection: true });
      this.selection.selectAll();
      return;
    }
    if (ctrl && e.code === 'KeyG') {
      e.preventDefault();
      if (e.shiftKey) this.selection.ungroupSelected();
      else this.selection.groupSelected();
      return;
    }
    if (ctrl && e.code === 'KeyC') {
      if (this.selection.selectedIds.size > 0) {
        this._copyHandled = false;
        setTimeout(() => {
          if (!this._copyHandled) this.selection.copySelected(null);
        }, 0);
      }
      return;
    }
    if (ctrl && e.code === 'KeyX') {
      if (this.selection.selectedIds.size > 0) {
        this._cutHandled = false;
        setTimeout(() => {
          if (!this._cutHandled) this.selection.cutSelected(null);
        }, 0);
      }
      return;
    }
    if (ctrl && e.code === 'KeyV') {
      this._pasteHandled = false;
      setTimeout(() => {
        if (!this._pasteHandled && this.selection.hasClipboard()) {
          this.selection.pasteInternal();
        }
      }, 40);
      return;
    }

    if (e.code === 'Space') {
      e.preventDefault();
      this.viewport.spacePressed = true;
      this._updateViewportCursor();
      return;
    }

    if (e.code === 'Tab') {
      e.preventDefault();
      $('sidebar').classList.toggle('collapsed');
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace' || e.code === 'Delete') {
      if (this.selection.deleteSelected()) {
        e.preventDefault();
      }
      return;
    }

    if (e.key === 'Enter' && this.selection.selectedIds.size === 1) {
      const items = this.selection.getSelectedItems();
      if (items[0].kind === 'object' && (items[0].data.type === 'text' || items[0].data.type === 'note') && !items[0].data.locked) {
        e.preventDefault();
        this.objects.startEditing(items[0].data.id);
        return;
      }
    }

    const toolMap = {
      KeyV: 'select',
      KeyH: 'pan',
      KeyP: 'pen',
      KeyM: 'highlighter',
      KeyE: 'eraser',
      KeyL: 'line',
      KeyA: 'arrow',
      KeyR: 'rect',
      KeyO: 'ellipse',
      KeyT: 'text',
      KeyN: 'note'
    };

    if (!ctrl && toolMap[e.code]) {
      this.setTool(toolMap[e.code]);
    }
  }

  // --- Modals ---

  _openBoardModal(mode, board = null) {
    this.modalBoardMode = mode;
    this.modalBoardEditId = board ? board.id : null;
    $('modal-board-heading').textContent = mode === 'edit' ? 'Редагувати дошку' : 'Нова дошка';
    $('input-board-name').value = board ? board.title : '';
    $('input-board-folder').value = board ? (board.folder || '') : '';
    $('modal-board').classList.remove('hidden');
    setTimeout(() => $('input-board-name').focus(), 40);
  }

  async _confirmBoardModal() {
    const title = $('input-board-name').value.trim() || 'Нова дошка';
    const folder = $('input-board-folder').value.trim();
    $('modal-board').classList.add('hidden');

    if (this.modalBoardMode === 'edit' && this.modalBoardEditId) {
      await this.boards.updateBoardMeta(this.modalBoardEditId, { title, folder });
      if (this.currentBoard && this.currentBoard.id === this.modalBoardEditId) {
        this.currentBoard.title = title;
        this.currentBoard.folder = folder;
        $('current-board-title').value = title;
        const badge = $('current-board-folder');
        badge.textContent = folder ? `📁 ${folder}` : '';
        badge.classList.toggle('hidden', !folder);
        await this.saveCurrentBoard(false);
      }
      this.toast('Дані дошки оновлено');
    } else {
      if (this.currentBoard && this.isDirty) {
        await this.saveCurrentBoard(false);
      }
      const created = await this.boards.createBoard(title, folder);
      await this.openBoard(created.id, created);
      this.toast('Нову дошку створено!');
    }
  }

  _openSettingsModal() {
    $('cfg-owner').value = this.ghConfig.owner || '';
    $('cfg-repo').value = this.ghConfig.repo || '';
    $('cfg-branch').value = this.ghConfig.branch || 'main';
    $('cfg-token').value = this.ghConfig.token || '';
    const resEl = $('settings-test-result');
    resEl.classList.add('hidden');
    resEl.textContent = '';
    $('modal-settings').classList.remove('hidden');
  }

  _readSettingsForm() {
    return {
      owner: $('cfg-owner').value.trim(),
      repo: $('cfg-repo').value.trim(),
      branch: $('cfg-branch').value.trim() || 'main',
      token: $('cfg-token').value.trim()
    };
  }

  async _testGitHubFromModal() {
    const resEl = $('settings-test-result');
    resEl.className = 'test-result';
    resEl.textContent = 'Перевіряю зв’язок...';
    resEl.classList.remove('hidden');

    const res = await this.storage.testConnection(this._readSettingsForm());
    resEl.className = `test-result ${res.ok ? 'ok' : 'err'}`;
    resEl.textContent = res.message;
  }

  async _saveSettingsFromModal() {
    const nextCfg = this._readSettingsForm();
    const resEl = $('settings-test-result');
    resEl.className = 'test-result';
    resEl.textContent = 'Перевіряю та підключаю...';
    resEl.classList.remove('hidden');

    const test = await this.storage.testConnection(nextCfg);
    if (!test.ok) {
      resEl.className = `test-result err`;
      resEl.textContent = test.message;
      return;
    }

    this.ghConfig = saveGitHubConfig(nextCfg);
    this.storage.setConfig(this.ghConfig);
    $('modal-settings').classList.add('hidden');
    this.toast('GitHub підключено! Завантажую дошки...');
    await this._boot();
  }

  setStatus(kind, text) {
    const el = $('sync-status');
    el.className = `sync-status status-${kind}`;
    el.textContent = text;
  }

  toast(msg) {
    const container = $('toast-container');
    const div = document.createElement('div');
    div.className = 'toast';
    div.textContent = msg;
    container.appendChild(div);
    setTimeout(() => div.remove(), 2600);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new WhiteboardApp();
});
