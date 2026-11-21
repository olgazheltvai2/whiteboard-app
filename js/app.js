// Main application controller: wires modules, Live Firebase collaboration, fonts & hotkeys

import {
  CLIPBOARD_MARKER_PREFIX,
  DRAW_COLORS,
  DRAW_WIDTHS,
  STORAGE_KEYS,
  isFirebaseConfigured,
  loadFirebaseConfig,
  loadGitHubConfig,
  saveFirebaseConfig,
  saveGitHubConfig
} from './config.js';
import { StorageService } from './storage.js';
import { HistoryManager } from './history.js';
import { ViewportController } from './viewport.js';
import { ObjectsManager } from './objects.js';
import { DrawingManager } from './drawing.js';
import { SelectionManager } from './selection.js';
import { BoardsManager } from './boards.js';
import { LiveSessionManager } from './live.js';

const $ = (id) => document.getElementById(id);

class WhiteboardApp {
  constructor() {
    this.ghConfig = loadGitHubConfig();
    this.fbConfig = loadFirebaseConfig();
    this.storage = new StorageService(this.ghConfig);

    this.currentTool = 'select';
    this.defaultFont = localStorage.getItem(STORAGE_KEYS.DEFAULT_FONT) || 'sans';
    this.currentBoard = null;
    this.isDirty = false;
    this.isSaving = false;
    this.autosaveTimer = null;
    this.modalBoardMode = 'create';
    this.modalBoardEditId = null;

    // Detect if opened via student invite link (?room=...&db=...)
    const params = new URLSearchParams(window.location.search);
    this.inviteRoomId = params.get('room');
    this.inviteDbUrl = params.get('db');
    this.isStudentMode = Boolean(this.inviteRoomId && this.inviteDbUrl);
    this.studentPerm = 'edit';
    this.lastRemoteCamera = null;

    // Multi-touch tracker for 2-finger pinch-to-zoom & pan on tablets/phones
    this.activeTouches = new Map();
    this.pinchCooldown = false;
    this.activeDrawPointerId = null;

    this._initModules();
    this._initUI();
    this._bindEvents();

    if (this.isStudentMode) {
      this._bootStudent();
    } else {
      this._bootTeacher();
    }
  }

  // Unified Z-index across BOTH objects & drawings
  getNextZIndex() {
    const objZ = this.objects.getObjects().map((o) => o.zIndex ?? 0);
    const strZ = this.drawing.getStrokes().map((s) => s.zIndex ?? 0);
    const all = [...objZ, ...strZ];
    return all.length ? Math.max(...all) + 1 : 1;
  }

  getMinZIndex() {
    const objZ = this.objects.getObjects().map((o) => o.zIndex ?? 0);
    const strZ = this.drawing.getStrokes().map((s) => s.zIndex ?? 0);
    const all = [...objZ, ...strZ];
    return all.length ? Math.min(...all) - 1 : 0;
  }

  _canDraw() {
    if (!this.isStudentMode) return true;
    return this.studentPerm === 'draw' || this.studentPerm === 'edit';
  }

  _canEditObjects() {
    if (!this.isStudentMode) return true;
    return this.studentPerm === 'edit';
  }

  _initModules() {
    this.viewport = new ViewportController(
      $('viewport'),
      $('world'),
      (zoom) => {
        $('btn-zoom-reset').textContent = `${Math.round(zoom * 100)}%`;
      },
      () => {
        if (this.live && this.live.isActive() && this.live.isTeacher() && this.live.followCamera) {
          this.live.pushCamera(this.viewport.getCameraState(), false);
        }
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
      getNextZIndex: () => this.getNextZIndex(),
      onMutate: (reason, meta) => this._onBoardMutated(reason, meta),
      onEditStateChange: () => {
        if (this.selection) this.selection.render();
      }
    });

    this.drawing = new DrawingManager({
      strokesLayer: $('strokes-layer'),
      activeGroup: $('active-stroke-group'),
      remoteActiveGroup: $('remote-active-strokes-group'),
      viewport: this.viewport,
      getNextZIndex: () => this.getNextZIndex(),
      onLiveStroke: (s) => this.live && this.live.pushLiveStroke(s),
      onMutate: (reason, meta) => this._onBoardMutated(reason, meta)
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
      isTeacher: () => !this.isStudentMode,
      canEditObjects: () => this._canEditObjects(),
      getNextZIndex: () => this.getNextZIndex(),
      getMinZIndex: () => this.getMinZIndex(),
      onLiveTransform: (meta) => this._pushLiveDeltaOnly(meta),
      onMutate: (reason, meta) => this._onBoardMutated(reason, meta),
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

    this.live = new LiveSessionManager({
      cursorsLayerEl: $('cursors-layer'),
      onRemoteObjects: (remoteMap) => this._applyRemoteObjects(remoteMap),
      onRemoteStrokes: (remoteMap) => this._applyRemoteStrokes(remoteMap),
      onRemoteLiveStrokes: (map, myId) => this.drawing.renderRemoteActiveStrokes(map, myId),
      onRemoteMeta: (meta, effPerm) => this._applyRemoteMeta(meta, effPerm),
      onRemoteCamera: (cam) => {
        this.lastRemoteCamera = cam;
        this.viewport.fitWorldRect(cam.cx, cam.cy, cam.viewW, cam.viewH, cam.zoom || 1);
      },
      onStudentsChange: (students) => this._renderStudentsList(students),
      onSessionEnded: () => {
        $('modal-session-ended').classList.remove('hidden');
      },
      onToast: (msg) => this.toast(msg)
    });

    this.storage.setRemoteAssetResolver((path) => this.live.resolveRoomAsset(path));
  }

  _initUI() {
    $('select-default-font').value = this.defaultFont;

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

    $('select-default-font').addEventListener('change', (e) => {
      this.defaultFont = e.target.value;
      localStorage.setItem(STORAGE_KEYS.DEFAULT_FONT, this.defaultFont);
      e.target.blur();
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
      if (!this.currentBoard || this.isStudentMode) return;
      this.currentBoard.bgTheme = this.currentBoard.bgTheme === 'light' ? 'dark' : 'light';
      this._applyBoardBgUI();
      this.live.syncBoardMeta({ bgTheme: this.currentBoard.bgTheme });
      this._markDirty();
    });

    $('select-bg-pattern').addEventListener('change', (e) => {
      e.currentTarget.blur();
      if (!this.currentBoard || this.isStudentMode) return;
      this.currentBoard.bgPattern = e.target.value;
      this._applyBoardBgUI();
      this.live.syncBoardMeta({ bgPattern: this.currentBoard.bgPattern });
      this._markDirty();
    });

    $('current-board-title').addEventListener('change', async (e) => {
      if (!this.currentBoard || this.isStudentMode) return;
      const val = e.target.value.trim() || 'Без назви';
      this.currentBoard.title = val;
      e.target.value = val;
      await this.boards.updateBoardMeta(this.currentBoard.id, { title: val });
      this.live.syncBoardMeta({ title: val });
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

    // Live Session Teacher Controls
    $('btn-live-toggle').addEventListener('click', (e) => {
      e.currentTarget.blur();
      this._toggleLiveSession();
    });
    $('btn-live-copy-link').addEventListener('click', (e) => {
      e.currentTarget.blur();
      this._copyInviteLink();
    });
    $('live-perm-group').querySelectorAll('.seg-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.blur();
        const perm = btn.dataset.perm;
        $('live-perm-group').querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        await this.live.setGlobalPermission(perm);
        const labels = { view: '👁️ Учні лише дивляться', draw: '✏️ Учні можуть малювати', edit: '🖐️ Повний доступ для учнів' };
        this.toast(labels[perm]);
      });
    });
    $('btn-live-call').addEventListener('click', async (e) => {
      e.currentTarget.blur();
      await this.live.pushCamera(this.viewport.getCameraState(), true);
      this.toast('📍 Екрани учнів перенесено до вас');
    });
    $('btn-live-follow').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.blur();
      const next = !this.live.followCamera;
      btn.classList.toggle('follow-active', next);
      await this.live.setFollowCamera(next, this.viewport.getCameraState());
      this.toast(next ? '🧲 Екрани учнів прив’язано до вашого' : 'Екрани учнів відв’язано');
    });
    $('btn-live-students').addEventListener('click', (e) => {
      e.stopPropagation();
      e.currentTarget.blur();
      $('live-students-popover').classList.toggle('hidden');
    });
    window.addEventListener('click', (e) => {
      if (!e.target.closest('.live-students-wrap')) {
        $('live-students-popover').classList.add('hidden');
      }
    });
    $('btn-live-stop').addEventListener('click', (e) => {
      e.currentTarget.blur();
      this._stopLiveSession();
    });

    // Boards modal
    $('btn-new-board').addEventListener('click', () => this._openBoardModal('create'));
    window.addEventListener('open-board-modal', (e) => {
      this._openBoardModal(e.detail.mode, e.detail.board);
    });
    $('btn-confirm-board').addEventListener('click', () => this._confirmBoardModal());
    $('input-board-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._confirmBoardModal();
    });

    // Settings modal + Tabs (GitHub / Firebase)
    $('btn-open-settings').addEventListener('click', () => this._openSettingsModal('tab-github'));
    document.querySelectorAll('.modal-tab').forEach((tab) => {
      tab.addEventListener('click', () => this._switchSettingsTab(tab.dataset.tab));
    });
    $('btn-test-github').addEventListener('click', () => this._testGitHubFromModal());
    $('btn-save-settings').addEventListener('click', () => this._saveSettingsFromModal());
    $('btn-test-firebase').addEventListener('click', () => this._testFirebaseFromModal());
    $('btn-save-firebase').addEventListener('click', () => this._saveFirebaseFromModal());

    // Student Join Modal
    $('btn-student-enter').addEventListener('click', () => this._enterStudentRoom());
    $('input-student-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._enterStudentRoom();
    });

    document.querySelectorAll('.modal-close').forEach((btn) => {
      btn.addEventListener('click', () => $(btn.dataset.close).classList.add('hidden'));
    });

    // Collapse sidebar automatically on narrow screens in teacher mode
    if (!this.isStudentMode && window.innerWidth <= 960) {
      $('sidebar').classList.add('collapsed');
    }

    // Re-fit teacher camera when student rotates phone/tablet or resizes window
    window.addEventListener('resize', () => {
      if (this.isStudentMode && this.lastRemoteCamera && this.live.followCamera) {
        const c = this.lastRemoteCamera;
        this.viewport.fitWorldRect(c.cx, c.cy, c.viewW, c.viewH, c.zoom || 1);
      }
    });

    // Viewport Pointer Interactions (Mouse + Stylus + Multi-Touch Pinch/Pan)
    const vp = $('viewport');
    vp.addEventListener('pointerdown', (e) => this._onViewportPointerDown(e));
    window.addEventListener('pointermove', (e) => this._onViewportPointerMove(e));
    window.addEventListener('pointerup', (e) => this._onViewportPointerUp(e));
    window.addEventListener('pointercancel', (e) => this._onViewportPointerUp(e));

    // Drag & Drop images (Teacher only)
    vp.addEventListener('dragover', (e) => e.preventDefault());
    vp.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (this.isStudentMode) return;
      const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
      const pt = this.viewport.screenToWorld(e.clientX, e.clientY);
      for (const f of files) {
        await this._handleImageInsert(f, pt);
      }
    });

    // Native Copy / Cut / Paste
    window.addEventListener('copy', (e) => {
      if (this._isTypingInInput(document.activeElement) || this.objects.isEditing()) return;
      if (this._canEditObjects() && this.selection.selectedIds.size > 0) {
        this._copyHandled = true;
        this.selection.copySelected(e);
      }
    });

    window.addEventListener('cut', (e) => {
      if (this._isTypingInInput(document.activeElement) || this.objects.isEditing()) return;
      if (this._canEditObjects() && this.selection.selectedIds.size > 0) {
        this._cutHandled = true;
        this.selection.cutSelected(e);
      }
    });

    window.addEventListener('paste', async (e) => {
      if (this._isTypingInInput(document.activeElement) || this.objects.isEditing()) return;
      if (!this._canEditObjects()) return;
      this._pasteHandled = true;

      const items = [...(e.clipboardData?.items || [])];
      const imgItem = items.find((it) => it.type.startsWith('image/'));
      if (imgItem && !this.isStudentMode) {
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
        const obj = this.objects.addTextAt(this.viewport.getCenterWorld(), defColor, plain.trim(), this.defaultFont);
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

    window.addEventListener('keydown', (e) => this._onKeyDown(e));
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.viewport.spacePressed = false;
        this._updateViewportCursor();
      }
    });

    window.addEventListener('beforeunload', (e) => {
      if (!this.isStudentMode && (this.isDirty || this.isSaving)) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  // --- BOOT MODES ---

  async _bootTeacher() {
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
        this._openSettingsModal('tab-github');
      }
    } catch (err) {
      console.error(err);
      this.setStatus('error', 'Помилка GitHub');
      this.toast(`Помилка підключення: ${err.message}`);
      this._openSettingsModal('tab-github');
    }
  }

  _bootStudent() {
    document.body.classList.add('student-mode');
    $('current-board-title').readOnly = true;
    $('student-mode-badge').classList.remove('hidden');
    $('student-perm-pill').classList.remove('hidden');

    const savedName = sessionStorage.getItem('wb_student_name') || '';
    $('input-student-name').value = savedName;
    $('modal-student-join').classList.remove('hidden');
    setTimeout(() => $('input-student-name').focus(), 60);
  }

  async _enterStudentRoom() {
    const name = $('input-student-name').value.trim() || 'Учень';
    sessionStorage.setItem('wb_student_name', name);
    $('btn-student-enter').disabled = true;
    $('btn-student-enter').textContent = 'Підключення...';

    try {
      const meta = await this.live.joinRoom({
        databaseURL: this.inviteDbUrl,
        roomId: this.inviteRoomId,
        studentName: name
      });
      $('modal-student-join').classList.add('hidden');
      $('student-mode-badge').textContent = `👤 ${name}`;
      this.currentBoard = {
        id: this.inviteRoomId,
        title: meta.boardTitle || 'Урок',
        bgTheme: meta.bgTheme || 'dark',
        bgPattern: meta.bgPattern || 'dots'
      };
      $('current-board-title').value = this.currentBoard.title;
      this._applyBoardBgUI();
      this.toast('Ти на дошці уроку!');
    } catch (err) {
      alert(err.message);
      $('btn-student-enter').disabled = false;
      $('btn-student-enter').textContent = 'Увійти на дошку';
    }
  }

  // --- LIVE SESSION HOSTING (TEACHER) ---

  async _toggleLiveSession() {
    if (this.live.isActive()) {
      this._copyInviteLink();
      return;
    }
    if (!isFirebaseConfigured(this.fbConfig)) {
      this.toast('Спочатку вкажіть посилання Firebase Realtime Database');
      this._openSettingsModal('tab-firebase');
      return;
    }
    if (!this.currentBoard) return;

    const btn = $('btn-live-toggle');
    btn.disabled = true;
    btn.textContent = '📡 Запуск...';

    try {
      await this.live.startHosting({
        databaseURL: this.fbConfig.databaseURL,
        board: {
          ...this.currentBoard,
          objects: this.objects.getObjects(),
          strokes: this.drawing.getStrokes()
        },
        storage: this.storage,
        cameraState: this.viewport.getCameraState()
      });

      $('live-bar').classList.remove('hidden');
      btn.classList.add('is-live');
      btn.textContent = '📡 В ефірі';
      $('btn-live-follow').classList.remove('follow-active');
      $('live-perm-group').querySelectorAll('.seg-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.perm === 'edit');
      });
      this._copyInviteLink();
    } catch (err) {
      console.error(err);
      this.toast(`Не вдалося запустити урок: ${err.message}`);
      btn.textContent = '📡 Спільний урок';
    } finally {
      btn.disabled = false;
    }
  }

  async _stopLiveSession() {
    await this.live.stopHosting();
    $('live-bar').classList.add('hidden');
    const btn = $('btn-live-toggle');
    btn.classList.remove('is-live');
    btn.textContent = '📡 Спільний урок';
    this.toast('Спільний урок завершено');
  }

  _copyInviteLink() {
    const link = this.live.getInviteUrl();
    if (!link) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(() => {
        this.toast('🔗 Посилання для учнів скопійовано! Надішліть його в чат Zoom.');
      }).catch(() => {
        prompt('Скопіюйте посилання для учнів:', link);
      });
    } else {
      prompt('Скопіюйте посилання для учнів:', link);
    }
  }

  _renderStudentsList(studentsMap) {
    const entries = Object.entries(studentsMap || {});
    $('live-students-count').textContent = String(entries.length);

    const pop = $('live-students-popover');
    pop.innerHTML = '';

    if (!entries.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding: 8px; color: var(--ui-text-muted); font-size: 12px; text-align: center;';
      empty.textContent = 'Поки ніхто не підключився. Надішліть посилання учням.';
      pop.appendChild(empty);
      return;
    }

    for (const [id, stu] of entries) {
      const row = document.createElement('div');
      row.className = 'student-row';

      const nameWrap = document.createElement('div');
      nameWrap.className = 'student-row-name';
      const dot = document.createElement('span');
      dot.className = 'student-color-dot';
      dot.style.background = stu.color || '#5b8def';
      const txt = document.createElement('span');
      txt.textContent = stu.name || 'Учень';
      nameWrap.append(dot, txt);

      const muted = stu.permOverride === 'view';
      const btnMute = document.createElement('button');
      btnMute.className = `ctx-btn ${muted ? 'active' : ''}`;
      btnMute.textContent = muted ? '🔇 Повернути' : '👁️ Забрати права';
      btnMute.title = muted ? 'Повернути загальні права цьому учню' : 'Вимкнути керування лише цьому учню';
      btnMute.addEventListener('click', (e) => {
        e.stopPropagation();
        this.live.setStudentOverride(id, muted ? null : 'view');
      });

      row.append(nameWrap, btnMute);
      pop.appendChild(row);
    }
  }

  // --- REMOTE SYNC HANDLERS ---

  _applyRemoteObjects(remoteMap) {
    const skipIds = this.selection.getActiveInteractionIds();
    this.objects.applyRemoteMap(remoteMap, { skipIds, isTeacher: !this.isStudentMode });
    this.selection.pruneMissing();
    this._updateEmptyHint();
    if (!this.isStudentMode && this.live.isActive()) {
      this._markDirty();
    }
  }

  _applyRemoteStrokes(remoteMap) {
    const skipIds = this.selection.getActiveInteractionIds();
    this.drawing.applyRemoteMap(remoteMap, { skipIds });
    this.selection.pruneMissing();
    this._updateEmptyHint();
    if (!this.isStudentMode && this.live.isActive()) {
      this._markDirty();
    }
  }

  _applyRemoteMeta(meta, effPerm) {
    if (!this.isStudentMode) return;
    if (this.currentBoard) {
      if (meta.boardTitle) {
        this.currentBoard.title = meta.boardTitle;
        $('current-board-title').value = meta.boardTitle;
      }
      if (meta.bgTheme) this.currentBoard.bgTheme = meta.bgTheme;
      if (meta.bgPattern) this.currentBoard.bgPattern = meta.bgPattern;
      this._applyBoardBgUI();
    }

    const prevPerm = this.studentPerm;
    this.studentPerm = effPerm;
    const permChanged = prevPerm !== effPerm;
    const follow = Boolean(meta.followCamera);
    this.viewport.setCameraLocked(follow);
    $('student-follow-banner').classList.toggle('hidden', !follow);
    $('zoom-controls').classList.toggle('hidden', follow);

    // Update permission indicator pill
    const pill = $('student-perm-pill');
    const pillMap = {
      view: { text: '👁️ Тільки перегляд', cls: 'status-error' },
      draw: { text: '✏️ Тільки малювання', cls: 'status-dirty' },
      edit: { text: '🖐️ Можна малювати і рухати', cls: 'status-saved' }
    };
    const info = pillMap[effPerm] || pillMap.edit;
    pill.className = `sync-status ${info.cls}`;
    pill.textContent = info.text;

    // Enforce tool availability for student
    const dock = $('dock-wrap');
    const drawTools = ['pen', 'highlighter', 'eraser', 'line', 'arrow', 'rect', 'ellipse'];

    if (effPerm === 'view') {
      this.selection.clear();
      this.objects.stopEditing();
      this.setTool('pan');
      dock.classList.toggle('hidden', follow);
    } else {
      dock.classList.remove('hidden');
    }

    document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
      const t = btn.dataset.tool;
      let allow = true;
      if (effPerm === 'view') {
        allow = t === 'pan' && !follow;
      } else if (effPerm === 'draw') {
        allow = drawTools.includes(t) || (t === 'pan' && !follow);
      } else {
        allow = !(t === 'pan' && follow);
      }
      btn.classList.toggle('perm-hidden', !allow);
    });

    // Cleanly hide redundant dividers when tools are restricted
    const divNav = document.querySelector('[data-div="nav"]');
    const divDraw = document.querySelector('[data-div="draw"]');
    const divShapes = document.querySelector('[data-div="shapes"]');
    if (divNav) divNav.classList.toggle('hidden', effPerm === 'view' || (effPerm === 'draw' && follow));
    if (divDraw) divDraw.classList.toggle('hidden', effPerm === 'view');
    if (divShapes) divShapes.classList.toggle('hidden', effPerm !== 'edit');

    // Ensure an actual drawing tool (pen) is active when entering 'draw' mode
    if (effPerm === 'draw') {
      this.selection.clear();
      this.objects.stopEditing();
      if (!drawTools.includes(this.currentTool)) {
        if (this.currentTool !== 'pan' || follow || permChanged) {
          this.setTool('pen');
        }
      }
    } else if (effPerm === 'edit' && (permChanged || follow) && this.currentTool === 'pan') {
      this.setTool('select');
    }

    this.selection.render();
  }

  // --- BOARD OPEN / SAVE / HISTORY ---

  async openBoard(boardId, preloadedData = null) {
    if (this.live.isActive() && this.live.isTeacher()) {
      await this._stopLiveSession();
    }
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
      const maxObjZ = this.objects.getObjects().reduce((m, o) => Math.max(m, o.zIndex || 0), 0);
      this.drawing.setStrokes(data.strokes || [], maxObjZ);
      this.selection.clear();

      if (data.viewport) {
        this.viewport.setView(data.viewport.x, data.viewport.y, data.viewport.zoom, false);
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
    if (this.isStudentMode) {
      $('empty-hint').classList.add('hidden');
      return;
    }
    const empty = this.objects.getObjects().length === 0 && this.drawing.getStrokes().length === 0;
    $('empty-hint').classList.toggle('hidden', !empty);
  }

  _getSnapshot() {
    return {
      objects: this.objects.getObjects(),
      strokes: this.drawing.getStrokes()
    };
  }

  _buildStateMaps() {
    const objectsMap = {};
    this.objects.getObjects().forEach((o) => { objectsMap[o.id] = o; });
    const strokesMap = {};
    this.drawing.getStrokes().forEach((s) => { strokesMap[s.id] = s; });
    return { objectsMap, strokesMap };
  }

  _restoreSnapshot(snap) {
    if (!snap) return;
    this.objects.setObjects(snap.objects);
    this.drawing.setStrokes(snap.strokes);
    this.selection.pruneMissing();
    this._updateEmptyHint();
    this._markDirty();
    if (this.live.isActive()) {
      const maps = this._buildStateMaps();
      this.live.pushMutation({ ...maps, fullSync: true });
    }
  }

  undo() {
    if (this.isStudentMode) return;
    const prev = this.history.undo();
    if (prev) this._restoreSnapshot(prev);
  }

  redo() {
    if (this.isStudentMode) return;
    const next = this.history.redo();
    if (next) this._restoreSnapshot(next);
  }

  _pushLiveDeltaOnly(meta) {
    if (!this.live.isActive() || !meta) return;
    const maps = this._buildStateMaps();
    this.live.pushMutation({ ...maps, ...meta }).catch(() => {});
  }

  _onBoardMutated(reason, meta = null) {
    if (!this.isStudentMode) {
      this.history.push(this._getSnapshot());
      this._markDirty();
    }
    this._updateEmptyHint();

    if (this.live.isActive()) {
      const maps = this._buildStateMaps();
      const syncNow = async () => {
        if (this.live.isTeacher() && meta?.changedObjectIds?.length) {
          for (const id of meta.changedObjectIds) {
            const obj = maps.objectsMap[id];
            if (obj && obj.type === 'image' && obj.assetPath) {
              const dataUrl = await this.storage.getAssetDataUrl(obj.assetPath, obj.inlineDataUrl);
              if (dataUrl) await this.live.publishAssetIfNeeded(obj.assetPath, dataUrl);
            }
          }
        }
        if (meta) {
          await this.live.pushMutation({ ...maps, ...meta });
        } else {
          await this.live.pushMutation({ ...maps, fullSync: true });
        }
      };
      syncNow().catch((err) => console.error('Live sync error:', err));
    }
  }

  _markDirty() {
    if (this.isStudentMode) return;
    this.isDirty = true;
    this.setStatus('dirty', 'Є зміни...');
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      this.saveCurrentBoard(false);
    }, 2400);
  }

  async saveCurrentBoard(manual = false) {
    if (!this.currentBoard || this.isStudentMode || this.isSaving) return;

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
    if (this.isStudentMode) return;
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
    if (this.isStudentMode) {
      if (this.studentPerm === 'view' && tool !== 'pan') return;
      if (this.studentPerm === 'draw' && ['select', 'text', 'note'].includes(tool)) return;
    }

    this.currentTool = tool;
    if (tool !== 'select' && !keepSelection) {
      this.selection.clear();
    }
    document.querySelectorAll('.tool-btn[data-tool]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === tool);
    });
    const showDrawOpts = ['pen', 'highlighter', 'line', 'arrow', 'rect', 'ellipse'].includes(tool);
    $('draw-options').classList.toggle('hidden', !showDrawOpts);
    $('text-options').classList.toggle('hidden', tool !== 'text' && tool !== 'note');
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
    if (e.target.closest('.board-obj.editing .board-obj-editable')) return;

    // Multi-touch tracking for 2-finger pinch-zoom & pan on tablets/phones
    if (e.pointerType === 'touch') {
      this.activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.activeTouches.size >= 2) {
        // Cancel any accidental 1-finger stroke/drag started milliseconds earlier
        if (this._isDrawingPointer) {
          this._isDrawingPointer = false;
          this.activeDrawPointerId = null;
          this.drawing.cancelActivePointer();
        }
        this.selection.cancelActiveInteraction();
        this.pinchCooldown = true;
        const pts = [...this.activeTouches.values()];
        this.viewport.startPinch(pts[0], pts[1]);
        return;
      }
    }

    // If selectionBox already initiated drag/resize on this touch, don't double-process
    if (e._handledBySelectionBox) return;

    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }

    if (e.button === 1 || e.button === 2 || this.viewport.spacePressed || this.currentTool === 'pan') {
      e.preventDefault();
      this.viewport.startPan(e.clientX, e.clientY, e.pointerId, e.button === 2);
      return;
    }

    if (e.button !== 0) return;

    const worldPt = this.viewport.screenToWorld(e.clientX, e.clientY);

    if (this.currentTool === 'text') {
      if (!this._canEditObjects()) return;
      e.preventDefault();
      const defColor = this.currentBoard?.bgTheme === 'light' ? '#18202c' : '#f3f5f9';
      const obj = this.objects.addTextAt(worldPt, defColor, '', this.defaultFont);
      this.setTool('select', { keepSelection: true });
      this.selection.selectOnly([obj.id]);
      this.objects.startEditing(obj.id);
      return;
    }

    if (this.currentTool === 'note') {
      if (!this._canEditObjects()) return;
      e.preventDefault();
      const obj = this.objects.addNoteAt(worldPt, this.defaultFont);
      this.setTool('select', { keepSelection: true });
      this.selection.selectOnly([obj.id]);
      this.objects.startEditing(obj.id);
      return;
    }

    if (this.currentTool === 'select') {
      this.selection.handleViewportPointerDown(e);
      return;
    }

    if (!this._canDraw()) return;
    this._isDrawingPointer = true;
    this.activeDrawPointerId = e.pointerId;
    this.drawing.startPointer(this.currentTool, worldPt);
  }

  _onViewportPointerMove(e) {
    if (e.pointerType === 'touch' && this.activeTouches.has(e.pointerId)) {
      this.activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.viewport.isPinching && this.activeTouches.size >= 2) {
        const pts = [...this.activeTouches.values()];
        this.viewport.movePinch(pts[0], pts[1]);
        return;
      }
      if (this.pinchCooldown) return;
    }

    if (this.live.isActive() && !this.viewport.isPinching) {
      const worldPt = this.viewport.screenToWorld(e.clientX, e.clientY);
      this.live.sendCursor(worldPt);
    }

    if (this.viewport.isPanning) {
      this.viewport.movePan(e.clientX, e.clientY, e.pointerId);
      return;
    }
    if (this._isDrawingPointer && (this.activeDrawPointerId === null || e.pointerId === this.activeDrawPointerId)) {
      const worldPt = this.viewport.screenToWorld(e.clientX, e.clientY);
      this.drawing.movePointer(worldPt);
    }
  }

  _onViewportPointerUp(e) {
    if (e && e.pointerType === 'touch') {
      this.activeTouches.delete(e.pointerId);
      if (this.viewport.isPinching && this.activeTouches.size < 2) {
        this.viewport.endPinch();
      }
      if (this.activeTouches.size === 0) {
        this.pinchCooldown = false;
      }
    }

    if (this.viewport.isPanning) {
      this.viewport.endPan(e ? e.pointerId : null);
      return;
    }
    if (this._isDrawingPointer && (!e || this.activeDrawPointerId === null || e.pointerId === this.activeDrawPointerId)) {
      this._isDrawingPointer = false;
      this.activeDrawPointerId = null;
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

    if (!this.isStudentMode) {
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
      if (e.code === 'Tab') {
        e.preventDefault();
        $('sidebar').classList.toggle('collapsed');
        return;
      }
    }

    if (this._canEditObjects()) {
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
    }

    if (e.code === 'Space') {
      e.preventDefault();
      this.viewport.spacePressed = true;
      this._updateViewportCursor();
      return;
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

  // --- MODALS ---

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
        this.live.syncBoardMeta({ title });
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

  _switchSettingsTab(tabId) {
    document.querySelectorAll('.modal-tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === tabId);
    });
    document.querySelectorAll('.modal-tab-panel').forEach((p) => {
      p.classList.toggle('hidden', p.id !== tabId);
    });
  }

  _openSettingsModal(initialTab = 'tab-github') {
    $('cfg-owner').value = this.ghConfig.owner || '';
    $('cfg-repo').value = this.ghConfig.repo || '';
    $('cfg-branch').value = this.ghConfig.branch || 'main';
    $('cfg-token').value = this.ghConfig.token || '';
    $('cfg-fb-url').value = this.fbConfig.databaseURL || '';

    $('settings-test-result').classList.add('hidden');
    $('fb-test-result').classList.add('hidden');
    this._switchSettingsTab(initialTab);
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
      resEl.className = 'test-result err';
      resEl.textContent = test.message;
      return;
    }

    this.ghConfig = saveGitHubConfig(nextCfg);
    this.storage.setConfig(this.ghConfig);
    $('modal-settings').classList.add('hidden');
    this.toast('GitHub підключено! Завантажую дошки...');
    await this._bootTeacher();
  }

  async _testFirebaseFromModal() {
    const resEl = $('fb-test-result');
    resEl.className = 'test-result';
    resEl.textContent = 'Перевіряю Firebase...';
    resEl.classList.remove('hidden');

    const res = await this.live.testConnection($('cfg-fb-url').value);
    resEl.className = `test-result ${res.ok ? 'ok' : 'err'}`;
    resEl.textContent = res.message;
  }

  async _saveFirebaseFromModal() {
    const resEl = $('fb-test-result');
    resEl.className = 'test-result';
    resEl.textContent = 'Перевіряю та зберігаю...';
    resEl.classList.remove('hidden');

    const rawUrl = $('cfg-fb-url').value;
    const res = await this.live.testConnection(rawUrl);
    if (!res.ok) {
      resEl.className = 'test-result err';
      resEl.textContent = res.message;
      return;
    }

    this.fbConfig = saveFirebaseConfig(rawUrl);
    $('cfg-fb-url').value = this.fbConfig.databaseURL;
    $('modal-settings').classList.add('hidden');
    this.toast('🔥 Firebase підключено! Тепер можна натискати «📡 Спільний урок».');
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
    setTimeout(() => div.remove(), 2900);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new WhiteboardApp();
});
