// ============================================
// JARVIS 2.0 - Cérebro (AI Brain + Agent Teams)
// ============================================
import Anthropic from '@anthropic-ai/sdk';
import { CONFIG, JARVIS_ALLOWED_GROUPS, teamPhones, teamWhatsApp } from './config.mjs';
import { getRecentMessages, getContactInfo, getGroupInfo, getMessageCount } from './database.mjs';
import { getMemoryContext, processMemory } from './memory.mjs';
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
