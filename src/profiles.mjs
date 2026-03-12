// ============================================
// JARVIS 2.0 - Síntese de Perfis de Entidades
// Gera perfis estruturados a partir de memórias
// ============================================
import Anthropic from '@anthropic-ai/sdk';
import { pool } from './database.mjs';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });
const PROFILE_MODEL = process.env.MEMORY_MODEL || 'claude-haiku-3-5-20241022';

/**
 * Sintetiza um perfil a partir das memórias de uma entidade
 */
export async function synthesizeProfile(entityType, entityId, entityName = null) {
  try {
    // Buscar memórias relacionadas
    let memories = [];

    if (entityType === 'client' || entityType === 'group') {
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
  "cargo_funcao": "o que faz na agencia",
  "habilidades": ["lista de habilidades"],
  "pontos_fortes": "no que se destaca",
  "estilo_trabalho": "como trabalha (rapido, detalhista, etc)",
  "horario_ativo": "quando costuma estar mais ativo",
  "observacoes": "outras observacoes importantes"
}`,
      process: `Analise as memorias abaixo sobre processos da agencia e sintetize um perfil JSON:
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
      system: `Voce sintetiza perfis a partir de memorias de uma agencia de marketing (Stream Lab).
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
 * Sincroniza perfis: identifica entidades e gera/atualiza perfis
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

    // 2. Perfis de usuários (contatos com mais memórias)
    const { rows: users } = await pool.query(`
      SELECT scope_id, COUNT(*) as cnt FROM jarvis_memories
      WHERE scope = 'user' AND scope_id IS NOT NULL
      GROUP BY scope_id HAVING COUNT(*) >= 3
      ORDER BY cnt DESC LIMIT 20
    `);

    for (const u of users) {
      const { rows: cInfo } = await pool.query('SELECT push_name FROM jarvis_contacts WHERE jid = $1', [u.scope_id]).catch(() => ({ rows: [] }));
      const name = cInfo[0]?.push_name || u.scope_id;
      const profile = await synthesizeProfile('team_member', u.scope_id, name);
      if (profile) { results.synced++; results.entities.push({ type: 'team_member', name }); }
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
