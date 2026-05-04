// ============================================
// JARVIS 3.0 - Síntese de Perfis de Entidades
// Gera perfis estruturados a partir de memórias
// ============================================
import Anthropic from '@anthropic-ai/sdk';
import { pool } from './database.mjs';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });
// Default = Sonnet 4.5 (melhor classificação de contexto). MEMORY_MODEL no .env sobrescreve.
const PROFILE_MODEL = process.env.MEMORY_MODEL || 'claude-sonnet-4-5';

/**
 * Sintetiza um perfil a partir das memórias de uma entidade
 */
export async function synthesizeProfile(entityType, entityId, entityName = null) {
  try {
    // Buscar memórias relacionadas
    let memories = [];

    if (entityType === 'client_contact') {
      // Contato de cliente — buscar memórias da pessoa + memórias do grupo de cliente
      const { rows } = await pool.query(
        `SELECT content, category, importance FROM jarvis_memories
         WHERE (scope = 'user' AND scope_id = $1)
            OR (content ILIKE '%' || $2 || '%' AND category IN ('client', 'client_profile', 'decision', 'preference', 'style'))
         ORDER BY importance DESC, updated_at DESC LIMIT 50`,
        [entityId, entityName || entityId]
      );
      memories = rows;
    } else if (entityType === 'client' || entityType === 'group') {
      // Buscar memórias do escopo chat (grupo do cliente)
      const { rows } = await pool.query(
        `SELECT content, category, importance FROM jarvis_memories
         WHERE (scope = 'chat' AND scope_id = $1)
            OR (content ILIKE '%' || $2 || '%' AND category IN ('client', 'client_profile', 'decision', 'preference', 'style'))
         ORDER BY importance DESC, updated_at DESC LIMIT 50`,
        [entityId, entityName || entityId]
      );
      memories = rows;
    } else if (entityType === 'team_member') {
      // Buscar memórias sobre o membro da equipe
      const { rows } = await pool.query(
        `SELECT content, category, importance FROM jarvis_memories
         WHERE (scope = 'user' AND scope_id = $1)
            OR (content ILIKE '%' || $2 || '%' AND category IN ('team_member', 'style', 'preference', 'pattern'))
         ORDER BY importance DESC, updated_at DESC LIMIT 50`,
        [entityId, entityName || entityId]
      );
      memories = rows;
    } else if (entityType === 'process') {
      const { rows } = await pool.query(
        `SELECT content, category, importance FROM jarvis_memories
         WHERE category IN ('process', 'rule', 'pattern')
         ORDER BY importance DESC, updated_at DESC LIMIT 50`
      );
      memories = rows;
    }

    if (memories.length < 3) {
      console.log(`[PROFILES] Poucas memórias para ${entityType}:${entityName || entityId} (${memories.length})`);
      return null;
    }

    const memoriesText = memories.map(m => `[${m.category}] ${m.content}`).join('\n');

    const prompts = {
      client_contact: `Analise as memorias abaixo sobre um CONTATO DE CLIENTE (pessoa de fora que é cliente da Stream Lab) e sintetize um perfil JSON:
{
  "nome": "nome da pessoa",
  "empresa": "empresa/marca que representa",
  "cargo_funcao": "cargo ou funcao na empresa do cliente",
  "como_se_comunica": "estilo de comunicacao (direto, detalhista, informal, etc)",
  "demandas_frequentes": ["tipos de pedidos que costuma fazer"],
  "preferencias": "preferencias de conteudo, formato, tom",
  "pontos_atencao": "coisas que irritam, exigencias, cuidados",
  "horario_ativo": "quando costuma mandar mensagens",
  "observacoes": "outras observacoes importantes"
}
IMPORTANTE: Esta pessoa NAO é da equipe Stream Lab. É um CLIENTE externo.`,
      client: `Analise as memorias abaixo sobre um cliente/grupo e sintetize um perfil JSON:
{
  "nome": "nome do cliente/empresa",
  "decisor": "quem toma decisoes (nome e cargo)",
  "tom_marca": "como a marca se comunica",
  "conteudo_preferido": "tipos de conteudo que preferem",
  "horario_ativo": "horarios de maior atividade",
  "pontos_atencao": "coisas que irritam ou que devemos evitar",
  "observacoes": "outras observacoes importantes"
}`,
      group: `Analise as memorias abaixo sobre um grupo de trabalho e sintetize um perfil JSON:
{
  "nome": "nome do grupo",
  "tipo": "cliente|interno|projeto",
  "participantes_chave": ["nomes dos principais participantes"],
  "assuntos_frequentes": ["temas mais discutidos"],
  "tom_comunicacao": "como o grupo se comunica",
  "observacoes": "outras observacoes importantes"
}`,
      team_member: `Analise as memorias abaixo sobre um membro da equipe e sintetize um perfil JSON:
{
  "nome": "nome da pessoa",
  "cargo_funcao": "o que faz no Lab",
  "habilidades": ["lista de habilidades"],
  "pontos_fortes": "no que se destaca",
  "estilo_trabalho": "como trabalha (rapido, detalhista, etc)",
  "horario_ativo": "quando costuma estar mais ativo",
  "observacoes": "outras observacoes importantes"
}`,
      process: `Analise as memorias abaixo sobre processos do Lab e sintetize um perfil JSON:
{
  "nome": "nome do processo/fluxo",
  "etapas": ["lista de etapas"],
  "responsaveis": ["quem participa"],
  "tempo_medio": "quanto tempo leva",
  "regras": ["regras importantes"],
  "observacoes": "outras observacoes"
}`
    };

    const response = await anthropic.messages.create({
      model: PROFILE_MODEL,
      max_tokens: 500,
      system: `Voce sintetiza perfis a partir de memorias da Stream Lab (laboratorio criativo de marketing).
Responda APENAS com o JSON, sem texto adicional. Se nao tiver informacao suficiente para um campo, use null.
${prompts[entityType] || prompts.client}`,
      messages: [{ role: 'user', content: `Nome da entidade: ${entityName || entityId}\n\nMemórias:\n${memoriesText}` }],
    });

    const raw = response.content[0]?.text || '{}';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const profile = JSON.parse(match[0]);

    // Upsert no banco
    await pool.query(`
      INSERT INTO jarvis_profiles (entity_type, entity_id, entity_name, profile, last_updated)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (entity_type, entity_id)
      DO UPDATE SET profile = $4, entity_name = COALESCE($3, jarvis_profiles.entity_name), last_updated = NOW()
    `, [entityType, entityId, entityName, JSON.stringify(profile)]);

    console.log(`[PROFILES] Perfil sintetizado: ${entityType}:${entityName || entityId}`);
    return profile;
  } catch (err) {
    console.error(`[PROFILES] Erro ao sintetizar ${entityType}:${entityId}:`, err.message);
    return null;
  }
}

// ============================================
// v6.0 Sprint 3 — PROFILE REAL-TIME
// ============================================
// Resolve: profiles eram sintetizados a cada 6h (cron), causando defasagem.
// Agora atualizam em background ao final de cada processMemory().
// Cache 30min evita custo desnecessário.
// ============================================

const _profileCache = new Map(); // key: "type:id", value: { profile, at }
const PROFILE_CACHE_TTL = 30 * 60 * 1000; // 30 min

/**
 * Wrapper com cache pra synthesizeProfile.
 * Se cache hit (< 30min), retorna sem rodar IA.
 * Se miss, sintetiza e guarda.
 */
export async function synthesizeProfileCached(entityType, entityId, entityName = null) {
  const key = `${entityType}:${entityId}`;
  const cached = _profileCache.get(key);
  if (cached && Date.now() - cached.at < PROFILE_CACHE_TTL) {
    return cached.profile;
  }
  const profile = await synthesizeProfile(entityType, entityId, entityName);
  if (profile) {
    _profileCache.set(key, { profile, at: Date.now() });
    // Limpa cache antigo periodicamente (max 200 entries)
    if (_profileCache.size > 200) {
      const entries = [..._profileCache.entries()].sort((a, b) => a[1].at - b[1].at);
      for (let i = 0; i < 50; i++) _profileCache.delete(entries[i][0]);
    }
  }
  return profile;
}

/**
 * Invalida cache de uma entity (use quando souber que dado mudou)
 */
export function invalidateProfileCache(entityType, entityId) {
  if (!entityType || !entityId) {
    _profileCache.clear();
    return;
  }
  _profileCache.delete(`${entityType}:${entityId}`);
}

/**
 * Stats do cache (pra dashboard /health)
 */
export function getProfileCacheStats() {
  const now = Date.now();
  let valid = 0, expired = 0;
  for (const v of _profileCache.values()) {
    if (now - v.at < PROFILE_CACHE_TTL) valid++;
    else expired++;
  }
  return { total: _profileCache.size, valid, expired };
}

/**
 * Busca perfil de uma entidade
 */
export async function getProfile(entityType, entityId) {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM jarvis_profiles WHERE entity_type = $1 AND entity_id = $2',
      [entityType, entityId]
    );
    return rows[0] || null;
  } catch { return null; }
}

/**
 * Lista todos os perfis de um tipo
 */
export async function listProfiles(entityType = null) {
  try {
    let sql = 'SELECT * FROM jarvis_profiles';
    const params = [];
    if (entityType) { sql += ' WHERE entity_type = $1'; params.push(entityType); }
    sql += ' ORDER BY last_updated DESC';
    const { rows } = await pool.query(sql, params);
    return rows;
  } catch { return []; }
}

/**
 * Determina se um JID pertence a um contato de cliente (não da equipe)
 * Cruza dados: em quais grupos essa pessoa fala? se fala em grupo de cliente → é contato de cliente
 */
async function isClientContact(userScopeId) {
  try {
    // Buscar mensagens desse usuário e ver em quais grupos ele aparece
    const { rows } = await pool.query(
      `SELECT DISTINCT chat_id FROM jarvis_messages
       WHERE sender = $1 AND chat_id LIKE '%@g.us'
       LIMIT 20`,
      [userScopeId]
    );

    if (rows.length === 0) return false;

    // Verificar se algum desses grupos é de cliente gerenciado
    const { rows: managed } = await pool.query(
      `SELECT value FROM jarvis_config WHERE key = 'managed_clients'`
    );

    if (managed.length === 0) return false;

    const clients = typeof managed[0].value === 'string'
      ? JSON.parse(managed[0].value) : managed[0].value;
    const clientJids = new Set(Object.values(clients).filter(c => c.active).map(c => c.groupJid));

    // Também considerar perfis de grupo com tipo "cliente"
    const { rows: clientGroups } = await pool.query(
      `SELECT entity_id FROM jarvis_profiles
       WHERE entity_type = 'group' AND profile::text ILIKE '%"tipo"%client%'`
    );
    for (const cg of clientGroups) clientJids.add(cg.entity_id);

    // Se o usuário fala em algum grupo de cliente → é contato de cliente
    for (const r of rows) {
      if (clientJids.has(r.chat_id)) return true;
    }

    return false;
  } catch (err) {
    console.error('[PROFILES] Erro em isClientContact:', err.message);
    return false;
  }
}

/**
 * Sincroniza perfis: identifica entidades e gera/atualiza perfis
 * Cruza dados de Asana, WhatsApp e grupos para classificar corretamente
 */
export async function syncProfiles() {
  const results = { synced: 0, errors: 0, entities: [] };

  try {
    // 1. Perfis de grupos (chats com mais memórias)
    const { rows: groups } = await pool.query(`
      SELECT scope_id, COUNT(*) as cnt FROM jarvis_memories
      WHERE scope = 'chat' AND scope_id IS NOT NULL
      GROUP BY scope_id HAVING COUNT(*) >= 3
      ORDER BY cnt DESC LIMIT 20
    `);

    for (const g of groups) {
      // Buscar nome do grupo
      const { rows: gInfo } = await pool.query('SELECT name FROM jarvis_groups WHERE jid = $1', [g.scope_id]).catch(() => ({ rows: [] }));
      const name = gInfo[0]?.name || g.scope_id;
      const profile = await synthesizeProfile('group', g.scope_id, name);
      if (profile) { results.synced++; results.entities.push({ type: 'group', name }); }
      else results.errors++;
      await new Promise(r => setTimeout(r, 500)); // Rate limit
    }

    // 2. Perfis de usuários — CRUZAR com grupos para classificar cliente vs equipe
    const { rows: users } = await pool.query(`
      SELECT scope_id, COUNT(*) as cnt FROM jarvis_memories
      WHERE scope = 'user' AND scope_id IS NOT NULL
      GROUP BY scope_id HAVING COUNT(*) >= 3
      ORDER BY cnt DESC LIMIT 20
    `);

    for (const u of users) {
      const { rows: cInfo } = await pool.query('SELECT push_name FROM jarvis_contacts WHERE jid = $1', [u.scope_id]).catch(() => ({ rows: [] }));
      const name = cInfo[0]?.push_name || u.scope_id;

      // CRUZAMENTO: verificar se essa pessoa é contato de cliente ou equipe
      const isClient = await isClientContact(u.scope_id);
      const entityType = isClient ? 'client_contact' : 'team_member';

      const profile = await synthesizeProfile(entityType, u.scope_id, name);
      if (profile) { results.synced++; results.entities.push({ type: entityType, name }); }
      else results.errors++;
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`[PROFILES] Sync concluído: ${results.synced} perfis, ${results.errors} erros`);
    return results;
  } catch (err) {
    console.error('[PROFILES] Erro no sync:', err.message);
    return { ...results, error: err.message };
  }
}
