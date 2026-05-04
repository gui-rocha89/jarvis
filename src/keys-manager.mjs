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

export const MANAGEABLE_KEYS = [
  // ==== IA ====
  { key: 'ANTHROPIC_API_KEY', group: 'IA', label: 'Claude API Key', sensitive: true, hint: 'sk-ant-api03-...' },
  { key: 'OPENAI_API_KEY', group: 'IA', label: 'OpenAI API Key (Whisper + TTS + Embeddings)', sensitive: true, hint: 'sk-...' },
  { key: 'ELEVENLABS_API_KEY', group: 'IA', label: 'ElevenLabs API Key (TTS primário)', sensitive: true },
  { key: 'ELEVENLABS_VOICE_ID', group: 'IA', label: 'ElevenLabs Voice ID', sensitive: false },
  { key: 'AI_MODEL', group: 'IA', label: 'Modelo padrão (Sonnet)', sensitive: false, hint: 'claude-sonnet-4-6' },
  { key: 'AI_MODEL_STRONG', group: 'IA', label: 'Modelo forte (Opus)', sensitive: false, hint: 'claude-opus-4-6' },
  { key: 'MEMORY_MODEL', group: 'IA', label: 'Modelo de memória/perfis', sensitive: false, hint: 'claude-sonnet-4-5' },

  // ==== Asana ====
  { key: 'ASANA_PAT', group: 'Asana', label: 'Asana Personal Access Token', sensitive: true, hint: '2/12...' },
  { key: 'ASANA_WORKSPACE', group: 'Asana', label: 'Asana Workspace GID', sensitive: false },

  // ==== Meta Ads ====
  { key: 'META_APP_ID', group: 'Meta Ads', label: 'Meta App ID', sensitive: false },
  { key: 'META_APP_SECRET', group: 'Meta Ads', label: 'Meta App Secret', sensitive: true },
  { key: 'META_ACCESS_TOKEN', group: 'Meta Ads', label: 'Meta Access Token (System User recomendado)', sensitive: true, hint: 'EAA...' },
  { key: 'META_AD_ACCOUNT_ID', group: 'Meta Ads', label: 'Ad Account ID', sensitive: false, hint: 'act_123...' },
  { key: 'META_PAGE_ID', group: 'Meta Ads', label: 'Page ID padrão', sensitive: false },
  { key: 'META_PIXEL_ID', group: 'Meta Ads', label: 'Pixel ID', sensitive: false },
  { key: 'META_API_VERSION', group: 'Meta Ads', label: 'Versão da Graph API', sensitive: false, hint: 'v25.0' },

  // ==== Email Asana (monitor de @menções) ====
  { key: 'IMAP_HOST', group: 'Email Asana', label: 'IMAP Host', sensitive: false, hint: 'imap.gmail.com' },
  { key: 'IMAP_USER', group: 'Email Asana', label: 'IMAP User', sensitive: false },
  { key: 'IMAP_PASSWORD', group: 'Email Asana', label: 'IMAP Password (App Password)', sensitive: true },

  // ==== Email Genérico (canal de leads) ====
  { key: 'EMAIL_IMAP_HOST', group: 'Email Lab', label: 'IMAP Host', sensitive: false },
  { key: 'EMAIL_IMAP_PORT', group: 'Email Lab', label: 'IMAP Port', sensitive: false, hint: '993' },
  { key: 'EMAIL_SMTP_HOST', group: 'Email Lab', label: 'SMTP Host', sensitive: false },
  { key: 'EMAIL_SMTP_PORT', group: 'Email Lab', label: 'SMTP Port', sensitive: false, hint: '587' },
  { key: 'EMAIL_USER', group: 'Email Lab', label: 'Email do Lab', sensitive: false },
  { key: 'EMAIL_PASSWORD', group: 'Email Lab', label: 'Email Password', sensitive: true },

  // ==== Instagram DM ====
  { key: 'INSTAGRAM_VERIFY_TOKEN', group: 'Instagram', label: 'Webhook Verify Token', sensitive: true },

  // ==== WhatsApp / Identidade ====
  { key: 'GROUP_TAREFAS', group: 'WhatsApp', label: 'JID grupo Tarefas', sensitive: false, hint: '...@g.us' },
  { key: 'GROUP_GALAXIAS', group: 'WhatsApp', label: 'JID grupo Galáxias', sensitive: false, hint: '...@g.us' },
  { key: 'GUI_JID', group: 'WhatsApp', label: 'JID do Gui (DM direto)', sensitive: false, hint: '...@s.whatsapp.net' },

  // ==== Google Calendar ====
  { key: 'GCAL_CALENDAR_ID', group: 'Google Calendar', label: 'Calendar ID', sensitive: false, hint: 'email@group.calendar.google.com' },
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

// Para testes
export const _internal = { encrypt, decrypt };
