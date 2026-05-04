// ============================================
// JARVIS 6.0 — KEYS MANAGER (Sprint 10)
// Permite gerenciar API keys e configs sensíveis via dashboard
// sem precisar mexer em arquivo .env no servidor.
//
// Como funciona:
//  - Whitelist de chaves gerenciáveis (segurança — não dá pra trocar JWT_SECRET, DB_PASSWORD, etc)
//  - Salva criptografado (AES-256-GCM) na tabela jarvis_config (key='runtime_keys')
//  - Sobrescreve process.env em runtime (chamadas futuras pegam novo valor)
//  - Endpoint /dashboard/restart força PM2 a reiniciar (necessário pra SDKs que cachearam o token)
// ============================================

import crypto from 'crypto';
import { pool } from './database.mjs';

const ALGO = 'aes-256-gcm';

// Chave derivada do JWT_SECRET (32 bytes pra AES-256)
function getKey() {
  const secret = process.env.JWT_SECRET || 'fallback-insecure-key-change-jwt-secret';
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(text) {
  if (typeof text !== 'string') throw new Error('encrypt: input deve ser string');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(payload) {
  if (typeof payload !== 'string') throw new Error('decrypt: input deve ser string');
  const data = Buffer.from(payload, 'base64');
  if (data.length < 28) throw new Error('payload corrompido');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const enc = data.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ============================================
// WHITELIST — chaves que podem ser editadas via dashboard
// ============================================
// NÃO incluir aqui:
//  - JWT_SECRET (usado pra criptografar — não pode mudar)
//  - DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD (mudar quebra tudo)
//  - JARVIS_API_KEY (chave interna — gerar nova requer config em vários lugares)
//  - REDIS_PASSWORD (idem)
//  - GCAL_KEY_PATH (é caminho de arquivo, não valor)

// Estrutura: kind = 'apikey' (segredo de API) | 'config' (ID, host, número) | 'model' (string de modelo)
// Isso ajuda a UI a separar visualmente
export const MANAGEABLE_KEYS = [
  // ==== Modelos de IA (não são chaves — são strings tipo "claude-sonnet-4-6") ====
  { key: 'AI_MODEL', group: 'Modelos Claude', kind: 'model', label: 'Modelo padrão — respostas rápidas (DM, grupo, Asana, voz)', sensitive: false, hint: 'claude-sonnet-4-6' },
  { key: 'AI_MODEL_STRONG', group: 'Modelos Claude', kind: 'model', label: 'Modelo forte — raciocínio complexo (showcase, decisões)', sensitive: false, hint: 'claude-opus-4-6' },
  { key: 'MEMORY_MODEL', group: 'Modelos Claude', kind: 'model', label: 'Modelo de memória — extração de fatos e síntese de perfis', sensitive: false, hint: 'claude-sonnet-4-5' },

  // ==== Chaves de API (segredos) ====
  { key: 'ANTHROPIC_API_KEY', group: 'API Keys', kind: 'apikey', label: 'Claude API Key (Anthropic)', sensitive: true, hint: 'sk-ant-api03-...' },
  { key: 'OPENAI_API_KEY', group: 'API Keys', kind: 'apikey', label: 'OpenAI API Key (Whisper + TTS + Embeddings)', sensitive: true, hint: 'sk-...' },
  { key: 'ELEVENLABS_API_KEY', group: 'API Keys', kind: 'apikey', label: 'ElevenLabs API Key (TTS primário)', sensitive: true },
  { key: 'ASANA_PAT', group: 'API Keys', kind: 'apikey', label: 'Asana Personal Access Token', sensitive: true, hint: '2/12...' },
  { key: 'META_ACCESS_TOKEN', group: 'API Keys', kind: 'apikey', label: 'Meta Access Token (System User recomendado)', sensitive: true, hint: 'EAA...' },
  { key: 'META_APP_SECRET', group: 'API Keys', kind: 'apikey', label: 'Meta App Secret', sensitive: true },
  { key: 'IMAP_PASSWORD', group: 'API Keys', kind: 'apikey', label: 'IMAP Password (Asana monitor)', sensitive: true },
  { key: 'EMAIL_PASSWORD', group: 'API Keys', kind: 'apikey', label: 'Email Password (canal Lab)', sensitive: true },
  { key: 'INSTAGRAM_VERIFY_TOKEN', group: 'API Keys', kind: 'apikey', label: 'Instagram Webhook Verify Token', sensitive: true },

  // ==== IDs e configs (não-secretos) ====
  { key: 'ELEVENLABS_VOICE_ID', group: 'IDs e Configurações', kind: 'config', label: 'ElevenLabs Voice ID', sensitive: false },
  { key: 'ASANA_WORKSPACE', group: 'IDs e Configurações', kind: 'config', label: 'Asana Workspace GID', sensitive: false },
  { key: 'META_APP_ID', group: 'IDs e Configurações', kind: 'config', label: 'Meta App ID', sensitive: false },
  { key: 'META_AD_ACCOUNT_ID', group: 'IDs e Configurações', kind: 'config', label: 'Meta Ad Account ID', sensitive: false, hint: 'act_123...' },
  { key: 'META_PAGE_ID', group: 'IDs e Configurações', kind: 'config', label: 'Meta Page ID padrão', sensitive: false },
  { key: 'META_PIXEL_ID', group: 'IDs e Configurações', kind: 'config', label: 'Meta Pixel ID', sensitive: false },
  { key: 'META_API_VERSION', group: 'IDs e Configurações', kind: 'config', label: 'Meta Graph API version', sensitive: false, hint: 'v25.0' },
  { key: 'IMAP_HOST', group: 'IDs e Configurações', kind: 'config', label: 'IMAP Host (Asana monitor)', sensitive: false, hint: 'imap.gmail.com' },
  { key: 'IMAP_USER', group: 'IDs e Configurações', kind: 'config', label: 'IMAP User (Asana monitor)', sensitive: false },
  { key: 'EMAIL_IMAP_HOST', group: 'IDs e Configurações', kind: 'config', label: 'Email IMAP Host (canal Lab)', sensitive: false },
  { key: 'EMAIL_IMAP_PORT', group: 'IDs e Configurações', kind: 'config', label: 'Email IMAP Port', sensitive: false, hint: '993' },
  { key: 'EMAIL_SMTP_HOST', group: 'IDs e Configurações', kind: 'config', label: 'Email SMTP Host', sensitive: false },
  { key: 'EMAIL_SMTP_PORT', group: 'IDs e Configurações', kind: 'config', label: 'Email SMTP Port', sensitive: false, hint: '587' },
  { key: 'EMAIL_USER', group: 'IDs e Configurações', kind: 'config', label: 'Email do Lab', sensitive: false },
  { key: 'GCAL_CALENDAR_ID', group: 'IDs e Configurações', kind: 'config', label: 'Google Calendar ID', sensitive: false, hint: 'email@group.calendar.google.com' },
  { key: 'GROUP_TAREFAS', group: 'IDs e Configurações', kind: 'config', label: 'JID do grupo Tarefas (WhatsApp)', sensitive: false, hint: '...@g.us' },
  { key: 'GROUP_GALAXIAS', group: 'IDs e Configurações', kind: 'config', label: 'JID do grupo Galáxias (WhatsApp)', sensitive: false, hint: '...@g.us' },
  { key: 'GUI_JID', group: 'IDs e Configurações', kind: 'config', label: 'JID do Gui (DM WhatsApp)', sensitive: false, hint: '...@s.whatsapp.net' },
];

export const KEY_NAMES = MANAGEABLE_KEYS.map(k => k.key);

// ============================================
// LOAD / SAVE / DELETE
// ============================================

// Lê chaves cifradas do banco e sobrescreve process.env
export async function loadKeysFromDb() {
  try {
    const { rows } = await pool.query("SELECT value FROM jarvis_config WHERE key = 'runtime_keys'");
    if (rows.length === 0) return 0;
    const stored = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
    let count = 0;
    for (const [k, encVal] of Object.entries(stored)) {
      if (!KEY_NAMES.includes(k)) continue; // segurança: ignora chaves fora da whitelist
      try {
        const dec = decrypt(encVal);
        process.env[k] = dec;
        count++;
      } catch (e) {
        console.error(`[KEYS] Erro decrypt ${k}:`, e.message);
      }
    }
    if (count) console.log(`[KEYS] ${count} chaves runtime carregadas do banco (sobrescrevendo .env)`);
    return count;
  } catch (e) {
    console.error('[KEYS] Erro loadKeysFromDb:', e.message);
    return 0;
  }
}

export async function saveKey(key, value) {
  if (!KEY_NAMES.includes(key)) throw new Error(`Chave "${key}" não está na whitelist de chaves gerenciáveis`);
  if (value === undefined || value === null) throw new Error('Valor não pode ser vazio');
  const strValue = String(value);
  if (strValue.length === 0) throw new Error('Valor não pode ser vazio');
  if (strValue.length > 8000) throw new Error('Valor muito longo (máx 8000 chars)');

  // Carrega chaves atuais
  const { rows } = await pool.query("SELECT value FROM jarvis_config WHERE key = 'runtime_keys'");
  const current = rows.length > 0
    ? (typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value)
    : {};

  current[key] = encrypt(strValue);

  await pool.query(
    "INSERT INTO jarvis_config (key, value) VALUES ('runtime_keys', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
    [JSON.stringify(current)]
  );

  // Aplica imediatamente em runtime
  process.env[key] = strValue;

  return true;
}

export async function deleteKey(key) {
  if (!KEY_NAMES.includes(key)) throw new Error(`Chave "${key}" não está na whitelist`);
  const { rows } = await pool.query("SELECT value FROM jarvis_config WHERE key = 'runtime_keys'");
  if (rows.length === 0) return false;
  const current = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
  if (!(key in current)) return false;
  delete current[key];
  await pool.query(
    "UPDATE jarvis_config SET value = $1 WHERE key = 'runtime_keys'",
    [JSON.stringify(current)]
  );
  // OBS: NÃO limpa do process.env. Quando reiniciar, o valor do .env volta.
  return true;
}

// Mascara valor sensível: '****abcd' (mostra só últimos 4 chars)
export function maskKey(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 4) return '****';
  if (s.length <= 8) return '****' + s.slice(-2);
  return '****' + s.slice(-4);
}

// Lista chaves com status (sem expor valores sensíveis)
export async function listKeys() {
  let stored = {};
  try {
    const { rows } = await pool.query("SELECT value FROM jarvis_config WHERE key = 'runtime_keys'");
    if (rows.length > 0) {
      stored = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
    }
  } catch (e) { /* ignora — pode não existir ainda */ }

  return MANAGEABLE_KEYS.map(meta => {
    const envValue = process.env[meta.key] || '';
    const inDb = !!stored[meta.key];
    return {
      ...meta,
      configured: !!envValue,
      source: inDb ? 'database' : (envValue ? 'env' : 'none'),
      preview: meta.sensitive ? maskKey(envValue) : envValue,
    };
  });
}

// ============================================
// TESTE DE CONECTIVIDADE
// Faz uma chamada real à API correspondente pra confirmar que a chave é válida.
// Retorna { ok: bool, message: string, latency_ms: number, details?: any }
// ============================================

const TEST_TIMEOUT_MS = 10000;

async function fetchWithTimeout(url, opts = {}, timeoutMs = TEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally { clearTimeout(t); }
}

// Helper: tenta uma chamada mínima ao Claude com modelo específico
async function probeAnthropicModel(modelName) {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) return { ok: false, message: 'ANTHROPIC_API_KEY vazia — configure ela primeiro' };
  if (!modelName) return { ok: false, message: 'Nome do modelo vazio' };
  const r = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: modelName, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
  });
  if (r.ok) {
    const data = await r.json().catch(() => ({}));
    return { ok: true, message: `Modelo "${modelName}" válido e respondendo (${data.usage?.input_tokens || '?'} tokens in)` };
  }
  const body = await r.text();
  let err = body;
  try { err = JSON.parse(body)?.error?.message || body; } catch {}
  if (r.status === 401) return { ok: false, message: `Chave inválida (401) — verifique ANTHROPIC_API_KEY` };
  if (r.status === 404) return { ok: false, message: `Modelo "${modelName}" NÃO EXISTE ou foi DEPRECADO` };
  if (r.status === 429) return { ok: true, message: `Modelo válido (rate-limited mas autenticou)`, warn: true };
  return { ok: false, message: `Erro ${r.status}: ${err.substring(0, 200)}` };
}

// Testers por chave — cada um faz 1 chamada barata pra validar
const TESTERS = {
  ANTHROPIC_API_KEY: async () => {
    return probeAnthropicModel('claude-haiku-4-5');
  },

  AI_MODEL: async () => {
    const m = process.env.AI_MODEL || 'claude-sonnet-4-6';
    const r = await probeAnthropicModel(m);
    if (r.ok) return { ok: true, message: `Modelo "${m}" disponível (Sonnet padrão pra respostas rápidas)` };
    return r;
  },

  AI_MODEL_STRONG: async () => {
    const m = process.env.AI_MODEL_STRONG || 'claude-opus-4-6';
    const r = await probeAnthropicModel(m);
    if (r.ok) return { ok: true, message: `Modelo "${m}" disponível (Opus pra raciocínio complexo)` };
    return r;
  },

  MEMORY_MODEL: async () => {
    const m = process.env.MEMORY_MODEL || 'claude-sonnet-4-5';
    const r = await probeAnthropicModel(m);
    if (r.ok) return { ok: true, message: `Modelo "${m}" disponível (extração de fatos e perfis)` };
    return r;
  },

  OPENAI_API_KEY: async () => {
    const k = process.env.OPENAI_API_KEY;
    if (!k) return { ok: false, message: 'Chave vazia' };
    const r = await fetchWithTimeout('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${k}` },
    });
    if (r.ok) {
      const data = await r.json();
      return { ok: true, message: `Chave válida — ${data.data?.length || 0} modelos disponíveis` };
    }
    if (r.status === 401) return { ok: false, message: 'Chave inválida (401 Unauthorized)' };
    return { ok: false, message: `Erro ${r.status}` };
  },

  ELEVENLABS_API_KEY: async () => {
    const k = process.env.ELEVENLABS_API_KEY;
    if (!k) return { ok: false, message: 'Chave vazia' };
    const r = await fetchWithTimeout('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': k },
    });
    if (r.ok) {
      const data = await r.json();
      const tier = data.subscription?.tier || 'desconhecido';
      const usage = data.subscription?.character_count || 0;
      const limit = data.subscription?.character_limit || 0;
      return { ok: true, message: `Tier: ${tier} — ${usage}/${limit} chars usados` };
    }
    if (r.status === 401) return { ok: false, message: 'Chave inválida (401 Unauthorized)' };
    return { ok: false, message: `Erro ${r.status}` };
  },

  ELEVENLABS_VOICE_ID: async () => {
    const id = process.env.ELEVENLABS_VOICE_ID;
    const k = process.env.ELEVENLABS_API_KEY;
    if (!id) return { ok: false, message: 'Voice ID vazio' };
    if (!k) return { ok: false, message: 'Precisa de ELEVENLABS_API_KEY pra testar' };
    const r = await fetchWithTimeout(`https://api.elevenlabs.io/v1/voices/${id}`, {
      headers: { 'xi-api-key': k },
    });
    if (r.ok) {
      const data = await r.json();
      return { ok: true, message: `Voz: ${data.name || id}` };
    }
    if (r.status === 404) return { ok: false, message: 'Voice ID não encontrado nesta conta' };
    return { ok: false, message: `Erro ${r.status}` };
  },

  ASANA_PAT: async () => {
    const k = process.env.ASANA_PAT;
    if (!k) return { ok: false, message: 'Token vazio' };
    const r = await fetchWithTimeout('https://app.asana.com/api/1.0/users/me', {
      headers: { 'Authorization': `Bearer ${k}` },
    });
    if (r.ok) {
      const data = await r.json();
      return { ok: true, message: `Conectado como: ${data.data?.name || data.data?.email || 'desconhecido'}` };
    }
    if (r.status === 401) return { ok: false, message: 'Token inválido ou expirado (401)' };
    return { ok: false, message: `Erro ${r.status}` };
  },

  ASANA_WORKSPACE: async () => {
    const ws = process.env.ASANA_WORKSPACE;
    const k = process.env.ASANA_PAT;
    if (!ws) return { ok: false, message: 'Workspace GID vazio' };
    if (!k) return { ok: false, message: 'Precisa de ASANA_PAT pra testar' };
    const r = await fetchWithTimeout(`https://app.asana.com/api/1.0/workspaces/${ws}`, {
      headers: { 'Authorization': `Bearer ${k}` },
    });
    if (r.ok) {
      const data = await r.json();
      return { ok: true, message: `Workspace: ${data.data?.name || ws}` };
    }
    if (r.status === 404) return { ok: false, message: 'Workspace não encontrado' };
    return { ok: false, message: `Erro ${r.status}` };
  },

  META_ACCESS_TOKEN: async () => {
    const k = process.env.META_ACCESS_TOKEN;
    if (!k) return { ok: false, message: 'Token vazio' };
    const v = process.env.META_API_VERSION || 'v25.0';
    const r = await fetchWithTimeout(`https://graph.facebook.com/${v}/me?access_token=${encodeURIComponent(k)}`);
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.id) {
      // Tenta descobrir se é System User Token (não expira) ou User Token
      const debug = await fetchWithTimeout(`https://graph.facebook.com/${v}/debug_token?input_token=${encodeURIComponent(k)}&access_token=${encodeURIComponent(k)}`);
      let tipo = 'desconhecido';
      let expira = null;
      if (debug.ok) {
        const d = await debug.json();
        tipo = d.data?.type || 'desconhecido';
        expira = d.data?.expires_at;
      }
      const expiraStr = expira === 0 ? 'NUNCA (System User)' : (expira ? new Date(expira * 1000).toLocaleString('pt-BR') : 'desconhecido');
      return { ok: true, message: `Conta: ${data.name || data.id} | Tipo: ${tipo} | Expira: ${expiraStr}` };
    }
    if (data.error) return { ok: false, message: `${data.error.message} (code ${data.error.code})` };
    return { ok: false, message: `Erro ${r.status}` };
  },

  META_AD_ACCOUNT_ID: async () => {
    const id = process.env.META_AD_ACCOUNT_ID;
    const k = process.env.META_ACCESS_TOKEN;
    if (!id) return { ok: false, message: 'Ad Account ID vazio' };
    if (!k) return { ok: false, message: 'Precisa de META_ACCESS_TOKEN pra testar' };
    const v = process.env.META_API_VERSION || 'v25.0';
    const cleanId = id.startsWith('act_') ? id : `act_${id}`;
    const r = await fetchWithTimeout(`https://graph.facebook.com/${v}/${cleanId}?fields=name,account_status,currency&access_token=${encodeURIComponent(k)}`);
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.name) {
      const status = data.account_status === 1 ? 'ATIVA' : 'INATIVA';
      return { ok: true, message: `Conta: ${data.name} | Status: ${status} | Moeda: ${data.currency}` };
    }
    return { ok: false, message: data.error?.message || `Erro ${r.status}` };
  },

  META_PAGE_ID: async () => {
    const id = process.env.META_PAGE_ID;
    const k = process.env.META_ACCESS_TOKEN;
    if (!id) return { ok: false, message: 'Page ID vazio' };
    if (!k) return { ok: false, message: 'Precisa de META_ACCESS_TOKEN pra testar' };
    const v = process.env.META_API_VERSION || 'v25.0';
    const r = await fetchWithTimeout(`https://graph.facebook.com/${v}/${id}?fields=name,fan_count&access_token=${encodeURIComponent(k)}`);
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.name) {
      return { ok: true, message: `Página: ${data.name}${data.fan_count ? ` (${data.fan_count} seguidores)` : ''}` };
    }
    return { ok: false, message: data.error?.message || `Erro ${r.status}` };
  },

  META_PIXEL_ID: async () => {
    const id = process.env.META_PIXEL_ID;
    const k = process.env.META_ACCESS_TOKEN;
    if (!id) return { ok: false, message: 'Pixel ID vazio' };
    if (!k) return { ok: false, message: 'Precisa de META_ACCESS_TOKEN pra testar' };
    const v = process.env.META_API_VERSION || 'v25.0';
    const r = await fetchWithTimeout(`https://graph.facebook.com/${v}/${id}?fields=name,is_active&access_token=${encodeURIComponent(k)}`);
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.name) {
      return { ok: true, message: `Pixel: ${data.name} | Ativo: ${data.is_active ? 'SIM' : 'NÃO'}` };
    }
    return { ok: false, message: data.error?.message || `Erro ${r.status}` };
  },

  IMAP_PASSWORD: async () => {
    const host = process.env.IMAP_HOST;
    const user = process.env.IMAP_USER;
    const pass = process.env.IMAP_PASSWORD;
    const port = parseInt(process.env.IMAP_PORT || '993');
    if (!host || !user || !pass) return { ok: false, message: 'IMAP_HOST/USER/PASSWORD precisam estar configurados' };
    try {
      const { ImapFlow } = await import('imapflow');
      const client = new ImapFlow({ host, port, secure: true, auth: { user, pass }, logger: false });
      await client.connect();
      await client.logout();
      return { ok: true, message: `Conectado em ${host} como ${user}` };
    } catch (e) {
      return { ok: false, message: `Falhou: ${e.message}` };
    }
  },

  EMAIL_PASSWORD: async () => {
    const host = process.env.EMAIL_IMAP_HOST;
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASSWORD;
    const port = parseInt(process.env.EMAIL_IMAP_PORT || '993');
    if (!host || !user || !pass) return { ok: false, message: 'EMAIL_IMAP_HOST/USER/PASSWORD precisam estar configurados' };
    try {
      const { ImapFlow } = await import('imapflow');
      const client = new ImapFlow({ host, port, secure: true, auth: { user, pass }, logger: false });
      await client.connect();
      await client.logout();
      return { ok: true, message: `Conectado em ${host} como ${user}` };
    } catch (e) {
      return { ok: false, message: `Falhou: ${e.message}` };
    }
  },

  // Validação de formato (sem chamar API externa)
  GROUP_TAREFAS: async () => {
    const v = process.env.GROUP_TAREFAS;
    if (!v) return { ok: false, message: 'JID vazio' };
    if (!/@g\.us$/.test(v)) return { ok: false, message: 'Formato inválido — deve terminar em @g.us' };
    return { ok: true, message: 'Formato válido (@g.us)' };
  },
  GROUP_GALAXIAS: async () => {
    const v = process.env.GROUP_GALAXIAS;
    if (!v) return { ok: false, message: 'JID vazio' };
    if (!/@g\.us$/.test(v)) return { ok: false, message: 'Formato inválido — deve terminar em @g.us' };
    return { ok: true, message: 'Formato válido (@g.us)' };
  },
  GUI_JID: async () => {
    const v = process.env.GUI_JID;
    if (!v) return { ok: false, message: 'JID vazio' };
    if (!/@s\.whatsapp\.net$/.test(v)) return { ok: false, message: 'Formato inválido — deve terminar em @s.whatsapp.net' };
    return { ok: true, message: 'Formato válido (@s.whatsapp.net)' };
  },
};

export const TESTABLE_KEYS = Object.keys(TESTERS);

export async function testKey(keyName) {
  if (!KEY_NAMES.includes(keyName)) throw new Error(`Chave "${keyName}" não está na whitelist`);
  if (!TESTERS[keyName]) {
    return { ok: null, message: 'Chave configurável mas sem teste de conectividade implementado', untestable: true };
  }
  const start = Date.now();
  try {
    const result = await TESTERS[keyName]();
    return { ...result, latency_ms: Date.now() - start, tested_at: new Date().toISOString() };
  } catch (e) {
    return { ok: false, message: `Erro inesperado: ${e.message}`, latency_ms: Date.now() - start, tested_at: new Date().toISOString() };
  }
}

// Para testes
export const _internal = { encrypt, decrypt };
