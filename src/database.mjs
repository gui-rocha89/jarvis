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

    // Índices para performance de busca de mensagens
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON jarvis_messages(chat_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_created_at ON jarvis_messages(created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON jarvis_messages(timestamp)`);

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

    // Tabela de conversas públicas (leads/desconhecidos no DM)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public_conversations (
        id SERIAL PRIMARY KEY,
        jid TEXT UNIQUE NOT NULL,
        name TEXT,
        status TEXT DEFAULT 'active',
        messages_count INTEGER DEFAULT 0,
        first_message_at TIMESTAMPTZ DEFAULT NOW(),
        last_message_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Tabela de log de emails (canal email genérico)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_log (
        id SERIAL PRIMARY KEY,
        from_address TEXT,
        subject TEXT,
        body_preview TEXT,
        classification TEXT DEFAULT 'normal',
        processed BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Tabela de log de cobranças (escalação)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cobranca_log (
        id SERIAL PRIMARY KEY,
        task_gid TEXT NOT NULL,
        cobranca_count INTEGER DEFAULT 1,
        last_cobrada_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(task_gid)
      )
    `);

    // ============================================
    // v6.0 — KNOWLEDGE GRAPH (entidades estruturadas)
    // Resolve: Jarvis tem 362k memórias mas não sabe O QUE é cada coisa
    // ============================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS knowledge_entities (
        id SERIAL PRIMARY KEY,
        nome TEXT NOT NULL,
        tipo TEXT NOT NULL,
        descricao TEXT,
        aliases TEXT[] DEFAULT ARRAY[]::TEXT[],
        status TEXT DEFAULT 'ativo',
        metadata JSONB DEFAULT '{}',
        source TEXT DEFAULT 'manual',
        criado_em TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ DEFAULT NOW(),
        deprecated_em TIMESTAMPTZ,
        deprecated_motivo TEXT,
        UNIQUE(nome, tipo)
      )
    `);
    // Índices: nome (lookup direto), aliases (busca por sinônimo), tipo
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_nome_lower ON knowledge_entities(LOWER(nome))`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_tipo ON knowledge_entities(tipo)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_aliases ON knowledge_entities USING GIN(aliases)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_status ON knowledge_entities(status) WHERE status = 'ativo'`);

    // Trigram pra fuzzy search (extensão opcional)
    try {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_nome_trgm ON knowledge_entities USING GIN(nome gin_trgm_ops)`);
    } catch (e) { console.log('[DB] pg_trgm extension skipped:', e.message); }

    // Tabela de "menções" — quando entity X é citada em alguma memória/mensagem
    // Permite query reversa: "tudo que foi mencionado sobre Stream Health"
    await pool.query(`
      CREATE TABLE IF NOT EXISTS entity_mentions (
        id SERIAL PRIMARY KEY,
        entity_id INTEGER REFERENCES knowledge_entities(id) ON DELETE CASCADE,
        memory_id INTEGER,
        message_id TEXT,
        contexto TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mentions_entity ON entity_mentions(entity_id, created_at DESC)`);

    // Migração: adicionar coluna message_key se não existe
    await pool.query(`
      ALTER TABLE jarvis_messages ADD COLUMN IF NOT EXISTS message_key JSONB
    `).catch(() => {});

    // Migração: corrigir memórias classificadas incorretamente como team_member
    // Apenas membros reais da equipe (Gui, Nicolas, Arthur, Bruno, Bruna, Rigon, Jarvis)
    // devem ter categoria team_member. Todos os outros são client_profile.
    try {
      const result = await pool.query(`
        UPDATE jarvis_memories
        SET category = 'client_profile'
        WHERE category = 'team_member'
          AND content NOT ILIKE '%Gui%'
          AND content NOT ILIKE '%Guilherme%'
          AND content NOT ILIKE '%Nicolas%'
          AND content NOT ILIKE '%Arthur%'
          AND content NOT ILIKE '%Bruno%'
          AND content NOT ILIKE '%Bruna%'
          AND content NOT ILIKE '%Rigon%'
          AND content NOT ILIKE '%Jarvis%'
      `);
      if (result.rowCount > 0) {
        console.log(`[DB] Migração: ${result.rowCount} memórias reclassificadas de team_member para client_profile`);
      }
    } catch (err) {
      // Tabela pode não existir ainda na primeira inicialização
      console.log('[DB] Migração team_member skipped:', err.message);
    }

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

export async function searchRecentMessagesByKeyword(keywords, hoursBack = 24, limit = 20) {
  if (!keywords || keywords.length === 0) return [];
  try {
    const patterns = keywords.filter(Boolean).map(k => `%${k}%`);
    if (patterns.length === 0) return [];
    const result = await pool.query(
      `SELECT push_name, text, chat_id, timestamp, created_at AT TIME ZONE 'America/Sao_Paulo' as hora_br
       FROM jarvis_messages
       WHERE text ILIKE ANY($1)
         AND created_at >= NOW() - INTERVAL '${parseInt(hoursBack)} hours'
         AND text IS NOT NULL AND text != ''
       ORDER BY timestamp DESC LIMIT $2`,
      [patterns, limit]
    );
    return result.rows;
  } catch (err) {
    console.error('[DB] Erro ao buscar mensagens por keyword:', err.message);
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

// --- CRUD de Conversas Públicas (leads) ---
export async function upsertPublicConversation(jid, name) {
  try {
    await pool.query(
      `INSERT INTO public_conversations (jid, name, messages_count, first_message_at, last_message_at)
       VALUES ($1, $2, 1, NOW(), NOW())
       ON CONFLICT (jid) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, public_conversations.name),
         messages_count = public_conversations.messages_count + 1,
         last_message_at = NOW()`,
      [jid, name || null]
    );
  } catch (err) {
    console.error('[DB] Erro upsertPublicConversation:', err.message);
  }
}

export async function getPublicConversation(jid) {
  try {
    const result = await pool.query('SELECT * FROM public_conversations WHERE jid = $1', [jid]);
    return result.rows[0] || null;
  } catch { return null; }
}

export async function incrementPublicMessages(jid) {
  try {
    await pool.query(
      `UPDATE public_conversations SET messages_count = messages_count + 1, last_message_at = NOW() WHERE jid = $1`,
      [jid]
    );
  } catch {}
}

// --- CRUD de Log de Cobranças (escalação) ---
export async function getCobrancaLog(taskGid) {
  try {
    const result = await pool.query('SELECT * FROM cobranca_log WHERE task_gid = $1', [taskGid]);
    return result.rows[0] || null;
  } catch { return null; }
}

export async function upsertCobrancaLog(taskGid) {
  try {
    await pool.query(
      `INSERT INTO cobranca_log (task_gid, cobranca_count, last_cobrada_at)
       VALUES ($1, 1, NOW())
       ON CONFLICT (task_gid) DO UPDATE SET
         cobranca_count = cobranca_log.cobranca_count + 1,
         last_cobrada_at = NOW()`,
      [taskGid]
    );
  } catch (err) {
    console.error('[DB] Erro upsertCobrancaLog:', err.message);
  }
}

export async function resetCobrancaLog(taskGid) {
  try {
    await pool.query('DELETE FROM cobranca_log WHERE task_gid = $1', [taskGid]);
  } catch {}
}

// ============================================================
// KNOWLEDGE GRAPH (v6.0) — entidades estruturadas
// Tipos válidos: cliente, sub_marca, projeto, ferramenta_interna,
//                evento, campanha, processo, decisao, pessoa_externa, pessoa_equipe
// ============================================================
export const KG_VALID_TYPES = [
  'cliente', 'sub_marca', 'projeto', 'ferramenta_interna',
  'evento', 'campanha', 'processo', 'decisao',
  'pessoa_externa', 'pessoa_equipe',
];

/**
 * Cria ou atualiza uma entity. Match por nome+tipo (case-insensitive).
 * Mescla aliases (não duplica).
 */
export async function upsertEntity({ nome, tipo, descricao = null, aliases = [], metadata = {}, source = 'manual', status = 'ativo' }) {
  if (!nome || !tipo) throw new Error('nome e tipo são obrigatórios');
  if (!KG_VALID_TYPES.includes(tipo)) throw new Error(`tipo inválido: ${tipo}. Válidos: ${KG_VALID_TYPES.join(', ')}`);

  // Normaliza aliases (remove duplicatas e o próprio nome)
  const cleanAliases = [...new Set(aliases.filter(a => a && a.toLowerCase() !== nome.toLowerCase()))];

  try {
    const { rows } = await pool.query(`
      INSERT INTO knowledge_entities (nome, tipo, descricao, aliases, metadata, source, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (nome, tipo) DO UPDATE SET
        descricao = COALESCE(EXCLUDED.descricao, knowledge_entities.descricao),
        aliases = ARRAY(SELECT DISTINCT unnest(knowledge_entities.aliases || EXCLUDED.aliases)),
        metadata = knowledge_entities.metadata || EXCLUDED.metadata,
        atualizado_em = NOW()
      RETURNING *
    `, [nome, tipo, descricao, cleanAliases, JSON.stringify(metadata), source, status]);
    return rows[0];
  } catch (err) {
    console.error('[KG] Erro upsertEntity:', err.message);
    throw err;
  }
}

/**
 * Busca entity por termo (exato, alias, ou fuzzy via trigram).
 * Retorna a melhor correspondência ou null.
 */
export async function findEntity(query, { tipo = null, limit = 5 } = {}) {
  if (!query) return null;
  const q = query.trim();
  const tipoFilter = tipo ? 'AND tipo = $2' : '';
  const params = tipo ? [q, tipo] : [q];

  try {
    // 1. Match exato no nome
    const exact = await pool.query(
      `SELECT * FROM knowledge_entities WHERE LOWER(nome) = LOWER($1) ${tipoFilter} AND status = 'ativo' LIMIT 1`,
      params
    );
    if (exact.rows[0]) return exact.rows[0];

    // 2. Match em aliases
    const alias = await pool.query(
      `SELECT * FROM knowledge_entities
       WHERE EXISTS (SELECT 1 FROM unnest(aliases) a WHERE LOWER(a) = LOWER($1))
       ${tipoFilter} AND status = 'ativo' LIMIT 1`,
      params
    );
    if (alias.rows[0]) return alias.rows[0];

    // 3. Match parcial (LIKE) no nome ou aliases
    const partial = await pool.query(
      `SELECT * FROM knowledge_entities
       WHERE (nome ILIKE '%' || $1 || '%'
              OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE a ILIKE '%' || $1 || '%'))
       ${tipoFilter} AND status = 'ativo' LIMIT 1`,
      params
    );
    if (partial.rows[0]) return partial.rows[0];

    return null;
  } catch (err) {
    console.error('[KG] Erro findEntity:', err.message);
    return null;
  }
}

/**
 * Busca múltiplas entities — útil pra dashboard listar/filtrar.
 */
export async function searchEntities(query = '', { tipo = null, limit = 20 } = {}) {
  try {
    let sql = `SELECT * FROM knowledge_entities WHERE status = 'ativo'`;
    const params = [];
    if (query) {
      params.push(query);
      sql += ` AND (nome ILIKE '%' || $${params.length} || '%'
                   OR descricao ILIKE '%' || $${params.length} || '%'
                   OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE a ILIKE '%' || $${params.length} || '%'))`;
    }
    if (tipo) {
      params.push(tipo);
      sql += ` AND tipo = $${params.length}`;
    }
    params.push(limit);
    sql += ` ORDER BY atualizado_em DESC LIMIT $${params.length}`;
    const { rows } = await pool.query(sql, params);
    return rows;
  } catch (err) {
    console.error('[KG] Erro searchEntities:', err.message);
    return [];
  }
}

export async function listEntitiesByType(tipo, limit = 100) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM knowledge_entities WHERE tipo = $1 AND status = 'ativo' ORDER BY nome LIMIT $2`,
      [tipo, limit]
    );
    return rows;
  } catch { return []; }
}

export async function getEntityStats() {
  try {
    const { rows } = await pool.query(`
      SELECT tipo, COUNT(*)::int as total, COUNT(*) FILTER (WHERE deprecated_em IS NULL)::int as ativos
      FROM knowledge_entities GROUP BY tipo ORDER BY total DESC
    `);
    return rows;
  } catch { return []; }
}

export async function deprecateEntity(id, motivo = null) {
  try {
    await pool.query(
      `UPDATE knowledge_entities SET status = 'deprecated', deprecated_em = NOW(), deprecated_motivo = $2 WHERE id = $1`,
      [id, motivo]
    );
    return true;
  } catch { return false; }
}

/**
 * Detecta entities mencionadas num texto e busca cada uma.
 * Retorna array de entities encontradas (sem duplicar).
 */
export async function detectEntitiesInText(text) {
  if (!text || text.length < 3) return [];
  try {
    // Busca por TODAS entities ativas e checa quais estão no texto
    const { rows } = await pool.query(
      `SELECT id, nome, tipo, descricao, aliases FROM knowledge_entities WHERE status = 'ativo'`
    );
    const lower = text.toLowerCase();
    const found = [];
    for (const e of rows) {
      const candidates = [e.nome, ...(e.aliases || [])];
      for (const c of candidates) {
        if (!c || c.length < 3) continue;
        // Match por palavra inteira (evita falsos positivos)
        const regex = new RegExp(`\\b${c.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i');
        if (regex.test(text)) {
          found.push(e);
          break;
        }
      }
    }
    return found;
  } catch (err) {
    console.error('[KG] Erro detectEntitiesInText:', err.message);
    return [];
  }
}

/**
 * Registra que entity foi mencionada (pra rastrear engajamento)
 */
export async function logEntityMention({ entityId, memoryId = null, messageId = null, contexto = null }) {
  try {
    await pool.query(
      `INSERT INTO entity_mentions (entity_id, memory_id, message_id, contexto) VALUES ($1, $2, $3, $4)`,
      [entityId, memoryId, messageId, contexto?.substring(0, 500)]
    );
  } catch {}
}
