// ============================================
// JARVIS 5.0 - Sistema de Memória Inteligente
// Mem0-inspired + pgvector (busca semântica)
// ============================================
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { pool } from './database.mjs';
import { CONFIG, TEAM_ASANA } from './config.mjs';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

// Retry automático para 429/529 (rate limit / overloaded)
async function claudeWithRetry(apiParams, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await anthropic.messages.create(apiParams);
    } catch (err) {
      const status = err?.status || 0;
      const isRetryable = status === 429 || status === 529 || (err.message && err.message.includes('Overloaded'));
      if (isRetryable && attempt < maxRetries) {
        const delay = Math.min(2000 * Math.pow(2, attempt - 1), 10000);
        console.log(`[MEMORY-RETRY] Tentativa ${attempt}/${maxRetries} falhou (${status}). Retry em ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
const MEMORY_MODEL = process.env.MEMORY_MODEL || 'claude-sonnet-4-6-20250514';
const EMBEDDING_MODEL = 'text-embedding-3-small'; // 1536 dimensões
let pgvectorEnabled = false;

// Cache de embeddings pra queries repetidas (TTL 1h)
const embeddingCache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of embeddingCache) {
    if (now - val.cachedAt > 3600000) embeddingCache.delete(key);
  }
}, 600000); // limpa a cada 10 min

// Cache de contexto de pessoa (TTL 30min) — evita queries repetidas no DB
const personContextCache = new Map();
const PERSON_CONTEXT_TTL = 30 * 60 * 1000; // 30 minutos
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of personContextCache) {
    if (now - val.cachedAt > PERSON_CONTEXT_TTL) personContextCache.delete(key);
  }
}, 600000); // limpa a cada 10 min

/**
 * Determina se uma pessoa é equipe ou cliente baseado no CONTEXTO (grupos onde interage).
 * Consulta o DB pra ver em quais grupos a pessoa já mandou mensagem.
 * Resultado cacheado por 30 minutos.
 * @returns {'team' | 'client' | 'unknown'}
 */
async function getPersonContext(senderJid) {
  if (!senderJid) return 'unknown';

  const cached = personContextCache.get(senderJid);
  if (cached) return cached.context;

  try {
    const { rows } = await pool.query(
      'SELECT DISTINCT chat_id FROM jarvis_messages WHERE sender = $1 LIMIT 20',
      [senderJid]
    );

    const internalGroups = [CONFIG.GROUP_TAREFAS, CONFIG.GROUP_GALAXIAS].filter(Boolean);
    const appearsInInternal = rows.some(r => internalGroups.includes(r.chat_id));

    const context = appearsInInternal ? 'team' : (rows.length > 0 ? 'client' : 'unknown');
    personContextCache.set(senderJid, { context, cachedAt: Date.now() });
    return context;
  } catch (err) {
    console.error('[MEMORY] getPersonContext erro:', err.message);
    return 'unknown';
  }
}

/**
 * Gera embedding via OpenAI text-embedding-3-small (1536 dims)
 */
async function generateEmbedding(text) {
  if (!text || text.length < 5) return null;
  const cacheKey = text.substring(0, 200);
  const cached = embeddingCache.get(cacheKey);
  if (cached) return cached.embedding;

  try {
    const resp = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text.substring(0, 8000), // limite do modelo
    });
    const embedding = resp.data[0]?.embedding;
    if (embedding) {
      embeddingCache.set(cacheKey, { embedding, cachedAt: Date.now() });
    }
    return embedding;
  } catch (err) {
    console.error('[MEMORY] Erro ao gerar embedding:', err.message);
    return null;
  }
}

export async function initMemory() {
  try {
    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
      pgvectorEnabled = true;
      console.log('[MEMORY] pgvector habilitado — busca semântica ativa');
    } catch {
      console.log('[MEMORY] pgvector não instalado — usando busca por texto');
    }

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

    // pgvector: adicionar coluna embedding se não existe
    if (pgvectorEnabled) {
      await pool.query('ALTER TABLE jarvis_memories ADD COLUMN IF NOT EXISTS embedding vector(1536)').catch(() => {});
      // Índice HNSW (mais rápido que IVFFlat pra datasets < 1M)
      await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_embedding ON jarvis_memories USING hnsw (embedding vector_cosine_ops)').catch(e => {
        console.log('[MEMORY] Índice HNSW não criado (pode precisar de mais dados):', e.message);
      });
    }

    console.log('[MEMORY] Sistema de memoria inicializado');
    return true;
  } catch (err) {
    console.error('[MEMORY] Erro ao inicializar:', err.message);
    return false;
  }
}

export async function extractFacts(text, senderName, chatId, isGroup, groupContext = null, senderJid = null) {
  try {
    // Determinar contexto da pessoa pelo histórico de interações (DB-driven, não hardcoded)
    const senderContext = senderJid ? await getPersonContext(senderJid) : 'unknown';
    const senderLabel = senderContext === 'team' ? 'membro da equipe Stream Lab'
      : senderContext === 'client' ? 'cliente/contato externo'
      : 'desconhecido';

    // Determinar tipo do grupo
    let groupType = 'DM';
    if (isGroup && groupContext) {
      if (groupContext.isInternalGroup) groupType = 'interno';
      else if (groupContext.isClientGroup) groupType = 'cliente';
      else groupType = 'grupo';
    }

    // Montar bloco de contexto para o modelo
    let contextBlock = `\n\nCONTEXTO DA MENSAGEM:
- Canal: ${isGroup ? `Grupo "${groupContext?.groupName || 'desconhecido'}" (tipo: ${groupType})` : 'Conversa privada (DM)'}
- Remetente: ${senderName} (${senderLabel})`;

    if (isGroup && groupContext?.isClientGroup) {
      contextBlock += `\n- REGRA: Pessoas neste grupo de cliente sao CONTATOS DO CLIENTE. Use "client_profile", NUNCA "team_member".`;
      if (senderContext !== 'team') {
        contextBlock += `\n- ${senderName} NAO interage nos grupos internos → e cliente, NAO equipe.`;
      }
    }

    if (senderContext === 'team' && isGroup && groupContext?.isClientGroup) {
      contextBlock += `\n- ${senderName} e da equipe (interage nos grupos internos), mas esta respondendo no grupo do cliente.`;
      contextBlock += `\n- Outras pessoas mencionadas que NAO sao da equipe sao clientes → use "client_profile".`;
    }

    // Build team names list from TEAM_ASANA config
    const teamNames = Object.keys(TEAM_ASANA || {}).map(n => n.charAt(0).toUpperCase() + n.slice(1));
    const teamListStr = teamNames.length > 0 ? teamNames.join(', ') : 'Gui, Nicolas, Arthur, Bruno, Bruna, Rigon, Jarvis';

    // Adicionar contexto do grupo de origem para classificacao inteligente
    const internalGroupIds = [CONFIG.GROUP_TAREFAS, CONFIG.GROUP_GALAXIAS].filter(Boolean);
    const isInternalGroup = isGroup && internalGroupIds.includes(chatId);
    const isClientGroup = isGroup && groupContext?.isClientGroup;
    const groupLabel = isInternalGroup ? 'INTERNO (equipe Stream Lab)' : isClientGroup ? 'DE CLIENTE (externo)' : 'desconhecido';

    contextBlock += `\n
CONTEXTO DO GRUPO: Esta mensagem veio do grupo "${groupContext?.groupName || 'DM privada'}" que e um grupo ${groupLabel}.
EQUIPE CONHECIDA: ${teamListStr}.

REGRAS DE CLASSIFICACAO POR ORIGEM:
- Grupo INTERNO (Tarefas Diarias, Galaxias): se alguem e MENCIONADO mas NAO esta na lista de equipe conhecida, provavelmente e um CLIENTE sendo discutido pela equipe → use "client" ou "client_profile"
- Grupo DE CLIENTE: o remetente provavelmente e cliente (a nao ser que esteja na lista de equipe conhecida)
- Se alguem interage regularmente nos grupos internos (Tarefas Diarias, Galaxias) → e equipe → "team_member"
- Remetente classificado como "${senderLabel}" com base no historico de interacoes reais
- Na duvida, compare o nome com a lista de EQUIPE CONHECIDA antes de classificar`;

    const response = await claudeWithRetry({
      model: MEMORY_MODEL,
      max_tokens: 800,
      system: `Voce e um extrator de fatos da Stream Lab (laboratorio criativo de marketing). Analise a mensagem e extraia APENAS fatos relevantes sobre:
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

CLASSIFICACAO DE PESSOAS:
Equipe conhecida (referencia): ${teamListStr}.
MAS use o CONTEXTO DA MENSAGEM abaixo como fonte primaria de classificacao — ele indica onde o remetente interage com base no historico real de mensagens.
- Pessoas que interagem nos grupos internos (Tarefas Diarias, Galaxias) sao equipe → "team_member"
- Pessoas que so aparecem em grupos de clientes sao contatos externos → "client_profile"
- Se alguem e mencionado no contexto de um grupo de cliente, e provavelmente cliente → "client_profile"
- Na duvida entre client_profile e team_member, use "client_profile" — e mais seguro${contextBlock}

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
        // Atualizar conteúdo + re-gerar embedding se mudou
        const embedding = pgvectorEnabled ? await generateEmbedding(fact.content) : null;
        const updateSql = embedding
          ? `UPDATE jarvis_memories SET content = $1, importance = GREATEST(importance, $2),
             access_count = access_count + 1, updated_at = NOW(), embedding = $4 WHERE id = $3`
          : `UPDATE jarvis_memories SET content = $1, importance = GREATEST(importance, $2),
             access_count = access_count + 1, updated_at = NOW() WHERE id = $3`;
        const updateParams = embedding
          ? [fact.content, fact.importance || 5, existing[0].id, JSON.stringify(embedding)]
          : [fact.content, fact.importance || 5, existing[0].id];
        await pool.query(updateSql, updateParams);
      } else {
        // Gerar embedding pro novo fato
        const embedding = pgvectorEnabled ? await generateEmbedding(fact.content) : null;
        if (embedding) {
          await pool.query(
            `INSERT INTO jarvis_memories (scope, scope_id, category, content, importance, embedding)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [scope, scopeId, fact.category || 'general', fact.content, fact.importance || 5, JSON.stringify(embedding)]
          );
        } else {
          await pool.query(
            `INSERT INTO jarvis_memories (scope, scope_id, category, content, importance)
             VALUES ($1, $2, $3, $4, $5)`,
            [scope, scopeId, fact.category || 'general', fact.content, fact.importance || 5]
          );
        }
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
    // Busca HÍBRIDA: vetor (semântica) + ILIKE (texto) combinados
    const embedding = pgvectorEnabled && query ? await generateEmbedding(query) : null;

    let sql, params;

    if (embedding) {
      // Busca híbrida: combina score de similaridade vetorial + importância
      sql = `SELECT content, category, importance, scope, scope_id,
             1 - (embedding <=> $1::vector) as similarity
             FROM jarvis_memories
             WHERE embedding IS NOT NULL`;
      params = [JSON.stringify(embedding)];
      let paramIdx = 2;

      if (scope) { sql += ` AND scope = $${paramIdx++}`; params.push(scope); }
      if (scopeId) { sql += ` AND (scope_id = $${paramIdx++} OR scope_id IS NULL)`; params.push(scopeId); }

      sql += ` ORDER BY (1 - (embedding <=> $1::vector)) * 0.7 + (importance::float / 10.0) * 0.3 DESC
               LIMIT $${paramIdx}`;
      params.push(limit);
    } else {
      // Fallback: busca por texto (ILIKE)
      sql = `SELECT content, category, importance, scope, scope_id FROM jarvis_memories WHERE 1=1`;
      params = [];
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
    }

    const { rows } = await pool.query(sql, params);

    // Atualizar access_count em batch (não bloqueia)
    if (rows.length > 0) {
      const contents = rows.map(r => r.content);
      pool.query('UPDATE jarvis_memories SET access_count = access_count + 1, last_accessed = NOW() WHERE content = ANY($1)', [contents]).catch(() => {});
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
    if (pgvectorEnabled) {
      // COM pgvector: busca semântica direta (sem precisar de Haiku pra expandir)
      // Uma única busca vetorial já captura sinônimos e contexto
      return searchMemories(query, scope, scopeId, limit);
    }

    // SEM pgvector: fallback com Haiku pra expandir queries (mais lento, mais caro)
    const response = await claudeWithRetry({
      model: MEMORY_MODEL,
      max_tokens: 300,
      system: `Você é um gerador de queries de busca. Dado um texto, gere 5-8 queries de busca alternativas que capturem TODOS os ângulos possíveis do que a pessoa pode estar perguntando. Inclua: sinônimos, termos relacionados, nomes de pessoas/empresas mencionados, categorias do assunto (processo, cliente, equipe, regra, preferência).

Responda APENAS em JSON array de strings. Exemplo: ["query1", "query2", "query3"]`,
      messages: [{ role: 'user', content: query }],
    });

    let queries = [query];
    try {
      const raw = response.content[0]?.text || '[]';
      const match = raw.match(/\[.*\]/s);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) queries = [query, ...parsed];
      }
    } catch {}

    const searchPromises = queries.slice(0, 8).map(q =>
      searchMemories(q, scope, scopeId, Math.ceil(limit / 2))
    );
    const results = await Promise.allSettled(searchPromises);

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
    const facts = await extractFacts(text, senderName, chatId, isGroup, groupContext, senderJid);
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
    const withEmbedding = await pool.query('SELECT COUNT(*) as count FROM jarvis_memories WHERE embedding IS NOT NULL').catch(() => ({ rows: [{ count: 0 }] }));
    return {
      total: parseInt(total.rows[0].count),
      withEmbedding: parseInt(withEmbedding.rows[0].count),
      pgvectorEnabled,
      byScope: byScope.rows,
      byCategory: byCategory.rows,
      topMemories: topMemories.rows,
    };
  } catch (err) {
    return { total: 0, withEmbedding: 0, pgvectorEnabled, byScope: [], byCategory: [], topMemories: [], error: err.message };
  }
}

/**
 * Backfill: gera embeddings pra memórias que ainda não têm.
 * Processa em batches de 50 pra não sobrecarregar a API.
 */
export async function backfillEmbeddings(batchSize = 50) {
  if (!pgvectorEnabled) return { error: 'pgvector não habilitado' };

  const { rows: pending } = await pool.query(
    'SELECT id, content FROM jarvis_memories WHERE embedding IS NULL ORDER BY importance DESC LIMIT $1',
    [batchSize]
  );

  if (pending.length === 0) return { processed: 0, message: 'Todas as memórias já têm embedding' };

  let processed = 0;
  for (const mem of pending) {
    try {
      const embedding = await generateEmbedding(mem.content);
      if (embedding) {
        await pool.query('UPDATE jarvis_memories SET embedding = $1 WHERE id = $2', [JSON.stringify(embedding), mem.id]);
        processed++;
      }
    } catch (err) {
      console.error(`[BACKFILL] Erro no ID ${mem.id}:`, err.message);
    }
  }

  const { rows: stats } = await pool.query('SELECT COUNT(*) as total, COUNT(embedding) as with_emb FROM jarvis_memories');
  console.log(`[BACKFILL] ${processed}/${pending.length} processados. Total: ${stats[0].with_emb}/${stats[0].total} com embedding`);
  return { processed, total: parseInt(stats[0].total), withEmbedding: parseInt(stats[0].with_emb) };
}

export { generateEmbedding, pgvectorEnabled, getPersonContext };
