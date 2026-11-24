// Boards list sidebar, folders/tags, search, create, rename, duplicate, delete + multi-tab safe index merge

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

  async touchBoard(id) {
    await this._mutateIndexSafely((idx) => {
      const meta = idx.boards.find((b) => b.id === id);
      if (!meta) return;
      meta.updatedAt = new Date().toISOString();
      idx.boards.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    });
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

      const top = document.createElement('div');
      top.className = 'board-item-top';

      const title = document.createElement('div');
      title.className = 'board-item-title';
      title.textContent = b.title;

      const actions = document.createElement('div');
      actions.className = 'board-item-actions';

      const btnEdit = document.createElement('button');
      btnEdit.className = 'board-mini-btn';
      btnEdit.textContent = '✏️';
      btnEdit.title = 'Перейменувати / змінити папку';
      btnEdit.addEventListener('click', (e) => {
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('open-board-modal', { detail: { mode: 'edit', board: b } }));
      });

      const btnDup = document.createElement('button');
      btnDup.className = 'board-mini-btn';
      btnDup.textContent = '📋';
      btnDup.title = 'Зробити копію дошки';
      btnDup.addEventListener('click', (e) => {
        e.stopPropagation();
        this.duplicateBoard(b.id, true);
      });

      const btnDel = document.createElement('button');
      btnDel.className = 'board-mini-btn danger';
      btnDel.textContent = '🗑️';
      btnDel.title = 'Видалити дошку';
      btnDel.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteBoard(b.id);
      });

      actions.append(btnEdit, btnDup, btnDel);
      top.append(title, actions);

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

      this.listEl.appendChild(card);
    }
  }
}
