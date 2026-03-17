// ============================================
// JARVIS 4.0 - Cérebro Persistente
// Documento de conhecimento sintetizado que o Jarvis carrega SEMPRE no system prompt.
// Atualizado 1x/dia via cron. Substitui a dependência de memórias aleatórias
// por um "manual operacional" completo e coerente.
// ============================================
import Anthropic from '@anthropic-ai/sdk';
import { pool } from './database.mjs';
import { CONFIG } from './config.mjs';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

// Modelo pra síntese — usa Opus pra qualidade máxima (é 1x/dia, custo justificado)
const BRAIN_MODEL = CONFIG.AI_MODEL_STRONG || CONFIG.AI_MODEL || 'claude-sonnet-4-6';

/**
 * Gera o Cérebro Persistente:
 * 1. Busca TODAS as memórias do banco
 * 2. Busca TODOS os perfis sintetizados
 * 3. Busca homework (instruções diretas do Gui)
 * 4. Busca configurações operacionais (clientes gerenciados, etc.)
 * 5. Envia tudo pro Claude Opus sintetizar num documento estruturado
 * 6. Salva em jarvis_config como key 'jarvis_brain'
 */
export async function generateBrainDocument() {
  console.log('[BRAIN-DOC] 🧠 Iniciando geração do Cérebro Persistente...');
  const startTime = Date.now();

  try {
    // ============================================
    // 1. Coletar TUDO do banco
    // ============================================
    const [
      memoriesResult,
      profilesResult,
      homeworkResult,
      configResult,
      statsResult,
    ] = await Promise.all([
      // Memórias MAIS IMPORTANTES — limitar a 500 pra caber no contexto do Claude
      // Prioriza: importância alta + mais acessadas + mais recentes
      pool.query(`
        SELECT content, category, importance, scope, access_count
        FROM (
          SELECT DISTINCT ON (content) content, category, importance, scope, scope_id,
                 access_count, updated_at
          FROM jarvis_memories
          WHERE importance >= 5
          ORDER BY content, importance DESC
        ) AS deduped
        ORDER BY importance DESC, access_count DESC, updated_at DESC
        LIMIT 500
      `),
      // Todos os perfis
      pool.query(`SELECT entity_type, entity_name, profile FROM jarvis_profiles ORDER BY entity_type, last_updated DESC`),
      // Homework
      pool.query(`SELECT content, source, created_at::date as data FROM homework ORDER BY created_at DESC`),
      // Clientes gerenciados
      pool.query(`SELECT key, value FROM jarvis_config WHERE key IN ('managed_clients', 'voice_config')`),
      // Stats gerais
      pool.query(`SELECT
        (SELECT COUNT(*) FROM jarvis_memories) as total_memorias,
        (SELECT COUNT(*) FROM jarvis_memories WHERE importance >= 5) as memorias_importantes,
        (SELECT COUNT(DISTINCT scope_id) FROM jarvis_memories WHERE scope = 'user') as total_pessoas,
        (SELECT COUNT(DISTINCT scope_id) FROM jarvis_memories WHERE scope = 'chat') as total_chats,
        (SELECT COUNT(*) FROM jarvis_profiles) as total_perfis,
        (SELECT COUNT(*) FROM homework) as total_homework
      `),
    ]);

    const memories = memoriesResult.rows;
    const profiles = profilesResult.rows;
    const homework = homeworkResult.rows;
    const configs = configResult.rows;
    const stats = statsResult.rows[0];

    console.log(`[BRAIN-DOC] Dados coletados: ${memories.length} memórias, ${profiles.length} perfis, ${homework.length} homework`);

    if (memories.length === 0) {
      console.log('[BRAIN-DOC] Sem memórias no banco, pulando geração');
      return null;
    }

    // ============================================
    // 2. Organizar memórias por categoria
    // ============================================
    const byCategory = {};
    for (const m of memories) {
      const cat = m.category || 'general';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push({
        conteudo: m.content,
        importancia: m.importance,
        acessos: m.access_count,
      });
    }

    // Ordenar cada categoria por importância DESC
    for (const cat of Object.keys(byCategory)) {
      byCategory[cat].sort((a, b) => b.importancia - a.importancia);
    }

    // ============================================
    // 3. Formatar perfis
    // ============================================
    const profilesText = profiles.map(p => {
      const prof = typeof p.profile === 'string' ? JSON.parse(p.profile) : p.profile;
      return `[${p.entity_type}] ${p.entity_name || 'sem nome'}:\n${JSON.stringify(prof, null, 1)}`;
    }).join('\n\n');

    // ============================================
    // 4. Formatar homework
    // ============================================
    const homeworkText = homework.map(h =>
      `- [${h.data}] ${h.content}`
    ).join('\n');

    // ============================================
    // 5. Formatar clientes gerenciados
    // ============================================
    let managedText = '';
    const managedRow = configs.find(c => c.key === 'managed_clients');
    if (managedRow) {
      const clients = typeof managedRow.value === 'string' ? JSON.parse(managedRow.value) : managedRow.value;
      managedText = Object.entries(clients).map(([slug, data]) => {
        return `- ${slug}: ${data.groupName || 'sem nome'} (${data.active ? 'ATIVO' : 'inativo'}) — responsável: ${data.defaultAssignee || 'não definido'}`;
      }).join('\n');
    }

    // ============================================
    // 6. Montar o input gigante e mandar pro Claude sintetizar
    // ============================================
    const categoriesText = Object.entries(byCategory).map(([cat, items]) => {
      const itemsStr = items.map(i =>
        `  [imp:${i.importancia}] ${i.conteudo}`
      ).join('\n');
      return `=== ${cat.toUpperCase()} (${items.length} fatos) ===\n${itemsStr}`;
    }).join('\n\n');

    const inputText = `ESTATÍSTICAS:
- Total de memórias no banco: ${stats.total_memorias} (mostrando top ${memories.length} com importância >= 5)
- Memórias importantes (imp >= 5): ${stats.memorias_importantes}
- Pessoas conhecidas: ${stats.total_pessoas}
- Chats/grupos: ${stats.total_chats}
- Perfis sintetizados: ${stats.total_perfis}
- Instruções do Gui: ${stats.total_homework}

============ MEMÓRIAS POR CATEGORIA ============
${categoriesText}

============ PERFIS SINTETIZADOS ============
${profilesText || '(nenhum perfil)'}

============ INSTRUÇÕES DIRETAS DO GUI (HOMEWORK) ============
${homeworkText || '(nenhuma instrução)'}

============ CLIENTES GERENCIADOS (PROATIVO) ============
${managedText || '(nenhum cliente gerenciado)'}`;

    // Garantir que cabe no limite da API (~200k tokens ≈ 800k chars)
    // Mas queremos ficar bem abaixo pra não estourar rate limit
    const maxInputChars = 300000; // ~75k tokens — seguro pro Opus
    let finalInput = inputText;
    if (finalInput.length > maxInputChars) {
      console.log(`[BRAIN-DOC] Input muito grande (${finalInput.length} chars), truncando...`);
      // Truncar: pegar só as memórias de importância mais alta
      const filteredCategories = {};
      for (const [cat, items] of Object.entries(byCategory)) {
        // Limitar cada categoria a 30 items mais importantes
        filteredCategories[cat] = items.slice(0, 30);
      }
      const filteredText = Object.entries(filteredCategories).map(([cat, items]) => {
        const itemsStr = items.map(i => `  [imp:${i.importancia}] ${i.conteudo}`).join('\n');
        return `=== ${cat.toUpperCase()} (${items.length} fatos) ===\n${itemsStr}`;
      }).join('\n\n');

      finalInput = `ESTATÍSTICAS:
- Total de memórias no banco: ${stats.total_memorias} (mostrando top ${memories.length} mais importantes)
- Pessoas conhecidas: ${stats.total_pessoas}
- Chats/grupos: ${stats.total_chats}

============ MEMÓRIAS POR CATEGORIA (TOP POR IMPORTÂNCIA) ============
${filteredText}

============ PERFIS SINTETIZADOS ============
${profilesText || '(nenhum)'}

============ INSTRUÇÕES DIRETAS DO GUI (HOMEWORK) ============
${homeworkText || '(nenhuma)'}

============ CLIENTES GERENCIADOS ============
${managedText || '(nenhum)'}`;

      // Se AINDA estiver grande, cortar perfis e homework longo
      if (finalInput.length > maxInputChars) {
        console.log(`[BRAIN-DOC] Ainda grande (${finalInput.length} chars), corte agressivo...`);
        finalInput = finalInput.substring(0, maxInputChars);
      }
    }

    console.log(`[BRAIN-DOC] Enviando ${finalInput.length} chars pro Claude sintetizar...`);

    const response = await anthropic.messages.create({
      model: BRAIN_MODEL,
      max_tokens: 16000,
      thinking: { type: 'enabled', budget_tokens: 8192 },
      system: `Você é o arquiteto de conhecimento do JARVIS, assistente de IA da Stream Lab (agência de marketing digital).

Sua tarefa: receber TODAS as memórias, perfis e instruções acumulados pelo Jarvis e sintetizar um DOCUMENTO DE CONHECIMENTO OPERACIONAL — o "cérebro" do Jarvis.

Este documento será carregado no system prompt do Jarvis em TODA conversa, então ele SEMPRE terá esse conhecimento disponível. É como o CLAUDE.md, mas gerado automaticamente a partir da experiência real.

REGRAS DE SÍNTESE:
1. NÃO seja um dump de memórias — SINTETIZE em conhecimento coerente e acionável
2. Elimine redundâncias (muitas memórias dizem a mesma coisa de formas diferentes)
3. Resolva contradições (se duas memórias se contradizem, a de maior importância prevalece)
4. Organize por TEMAS, não por data ou categoria bruta
5. Priorize informações ACIONÁVEIS (o que o Jarvis precisa saber pra agir bem)
6. Instruções do Gui (homework) têm PRIORIDADE ABSOLUTA sobre tudo
7. Mantenha o tom direto, sem enrolação — cada frase deve ter utilidade
8. Use português brasileiro com acentos corretos
9. NÃO inclua IDs internos (JIDs, GIDs) — eles mudam. Use apenas nomes
10. Inclua TODAS as pessoas conhecidas, clientes, processos e regras
11. Se uma memória tem importância >= 8, seu conteúdo DEVE aparecer no documento
12. Máximo de 12.000 caracteres no documento final (precisa caber no prompt sem estourar)

ESTRUTURA OBRIGATÓRIA DO DOCUMENTO:
Use exatamente estas seções (pule se não houver dados):

# 🧠 CÉREBRO PERSISTENTE DO JARVIS
## Última atualização: [data de hoje]

### 1. EQUIPE STREAM LAB
(Quem é quem, funções, estilos de trabalho, pontos fortes/fracos)

### 2. CLIENTES
(Cada cliente: quem é, o que faz, como se comunica, preferências, cuidados)

### 3. PROCESSOS E FLUXOS
(Como a agência funciona: criação de conteúdo, aprovação, tráfego, captação, etc.)

### 4. REGRAS E RESTRIÇÕES
(O que NUNCA fazer, o que SEMPRE fazer, protocolos de segurança)

### 5. PREFERÊNCIAS DO GUI
(Como o Gui gosta que as coisas sejam feitas, correções que já fez, padrões)

### 6. CONTEXTO OPERACIONAL
(Ferramentas usadas, integrações, configs importantes, clientes gerenciados)

### 7. PADRÕES APRENDIDOS
(Comportamentos recorrentes, horários típicos, dinâmicas do time)

### 8. INSTRUÇÕES ESPECIAIS
(Homework do Gui — PRIORIDADE MÁXIMA, sobrepõe qualquer outra seção)`,
      messages: [{
        role: 'user',
        content: `Aqui está TODO o conhecimento acumulado pelo Jarvis. Sintetize no documento operacional:\n\n${finalInput}`,
      }],
    });

    // Extrair texto (ignorar thinking blocks)
    const textBlock = response.content.find(b => b.type === 'text');
    const brainDocument = textBlock?.text || '';

    if (!brainDocument || brainDocument.length < 100) {
      console.error('[BRAIN-DOC] Documento gerado está vazio ou muito curto');
      return null;
    }

    console.log(`[BRAIN-DOC] Documento gerado: ${brainDocument.length} caracteres`);

    // ============================================
    // 7. Salvar no banco (jarvis_config)
    // ============================================
    await pool.query(`
      INSERT INTO jarvis_config (key, value)
      VALUES ('jarvis_brain', $1)
      ON CONFLICT (key) DO UPDATE SET value = $1
    `, [JSON.stringify({
      document: brainDocument,
      generated_at: new Date().toISOString(),
      memories_count: memories.length,
      profiles_count: profiles.length,
      homework_count: homework.length,
      generation_time_ms: Date.now() - startTime,
      model_used: BRAIN_MODEL,
    })]);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[BRAIN-DOC] ✅ Cérebro Persistente salvo com sucesso (${elapsed}s, ${brainDocument.length} chars)`);

    return brainDocument;
  } catch (err) {
    console.error('[BRAIN-DOC] ❌ Erro ao gerar Cérebro Persistente:', err.message);
    return null;
  }
}

/**
 * Carrega o Cérebro Persistente do banco.
 * Retorna o documento de texto ou string vazia se não existir.
 * Cached em memória pra não bater no banco a cada mensagem.
 */
let _cachedBrain = null;
let _cachedAt = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutos — recarrega do banco periodicamente

export async function loadBrainDocument() {
  // Cache em memória (evita query a cada mensagem)
  if (_cachedBrain && (Date.now() - _cachedAt) < CACHE_TTL) {
    return _cachedBrain;
  }

  try {
    const { rows } = await pool.query(
      "SELECT value FROM jarvis_config WHERE key = 'jarvis_brain'"
    );

    if (rows.length === 0) {
      console.log('[BRAIN-DOC] Cérebro Persistente não encontrado no banco');
      return '';
    }

    const data = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
    const document = data.document || '';

    if (document) {
      _cachedBrain = document;
      _cachedAt = Date.now();

      // Log só na primeira vez ou quando recarrega
      const age = data.generated_at
        ? Math.round((Date.now() - new Date(data.generated_at).getTime()) / (1000 * 60 * 60))
        : '?';
      console.log(`[BRAIN-DOC] Cérebro carregado (${document.length} chars, idade: ${age}h, ${data.memories_count || '?'} memórias)`);
    }

    return document;
  } catch (err) {
    console.error('[BRAIN-DOC] Erro ao carregar Cérebro:', err.message);
    return _cachedBrain || '';
  }
}

/**
 * Força o reload do cache (útil após gerar novo documento)
 */
export function invalidateBrainCache() {
  _cachedBrain = null;
  _cachedAt = 0;
}

/**
 * Retorna metadados do cérebro (para o dashboard)
 */
export async function getBrainStatus() {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM jarvis_config WHERE key = 'jarvis_brain'"
    );

    if (rows.length === 0) return { exists: false };

    const data = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
    return {
      exists: true,
      generated_at: data.generated_at,
      document_length: data.document?.length || 0,
      memories_count: data.memories_count,
      profiles_count: data.profiles_count,
      homework_count: data.homework_count,
      generation_time_ms: data.generation_time_ms,
      model_used: data.model_used,
      age_hours: data.generated_at
        ? Math.round((Date.now() - new Date(data.generated_at).getTime()) / (1000 * 60 * 60))
        : null,
    };
  } catch (err) {
    return { exists: false, error: err.message };
  }
}
