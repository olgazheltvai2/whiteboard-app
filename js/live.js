// Firebase Realtime Database live collaboration module (Teacher & Mini-Group Student Mode)

import { STUDENT_COLORS, extractDatabaseUrl, uid } from './config.js';

const FB_VER = '10.12.2';

function assetKeyFromPath(assetPath) {
  return String(assetPath || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function stripUndefined(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export class LiveSessionManager {
  constructor({
    cursorsLayerEl,
    onRemoteObjects,
    onRemoteStrokes,
    onRemoteLiveStrokes,
    onRemoteMeta,
    onRemoteCamera,
    onStudentsChange,
    onSessionEnded,
    onToast
  }) {
    this.cursorsLayerEl = cursorsLayerEl;
    this.onRemoteObjects = onRemoteObjects;
    this.onRemoteStrokes = onRemoteStrokes;
    this.onRemoteLiveStrokes = onRemoteLiveStrokes || (() => {});
    this.onRemoteMeta = onRemoteMeta;
    this.onRemoteCamera = onRemoteCamera;
    this.onStudentsChange = onStudentsChange;
    this.onSessionEnded = onSessionEnded;
    this.onToast = onToast;

    this.fb = null;
    this.db = null;
    this.databaseURL = '';
    this.role = null; // 'teacher' | 'student' | null
    this.roomId = null;
    this.clientId = uid('usr');
    this.studentName = '';
    this.studentColor = STUDENT_COLORS[Math.floor(Math.random() * STUDENT_COLORS.length)];

    this.globalPerm = 'edit';
    this.followCamera = false;
    this.cameraSeq = 0;
    this.students = {};
    this.unsubscribers = [];
    this.cursorEls = new Map();
    this.roomAssetCache = new Map();
    this.lastCursorSentAt = 0;
    this.lastCameraSentAt = 0;
    this.teacherClaimedUntil = new Map();
  }

  isActive() {
    return Boolean(this.roomId && this.role);
  }

  isTeacher() {
    return this.role !== 'student';
  }

  isStudent() {
    return this.role === 'student';
  }

  async _loadFirebase(databaseURL) {
    const cleanUrl = extractDatabaseUrl(databaseURL);
    if (!cleanUrl || !cleanUrl.startsWith('https://')) {
      throw new Error('Некоректне посилання Firebase Realtime Database.');
    }

    if (!this.fb) {
      const [appMod, dbMod] = await Promise.all([
        import(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-database.js`)
      ]);
      this.fb = { ...appMod, ...dbMod };
    }

    if (this.db && this.databaseURL === cleanUrl) {
      return this.db;
    }

    const appName = `wb_rtdb_${cleanUrl.replace(/[^a-zA-Z0-9]/g, '').slice(-16)}`;
    let app;
    try {
      app = this.fb.getApp(appName);
    } catch {
      app = this.fb.initializeApp({ databaseURL: cleanUrl }, appName);
    }
    this.db = this.fb.getDatabase(app);
    this.databaseURL = cleanUrl;
    return this.db;
  }

  async testConnection(databaseURL) {
    try {
      const db = await this._loadFirebase(databaseURL);
      const pingRef = this.fb.ref(db, `_ping/${uid('t')}`);
      await this.fb.set(pingRef, { ok: true, ts: Date.now() });
      await this.fb.remove(pingRef);
      return { ok: true, message: 'Firebase Realtime Database підключено й готово до спільних уроків!' };
    } catch (err) {
      const msg = err?.message || String(err);
      if (msg.toLowerCase().includes('permission')) {
        return {
          ok: false,
          message: 'Базу знайдено, але доступ закритий правилами (Rules). Дозвольте запис у _ping та rooms/$roomId.'
        };
      }
      return { ok: false, message: `Помилка Firebase: ${msg}` };
    }
  }

  // --- TEACHER: Host a single board live ---

  async startHosting({ databaseURL, board, storage, cameraState }) {
    const db = await this._loadFirebase(databaseURL);
    this._cleanupListeners();

    this.role = 'teacher';
    this.roomId = uid('rm');
    this.globalPerm = 'edit';
    this.followCamera = false;
    this.cameraSeq = 1;
    this.students = {};

    const objectsMap = {};
    const assetsMap = {};
    for (const o of board.objects || []) {
      const cleanObj = stripUndefined(o);
      delete cleanObj.inlineDataUrl; // Stored once in assetsMap
      objectsMap[o.id] = { ...cleanObj, _by: 'teacher', _ts: Date.now() };
      if (o.type === 'image' && o.assetPath) {
        const dataUrl = await storage.getAssetDataUrl(o.assetPath, o.inlineDataUrl);
        if (dataUrl) {
          assetsMap[assetKeyFromPath(o.assetPath)] = dataUrl;
        }
      }
    }

    const strokesMap = {};
    for (const s of board.strokes || []) {
      strokesMap[s.id] = { ...stripUndefined(s), _by: 'teacher', _ts: Date.now() };
    }

    const roomData = {
      meta: {
        boardTitle: board.title || 'Спільна дошка',
        bgTheme: board.bgTheme || 'dark',
        bgPattern: board.bgPattern || 'dots',
        globalPerm: this.globalPerm,
        followCamera: false,
        active: true,
        startedAt: Date.now()
      },
      camera: {
        cx: Math.round(cameraState.cx),
        cy: Math.round(cameraState.cy),
        viewW: Math.round(cameraState.viewW),
        viewH: Math.round(cameraState.viewH),
        zoom: Number(cameraState.zoom.toFixed(3)),
        seq: this.cameraSeq,
        force: true
      },
      objects: objectsMap,
      strokes: strokesMap,
      assets: assetsMap
    };

    const roomRef = this.fb.ref(db, `rooms/${this.roomId}`);
    await this.fb.set(roomRef, roomData);

    // Subscribe to student edits, presence & cursors
    this._subscribeTeacherListeners();
    return this.getInviteUrl();
  }

  getInviteUrl() {
    if (!this.roomId || !this.databaseURL) return '';
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('room', this.roomId);
    url.searchParams.set('db', this.databaseURL);
    return url.toString();
  }

  _subscribeTeacherListeners() {
    const db = this.db;
    const base = `rooms/${this.roomId}`;

    const unsubObj = this.fb.onValue(this.fb.ref(db, `${base}/objects`), (snap) => {
      const map = snap.val() || {};
      const filtered = {};
      const now = Date.now();
      for (const [id, item] of Object.entries(map)) {
        if (!item) continue;
        // Teacher priority: ignore stale student updates while teacher recently touched this item
        if (item._by !== 'teacher' && (this.teacherClaimedUntil.get(id) || 0) > now) {
          continue;
        }
        filtered[id] = item;
      }
      this.onRemoteObjects(filtered);
    });

    const unsubStr = this.fb.onValue(this.fb.ref(db, `${base}/strokes`), (snap) => {
      const map = snap.val() || {};
      const filtered = {};
      const now = Date.now();
      for (const [id, item] of Object.entries(map)) {
        if (!item) continue;
        if (item._by !== 'teacher' && (this.teacherClaimedUntil.get(id) || 0) > now) {
          continue;
        }
        filtered[id] = item;
      }
      this.onRemoteStrokes(filtered);
    });

    const unsubStu = this.fb.onValue(this.fb.ref(db, `${base}/students`), (snap) => {
      this.students = snap.val() || {};
      this.onStudentsChange(this.students);
      this._renderRemoteCursors(this.students, null);
    });

    const unsubLiveStr = this.fb.onValue(this.fb.ref(db, `${base}/liveStrokes`), (snap) => {
      this.onRemoteLiveStrokes(snap.val() || {}, this.clientId);
    });

    this.unsubscribers.push(unsubObj, unsubStr, unsubStu, unsubLiveStr);
  }

  async stopHosting() {
    if (!this.isActive() || this.role !== 'teacher') return;
    const roomId = this.roomId;
    this._cleanupListeners();
    this.role = null;
    this.roomId = null;
    this.students = {};
    this.onStudentsChange({});
    this._clearCursors();

    try {
      await this.fb.set(this.fb.ref(this.db, `rooms/${roomId}/meta/active`), false);
      setTimeout(() => {
        this.fb.remove(this.fb.ref(this.db, `rooms/${roomId}`)).catch(() => {});
      }, 900);
    } catch {
      // Ignore cleanup errors
    }
  }

  // --- TEACHER CONTROLS ---

  async setGlobalPermission(perm) {
    if (!this.isActive() || this.role !== 'teacher') return;
    this.globalPerm = perm;
    await this.fb.set(this.fb.ref(this.db, `rooms/${this.roomId}/meta/globalPerm`), perm);
  }

  async setStudentOverride(studentId, permOrNull) {
    if (!this.isActive() || this.role !== 'teacher') return;
    const path = `rooms/${this.roomId}/students/${studentId}/permOverride`;
    if (permOrNull) {
      await this.fb.set(this.fb.ref(this.db, path), permOrNull);
    } else {
      await this.fb.remove(this.fb.ref(this.db, path));
    }
  }

  async setFollowCamera(enabled, cameraState) {
    if (!this.isActive() || this.role !== 'teacher') return;
    this.followCamera = Boolean(enabled);
    await this.fb.set(this.fb.ref(this.db, `rooms/${this.roomId}/meta/followCamera`), this.followCamera);
    if (this.followCamera) {
      await this.pushCamera(cameraState, true);
    }
  }

  async pushCamera(cameraState, force = false) {
    if (!this.isActive() || this.role !== 'teacher') return;
    const now = Date.now();
    if (!force && now - this.lastCameraSentAt < 70) return;
    this.lastCameraSentAt = now;
    if (force) this.cameraSeq += 1;

    await this.fb.set(this.fb.ref(this.db, `rooms/${this.roomId}/camera`), {
      cx: Math.round(cameraState.cx),
      cy: Math.round(cameraState.cy),
      viewW: Math.round(cameraState.viewW),
      viewH: Math.round(cameraState.viewH),
      zoom: Number(cameraState.zoom.toFixed(3)),
      seq: this.cameraSeq,
      force: Boolean(force)
    });
  }

  async syncBoardMeta({ title, bgTheme, bgPattern }) {
    if (!this.isActive() || this.role !== 'teacher') return;
    const updates = {};
    if (typeof title === 'string') updates.boardTitle = title;
    if (typeof bgTheme === 'string') updates.bgTheme = bgTheme;
    if (typeof bgPattern === 'string') updates.bgPattern = bgPattern;
    await this.fb.update(this.fb.ref(this.db, `rooms/${this.roomId}/meta`), updates);
  }

  async publishAssetIfNeeded(assetPath, dataUrl) {
    if (!this.isActive() || this.role !== 'teacher' || !assetPath || !dataUrl) return;
    const key = assetKeyFromPath(assetPath);
    await this.fb.set(this.fb.ref(this.db, `rooms/${this.roomId}/assets/${key}`), dataUrl);
  }

  // --- STUDENT: Join a single board room ---

  async joinRoom({ databaseURL, roomId, studentName }) {
    const db = await this._loadFirebase(databaseURL);
    this._cleanupListeners();

    const metaSnap = await this.fb.get(this.fb.ref(db, `rooms/${roomId}/meta`));
    const meta = metaSnap.val();
    if (!meta || meta.active === false) {
      throw new Error('Цей урок уже завершено або посилання недійсне.');
    }

    this.role = 'student';
    this.roomId = roomId;
    this.studentName = (studentName || 'Учень').trim().slice(0, 24);
    this.lastAppliedCameraSeq = 0;

    // Register presence with automatic cleanup on disconnect
    const myRef = this.fb.ref(db, `rooms/${roomId}/students/${this.clientId}`);
    await this.fb.set(myRef, {
      name: this.studentName,
      color: this.studentColor,
      online: true,
      joinedAt: Date.now()
    });
    this.fb.onDisconnect(myRef).remove();
    this.fb.onDisconnect(this.fb.ref(db, `rooms/${roomId}/liveStrokes/${this.clientId}`)).remove();

    const base = `rooms/${roomId}`;

    const unsubMeta = this.fb.onValue(this.fb.ref(db, `${base}/meta`), (snap) => {
      const m = snap.val();
      if (!m || m.active === false) {
        this._cleanupListeners();
        this.role = null;
        this.roomId = null;
        this.onSessionEnded();
        return;
      }
      this.globalPerm = m.globalPerm || 'edit';
      this.followCamera = Boolean(m.followCamera);
      const eff = this.getEffectiveStudentPerm();
      this._lastStudentPerm = eff;
      this.onRemoteMeta(m, eff);
    });

    const unsubObj = this.fb.onValue(this.fb.ref(db, `${base}/objects`), (snap) => {
      this.onRemoteObjects(snap.val() || {});
    });

    const unsubStr = this.fb.onValue(this.fb.ref(db, `${base}/strokes`), (snap) => {
      this.onRemoteStrokes(snap.val() || {});
    });

    const unsubCam = this.fb.onValue(this.fb.ref(db, `${base}/camera`), (snap) => {
      const cam = snap.val();
      if (!cam) return;
      const shouldJump = this.followCamera || (cam.force && cam.seq && cam.seq !== this.lastAppliedCameraSeq);
      if (shouldJump) {
        this.lastAppliedCameraSeq = cam.seq || this.lastAppliedCameraSeq;
        this.onRemoteCamera(cam);
      }
    });

    let latestStudents = {};
    let latestTeacherCursor = null;

    this._lastStudentPerm = null;
    const unsubStu = this.fb.onValue(this.fb.ref(db, `${base}/students`), (snap) => {
      latestStudents = snap.val() || {};
      this.students = latestStudents;
      const eff = this.getEffectiveStudentPerm();
      if (eff !== this._lastStudentPerm) {
        this._lastStudentPerm = eff;
        this.onRemoteMeta({
          globalPerm: this.globalPerm,
          followCamera: this.followCamera
        }, eff);
      }
      this._renderRemoteCursors(latestStudents, latestTeacherCursor);
    });

    const unsubTCur = this.fb.onValue(this.fb.ref(db, `${base}/teacherCursor`), (snap) => {
      latestTeacherCursor = snap.val();
      this._renderRemoteCursors(latestStudents, latestTeacherCursor);
    });

    const unsubLiveStr = this.fb.onValue(this.fb.ref(db, `${base}/liveStrokes`), (snap) => {
      this.onRemoteLiveStrokes(snap.val() || {}, this.clientId);
    });

    this.unsubscribers.push(unsubMeta, unsubObj, unsubStr, unsubCam, unsubStu, unsubTCur, unsubLiveStr);
    return meta;
  }

  getEffectiveStudentPerm() {
    if (this.role !== 'student') return 'edit';
    const me = this.students[this.clientId];
    if (me && me.permOverride) return me.permOverride;
    return this.globalPerm || 'edit';
  }

  async resolveRoomAsset(assetPath) {
    if (!this.isActive() || !assetPath) return null;
    const key = assetKeyFromPath(assetPath);
    if (this.roomAssetCache.has(key)) return this.roomAssetCache.get(key);
    for (let attempt = 0; attempt < 4; attempt++) {
      const snap = await this.fb.get(this.fb.ref(this.db, `rooms/${this.roomId}/assets/${key}`));
      const val = snap.val();
      if (val) {
        this.roomAssetCache.set(key, val);
        return val;
      }
      await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
    }
    return null;
  }

  // --- SHARED DIFF SYNC (Teacher & Students) ---

  async pushMutation({
    objectsMap,
    strokesMap,
    changedObjectIds = null,
    deletedObjectIds = [],
    changedStrokeIds = null,
    deletedStrokeIds = [],
    fullSync = false
  }) {
    if (!this.isActive()) return;
    const by = this.role === 'teacher' ? 'teacher' : this.clientId;
    const now = Date.now();
    const updates = {};

    if (fullSync) {
      // Replace entire maps (used by Teacher on Undo/Redo)
      const cleanObjs = {};
      for (const [id, o] of Object.entries(objectsMap)) {
        const c = stripUndefined(o);
        delete c.inlineDataUrl;
        cleanObjs[id] = { ...c, _by: by, _ts: now };
        if (this.role === 'teacher') this.teacherClaimedUntil.set(id, now + 900);
      }
      const cleanStrs = {};
      for (const [id, s] of Object.entries(strokesMap)) {
        cleanStrs[id] = { ...stripUndefined(s), _by: by, _ts: now };
        if (this.role === 'teacher') this.teacherClaimedUntil.set(id, now + 900);
      }
      await this.fb.update(this.fb.ref(this.db, `rooms/${this.roomId}`), {
        objects: cleanObjs,
        strokes: cleanStrs
      });
      return;
    }

    for (const id of changedObjectIds || []) {
      const o = objectsMap[id];
      if (!o) continue;
      const c = stripUndefined(o);
      delete c.inlineDataUrl;
      updates[`objects/${id}`] = { ...c, _by: by, _ts: now };
      if (this.role === 'teacher') this.teacherClaimedUntil.set(id, now + 900);
    }
    for (const id of deletedObjectIds || []) {
      updates[`objects/${id}`] = null;
      if (this.role === 'teacher') this.teacherClaimedUntil.set(id, now + 900);
    }

    for (const id of changedStrokeIds || []) {
      const s = strokesMap[id];
      if (!s) continue;
      updates[`strokes/${id}`] = { ...stripUndefined(s), _by: by, _ts: now };
      if (this.role === 'teacher') this.teacherClaimedUntil.set(id, now + 900);
    }
    for (const id of deletedStrokeIds || []) {
      updates[`strokes/${id}`] = null;
      if (this.role === 'teacher') this.teacherClaimedUntil.set(id, now + 900);
    }

    if (Object.keys(updates).length > 0) {
      await this.fb.update(this.fb.ref(this.db, `rooms/${this.roomId}`), updates);
    }
  }

  // --- LIVE CURSORS ---

  pushLiveStroke(strokeOrNull) {
    if (!this.isActive()) return;
    const path = `rooms/${this.roomId}/liveStrokes/${this.clientId}`;
    if (!strokeOrNull) {
      this.fb.remove(this.fb.ref(this.db, path)).catch(() => {});
    } else {
      this.fb.set(this.fb.ref(this.db, path), stripUndefined(strokeOrNull)).catch(() => {});
    }
  }

  sendCursor(worldPt) {
    if (!this.isActive()) return;
    const now = Date.now();
    if (now - this.lastCursorSentAt < 85) return;
    this.lastCursorSentAt = now;

    const payload = { x: Math.round(worldPt.x), y: Math.round(worldPt.y), ts: now };
    const path = this.role === 'teacher'
      ? `rooms/${this.roomId}/teacherCursor`
      : `rooms/${this.roomId}/students/${this.clientId}/cursor`;
    this.fb.set(this.fb.ref(this.db, path), payload).catch(() => {});
  }

  _renderRemoteCursors(studentsMap, teacherCursor) {
    const activeKeys = new Set();

    const drawCursor = (key, name, color, pos) => {
      if (!pos || typeof pos.x !== 'number') return;
      activeKeys.add(key);
      let el = this.cursorEls.get(key);
      if (!el) {
        el = document.createElement('div');
        el.className = 'remote-cursor';
        el.innerHTML = `
          <svg class="remote-cursor-arrow" viewBox="0 0 18 18" fill="none">
            <path d="M2 2L15 7.5L9.2 9.8L7 15.5L2 2Z" fill="${color}" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/>
          </svg>
          <span class="remote-cursor-tag" style="background:${color}"></span>
        `;
        this.cursorsLayerEl.appendChild(el);
        this.cursorEls.set(key, el);
      }
      el.querySelector('.remote-cursor-tag').textContent = name;
      el.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    };

    if (this.role === 'student' && teacherCursor) {
      drawCursor('teacher', '👩‍🏫 Вчитель', '#5b8def', teacherCursor);
    }

    for (const [id, stu] of Object.entries(studentsMap || {})) {
      if (id === this.clientId || !stu || !stu.cursor) continue;
      drawCursor(id, stu.name || 'Учень', stu.color || '#ff6b6b', stu.cursor);
    }

    for (const [key, el] of [...this.cursorEls.entries()]) {
      if (!activeKeys.has(key)) {
        el.remove();
        this.cursorEls.delete(key);
      }
    }
  }

  _clearCursors() {
    this.cursorsLayerEl.innerHTML = '';
    this.cursorEls.clear();
  }

  _cleanupListeners() {
    this.unsubscribers.forEach((fn) => {
      try { fn(); } catch {}
    });
    this.unsubscribers = [];
    this.roomAssetCache.clear();
  }
}
