// ============================================
// JARVIS 3.0 - Sistema de Memória Inteligente
// Inspirado no Mem0 (3 escopos + extração de fatos)
// ============================================
import Anthropic from '@anthropic-ai/sdk';
import { pool } from './database.mjs';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });
const MEMORY_MODEL = process.env.MEMORY_MODEL || 'claude-haiku-3-5-20241022';

export async function initMemory() {
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector').catch(() => {
      console.log('[MEMORY] pgvector nao instalado - usando busca por texto');
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS jarvis_memories (
        id SERIAL PRIMARY KEY,
        scope TEXT NOT NULL DEFAULT 'global',
        scope_id TEXT DEFAULT NULL,
        category TEXT DEFAULT 'general',
        content TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        importance INTEGER DEFAULT 5,
        access_count INTEGER DEFAULT 0,
        last_accessed TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_scope ON jarvis_memories(scope, scope_id)').catch(() => {});
    await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_category ON jarvis_memories(category)').catch(() => {});
    await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_importance ON jarvis_memories(importance DESC)').catch(() => {});

    console.log('[MEMORY] Sistema de memoria inicializado');
    return true;
  } catch (err) {
    console.error('[MEMORY] Erro ao inicializar:', err.message);
    return false;
  }
}

export async function extractFacts(text, senderName, chatId, isGroup, groupContext = null) {
  try {
    // Montar contexto do grupo para o extrator saber quem é cliente vs equipe
    let groupHint = '';
    if (isGroup && groupContext) {
      groupHint = `\n\nCONTEXTO IMPORTANTE:
- Grupo: "${groupContext.groupName}"
- Tipo: ${groupContext.isClientGroup ? 'GRUPO DE CLIENTE (empresa externa)' : 'grupo interno da agência'}
${groupContext.isClientGroup ? `- ${senderName} é CONTATO DO CLIENTE (NÃO é membro da equipe Stream Lab). Use categoria "client_profile" para fatos sobre esta pessoa, NUNCA "team_member".` : `- ${senderName} é da equipe interna Stream Lab.`}`;
    }

    const response = await anthropic.messages.create({
      model: MEMORY_MODEL,
      max_tokens: 800,
      system: `Voce e um extrator de fatos de uma agencia de marketing (Stream Lab). Analise a mensagem e extraia APENAS fatos relevantes sobre:
- Preferencias da pessoa (gosta de X, nao gosta de Y)
- Informacoes sobre clientes (empresa, contato, projeto, marca)
- Perfil de clientes (quem decide, tom de voz da marca, preferencias de conteudo)
- Decisoes tomadas (escolheu X, aprovou Y)
- Prazos e datas mencionados
- Regras ou instrucoes dadas
- Estilo de comunicacao da pessoa
- Informacoes sobre membros da equipe (habilidades, responsabilidades, historico)
- Processos e fluxos de trabalho (como as coisas funcionam)
- Padroes comportamentais (frequencia, horarios, preferencias de comunicacao)

REGRA CRITICA DE CLASSIFICACAO:
- Pessoas que falam em GRUPOS DE CLIENTES (empresas externas) sao CONTATOS DO CLIENTE → use "client_profile", NUNCA "team_member"
- Apenas pessoas dos grupos internos da Stream Lab (Tarefas Diárias, Galáxias) sao "team_member"
- Na duvida entre client_profile e team_member, considere o contexto do grupo${groupHint}

Responda APENAS em JSON array. Se nao houver fatos relevantes, responda [].
Cada fato: {"content": "fato claro e completo", "category": "preference|client|client_profile|decision|deadline|rule|style|team_member|process|pattern", "importance": 1-10}
NUNCA extraia fatos triviais como cumprimentos, "ok", "bom dia", emojis isolados.
Priorize fatos que ajudem a entender QUEM sao as pessoas, COMO trabalham, e O QUE preferem.`,
      messages: [{ role: 'user', content: `Mensagem de ${senderName} no ${isGroup ? `grupo "${groupContext?.groupName || 'desconhecido'}"` : 'privado'}:\n"${text}"` }],
    });

    const raw = response.content[0]?.text || '[]';
    const match = raw.match(/\[.*\]/s);
    if (!match) return [];
    const facts = JSON.parse(match[0]);
    return Array.isArray(facts) ? facts : [];
  } catch (err) {
    console.error('[MEMORY] extractFacts ERRO:', err.message, '| texto:', text.substring(0, 50));
    return [];
  }
}

export async function storeFacts(facts, scope, scopeId) {
  let stored = 0;
  for (const fact of facts) {
    try {
      const { rows: existing } = await pool.query(
        `SELECT id, content FROM jarvis_memories
         WHERE scope = $1 AND (scope_id = $2 OR scope_id IS NULL)
         AND content ILIKE '%' || $3 || '%' LIMIT 1`,
        [scope, scopeId, fact.content.substring(0, 50)]
      );

      if (existing.length > 0) {
        await pool.query(
          `UPDATE jarvis_memories SET content = $1, importance = GREATEST(importance, $2),
           access_count = access_count + 1, updated_at = NOW() WHERE id = $3`,
          [fact.content, fact.importance || 5, existing[0].id]
        );
      } else {
        await pool.query(
          `INSERT INTO jarvis_memories (scope, scope_id, category, content, importance)
           VALUES ($1, $2, $3, $4, $5)`,
          [scope, scopeId, fact.category || 'general', fact.content, fact.importance || 5]
        );
        stored++;
      }
    } catch (err) {
      console.error('[MEMORY] Erro ao salvar fato:', err.message);
    }
  }
  if (stored > 0) console.log(`[MEMORY] ${stored} novo(s) fato(s) armazenado(s) [${scope}:${scopeId || 'global'}]`);
  return stored;
}

export async function searchMemories(query, scope = null, scopeId = null, limit = 10) {
  try {
    let sql = `SELECT content, category, importance, scope, scope_id FROM jarvis_memories WHERE 1=1`;
    const params = [];
    let paramIdx = 1;

    if (scope) { sql += ` AND scope = $${paramIdx++}`; params.push(scope); }
    if (scopeId) { sql += ` AND (scope_id = $${paramIdx++} OR scope_id IS NULL)`; params.push(scopeId); }

    if (query) {
      const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2).slice(0, 10);
      if (keywords.length > 0) {
        const conditions = keywords.map(k => { params.push(`%${k}%`); return `content ILIKE $${paramIdx++}`; });
        sql += ` AND (${conditions.join(' OR ')})`;
      }
    }

    sql += ` ORDER BY importance DESC, updated_at DESC LIMIT $${paramIdx}`;
    params.push(limit);

    const { rows } = await pool.query(sql, params);

    for (const row of rows) {
      await pool.query('UPDATE jarvis_memories SET access_count = access_count + 1, last_accessed = NOW() WHERE content = $1', [row.content]).catch(() => {});
    }

    return rows;
  } catch (err) {
    console.error('[MEMORY] Erro ao buscar memorias:', err.message);
    return [];
  }
}

/**
 * Busca INTELIGENTE de memórias — usa Claude Haiku pra expandir a query
 * em múltiplas buscas paralelas, cobrindo sinônimos, categorias e termos relacionados.
 * Retorna resultados deduplicados ordenados por relevância.
 */
export async function smartSearchMemories(query, scope = null, scopeId = null, limit = 15) {
  try {
    // 1. Usar Haiku pra gerar queries de busca inteligentes
    const response = await anthropic.messages.create({
      model: MEMORY_MODEL,
      max_tokens: 300,
      system: `Você é um gerador de queries de busca. Dado um texto, gere 5-8 queries de busca alternativas que capturem TODOS os ângulos possíveis do que a pessoa pode estar perguntando. Inclua: sinônimos, termos relacionados, nomes de pessoas/empresas mencionados, categorias do assunto (processo, cliente, equipe, regra, preferência).

Responda APENAS em JSON array de strings. Exemplo: ["query1", "query2", "query3"]`,
      messages: [{ role: 'user', content: query }],
    });

    let queries = [query]; // sempre inclui a original
    try {
      const raw = response.content[0]?.text || '[]';
      const match = raw.match(/\[.*\]/s);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) queries = [query, ...parsed];
      }
    } catch {}

    // 2. Executar TODAS as queries em paralelo
    const searchPromises = queries.slice(0, 8).map(q =>
      searchMemories(q, scope, scopeId, Math.ceil(limit / 2))
    );
    const results = await Promise.allSettled(searchPromises);

    // 3. Deduplicar e ordenar por importância
    const seen = new Set();
    const allMemories = [];
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const m of result.value) {
        if (seen.has(m.content)) continue;
        seen.add(m.content);
        allMemories.push(m);
      }
    }

    // Ordenar: importância DESC, depois por quantas queries bateram (relevância)
    allMemories.sort((a, b) => b.importance - a.importance);
    return allMemories.slice(0, limit);
  } catch (err) {
    console.error('[MEMORY] smartSearch erro, fallback para busca simples:', err.message);
    return searchMemories(query, scope, scopeId, limit);
  }
}

export async function getMemoryContext(senderJid, chatId, text) {
  try {
    const contexts = [];

    // ============================================
    // CAMADA 1: Memórias de ALTA IMPORTÂNCIA — SEMPRE presentes
    // Independente da pergunta, o Jarvis SEMPRE tem acesso ao conhecimento mais valioso
    // ============================================
    try {
      const { rows: topMemories } = await pool.query(
        `SELECT DISTINCT ON (content) content, category, importance, scope, scope_id
         FROM jarvis_memories
         WHERE importance >= 8
         ORDER BY content, importance DESC
         LIMIT 25`
      );
      if (topMemories.length > 0) {
        contexts.push('🧠 CONHECIMENTO FUNDAMENTAL (alta importância — SEMPRE disponível):');
        // Agrupar por categoria pra ficar organizado
        const byCategory = {};
        for (const m of topMemories) {
          const cat = m.category || 'general';
          if (!byCategory[cat]) byCategory[cat] = [];
          byCategory[cat].push(m.content);
        }
        for (const [cat, items] of Object.entries(byCategory)) {
          contexts.push(`  [${cat}]:`);
          items.forEach(item => contexts.push(`  - ${item}`));
        }
      }
    } catch {}

    // ============================================
    // CAMADA 2: Busca INTELIGENTE por relevância à mensagem
    // Usa Haiku pra expandir a query em múltiplos ângulos de busca
    // ============================================
    const [userMemories, chatMemories, agentMemories] = await Promise.all([
      smartSearchMemories(text, 'user', senderJid, 15),
      smartSearchMemories(text, 'chat', chatId, 15),
      smartSearchMemories(text, 'agent', null, 15),
    ]);

    if (userMemories.length > 0) {
      contexts.push('\nMEMORIAS SOBRE ESTA PESSOA:');
      userMemories.forEach(m => contexts.push(`- [${m.category}] ${m.content}`));
    }

    if (chatMemories.length > 0) {
      contexts.push('\nMEMORIAS DESTE CHAT/GRUPO:');
      chatMemories.forEach(m => contexts.push(`- [${m.category}] ${m.content}`));
    }

    if (agentMemories.length > 0) {
      contexts.push('\nCONHECIMENTO OPERACIONAL DO JARVIS:');
      agentMemories.forEach(m => contexts.push(`- [${m.category}] ${m.content}`));
    }

    // ============================================
    // CAMADA 3: Busca por CATEGORIAS relevantes ao contexto
    // Se a mensagem fala de processo, traz TODOS os processos conhecidos
    // ============================================
    try {
      const lower = text.toLowerCase();
      const categoryQueries = [];
      if (/process|fluxo|como funciona|etapa|passo|procedimento/i.test(lower)) categoryQueries.push('process');
      if (/equipe|time|quem|responsável|nicolas|bruna|arthur|bruno|rigon/i.test(lower)) categoryQueries.push('team_member');
      if (/cliente|marca|empresa/i.test(lower)) categoryQueries.push('client', 'client_profile');
      if (/regra|nunca|sempre|obrigat/i.test(lower)) categoryQueries.push('rule');
      if (/prazo|deadline|vence|atrasa/i.test(lower)) categoryQueries.push('deadline');
      if (/prefer|gosta|estilo|tom/i.test(lower)) categoryQueries.push('preference', 'style');

      if (categoryQueries.length > 0) {
        const placeholders = categoryQueries.map((_, i) => `$${i + 1}`).join(', ');
        const { rows: catMemories } = await pool.query(
          `SELECT content, category, importance FROM jarvis_memories
           WHERE category IN (${placeholders})
           ORDER BY importance DESC, updated_at DESC LIMIT 20`,
          categoryQueries
        );
        // Filtrar memórias que já apareceram nas camadas anteriores
        const existingContents = new Set(contexts.filter(c => c.startsWith('  - ') || c.startsWith('- ')).map(c => c.replace(/^-?\s*(\[.*?\]\s*)?/, '')));
        const newCatMemories = catMemories.filter(m => !existingContents.has(m.content));
        if (newCatMemories.length > 0) {
          contexts.push(`\nCONHECIMENTO POR CATEGORIA (${categoryQueries.join(', ')}):`);
          newCatMemories.forEach(m => contexts.push(`- [${m.category}] ${m.content}`));
        }
      }
    } catch {}

    // ============================================
    // CAMADA 4: Perfis sintetizados (grupo, cliente, pessoa)
    // ============================================
    try {
      const { rows: profiles } = await pool.query(
        `SELECT entity_type, entity_name, profile FROM jarvis_profiles WHERE entity_id = $1`,
        [chatId]
      );
      if (profiles.length > 0) {
        for (const p of profiles) {
          const prof = typeof p.profile === 'string' ? JSON.parse(p.profile) : p.profile;
          contexts.push(`\nPERFIL ${p.entity_type === 'client' ? 'DO CLIENTE' : 'DO GRUPO'} (${p.entity_name || 'desconhecido'}):`);
          for (const [key, val] of Object.entries(prof)) {
            if (val && val !== null) contexts.push(`- ${key}: ${Array.isArray(val) ? val.join(', ') : val}`);
          }
        }
      }
    } catch {}

    try {
      const { rows: senderProfiles } = await pool.query(
        `SELECT entity_type, entity_name, profile FROM jarvis_profiles WHERE entity_id = $1 AND entity_type IN ('team_member', 'client_contact')`,
        [senderJid]
      );
      if (senderProfiles.length > 0) {
        const p = senderProfiles[0];
        const prof = typeof p.profile === 'string' ? JSON.parse(p.profile) : p.profile;
        const label = p.entity_type === 'client_contact' ? 'PERFIL DO CLIENTE' : 'PERFIL DE';
        contexts.push(`\n${label} ${p.entity_name || 'esta pessoa'}:`);
        for (const [key, val] of Object.entries(prof)) {
          if (val && val !== null) contexts.push(`- ${key}: ${Array.isArray(val) ? val.join(', ') : val}`);
        }
      }
    } catch {}

    // ============================================
    // CAMADA 5: Homework (instruções diretas — prioridade máxima)
    // ============================================
    try {
      const { rows } = await pool.query('SELECT content, source FROM homework ORDER BY created_at DESC LIMIT 20');
      if (rows.length > 0) {
        contexts.push('\n⚠️ INSTRUCOES DIRETAS DO GUI (PRIORIDADE MAXIMA — sobrepoe qualquer outra regra):');
        rows.forEach(r => contexts.push(`- ${r.content}`));
      }
    } catch {}

    return contexts.length > 0 ? '\n\n' + contexts.join('\n') : '';
  } catch (err) {
    console.error('[MEMORY] Erro ao montar contexto:', err.message);
    return '';
  }
}

export async function processMemory(text, senderName, senderJid, chatId, isGroup, groupContext = null) {
  if (!text || text.length < 15) return;
  try {
    console.log(`[MEMORY] Processando: "${text.substring(0, 40)}..." de ${senderName}`);
    const facts = await extractFacts(text, senderName, chatId, isGroup, groupContext);
    if (facts.length === 0) {
      console.log(`[MEMORY] Nenhum fato extraído de: "${text.substring(0, 40)}..."`);
      return;
    }
    console.log(`[MEMORY] ${facts.length} fato(s) extraído(s) de ${senderName}`);
    await storeFacts(facts, 'user', senderJid);
    if (isGroup) await storeFacts(facts, 'chat', chatId);
  } catch (err) {
    console.error('[MEMORY] processMemory ERRO:', err.message);
  }
}

export async function getMemoryStats() {
  try {
    const total = await pool.query('SELECT COUNT(*) as count FROM jarvis_memories');
    const byScope = await pool.query('SELECT scope, COUNT(*) as count FROM jarvis_memories GROUP BY scope ORDER BY count DESC');
    const byCategory = await pool.query('SELECT category, COUNT(*) as count FROM jarvis_memories GROUP BY category ORDER BY count DESC');
    const topMemories = await pool.query('SELECT content, importance, access_count, scope FROM jarvis_memories ORDER BY importance DESC, access_count DESC LIMIT 10');
    return { total: parseInt(total.rows[0].count), byScope: byScope.rows, byCategory: byCategory.rows, topMemories: topMemories.rows };
  } catch (err) {
    return { total: 0, byScope: [], byCategory: [], topMemories: [], error: err.message };
  }
}
