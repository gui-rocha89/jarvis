// ============================================
// JARVIS 2.0 - Cérebro (AI Brain + Agent Teams)
// ============================================
import Anthropic from '@anthropic-ai/sdk';
import { CONFIG, JARVIS_ALLOWED_GROUPS, teamPhones, teamWhatsApp } from './config.mjs';
import { pool } from './database.mjs';
import { getRecentMessages, getContactInfo, getGroupInfo, getMessageCount } from './database.mjs';
import { getMemoryContext, processMemory, searchMemories } from './memory.mjs';
import { classifyIntent, MASTER_SYSTEM_PROMPT, AGENT_PROMPTS } from './agents/master.mjs';
import { JARVIS_TOOLS, executeJarvisTool } from './skills/loader.mjs';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

// Modo conversa: Jarvis fica escutando 3 min após responder
const activeConversations = new Map();

export function markConversationActive(chatId) {
  activeConversations.set(chatId, Date.now());
}

export function isConversationActive(chatId) {
  const lastResponse = activeConversations.get(chatId);
  if (!lastResponse) return false;
  const elapsed = Date.now() - lastResponse;
  if (elapsed > 3 * 60 * 1000) {
    activeConversations.delete(chatId);
    return false;
  }
  return true;
}

export function shouldJarvisRespond(text, chatId, isGroup, isReplyToJarvis) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();

  if (isGroup) {
    if (!JARVIS_ALLOWED_GROUPS.has(chatId)) return false;
    if (lower.includes('jarvis')) return true;
    if (isReplyToJarvis) {
      console.log('[JARVIS] Reply detectado, respondendo...');
      return true;
    }
    if (isConversationActive(chatId)) {
      console.log('[JARVIS] Modo conversa ativo, respondendo...');
      return true;
    }
    return false;
  }

  if (chatId === CONFIG.GUI_JID) return true;
  return false;
}

export function isValidResponse(text) {
  if (!text) return false;
  const cleaned = text.trim();
  if (cleaned.length === 0) return false;
  const lettersOnly = cleaned.replace(/[^a-zA-ZÀ-ÿ\s]/g, '').trim();
  if (lettersOnly.length < 3) return false;
  if (/^[.\s]+$/.test(cleaned)) return false;
  return true;
}

// Encontrar JID da equipe por nome
export function findTeamJid(name) {
  if (!name) return null;
  const lower = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const [key, jid] of teamPhones) {
    const keyNorm = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (keyNorm.includes(lower) || lower.includes(keyNorm)) return jid;
  }
  for (const [key, jid] of teamWhatsApp) {
    const keyNorm = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (keyNorm.includes(lower) || lower.includes(keyNorm)) return jid;
  }
  return null;
}

// Auto-detectar @mentions no texto
export function extractMentionsFromText(text) {
  const mentions = [];
  const mentionRegex = /@([A-Za-zÀ-ÿ]+)/g;
  let match;
  while ((match = mentionRegex.exec(text)) !== null) {
    const jid = findTeamJid(match[1]);
    if (jid) mentions.push({ name: match[1], jid });
  }
  return mentions;
}

// ============================================
// GERAÇÃO DE RESPOSTA (com Agent Teams)
// ============================================
export async function generateResponse(text, chatId, senderJid, pushName, isGroup) {
  try {
    const recentMessages = await getRecentMessages(chatId, 20);
    const contactInfo = await getContactInfo(senderJid);
    const groupInfo = await getGroupInfo(chatId);

    // Montar histórico
    const chatHistory = [];
    for (const m of recentMessages) {
      const name = m.push_name || 'Desconhecido';
      if (name === 'Jarvis') {
        chatHistory.push({ role: 'assistant', content: m.text });
      } else {
        chatHistory.push({ role: 'user', content: `[${name}]: ${m.text}` });
      }
    }

    // Consolidar mensagens consecutivas do mesmo role
    const consolidatedHistory = [];
    for (const msg of chatHistory) {
      const last = consolidatedHistory[consolidatedHistory.length - 1];
      if (last && last.role === msg.role) {
        last.content += '\n' + msg.content;
      } else {
        consolidatedHistory.push({ ...msg });
      }
    }

    // Contexto temporal
    const now = new Date();
    const brDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const dayOfWeek = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'][brDate.getDay()];
    const dateStr = brDate.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = brDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const year = brDate.getFullYear();

    // Buscar memórias relevantes (NOVO - Mem0)
    const memoryContext = await getMemoryContext(senderJid, chatId, text);

    // Classificar intenção (Agent Teams)
    const intent = await classifyIntent(text, chatId, isGroup);

    let contextNote = `\n\nCONTEXTO ATUAL:
- Data/hora: ${dayOfWeek}, ${dateStr} ${timeStr} (horario de Brasilia)
- ANO ATUAL: ${year}
- Mensagem de: ${pushName || 'Desconhecido'} (${contactInfo?.role || 'desconhecido'})
- Grupo: ${groupInfo?.name || (isGroup ? 'Grupo desconhecido' : 'Mensagem privada')}
- Total de mensagens na memoria: ${await getMessageCount()}
- Agente ativo: ${intent.agent} (confianca: ${(intent.confidence * 100).toFixed(0)}%)`;

    if (contactInfo?.role === 'owner') {
      contextNote += '\n- ATENCAO: Esta pessoa e o Gui, dono da Stream Lab.';
    }

    contextNote += memoryContext;

    // Escolher prompt baseado no agente classificado
    let systemPrompt = MASTER_SYSTEM_PROMPT;
    if (intent.agent !== 'master' && intent.confidence >= 0.8) {
      const agentPrompt = AGENT_PROMPTS[intent.agent];
      if (agentPrompt) {
        systemPrompt = MASTER_SYSTEM_PROMPT + '\n\n--- MODO ESPECIALISTA ---\n' + agentPrompt;
        console.log(`[AGENT] Agente ${intent.agent} ativado (confianca ${(intent.confidence * 100).toFixed(0)}%)`);
      }
    }

    // Adicionar mensagem atual
    const currentMsg = { role: 'user', content: `[${pushName}]: ${text}` };
    const lastConsolidated = consolidatedHistory[consolidatedHistory.length - 1];
    if (lastConsolidated && lastConsolidated.role === 'user') {
      lastConsolidated.content += '\n' + currentMsg.content;
    } else {
      consolidatedHistory.push(currentMsg);
    }

    if (consolidatedHistory.length > 0 && consolidatedHistory[0].role !== 'user') {
      consolidatedHistory.shift();
    }

    const response = await anthropic.messages.create({
      model: CONFIG.AI_MODEL,
      max_tokens: 1024,
      system: systemPrompt + contextNote,
      messages: consolidatedHistory,
      tools: JARVIS_TOOLS,
    });

    // Processar resposta
    let finalText = '';
    const mentions = [];
    const toolResults = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        finalText += block.text;
      } else if (block.type === 'tool_use') {
        const result = await executeJarvisTool(block.name, block.input, teamPhones);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
        if (result.mention_jid) {
          mentions.push({ name: result.mention_name, jid: result.mention_jid });
        }
      }
    }

    // Follow-up se houve tool_use
    if (toolResults.length > 0 && response.stop_reason === 'tool_use') {
      const followUp = await anthropic.messages.create({
        model: CONFIG.AI_MODEL,
        max_tokens: 500,
        system: systemPrompt + contextNote,
        messages: [...consolidatedHistory, { role: 'assistant', content: response.content }, { role: 'user', content: toolResults }],
      });
      finalText = followUp.content.filter(b => b.type === 'text').map(b => b.text).join('');
    }

    // Auto-detectar @mentions
    const textMentions = extractMentionsFromText(finalText);
    for (const tm of textMentions) {
      if (!mentions.some(m => m.jid === tm.jid)) mentions.push(tm);
    }

    // Nota: processMemory agora roda no handler principal (aprendizado passivo em tempo real)
    // Não precisa rodar aqui de novo — evita duplicação

    return { text: finalText || null, mentions, agent: intent.agent };
  } catch (err) {
    console.error('[AI] Erro ao gerar resposta:', err.message);
    return { text: null, mentions: [], agent: 'master' };
  }
}

// ============================================
// AGENTE PROATIVO — Grupos de Clientes Gerenciados
// Usa memórias + perfis + histórico para agir autonomamente
// ============================================

// Rate limit: evita spam em grupos de clientes
const clientGroupCooldown = new Map(); // groupJid → timestamp
const clientGroupBuffer = new Map();   // groupJid → { messages: [], timer }

/**
 * Processa mensagem de grupo de cliente gerenciado.
 * Em vez de regras rígidas, busca todo o contexto (memórias, perfil, histórico)
 * e deixa o Jarvis decidir autonomamente o que fazer — usando as tools disponíveis.
 */
export async function handleManagedClientMessage(text, senderJid, pushName, chatId, managedClient, sendTextFn) {
  try {
    // Rate limit: 30s entre respostas no mesmo grupo
    const lastResponse = clientGroupCooldown.get(chatId);
    if (lastResponse && Date.now() - lastResponse < 30000) {
      console.log(`[PROACTIVE] Cooldown ativo para ${managedClient.groupName}, ignorando`);
      return null;
    }

    // Consolidação: se cliente manda várias msgs rápidas, espera e processa junto
    const consolidated = await consolidateMessages(chatId, text, pushName);
    if (!consolidated) return null; // Ainda esperando mais mensagens

    console.log(`[PROACTIVE] Processando mensagem de ${pushName} no grupo ${managedClient.groupName}`);

    // Buscar todo o contexto disponível sobre este cliente
    const [recentMessages, memoryContext, clientProfile, groupProfile] = await Promise.all([
      getRecentMessages(chatId, 15),
      getClientFullContext(chatId, senderJid, managedClient, consolidated.text),
      getClientProfile(chatId, managedClient.groupName),
      getGroupInfo(chatId),
    ]);

    // Montar histórico do chat
    const chatHistory = [];
    for (const m of recentMessages) {
      const name = m.push_name || 'Desconhecido';
      if (name === 'Jarvis') {
        chatHistory.push({ role: 'assistant', content: m.text });
      } else {
        chatHistory.push({ role: 'user', content: `[${name}]: ${m.text}` });
      }
    }
    // Consolidar consecutivos
    const consolidatedHistory = [];
    for (const msg of chatHistory) {
      const last = consolidatedHistory[consolidatedHistory.length - 1];
      if (last && last.role === msg.role) {
        last.content += '\n' + msg.content;
      } else {
        consolidatedHistory.push({ ...msg });
      }
    }

    // Adicionar mensagem atual
    const currentMsg = { role: 'user', content: `[${consolidated.pushName}]: ${consolidated.text}` };
    const lastConsolidated = consolidatedHistory[consolidatedHistory.length - 1];
    if (lastConsolidated && lastConsolidated.role === 'user') {
      lastConsolidated.content += '\n' + currentMsg.content;
    } else {
      consolidatedHistory.push(currentMsg);
    }
    if (consolidatedHistory.length > 0 && consolidatedHistory[0].role !== 'user') {
      consolidatedHistory.shift();
    }

    // Contexto temporal
    const now = new Date();
    const brDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const dayOfWeek = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'][brDate.getDay()];
    const dateStr = brDate.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = brDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    const systemPrompt = buildClientAgentPrompt(managedClient, memoryContext, dateStr, timeStr, dayOfWeek);

    // Chamar Claude com tools — ele decide sozinho o que fazer
    const response = await anthropic.messages.create({
      model: CONFIG.AI_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: consolidatedHistory,
      tools: JARVIS_TOOLS,
    });

    // Processar resposta
    let finalText = '';
    const toolResults = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        finalText += block.text;
      } else if (block.type === 'tool_use') {
        const result = await executeJarvisTool(block.name, block.input);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
    }

    // Follow-up se houve tool_use
    if (toolResults.length > 0 && response.stop_reason === 'tool_use') {
      const followUp = await anthropic.messages.create({
        model: CONFIG.AI_MODEL,
        max_tokens: 500,
        system: systemPrompt,
        messages: [...consolidatedHistory, { role: 'assistant', content: response.content }, { role: 'user', content: toolResults }],
      });
      finalText = followUp.content.filter(b => b.type === 'text').map(b => b.text).join('');
    }

    // Decisão do modelo: se retornou texto vazio ou [SILENCIO], não responde
    if (!finalText || finalText.trim() === '' || finalText.includes('[SILENCIO]')) {
      console.log(`[PROACTIVE] Jarvis decidiu ficar em silêncio para ${managedClient.groupName}`);
      return null;
    }

    if (!isValidResponse(finalText)) {
      console.log('[PROACTIVE] Resposta inválida, ignorando');
      return null;
    }

    // Marcar cooldown
    clientGroupCooldown.set(chatId, Date.now());

    console.log(`[PROACTIVE] Resposta para ${managedClient.groupName}: ${finalText.substring(0, 80)}`);
    return { text: finalText, toolResults };
  } catch (err) {
    console.error(`[PROACTIVE] Erro ao processar mensagem de cliente:`, err.message);
    return null; // Silêncio em caso de erro — NUNCA erro para o cliente
  }
}

/**
 * Consolida mensagens rápidas do mesmo grupo (15s de buffer)
 */
function consolidateMessages(chatId, text, pushName) {
  return new Promise((resolve) => {
    let buffer = clientGroupBuffer.get(chatId);
    if (!buffer) {
      buffer = { messages: [], timer: null, resolve: null };
      clientGroupBuffer.set(chatId, buffer);
    }

    buffer.messages.push({ text, pushName });

    // Cancelar timer anterior
    if (buffer.timer) clearTimeout(buffer.timer);
    if (buffer.resolve) buffer.resolve(null); // Resolver anterior como null (ainda bufferizando)

    buffer.resolve = resolve;

    // Esperar 15s após última mensagem
    buffer.timer = setTimeout(() => {
      const msgs = buffer.messages;
      clientGroupBuffer.delete(chatId);

      if (msgs.length === 1) {
        resolve({ text: msgs[0].text, pushName: msgs[0].pushName });
      } else {
        // Consolidar múltiplas mensagens
        const consolidated = msgs.map(m => `[${m.pushName}]: ${m.text}`).join('\n');
        resolve({ text: consolidated, pushName: msgs[msgs.length - 1].pushName });
      }
    }, 15000);
  });
}

/**
 * Busca contexto completo sobre o cliente: memórias, perfil, histórico de trabalho
 */
async function getClientFullContext(chatId, senderJid, managedClient, text) {
  const contexts = [];

  try {
    // 1. Memórias do chat/grupo deste cliente
    const chatMemories = await searchMemories(text, 'chat', chatId, 10);
    if (chatMemories.length > 0) {
      contexts.push('HISTÓRICO E MEMÓRIAS DESTE CLIENTE:');
      chatMemories.forEach(m => contexts.push(`- [${m.category}] ${m.content}`));
    }

    // 2. Memórias sobre a pessoa que mandou a mensagem
    const senderMemories = await searchMemories(text, 'user', senderJid, 5);
    if (senderMemories.length > 0) {
      contexts.push('\nSOBRE QUEM MANDOU A MENSAGEM:');
      senderMemories.forEach(m => contexts.push(`- [${m.category}] ${m.content}`));
    }

    // 3. Conhecimento operacional do Jarvis (processos, regras)
    const agentMemories = await searchMemories('cliente demanda task fluxo processo', 'agent', null, 8);
    if (agentMemories.length > 0) {
      contexts.push('\nCONHECIMENTO OPERACIONAL (como a agência funciona):');
      agentMemories.forEach(m => contexts.push(`- ${m.content}`));
    }

    // 4. Perfil sintetizado do cliente
    try {
      const { rows: profiles } = await pool.query(
        `SELECT entity_type, entity_name, profile FROM jarvis_profiles
         WHERE entity_id = $1 OR entity_name ILIKE $2`,
        [chatId, `%${managedClient.groupName?.split('🔛')[0]?.trim() || ''}%`]
      );
      if (profiles.length > 0) {
        for (const p of profiles) {
          const prof = typeof p.profile === 'string' ? JSON.parse(p.profile) : p.profile;
          contexts.push(`\nPERFIL DO CLIENTE (${p.entity_name || 'desconhecido'}):`);
          for (const [key, val] of Object.entries(prof)) {
            if (val && val !== null) contexts.push(`- ${key}: ${Array.isArray(val) ? val.join(', ') : val}`);
          }
        }
      }
    } catch {}

    // 5. Perfil da pessoa que enviou
    try {
      const { rows: senderProfiles } = await pool.query(
        `SELECT entity_name, profile FROM jarvis_profiles WHERE entity_id = $1`,
        [senderJid]
      );
      if (senderProfiles.length > 0) {
        const p = senderProfiles[0];
        const prof = typeof p.profile === 'string' ? JSON.parse(p.profile) : p.profile;
        contexts.push(`\nPERFIL DE ${p.entity_name || 'esta pessoa'}:`);
        for (const [key, val] of Object.entries(prof)) {
          if (val && val !== null) contexts.push(`- ${key}: ${Array.isArray(val) ? val.join(', ') : val}`);
        }
      }
    } catch {}

    // 6. Homework (instruções diretas do Gui)
    try {
      const { rows } = await pool.query('SELECT content FROM homework ORDER BY created_at DESC LIMIT 20');
      if (rows.length > 0) {
        contexts.push('\n⚠️ INSTRUÇÕES DIRETAS DO GUI (PRIORIDADE MÁXIMA):');
        rows.forEach(r => contexts.push(`- ${r.content}`));
      }
    } catch {}
  } catch (err) {
    console.error('[PROACTIVE] Erro ao buscar contexto:', err.message);
  }

  return contexts.join('\n');
}

/**
 * Busca perfil do cliente pelo nome ou JID
 */
async function getClientProfile(chatId, groupName) {
  try {
    const clientName = groupName?.split('🔛')[0]?.trim() || '';
    const { rows } = await pool.query(
      `SELECT profile FROM jarvis_profiles
       WHERE entity_id = $1 OR entity_name ILIKE $2
       ORDER BY last_updated DESC LIMIT 1`,
      [chatId, `%${clientName}%`]
    );
    if (rows.length > 0) {
      return typeof rows[0].profile === 'string' ? JSON.parse(rows[0].profile) : rows[0].profile;
    }
    return null;
  } catch { return null; }
}

/**
 * Constrói o system prompt para o agente de cliente.
 * NÃO usa regras rígidas — deixa o Jarvis usar seu conhecimento acumulado.
 */
function buildClientAgentPrompt(managedClient, memoryContext, dateStr, timeStr, dayOfWeek) {
  const clientName = managedClient.groupName?.split('🔛')[0]?.trim() || 'Cliente';

  return `Você é JARVIS, assistente de IA da Stream Lab (agência de marketing digital).
Você está operando AUTONOMAMENTE no grupo do cliente *${clientName}*.

O Gui (dono da agência) autorizou você a atuar neste grupo. Você é o representante da Stream Lab aqui.

CONTEXTO:
- Data/hora: ${dayOfWeek}, ${dateStr} ${timeStr} (horário de Brasília)
- Grupo: ${managedClient.groupName || clientName}
- Responsável padrão: ${managedClient.defaultAssignee || 'bruna'}

COMO AGIR:
Você já estudou todo o Asana da agência — projetos, tarefas, históricos, processos.
Use esse conhecimento para entender o que está acontecendo e agir da forma correta.
Cruze os dados: como mensagens de clientes viram tasks? Quem fica responsável? Qual projeto? Qual seção?
Você SABE como funciona porque já aprendeu. Aja com base nisso.

QUANDO AGIR:
- Se o cliente mandou uma demanda de trabalho → responda confirmando, pergunte o que faltar (prazo, referências), crie a task no Asana, avise a equipe
- Se o cliente tem uma dúvida sobre andamento → responda com o que você sabe
- Se o cliente mandou aprovação/feedback → notifique a equipe internamente
- Se é conversa casual, cumprimento ou mensagem irrelevante → [SILENCIO] (NÃO responda)

QUANDO FICAR EM SILÊNCIO:
- Mensagens casuais ("bom dia", "ok", emojis, risadas)
- Assuntos pessoais entre pessoas do grupo
- Mensagens que não são direcionadas à agência
- Se não tem certeza se deve responder → [SILENCIO]
Para ficar em silêncio, responda APENAS com o texto literal: [SILENCIO]

TOM DE VOZ:
- 100% PROFISSIONAL — NUNCA humor, NUNCA referências Marvel, NUNCA zoeira
- Educado, eficiente, direto
- Breve: 2-4 frases no máximo
- Confirme recebimento de demandas
- Pergunte prazo/urgência se não mencionado
- NUNCA invente informação — se não sabe, diga que vai verificar com a equipe

TOOLS DISPONÍVEIS:
- criar_demanda_cliente: para criar tasks no Asana quando identificar uma demanda
- enviar_mensagem_grupo: para notificar a equipe internamente (grupo "tarefas")
- lembrar: para salvar informações importantes sobre o cliente

REGRAS ABSOLUTAS:
- NUNCA altere descrições de tasks no Asana (use SOMENTE comentários)
- NUNCA exponha processos internos da agência para o cliente
- NUNCA mencione ferramentas, Asana, ou detalhes técnicos para o cliente
- Se algo deu errado → silêncio (nunca mostre erro para o cliente)
- Português brasileiro com acentos SEMPRE

${memoryContext ? '\n' + memoryContext : ''}`;
}

// ============================================
// RELATÓRIO DIÁRIO
// ============================================
export async function generateDailyReport() {
  if (!CONFIG.ASANA_PAT) return 'Relatorio indisponivel - Asana nao configurado.';
  try {
    const { getOverdueTasks } = await import('./skills/loader.mjs');
    const overdue = await getOverdueTasks();
    const now = new Date();
    const dateStr = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    let report = `*RELATORIO JARVIS — ${dateStr}*\n\n`;
    if (overdue.length === 0) {
      report += 'Nenhuma task atrasada. Equipe em dia.\n';
    } else {
      report += `*${overdue.length} task(s) atrasada(s):*\n\n`;
      for (const t of overdue.slice(0, 15)) {
        const daysLate = Math.floor((now - new Date(t.due_on)) / (1000 * 60 * 60 * 24));
        report += `- *${t.name}*\n  ${t.project} | ${t.assignee} | ${daysLate} dia(s) de atraso\n\n`;
      }
    }
    report += '\n_Jarvis 2.0, seu gerente de projetos incansavel._';
    return report;
  } catch (err) {
    console.error('[REPORT] Erro:', err.message);
    return 'Erro ao gerar relatorio.';
  }
}
