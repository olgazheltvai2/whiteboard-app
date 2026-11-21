// App constants, font presets, GitHub & Firebase configuration

export const STORAGE_KEYS = {
  GH_CONFIG: 'whiteboard_gh_config_v1',
  FB_CONFIG: 'whiteboard_fb_config_v1',
  LAST_BOARD: 'whiteboard_last_board_id',
  LOCAL_INDEX: 'whiteboard_local_index_v1',
  LOCAL_BOARD_PREFIX: 'whiteboard_local_board_',
  DEFAULT_FONT: 'whiteboard_default_font_v1'
};

export const CLIPBOARD_MARKER_PREFIX = '__WB_INTERNAL_CLIPBOARD__:';

export const DEFAULT_GH_CONFIG = {
  owner: 'olgazheltvai2',
  repo: 'whiteboard-data',
  branch: 'main',
  token: ''
};

export const FONT_PRESETS = [
  {
    id: 'sans',
    label: 'Друкований',
    family: '"Segoe UI", system-ui, -apple-system, Roboto, sans-serif',
    lineHeight: 1.35,
    sizeScale: 1
  },
  {
    id: 'propysy',
    label: '✍️ Прописний',
    family: '"SchoolPropysy", "Marck Script", cursive',
    lineHeight: 1.5,
    sizeScale: 1.25
  },
  {
    id: 'hand',
    label: 'Рукописний',
    family: '"Caveat", cursive',
    lineHeight: 1.3,
    sizeScale: 1.22
  },
  {
    id: 'neat',
    label: 'Зошитовий',
    family: '"Bad Script", cursive',
    lineHeight: 1.45,
    sizeScale: 1.1
  }
];

export function getFontPreset(id) {
  return FONT_PRESETS.find((f) => f.id === id) || FONT_PRESETS[0];
}

export const DRAW_COLORS = [
  '#ffffff',
  '#18202c',
  '#ff5c5c',
  '#ffb74d',
  '#ffe066',
  '#4cd964',
  '#5b8def',
  '#c084fc'
];

export const DRAW_WIDTHS = [
  { id: 's', size: 2.5, dot: 5 },
  { id: 'm', size: 5, dot: 8 },
  { id: 'l', size: 10, dot: 12 },
  { id: 'xl', size: 18, dot: 16 }
];

export const NOTE_COLORS = [
  { bg: '#fff3a1', text: '#1f2328' },
  { bg: '#b8f2d4', text: '#162b21' },
  { bg: '#ffd1dc', text: '#331822' },
  { bg: '#c7e2ff', text: '#16253b' },
  { bg: '#e3d1ff', text: '#25173b' }
];

export const STUDENT_COLORS = [
  '#ff6b6b',
  '#4ecdc4',
  '#ffa94d',
  '#a78bfa',
  '#38bdf8',
  '#f472b6',
  '#a3e635'
];

export const IMAGE_LIMITS = {
  MAX_DIMENSION: 1920,
  WEBP_QUALITY: 0.85,
  INITIAL_DISPLAY_MAX_WIDTH: 460
};

export function loadGitHubConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.GH_CONFIG);
    if (!raw) return { ...DEFAULT_GH_CONFIG };
    return { ...DEFAULT_GH_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_GH_CONFIG };
  }
}

export function saveGitHubConfig(cfg) {
  const clean = {
    owner: (cfg.owner || '').trim(),
    repo: (cfg.repo || '').trim(),
    branch: (cfg.branch || 'main').trim() || 'main',
    token: (cfg.token || '').trim()
  };
  localStorage.setItem(STORAGE_KEYS.GH_CONFIG, JSON.stringify(clean));
  return clean;
}

export function isGitHubConfigured(cfg) {
  return Boolean(cfg && cfg.owner && cfg.repo && cfg.token);
}

export function extractDatabaseUrl(input) {
  const raw = (input || '').trim();
  if (!raw) return '';
  // Allow user to paste either a direct URL or a full Firebase config snippet
  const match = raw.match(/https:\/\/[a-zA-Z0-9.-]+(?:firebaseio\.com|firebasedatabase\.app)[^\s"'`,}]*/);
  if (match) {
    return match[0].replace(/\/+$/, '');
  }
  return raw.replace(/\/+$/, '');
}

export function loadFirebaseConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.FB_CONFIG);
    if (!raw) return { databaseURL: '' };
    return { databaseURL: '', ...JSON.parse(raw) };
  } catch {
    return { databaseURL: '' };
  }
}

export function saveFirebaseConfig(databaseURLInput) {
  const clean = { databaseURL: extractDatabaseUrl(databaseURLInput) };
  localStorage.setItem(STORAGE_KEYS.FB_CONFIG, JSON.stringify(clean));
  return clean;
}

export function isFirebaseConfigured(cfg) {
  return Boolean(cfg && cfg.databaseURL && cfg.databaseURL.startsWith('https://'));
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
