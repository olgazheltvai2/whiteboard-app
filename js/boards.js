// Boards list sidebar, folders/tags, search, create, rename, duplicate, delete + Drag & Drop Custom Order

import { uid } from './config.js';

function formatShortDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' }) +
      ' ' + d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function applyReorderInPlace(boardsList, draggedId, targetId, position) {
  if (!draggedId || !targetId || draggedId === targetId) return false;
  const fromIdx = boardsList.findIndex((b) => b.id === draggedId);
  const targetIdx = boardsList.findIndex((b) => b.id === targetId);
  if (fromIdx === -1 || targetIdx === -1) return false;

  const [moved] = boardsList.splice(fromIdx, 1);
  let insertIdx = boardsList.findIndex((b) => b.id === targetId);
  if (insertIdx === -1) {
    boardsList.push(moved);
    return true;
  }
  if (position === 'after') insertIdx += 1;
  boardsList.splice(insertIdx, 0, moved);
  return true;
}

export class BoardsManager {
  constructor({ listEl, filtersEl, searchEl, datalistEl, storage, onSelectBoard, onToast }) {
    this.listEl = listEl;
    this.filtersEl = filtersEl;
    this.searchEl = searchEl;
    this.datalistEl = datalistEl;
    this.storage = storage;
    this.onSelectBoard = onSelectBoard;
    this.onToast = onToast;

    this.index = { version: 1, boards: [] };
    this.activeBoardId = null;
    this.activeFolder = 'ALL';
    this.searchQuery = '';
    this.draggingId = null;

    this.searchEl.addEventListener('input', () => {
      this.searchQuery = this.searchEl.value.trim().toLowerCase();
      this.render();
    });
  }

  async loadList() {
    this.index = await this.storage.loadIndex();
    if (!Array.isArray(this.index.boards)) this.index.boards = [];
    this.render();
    return this.index.boards;
  }

  // Safely pulls fresh remote index before writing so two open browser tabs never overwrite each other
  async _mutateIndexSafely(mutatorFn) {
    if (this.storage.isCloudReady()) {
      try {
        const fresh = await this.storage.loadIndex();
        if (fresh && Array.isArray(fresh.boards)) {
          this.index = fresh;
        }
      } catch {
        // Fallback to local in-memory index if temporary network hiccup
      }
    }
    if (!Array.isArray(this.index.boards)) this.index.boards = [];
    mutatorFn(this.index);
    this.render();
    await this.storage.saveIndex(this.index);
  }

  getBoardMeta(id) {
    return this.index.boards.find((b) => b.id === id) || null;
  }

  setActiveId(id) {
    this.activeBoardId = id;
    this.render();
  }

  async createBoard(title = 'Нова дошка', folder = '') {
    const now = new Date().toISOString();
    const id = uid('board');
    const meta = {
      id,
      title: title.trim() || 'Нова дошка',
      folder: folder.trim(),
      updatedAt: now
    };
    const fullData = {
      ...meta,
      bgTheme: 'dark',
      bgPattern: 'dots',
      viewport: null,
      anchorObjectId: null,
      objects: [],
      strokes: []
    };

    await this.storage.saveBoard(fullData);
    await this._mutateIndexSafely((idx) => {
      idx.boards = idx.boards.filter((b) => b.id !== id);
      idx.boards.unshift(meta);
    });
    return fullData;
  }

  async updateBoardMeta(id, { title, folder }) {
    await this._mutateIndexSafely((idx) => {
      const meta = idx.boards.find((b) => b.id === id);
      if (!meta) return;
      if (typeof title === 'string') meta.title = title.trim() || 'Без назви';
      if (typeof folder === 'string') meta.folder = folder.trim();
      meta.updatedAt = new Date().toISOString();
    });
  }

  // Preserves custom drag-and-drop sequence (does NOT re-sort by date!)
  async touchBoard(id) {
    await this._mutateIndexSafely((idx) => {
      const meta = idx.boards.find((b) => b.id === id);
      if (!meta) return;
      meta.updatedAt = new Date().toISOString();
    });
  }

  async reorderBoard(draggedId, targetId, position = 'before') {
    if (!draggedId || !targetId || draggedId === targetId) return;
    // Optimistic local reorder for instant feedback
    const changed = applyReorderInPlace(this.index.boards, draggedId, targetId, position);
    if (!changed) return;
    this.render();

    // Persist safely to GitHub / localStorage, keeping any newly added boards from other tabs
    const desiredOrderIds = this.index.boards.map((b) => b.id);
    try {
      await this._mutateIndexSafely((idx) => {
        const byId = new Map(idx.boards.map((b) => [b.id, b]));
        const reordered = [];
        for (const id of desiredOrderIds) {
          if (byId.has(id)) {
            reordered.push(byId.get(id));
            byId.delete(id);
          }
        }
        // Keep any brand-new boards created in another tab at the top
        if (byId.size > 0) {
          idx.boards = [...byId.values(), ...reordered];
        } else {
          idx.boards = reordered;
        }
      });
      this.onToast('Порядок дошок збережено');
    } catch (err) {
      console.error('Reorder save error:', err);
      this.onToast('Не вдалося зберегти порядок дошок');
    }
  }

  async duplicateBoard(id, openAfter = true) {
    const srcMeta = this.getBoardMeta(id);
    if (!srcMeta) return;
    const srcData = await this.storage.loadBoard(id);
    if (!srcData) return;

    const newId = uid('board');
    const now = new Date().toISOString();
    const newTitle = `${srcMeta.title} (копія)`;

    const newMeta = {
      id: newId,
      title: newTitle,
      folder: srcMeta.folder || '',
      updatedAt: now
    };
    const newData = {
      ...JSON.parse(JSON.stringify(srcData)),
      ...newMeta
    };

    await this.storage.saveBoard(newData);
    await this._mutateIndexSafely((idx) => {
      idx.boards.unshift(newMeta);
    });
    this.onToast('Копію дошки створено');
    if (openAfter) {
      await this.onSelectBoard(newId);
    }
  }

  async deleteBoard(id) {
    const meta = this.getBoardMeta(id);
    if (!meta) return;
    if (!confirm(`Видалити дошку «${meta.title}»?`)) return;

    await this.storage.deleteBoard(id);
    await this._mutateIndexSafely((idx) => {
      idx.boards = idx.boards.filter((b) => b.id !== id);
    });
    this.onToast('Дошку видалено');

    if (this.activeBoardId === id) {
      if (this.index.boards.length > 0) {
        await this.onSelectBoard(this.index.boards[0].id);
      } else {
        const fresh = await this.createBoard('Перша дошка', '');
        await this.onSelectBoard(fresh.id);
      }
    }
  }

  getUniqueFolders() {
    const set = new Set();
    for (const b of this.index.boards) {
      if (b.folder) set.add(b.folder);
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'uk'));
  }

  _clearDragClasses() {
    this.listEl.querySelectorAll('.board-item').forEach((el) => {
      el.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
    });
  }

  render() {
    const folders = this.getUniqueFolders();

    this.datalistEl.innerHTML = '';
    folders.forEach((f) => {
      const opt = document.createElement('option');
      opt.value = f;
      this.datalistEl.appendChild(opt);
    });

    this.filtersEl.innerHTML = '';
    if (folders.length > 0) {
      const makePill = (label, val) => {
        const btn = document.createElement('button');
        btn.className = `folder-pill ${this.activeFolder === val ? 'active' : ''}`;
        btn.textContent = label;
        btn.addEventListener('click', () => {
          this.activeFolder = val;
          this.render();
        });
        this.filtersEl.appendChild(btn);
      };
      makePill('Усі', 'ALL');
      folders.forEach((f) => makePill(f, f));
    }

    const filtered = this.index.boards.filter((b) => {
      if (this.activeFolder !== 'ALL' && b.folder !== this.activeFolder) return false;
      if (this.searchQuery) {
        const hay = `${b.title} ${b.folder || ''}`.toLowerCase();
        if (!hay.includes(this.searchQuery)) return false;
      }
      return true;
    });

    this.listEl.innerHTML = '';
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding: 16px; color: var(--ui-text-muted); text-align: center; font-size: 13px;';
      empty.textContent = 'Дошок поки немає';
      this.listEl.appendChild(empty);
      return;
    }

    for (const b of filtered) {
      const card = document.createElement('div');
      card.className = `board-item ${b.id === this.activeBoardId ? 'active' : ''}`;
      card.dataset.boardId = b.id;
      card.draggable = true;

      const top = document.createElement('div');
      top.className = 'board-item-top';

      const titleWrap = document.createElement('div');
      titleWrap.className = 'board-item-title-wrap';

      const grip = document.createElement('span');
      grip.className = 'board-drag-handle';
      grip.textContent = '⋮⋮';
      grip.title = 'Потягніть, щоб змінити порядок дошки';

      const title = document.createElement('div');
      title.className = 'board-item-title';
      title.textContent = b.title;

      titleWrap.append(grip, title);

      const actions = document.createElement('div');
      actions.className = 'board-item-actions';

      const btnEdit = document.createElement('button');
      btnEdit.className = 'board-mini-btn';
      btnEdit.textContent = '✏️';
      btnEdit.title = 'Перейменувати / змінити папку';
      btnEdit.draggable = false;
      btnEdit.addEventListener('click', (e) => {
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('open-board-modal', { detail: { mode: 'edit', board: b } }));
      });

      const btnDup = document.createElement('button');
      btnDup.className = 'board-mini-btn';
      btnDup.textContent = '📋';
      btnDup.title = 'Зробити копію дошки';
      btnDup.draggable = false;
      btnDup.addEventListener('click', (e) => {
        e.stopPropagation();
        this.duplicateBoard(b.id, true);
      });

      const btnDel = document.createElement('button');
      btnDel.className = 'board-mini-btn danger';
      btnDel.textContent = '🗑️';
      btnDel.title = 'Видалити дошку';
      btnDel.draggable = false;
      btnDel.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteBoard(b.id);
      });

      actions.append(btnEdit, btnDup, btnDel);
      top.append(titleWrap, actions);

      const meta = document.createElement('div');
      meta.className = 'board-item-meta';
      const folderSpan = document.createElement('span');
      folderSpan.textContent = b.folder ? `📁 ${b.folder}` : '';
      const dateSpan = document.createElement('span');
      dateSpan.textContent = formatShortDate(b.updatedAt);
      meta.append(folderSpan, dateSpan);

      card.append(top, meta);
      card.addEventListener('click', () => {
        if (b.id !== this.activeBoardId) {
          this.onSelectBoard(b.id);
        }
      });

      // Drag & Drop handlers for reordering
      card.addEventListener('dragstart', (e) => {
        if (e.target && e.target.closest && e.target.closest('.board-item-actions')) {
          e.preventDefault();
          return;
        }
        this.draggingId = b.id;
        card.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', b.id);
        }
      });

      card.addEventListener('dragover', (e) => {
        if (!this.draggingId || this.draggingId === b.id) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        const rect = card.getBoundingClientRect();
        const isTop = e.clientY < rect.top + rect.height / 2;
        card.classList.toggle('drag-over-top', isTop);
        card.classList.toggle('drag-over-bottom', !isTop);
      });

      card.addEventListener('dragleave', () => {
        card.classList.remove('drag-over-top', 'drag-over-bottom');
      });

      card.addEventListener('drop', (e) => {
        e.preventDefault();
        const draggedId = this.draggingId || e.dataTransfer?.getData('text/plain');
        if (!draggedId || draggedId === b.id) {
          this._clearDragClasses();
          return;
        }
        const rect = card.getBoundingClientRect();
        const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        this.draggingId = null;
        this._clearDragClasses();
        this.reorderBoard(draggedId, b.id, pos);
      });

      card.addEventListener('dragend', () => {
        this.draggingId = null;
        this._clearDragClasses();
      });

      this.listEl.appendChild(card);
    }
  }
}
