// ============================================
// JARVIS 2.0 - Configuração Central
// Todas as credenciais vêm do .env
// ============================================

export const CONFIG = {
  API_PORT: parseInt(process.env.API_PORT) || 3100,
  API_KEY: process.env.JARVIS_API_KEY || '',
  GROUP_TAREFAS: process.env.GROUP_TAREFAS || '',
  GROUP_GALAXIAS: process.env.GROUP_GALAXIAS || '',
  GUI_JID: process.env.GUI_JID || '',
  AI_MODEL: process.env.AI_MODEL || 'claude-sonnet-4-6',
  MAX_CONTEXT_MESSAGES: 30,
  ASANA_PAT: process.env.ASANA_PAT || '',
  ASANA_WORKSPACE: process.env.ASANA_WORKSPACE || '',
  JARVIS_VERSION: '2.0.0',
};

// Asana GIDs da equipe (via .env JSON ou fallback vazio)
function parseJsonEnv(key, fallback = {}) {
  try { return JSON.parse(process.env[key] || '{}'); } catch { return fallback; }
}

export const TEAM_ASANA = parseJsonEnv('TEAM_ASANA');

export const ASANA_PROJECTS = parseJsonEnv('ASANA_PROJECTS');

export const ASANA_SECTIONS = parseJsonEnv('ASANA_SECTIONS');

export const PUBLIC_ASANA_PROJECTS = new Set(
  (process.env.PUBLIC_ASANA_PROJECTS || '').split(',').filter(Boolean)
);

export const GCAL_KEY_PATH = process.env.GCAL_KEY_PATH || '/opt/jarvis/google-calendar-key.json';
export const GCAL_CALENDAR_ID = process.env.GCAL_CALENDAR_ID || '';

// Grupos onde Jarvis pode responder
export const JARVIS_ALLOWED_GROUPS = new Set(
  [CONFIG.GROUP_TAREFAS, CONFIG.GROUP_GALAXIAS].filter(Boolean)
);

// Grupos onde Jarvis pode mandar áudio
export const AUDIO_ALLOWED = new Set(
  [CONFIG.GROUP_TAREFAS, CONFIG.GROUP_GALAXIAS, CONFIG.GUI_JID].filter(Boolean)
);

// Mapeamento dinâmico de equipe (telefones e LIDs)
export const teamPhones = new Map();
export const teamWhatsApp = new Map();
