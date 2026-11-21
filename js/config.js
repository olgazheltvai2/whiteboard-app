// App constants and saved GitHub configuration

export const STORAGE_KEYS = {
  GH_CONFIG: 'whiteboard_gh_config_v1',
  LAST_BOARD: 'whiteboard_last_board_id',
  LOCAL_INDEX: 'whiteboard_local_index_v1',
  LOCAL_BOARD_PREFIX: 'whiteboard_local_board_'
};

export const DEFAULT_GH_CONFIG = {
  owner: 'olgazheltvai2',
  repo: 'whiteboard-data',
  branch: 'main',
  token: ''
};

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

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
