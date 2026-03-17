// ============================================
// JARVIS 3.0 - Banco de Dados (PostgreSQL)
// ============================================
import pg from 'pg';

export const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'jarvis',
  user: process.env.DB_USER || 'jarvis',
  password: process.env.DB_PASSWORD || '',
});

export async function initDB() {
  try {
    await pool.query('SELECT 1');
    console.log('[DB] Conectado ao PostgreSQL');

    // Criar tabelas do Jarvis se não existirem
    await pool.query(`
      CREATE TABLE IF NOT EXISTS jarvis_messages (
        id SERIAL PRIMARY KEY,
        message_id TEXT UNIQUE,
        chat_id TEXT,
        sender TEXT,
        push_name TEXT,
        text TEXT,
        is_group BOOLEAN DEFAULT false,
        is_audio BOOLEAN DEFAULT false,
        timestamp BIGINT DEFAULT 0,
        media_type TEXT,
        transcription TEXT,
        message_key JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS jarvis_contacts (
        jid TEXT PRIMARY KEY,
        push_name TEXT,
        role TEXT DEFAULT 'unknown',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS jarvis_groups (
        jid TEXT PRIMARY KEY,
        name TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS jarvis_config (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS homework (
        id SERIAL PRIMARY KEY,
        type TEXT DEFAULT 'learning',
        content TEXT NOT NULL,
        source TEXT DEFAULT 'dashboard',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS gcal_sync (
        asana_gid TEXT PRIMARY KEY,
        gcal_event_id TEXT,
        task_name TEXT,
        event_date TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS group_events (
        id SERIAL PRIMARY KEY,
        group_jid TEXT NOT NULL,
        group_name TEXT,
        participant_jid TEXT NOT NULL,
        participant_name TEXT,
        action TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // --- Tabelas de segurança do Dashboard ---
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dashboard_users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        phone_2fa TEXT NOT NULL,
        is_active BOOLEAN DEFAULT true,
        failed_attempts INTEGER DEFAULT 0,
        locked_until TIMESTAMPTZ DEFAULT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS dashboard_access_log (
        id SERIAL PRIMARY KEY,
        email TEXT,
        ip TEXT NOT NULL,
        user_agent TEXT,
        action TEXT NOT NULL,
        success BOOLEAN DEFAULT false,
        city TEXT,
        region TEXT,
        country TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS dashboard_2fa_codes (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        code TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Dispositivos confiáveis (pula 2FA)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dashboard_trusted_devices (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        device_token TEXT UNIQUE NOT NULL,
        ip TEXT,
        user_agent TEXT,
        label TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Tabela de perfis sintetizados (clientes, equipe, processos)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS jarvis_profiles (
        id SERIAL PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        entity_name TEXT,
        profile JSONB DEFAULT '{}',
        last_updated TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(entity_type, entity_id)
      )
    `);

    // Tabela de controle do estudo exaustivo do Asana
    await pool.query(`
      CREATE TABLE IF NOT EXISTS asana_study_log (
        id SERIAL PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_gid TEXT NOT NULL,
        project_name TEXT,
        processed BOOLEAN DEFAULT false,
        facts_extracted INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(entity_type, entity_gid)
      )
    `);

    // Migração: adicionar coluna message_key se não existe
    await pool.query(`
      ALTER TABLE jarvis_messages ADD COLUMN IF NOT EXISTS message_key JSONB
    `).catch(() => {});

    console.log('[DB] Tabelas verificadas/criadas');
  } catch (err) {
    console.error('[DB] Erro ao conectar:', err.message);
    process.exit(1);
  }
}

// --- CRUD de Mensagens ---
export async function storeMessage(data) {
  if (typeof data.timestamp === 'object' && data.timestamp?.low !== undefined) {
    data.timestamp = data.timestamp.low;
  } else {
    data.timestamp = Number(data.timestamp) || 0;
  }
  try {
    await pool.query(
      `INSERT INTO jarvis_messages (message_id, chat_id, sender, push_name, text, is_group, is_audio, timestamp, media_type, transcription, message_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (message_id) DO UPDATE SET
         transcription = COALESCE(EXCLUDED.transcription, jarvis_messages.transcription),
         media_type = COALESCE(EXCLUDED.media_type, jarvis_messages.media_type),
         sender = CASE
           WHEN EXCLUDED.sender != EXCLUDED.chat_id AND jarvis_messages.sender = jarvis_messages.chat_id
           THEN EXCLUDED.sender ELSE jarvis_messages.sender END,
         push_name = CASE
           WHEN EXCLUDED.push_name IS NOT NULL AND EXCLUDED.push_name != '' AND (jarvis_messages.push_name IS NULL OR jarvis_messages.push_name = '')
           THEN EXCLUDED.push_name ELSE jarvis_messages.push_name END`,
      [data.messageId, data.chatId, data.sender, data.pushName, data.text, data.isGroup, data.isAudio, data.timestamp, data.mediaType || null, data.transcription || null, data.messageKey || null]
    );
  } catch (err) {
    console.error('[DB] Erro ao salvar mensagem:', err.message);
  }
}

export async function getRecentMessages(chatId, limit = 30) {
  try {
    const result = await pool.query(
      `SELECT message_id, push_name, sender, text, is_audio, timestamp, message_key,
              created_at AT TIME ZONE 'America/Sao_Paulo' as hora_br
       FROM jarvis_messages
       WHERE chat_id = $1 AND text IS NOT NULL AND text != ''
       ORDER BY timestamp DESC LIMIT $2`,
      [chatId, limit]
    );
    return result.rows.reverse();
  } catch (err) {
    console.error('[DB] Erro ao buscar mensagens:', err.message);
    return [];
  }
}

export async function getContactInfo(jid) {
  try {
    const result = await pool.query('SELECT * FROM jarvis_contacts WHERE jid = $1', [jid]);
    return result.rows[0] || null;
  } catch { return null; }
}

export async function getGroupInfo(jid) {
  try {
    const result = await pool.query('SELECT * FROM jarvis_groups WHERE jid = $1', [jid]);
    return result.rows[0] || null;
  } catch { return null; }
}

export async function upsertContact(jid, pushName) {
  if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid === 'jarvis@bot') return;
  if (!pushName || pushName.trim() === '') return;
  try {
    await pool.query(
      `INSERT INTO jarvis_contacts (jid, push_name, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (jid) DO UPDATE SET push_name = COALESCE(EXCLUDED.push_name, jarvis_contacts.push_name), updated_at = NOW()`,
      [jid, pushName]
    );
  } catch {}
}

export async function upsertGroup(jid, name) {
  try {
    await pool.query(
      `INSERT INTO jarvis_groups (jid, name, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (jid) DO UPDATE SET name = COALESCE(EXCLUDED.name, jarvis_groups.name), updated_at = NOW()`,
      [jid, name]
    );
  } catch {}
}

export async function getMessageCount() {
  try {
    const result = await pool.query('SELECT COUNT(*) as count FROM jarvis_messages');
    return parseInt(result.rows[0].count);
  } catch { return 0; }
}
