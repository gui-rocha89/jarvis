// ============================================
// JARVIS 3.0 - Configuração Central
// Todas as credenciais vêm do .env
// ============================================

export const CONFIG = {
  API_PORT: parseInt(process.env.API_PORT) || 3100,
  API_KEY: process.env.JARVIS_API_KEY || '',
  GROUP_TAREFAS: process.env.GROUP_TAREFAS || '',
  GROUP_GALAXIAS: process.env.GROUP_GALAXIAS || '',
  GUI_JID: process.env.GUI_JID || '',
  AI_MODEL: process.env.AI_MODEL || 'claude-sonnet-4-6',
  AI_MODEL_STRONG: process.env.AI_MODEL_STRONG || 'claude-opus-4-0-20250514',
  MAX_CONTEXT_MESSAGES: 30,
  ASANA_PAT: process.env.ASANA_PAT || '',
  ASANA_WORKSPACE: process.env.ASANA_WORKSPACE || '',
  JARVIS_VERSION: '3.0.0',
  JWT_SECRET: process.env.JWT_SECRET || '',
  // Meta Ads (Facebook/Instagram)
  META_APP_ID: process.env.META_APP_ID || '',
  META_APP_SECRET: process.env.META_APP_SECRET || '',
  META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN || '',
  META_AD_ACCOUNT_ID: process.env.META_AD_ACCOUNT_ID || '',
  META_PAGE_ID: process.env.META_PAGE_ID || '',
  META_API_VERSION: process.env.META_API_VERSION || 'v25.0',
  // IMAP (Asana Email Monitor)
  IMAP_HOST: process.env.IMAP_HOST || '',
  IMAP_PORT: parseInt(process.env.IMAP_PORT) || 993,
  IMAP_USER: process.env.IMAP_USER || '',
  IMAP_PASSWORD: process.env.IMAP_PASSWORD || '',
  IMAP_POLL_INTERVAL: parseInt(process.env.IMAP_POLL_INTERVAL) || 90,
};

// Asana GIDs da equipe (via .env JSON ou fallback vazio)
function parseJsonEnv(key, fallback = {}) {
  try { return JSON.parse(process.env[key] || '{}'); } catch { return fallback; }
}

export const TEAM_ASANA = parseJsonEnv('TEAM_ASANA');

export const ASANA_PROJECTS = parseJsonEnv('ASANA_PROJECTS');

export const ASANA_SECTIONS = parseJsonEnv('ASANA_SECTIONS');

// Custom Fields do Asana (Cabine de Comando)
export const ASANA_CUSTOM_FIELDS = parseJsonEnv('ASANA_CUSTOM_FIELDS');
export const ASANA_CLIENTE_MAP = parseJsonEnv('ASANA_CLIENTE_MAP');
export const ASANA_URGENCIA_MAP = parseJsonEnv('ASANA_URGENCIA_MAP');
export const ASANA_TIER_MAP = parseJsonEnv('ASANA_TIER_MAP');
export const ASANA_TIPO_DEMANDA_MAP = parseJsonEnv('ASANA_TIPO_DEMANDA_MAP');

// Meta Ads — mapeamento cliente → Page ID do Facebook
export const META_PAGES_MAP = parseJsonEnv('META_PAGES_MAP');

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

// ============================================
// CLIENTES GERENCIADOS (Jarvis Proativo)
// ============================================
export const managedClients = new Map(); // groupJid → { groupName, active, defaultAssignee, ... }

export async function loadManagedClients(pool) {
  try {
    const { rows } = await pool.query("SELECT value FROM jarvis_config WHERE key = 'managed_clients'");
    if (rows.length > 0) {
      const data = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
      for (const [key, client] of Object.entries(data)) {
        if (client.groupJid) managedClients.set(client.groupJid, { ...client, slug: key });
      }
      console.log(`[PROACTIVE] ${managedClients.size} clientes gerenciados carregados`);
    }
  } catch (err) {
    console.error('[PROACTIVE] Erro ao carregar clientes gerenciados:', err.message);
  }
}

export async function saveManagedClients(pool) {
  const data = {};
  for (const [jid, client] of managedClients) {
    const slug = client.slug || client.groupName?.split('🔛')[0]?.trim().toLowerCase().replace(/\s+/g, '_') || jid;
    data[slug] = { ...client, groupJid: jid };
    delete data[slug].slug;
  }
  await pool.query(
    "INSERT INTO jarvis_config (key, value) VALUES ('managed_clients', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
    [JSON.stringify(data)]
  );
}

export function isManagedClientGroup(groupJid) {
  const client = managedClients.get(groupJid);
  return (client && client.active) ? client : null;
}
