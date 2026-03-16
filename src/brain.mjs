// ============================================
// JARVIS 3.0 - Cérebro (Agent Loop + Extended Thinking + Prompt Caching)
// ============================================
import Anthropic from '@anthropic-ai/sdk';
import { CONFIG, JARVIS_ALLOWED_GROUPS, teamPhones, teamWhatsApp } from './config.mjs';
import { pool } from './database.mjs';
import { getRecentMessages, getContactInfo, getGroupInfo, getMessageCount } from './database.mjs';
import { getMemoryContext, processMemory, searchMemories } from './memory.mjs';
import { classifyIntent, MASTER_SYSTEM_PROMPT, AGENT_PROMPTS } from './agents/master.mjs';
import { JARVIS_TOOLS, executeJarvisTool } from './skills/loader.mjs';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

// Máximo de iterações no agent loop (evita loops infinitos)
const MAX_AGENT_ITERATIONS = 10;

/**
 * Decide qual modelo usar baseado na complexidade da mensagem.
 * Queries complexas (multi-step, análise profunda, estratégia) → Opus
 * Queries simples (cumprimento, pergunta direta, status) → Sonnet
 */
function chooseModel(text, intent) {
  const strong = CONFIG.AI_MODEL_STRONG;
  if (!strong || strong === CONFIG.AI_MODEL) return CONFIG.AI_MODEL;

  // Indicadores de complexidade que justificam Opus
  const complexPatterns = [
    /\b(analise|analis[ae]r|estrateg|planejar|planejamento|comparar|avaliar)\b/i,
    /\b(relat[oó]rio|diagn[oó]stico|revis[aã]o|auditoria)\b/i,
    /\b(como (funciona|posso|fazer|melhorar|resolver))\b/i,
    /\b(por que|qual (a |o )?melhor|prós e contras)\b/i,
    /\b(crie|monte|elabore|desenvolva|proponha)\b/i,
  ];

  // Texto longo + complexidade = Opus
  const isComplex = text.length > 100 && complexPatterns.some(p => p.test(text));
  // Agente gestor com query longa = Opus
  const isManagerComplex = intent?.agent === 'manager' && text.length > 80;
  // Agente criativo com briefing = Opus
  const isCreativeComplex = intent?.agent === 'creative' && text.length > 120;

  if (isComplex || isManagerComplex || isCreativeComplex) {
    console.log(`[AI] Modelo forte selecionado: ${strong} (complexidade detectada)`);
    return strong;
  }

  return CONFIG.AI_MODEL;
}

/**
 * Executa o Agent Loop completo:
 * 1. Chama Claude com tools
 * 2. Se retornou tool_use → executa tools → alimenta resultados → repete
 * 3. Continua até receber texto final ou atingir MAX_AGENT_ITERATIONS
 *
 * Retorna { text, mentions, toolResults }
 */
async function agentLoop(model, systemPrompt, messages, tools, context = {}) {
  let currentMessages = [...messages];
  let finalText = '';
  const allMentions = [];
  const toolsUsed = new Set(); // Rastrear tools usadas (anti-alucinação)
  let iterations = 0;

  // Configurar thinking baseado no modelo
  const useThinking = true;
  const thinkingConfig = model.includes('opus')
    ? { type: 'enabled', budget_tokens: 8192 }
    : { type: 'enabled', budget_tokens: 4096 };

  while (iterations < MAX_AGENT_ITERATIONS) {
    iterations++;

    const apiParams = {
      model,
      max_tokens: useThinking ? 12000 : 2048,
      system: systemPrompt,
      messages: currentMessages,
      tools: tools || undefined,
      thinking: thinkingConfig,
    };

    // Interleaved thinking para ver raciocínio entre tool calls
    const response = await anthropic.messages.create(apiParams, {
      headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
    });

    // Processar blocos da resposta
    let hasToolUse = false;
    const toolResults = [];
    const assistantContent = [];

    for (const block of response.content) {
      // Preservar todos os blocos (incluindo thinking) para o histórico
      assistantContent.push(block);

      if (block.type === 'text') {
        finalText += block.text;
      } else if (block.type === 'tool_use') {
        hasToolUse = true;
        toolsUsed.add(block.name); // Rastrear tool usada
        console.log(`[AGENT-LOOP] Iteração ${iterations}: tool_use → ${block.name}(${JSON.stringify(block.input).substring(0, 100)})`);
        try {
          const result = await executeJarvisTool(block.name, block.input, context);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
          if (result.mention_jid) {
            allMentions.push({ name: result.mention_name, jid: result.mention_jid });
          }
        } catch (err) {
          console.error(`[AGENT-LOOP] Erro na tool ${block.name}:`, err.message);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ error: err.message }), is_error: true });
        }
      }
      // thinking blocks são preservados no assistantContent mas não geram ação
    }

    // Se não houve tool_use, temos a resposta final
    if (!hasToolUse || response.stop_reason !== 'tool_use') {
      console.log(`[AGENT-LOOP] Concluído em ${iterations} iteração(ões). Tools usadas: [${[...toolsUsed].join(', ')}]`);
      break;
    }

    // Preparar próxima iteração: adicionar assistant content + tool results
    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: assistantContent },
      { role: 'user', content: toolResults },
    ];

    // Reset finalText para pegar apenas o texto da última iteração
    finalText = '';
  }

  if (iterations >= MAX_AGENT_ITERATIONS) {
    console.warn(`[AGENT-LOOP] Atingiu limite de ${MAX_AGENT_ITERATIONS} iterações`);
  }

  return { text: finalText, mentions: allMentions, toolsUsed };
}

// ============================================
// SALVAGUARDA ANTI-ALUCINAÇÃO
// Detecta respostas que INVENTAM dados factuais (horários, conteúdo de mensagens)
// sem ter usado tools para buscar esses dados.
// NÃO bloqueia: confirmações, instruções, ações, planos.
// ============================================
export function antiHallucinationCheck(finalText, toolsUsed) {
  // Se usou tools de busca/consulta nesta iteração, a resposta é baseada em dados reais
  if (toolsUsed.has('buscar_mensagens') || toolsUsed.has('consultar_tarefas') || toolsUsed.has('consultar_task') || toolsUsed.has('buscar_memorias')) {
    return { safe: true };
  }

  // Se usou tools de ação (lembrar, criar_demanda, enviar_mensagem), tá agindo — não bloquear
  if (toolsUsed.has('lembrar') || toolsUsed.has('criar_demanda_cliente') || toolsUsed.has('enviar_mensagem_grupo') || toolsUsed.has('autorizar_cliente') || toolsUsed.has('revogar_cliente')) {
    return { safe: true };
  }

  // Se a resposta é curta (< 200 chars), provavelmente é confirmação/ação — não bloquear
  if (finalText.length < 200) {
    return { safe: true };
  }

  // Padrões que indicam NARRATIVA FABRICADA com dados específicos
  // (o Jarvis está contando uma história detalhada com horários e citações sem ter consultado nada)
  const fabricatedNarrativePatterns = [
    // Narrativa com múltiplos horários específicos (ex: "às 14:07... às 16:03... às 16:05")
    { pattern: /\b\d{1,2}[h:]\d{2}\b/g, minMatches: 3 },
    // Atribuição de falas com horários (ex: "Doug mandou às 14h", "Jarvis respondeu às 11h")
    { pattern: /\b(mandou|enviou|disse|falou|respondeu|escreveu)\s+(às|as)\s*\d{1,2}[h:]\d{2}/gi, minMatches: 2 },
  ];

  for (const { pattern, minMatches } of fabricatedNarrativePatterns) {
    const matches = finalText.match(pattern);
    if (matches && matches.length >= minMatches) {
      console.warn(`[ANTI-HALLUCINATION] ⚠️ Narrativa fabricada detectada: ${matches.length} ocorrências de "${pattern.source}"`);
      return {
        safe: false,
        reason: `Narrativa com ${matches.length} dados específicos sem consulta via tools`,
      };
    }
  }

  return { safe: true };
}

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
export async function generateResponse(text, chatId, senderJid, pushName, isGroup, mediaFiles = []) {
  try {
    const recentMessages = await getRecentMessages(chatId, 20);
    const contactInfo = await getContactInfo(senderJid);
    const groupInfo = await getGroupInfo(chatId);

    // Montar histórico
    // Identificar mensagens do próprio Jarvis por múltiplos critérios
    const botNumber = CONFIG.BOT_NUMBER || '';
    const chatHistory = [];
    for (const m of recentMessages) {
      const isJarvisMsg = m.push_name === 'Jarvis' ||
        m.message_id?.startsWith('jarvis_') ||
        (botNumber && m.sender && m.sender.includes(botNumber));
      // Timestamp para noção temporal
      const timeTag = m.hora_br ? `[${new Date(m.hora_br).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}] ` : '';
      if (isJarvisMsg) {
        chatHistory.push({ role: 'assistant', content: `${timeTag}${m.text}` });
      } else {
        const name = m.push_name || 'Desconhecido';
        chatHistory.push({ role: 'user', content: `${timeTag}[${name}]: ${m.text}` });
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
    let agentSection = '';
    if (intent.agent !== 'master' && intent.confidence >= 0.8) {
      const agentPrompt = AGENT_PROMPTS[intent.agent];
      if (agentPrompt) {
        agentSection = '\n\n--- MODO ESPECIALISTA ---\n' + agentPrompt;
        console.log(`[AGENT] Agente ${intent.agent} ativado (confianca ${(intent.confidence * 100).toFixed(0)}%)`);
      }
    }

    // Prompt Caching: system prompt como array com cache_control
    // Bloco estático (MASTER_SYSTEM_PROMPT) = cacheável (muda raramente)
    // Bloco dinâmico (contextNote) = NÃO cacheável (muda a cada request)
    const systemPrompt = [
      {
        type: 'text',
        text: MASTER_SYSTEM_PROMPT + agentSection,
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: contextNote,
      },
    ];

    // Detectar links de tasks do Asana na mensagem
    let asanaTaskContext = '';
    const asanaLinkMatch = text?.match(/app\.asana\.com\/\d+\/\d+\/(\d+)/);
    if (asanaLinkMatch) {
      const taskGid = asanaLinkMatch[1];
      asanaTaskContext = `\n[TASK EXISTENTE DETECTADA - GID: ${taskGid}] O usuário referenciou uma task que JÁ EXISTE no Asana. Se ele pedir pra anexar arquivos, comentar, ou fazer qualquer ação nessa task, use o GID ${taskGid} diretamente. NÃO crie uma task nova.`;
      console.log(`[BRAIN] Link de task Asana detectado: GID ${taskGid}`);
    }

    // Adicionar mensagem atual (com contexto de mídia se houver)
    let mediaContext = '';
    if (mediaFiles.length > 0) {
      const mediaDesc = mediaFiles.map(f => `📎 ${f.type}: ${f.fileName} (${Math.round(f.size / 1024)}KB) [msg_id: ${f.messageId}]`).join('\n');
      mediaContext = `\n[MÍDIA RECEBIDA - arquivos já baixados e prontos para anexar no Asana via tool "anexar_midia_asana"]\n${mediaDesc}`;
    }
    const currentMsg = { role: 'user', content: `[${pushName}]: ${text || '[enviou mídia]'}${asanaTaskContext}${mediaContext}` };
    const lastConsolidated = consolidatedHistory[consolidatedHistory.length - 1];
    if (lastConsolidated && lastConsolidated.role === 'user') {
      lastConsolidated.content += '\n' + currentMsg.content;
    } else {
      consolidatedHistory.push(currentMsg);
    }

    if (consolidatedHistory.length > 0 && consolidatedHistory[0].role !== 'user') {
      consolidatedHistory.shift();
    }

    // Escolher modelo (Sonnet para simples, Opus para complexo)
    const model = chooseModel(text, intent);

    // Agent Loop: executa tools em loop até resposta final
    const { text: finalText, mentions } = await agentLoop(
      model, systemPrompt, consolidatedHistory, JARVIS_TOOLS, { senderJid, chatId }
    );

    // Auto-detectar @mentions adicionais no texto
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
export async function handleManagedClientMessage(text, senderJid, pushName, chatId, managedClient, sendTextFn, mediaFiles = []) {
  try {
    // Rate limit: 30s entre respostas no mesmo grupo
    const lastResponse = clientGroupCooldown.get(chatId);
    if (lastResponse && Date.now() - lastResponse < 30000) {
      console.log(`[PROACTIVE] Cooldown ativo para ${managedClient.groupName}, ignorando`);
      return null;
    }

    // Consolidação: se cliente manda várias msgs rápidas, espera e processa junto
    // mediaFiles são acumulados no buffer — pega todos quando consolida
    const consolidated = await consolidateMessages(chatId, text, pushName, mediaFiles);
    if (!consolidated) return null; // Ainda esperando mais mensagens

    // Usar mediaFiles acumulados da consolidação (inclui mídia de TODAS as mensagens do buffer)
    const allMediaFiles = consolidated.mediaFiles || mediaFiles;

    console.log(`[PROACTIVE] Processando mensagem de ${pushName} no grupo ${managedClient.groupName}${allMediaFiles.length > 0 ? ` (${allMediaFiles.length} mídia(s))` : ''}`);

    // Buscar todo o contexto disponível sobre este cliente
    const [recentMessages, memoryContext, clientProfile, groupProfile] = await Promise.all([
      getRecentMessages(chatId, 15),
      getClientFullContext(chatId, senderJid, managedClient, consolidated.text),
      getClientProfile(chatId, managedClient.groupName),
      getGroupInfo(chatId),
    ]);

    // Montar histórico do chat
    // Identificar mensagens do Jarvis por múltiplos critérios (push_name, message_id, sender)
    const botNum = CONFIG.BOT_NUMBER || '';
    const chatHistory = [];
    for (const m of recentMessages) {
      const isJarvisMsg = m.push_name === 'Jarvis' ||
        m.message_id?.startsWith('jarvis_') ||
        (botNum && m.sender && m.sender.includes(botNum));
      // Incluir timestamp no histórico para noção temporal
      const timeTag = m.hora_br ? `[${new Date(m.hora_br).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}] ` : '';
      if (isJarvisMsg) {
        chatHistory.push({ role: 'assistant', content: `${timeTag}${m.text}` });
      } else {
        const name = m.push_name || 'Desconhecido';
        chatHistory.push({ role: 'user', content: `${timeTag}[${name}]: ${m.text}` });
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

    // Adicionar mensagem atual (com indicação de mídia se houver)
    let mediaContext = '';
    if (allMediaFiles.length > 0) {
      const mediaDesc = allMediaFiles.map(f => `📎 ${f.type}: ${f.fileName} (${Math.round(f.size / 1024)}KB) [msg_id: ${f.messageId}]`).join('\n');
      mediaContext = `\n[MÍDIA RECEBIDA - arquivos já baixados e prontos para anexar no Asana via tool "anexar_midia_asana"]\n${mediaDesc}`;
    }
    const currentMsg = { role: 'user', content: `[${consolidated.pushName}]: ${consolidated.text}${mediaContext}` };
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

    const clientPromptText = buildClientAgentPrompt(managedClient, memoryContext, dateStr, timeStr, dayOfWeek);

    // Prompt Caching: separar parte estática (prompt do agente) da dinâmica (contexto)
    const systemPrompt = [
      {
        type: 'text',
        text: clientPromptText,
        cache_control: { type: 'ephemeral' },
      },
    ];

    // Agent Loop: executa tools em loop até resposta final
    const { text: finalText, toolsUsed } = await agentLoop(
      CONFIG.AI_MODEL, systemPrompt, consolidatedHistory, JARVIS_TOOLS, { senderJid, chatId }
    );

    // Decisão do modelo: se retornou texto vazio ou [SILENCIO], não responde
    if (!finalText || finalText.trim() === '' || finalText.includes('[SILENCIO]')) {
      console.log(`[PROACTIVE] Jarvis decidiu ficar em silêncio para ${managedClient.groupName}`);
      return null;
    }

    if (!isValidResponse(finalText)) {
      console.log('[PROACTIVE] Resposta inválida, ignorando');
      return null;
    }

    // SALVAGUARDA ANTI-ALUCINAÇÃO: no grupo do cliente é CRÍTICO não inventar dados
    const hallucinationCheck = antiHallucinationCheck(finalText, toolsUsed || new Set());
    if (!hallucinationCheck.safe) {
      console.warn(`[PROACTIVE] ⚠️ ALUCINAÇÃO BLOQUEADA para ${managedClient.groupName}: ${hallucinationCheck.reason}`);
      console.warn(`[PROACTIVE] Texto bloqueado: ${finalText.substring(0, 200)}`);
      return null; // Silêncio é melhor que mentir pro cliente
    }

    // Marcar cooldown
    clientGroupCooldown.set(chatId, Date.now());

    console.log(`[PROACTIVE] Resposta para ${managedClient.groupName}: ${finalText.substring(0, 80)}`);
    return { text: finalText };
  } catch (err) {
    console.error(`[PROACTIVE] Erro ao processar mensagem de cliente:`, err.message);
    return null; // Silêncio em caso de erro — NUNCA erro para o cliente
  }
}

/**
 * Consolida mensagens rápidas do mesmo grupo (15s de buffer)
 */
function consolidateMessages(chatId, text, pushName, mediaFiles = []) {
  return new Promise((resolve) => {
    let buffer = clientGroupBuffer.get(chatId);
    if (!buffer) {
      buffer = { messages: [], mediaFiles: [], timer: null, resolve: null };
      clientGroupBuffer.set(chatId, buffer);
    }

    buffer.messages.push({ text, pushName });
    // Acumular mídia de todas as mensagens consolidadas
    if (mediaFiles.length > 0) {
      buffer.mediaFiles.push(...mediaFiles);
    }

    // Cancelar timer anterior
    if (buffer.timer) clearTimeout(buffer.timer);
    if (buffer.resolve) buffer.resolve(null); // Resolver anterior como null (ainda bufferizando)

    buffer.resolve = resolve;

    // Esperar 15s após última mensagem
    buffer.timer = setTimeout(() => {
      const msgs = buffer.messages;
      const allMedia = buffer.mediaFiles;
      clientGroupBuffer.delete(chatId);

      if (msgs.length === 1) {
        resolve({ text: msgs[0].text, pushName: msgs[0].pushName, mediaFiles: allMedia });
      } else {
        // Consolidar múltiplas mensagens (filtra vazias)
        const consolidated = msgs.filter(m => m.text).map(m => `[${m.pushName}]: ${m.text}`).join('\n');
        resolve({ text: consolidated || `[${msgs[msgs.length - 1].pushName} enviou mídia]`, pushName: msgs[msgs.length - 1].pushName, mediaFiles: allMedia });
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

INTELIGÊNCIA ATIVA — NÃO FIQUE PARADO:
- Se você NÃO SABE algo, PERGUNTE. Nunca fique travado ou diga "vou verificar" sem agir.
- Se a dúvida é operacional (como funciona, quem faz, qual projeto) → pergunte pra Bruna no grupo "tarefas" usando a tool enviar_mensagem_grupo
- Se a dúvida é estratégica (prioridade, decisão importante, aprovação) → pergunte pro Gui no grupo "tarefas"
- Quando receber a resposta (em mensagens futuras), APRENDA com ela usando a tool "lembrar" — assim na próxima vez você já sabe
- Cada interação te torna mais inteligente. Pergunte → Aprenda → Melhore

PROCESSOS DA AGÊNCIA QUE VOCÊ DEVE SEGUIR:
- O grupo "tarefas" (Tarefas Diárias) serve pra cobranças internas quando alguém não responde no Asana em 2h
- TODA demanda de cliente DEVE virar task no Asana com prazo — sem exceção
- Quando criar task e precisar que alguém aja: marque a pessoa na task + avise no grupo "tarefas" com o link
- Se o cliente mandou material (fotos, vídeos, docs), eles foram baixados automaticamente e estão indicados na mensagem como [MÍDIA RECEBIDA]. Use a tool "anexar_midia_asana" para subir esses arquivos na task do Asana — NUNCA ignore material do cliente
- TODA task OBRIGATORIAMENTE precisa ter os campos: urgência e tipo_demanda. Se o cliente não especificou prazo, use urgência "negociavel". Classifique o tipo_demanda com base no conteúdo da demanda (design, audiovisual, marketing, planejamento, etc.)

QUANDO AGIR:
- Cliente mandou demanda de trabalho → responda confirmando, pergunte o que faltar (prazo, referências), crie a task no Asana, ANEXE material se houver, avise a equipe
- Cliente mandou material (fotos, vídeos, documentos) → crie a task + use anexar_midia_asana (basta o task_gid) + avise equipe
- Cliente tem dúvida sobre andamento → responda com o que você sabe. Se não sabe, pergunte internamente e avise o cliente que está verificando
- Cliente mandou aprovação/feedback → notifique a equipe internamente
- Conversa casual, cumprimento ou mensagem irrelevante → [SILENCIO] (NÃO responda)

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
- NUNCA invente informação — se não sabe, diga que está verificando com a equipe E de fato verifique (mande mensagem no grupo tarefas)
- SEMPRE TERMINE SUA RESPOSTA COM UMA PERGUNTA — isso força o cliente a responder e mantém o diálogo ativo (ex: "Podemos seguir assim?", "Tem algum prazo em mente?", "Ficou claro?")

TOOLS DISPONÍVEIS:
- criar_demanda_cliente: para criar tasks no Asana quando identificar uma demanda. OBRIGATÓRIO preencher: urgencia ("24h", "48h", "72h" ou "negociavel") e tipo_demanda ("design", "audiovisual", "marketing", "planejamento", "reuniao", "captacao", "endomarketing", "demanda_extra"). O campo "cliente" é o nome do cliente. Se souber o tier do cliente, preencha também.
- anexar_midia_asana: para subir fotos/vídeos/docs do WhatsApp na task do Asana. Basta passar o task_gid — encontra e envia todos os arquivos recentes automaticamente.
- consultar_task: para ver detalhes de uma task específica (nome, responsável, prazo, comentários). Use ANTES de responder sobre qualquer task.
- comentar_task: para adicionar comentário em uma task do Asana, com @menção de pessoas.
- atualizar_task: para mudar responsável, prazo, ou marcar como concluída. NUNCA altera descrição.
- buscar_memorias: para consultar o que você já sabe sobre clientes, processos, regras. Use ANTES de inventar.
- enviar_mensagem_grupo: para notificar/perguntar pra equipe internamente (grupo "tarefas") — USE SEMPRE que precisar avisar, perguntar, ou tirar dúvida com a equipe
- lembrar: para salvar informações importantes sobre o cliente — USE para guardar tudo que aprender

⚠️ ATENÇÃO MÁXIMA — SEPARAÇÃO INTERNO vs EXTERNO:
Você fala em DOIS contextos diferentes:
1. RESPOSTA DIRETA (o texto que você retorna) → vai para o GRUPO DO CLIENTE. Deve ser 100% profissional, sem NENHUMA menção a ferramentas, Asana, tasks, ou processos internos.
2. NOTIFICAÇÃO INTERNA (via tool enviar_mensagem_grupo para "tarefas") → vai para o grupo INTERNO da equipe. Aqui pode ter detalhes operacionais.

NUNCA misture os dois. Sua resposta direta NUNCA deve conter:
- "task criada", "Asana", "Cabine de Comando"
- "executado", "equipe avisada", "Bruna notificada"
- Checklists de ações internas (✅ task, ✅ equipe)
- Qualquer menção a processos, ferramentas ou nomes de pessoas da equipe

Se precisar executar ações (criar task, avisar equipe), faça via tools SILENCIOSAMENTE. Sua resposta ao cliente deve ser APENAS o que o cliente precisa saber.

REGRAS ABSOLUTAS:
- NUNCA altere descrições de tasks no Asana (use SOMENTE comentários)
- NUNCA exponha processos internos da agência para o cliente
- NUNCA mencione ferramentas, Asana, ou detalhes técnicos para o cliente
- NUNCA envie mais de UMA mensagem por interação no grupo do cliente — se precisa dizer várias coisas, junte tudo numa só mensagem
- Se algo deu errado → silêncio (nunca mostre erro para o cliente)
- Português brasileiro com acentos SEMPRE

${memoryContext ? '\n' + memoryContext : ''}`;
}

// ============================================
// RELATÓRIO DIÁRIO (melhorado com 4 categorias)
// ============================================
export async function generateDailyReport() {
  if (!CONFIG.ASANA_PAT) return 'Relatório indisponível - Asana não configurado.';
  try {
    const { getTasksSummary } = await import('./skills/loader.mjs');
    const summary = await getTasksSummary();
    const now = new Date();
    const dateStr = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const dayNames = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
    const dayOfWeek = dayNames[new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).getDay()];

    let report = `📋 *RELATÓRIO JARVIS — ${dayOfWeek}, ${dateStr}*\n\n`;

    // Tasks atrasadas
    if (summary.atrasadas.length > 0) {
      report += `⏰ *${summary.atrasadas.length} task(s) ATRASADA(S):*\n`;
      for (const t of summary.atrasadas.slice(0, 10)) {
        const daysLate = Math.floor((now - new Date(t.due_on)) / (1000 * 60 * 60 * 24));
        report += `• *${t.name}* — ${t.assignee} (${daysLate}d atraso)\n  ${t.project}\n`;
      }
      report += '\n';
    }

    // Tasks vencendo hoje
    if (summary.vencendo_hoje.length > 0) {
      report += `📅 *${summary.vencendo_hoje.length} task(s) VENCEM HOJE:*\n`;
      for (const t of summary.vencendo_hoje.slice(0, 10)) {
        report += `• *${t.name}* — ${t.assignee}\n  ${t.project}\n`;
      }
      report += '\n';
    }

    // Tasks vencendo amanhã (preventivo)
    if (summary.vencendo_amanha.length > 0) {
      report += `⚠️ *${summary.vencendo_amanha.length} task(s) VENCEM AMANHÃ:*\n`;
      for (const t of summary.vencendo_amanha.slice(0, 10)) {
        report += `• *${t.name}* — ${t.assignee}\n  ${t.project}\n`;
      }
      report += '\n';
    }

    // Tasks concluídas ontem
    if (summary.concluidas_ontem.length > 0) {
      report += `✅ *${summary.concluidas_ontem.length} task(s) concluída(s) ontem:*\n`;
      for (const t of summary.concluidas_ontem.slice(0, 8)) {
        report += `• ${t.name} — ${t.assignee}\n`;
      }
      report += '\n';
    }

    // Tudo em dia
    if (summary.atrasadas.length === 0 && summary.vencendo_hoje.length === 0) {
      report += '🟢 Nenhuma task atrasada ou vencendo hoje. Equipe em dia!\n\n';
    }

    report += '_Jarvis 3.0 — seu gestor de projetos 24/7_ 🤖';
    return report;
  } catch (err) {
    console.error('[REPORT] Erro:', err.message);
    return 'Erro ao gerar relatório.';
  }
}

// ============================================
// COBRANÇA AUTOMÁTICA (estilo Camile)
// ============================================
export async function runOverdueCheck() {
  if (!CONFIG.ASANA_PAT) return;
  try {
    const { getOverdueTasks, getSendFunction, getSendWithMentionsFunction, asanaRequest, asanaWrite } = await import('./skills/loader.mjs');
    const { searchMemories } = await import('./memory.mjs');
    const { TEAM_ASANA } = await import('./config.mjs');
    const sendFn = getSendFunction();
    if (!sendFn || !CONFIG.GROUP_TAREFAS) {
      console.log('[COBRANCA] WhatsApp não conectado ou grupo tarefas não configurado');
      return;
    }

    const overdue = await getOverdueTasks();
    if (overdue.length === 0) {
      console.log('[COBRANCA] Nenhuma task atrasada');
      return;
    }

    // Controle anti-spam: não cobrar a mesma task 2x no mesmo dia
    let notified = {};
    try {
      const { rows } = await pool.query("SELECT value FROM jarvis_config WHERE key = 'overdue_notified'");
      if (rows.length > 0) {
        notified = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
      }
    } catch {}

    const today = new Date().toISOString().split('T')[0];
    for (const gid of Object.keys(notified)) {
      if (notified[gid] !== today) delete notified[gid];
    }

    const toCobrar = overdue.filter(t => !notified[t.gid]);
    if (toCobrar.length === 0) {
      console.log('[COBRANCA] Todas as tasks atrasadas já foram cobradas hoje');
      return;
    }

    // Inverter TEAM_ASANA para buscar GID pelo nome (suporta match parcial: "Bruno Faccin" → "bruno")
    const teamEntries = Object.entries(TEAM_ASANA); // [["gui","123"], ["bruno","456"], ...]
    function findTeamGid(fullName) {
      if (!fullName) return null;
      const lower = fullName.toLowerCase();
      // Match exato primeiro
      for (const [name, gid] of teamEntries) {
        if (lower === name) return gid;
      }
      // Match pelo primeiro nome
      const firstName = lower.split(/\s+/)[0];
      for (const [name, gid] of teamEntries) {
        if (firstName === name) return gid;
      }
      // Match parcial (nome do time contido no nome completo)
      for (const [name, gid] of teamEntries) {
        if (lower.includes(name)) return gid;
      }
      return null;
    }

    // Claude para gerar comentários contextualizados
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

    // Lista da equipe real (pra evitar alucinação de nomes)
    const teamNames = Object.keys(TEAM_ASANA).map(n => n.charAt(0).toUpperCase() + n.slice(1));
    const teamList = [...new Set(teamNames)].join(', ');

    const now = new Date();
    const allCommentResults = []; // Todos os resultados pra expor no grupo no final

    // Processar task por task (não agrupa por responsável — processa todas em sequência)
    for (const t of toCobrar.slice(0, 10)) {
      if (notified[t.gid]) continue;
      const daysLate = Math.floor((now - new Date(t.due_on)) / (1000 * 60 * 60 * 24));

      // ============================================
      // FASE 1: Coleta de inteligência completa
      // ============================================
      let taskContext = `TASK: ${t.name}\nGID: ${t.gid}\nPrazo: ${t.due_on} (${daysLate} dias de atraso)\nResponsável: ${t.assignee || 'Sem responsável'}\nProjeto: ${t.project}`;

      // 1A. Detalhes completos da task no Asana (descrição, seção, campos, followers)
      let followers = [];
      let sectionName = '';
      let projectName = t.project;
      try {
        const taskDetail = await asanaRequest(`/tasks/${t.gid}?opt_fields=name,notes,memberships.section.name,memberships.project.name,custom_fields.name,custom_fields.display_value,followers.name,num_subtasks`);
        if (taskDetail?.data) {
          const td = taskDetail.data;
          if (td.notes) taskContext += `\nDescrição da task: ${td.notes.substring(0, 600)}`;
          if (td.memberships?.[0]?.section?.name) {
            sectionName = td.memberships[0].section.name;
            taskContext += `\nSeção atual no Asana: ${sectionName}`;
          }
          if (td.memberships?.[0]?.project?.name) {
            projectName = td.memberships[0].project.name;
            taskContext += `\nProjeto: ${projectName}`;
          }
          const customFields = (td.custom_fields || []).filter(cf => cf.display_value);
          if (customFields.length) taskContext += `\nCampos custom: ${customFields.map(cf => `${cf.name}: ${cf.display_value}`).join(', ')}`;
          if (td.followers && td.followers.length > 0) {
            followers = td.followers.map(f => f.name).filter(Boolean);
            taskContext += `\nPessoas envolvidas (followers): ${followers.join(', ')}`;
          }
          if (td.num_subtasks > 0) taskContext += `\nSubtasks: ${td.num_subtasks}`;
        }
      } catch (e) { console.error(`[COBRANCA] Erro ao buscar detalhes task ${t.gid}:`, e.message); }

      // 1B. Últimos comentários da task
      try {
        const stories = await asanaRequest(`/tasks/${t.gid}/stories?opt_fields=text,created_by.name,created_at,type&limit=15`);
        if (stories?.data) {
          const comments = stories.data.filter(s => s.type === 'comment').slice(-5);
          if (comments.length > 0) {
            taskContext += `\n\nÚLTIMOS COMENTÁRIOS NA TASK:`;
            for (const c of comments) {
              const date = new Date(c.created_at).toLocaleDateString('pt-BR');
              taskContext += `\n- ${c.created_by?.name || '?'} (${date}): ${(c.text || '').substring(0, 300)}`;
            }
          } else {
            taskContext += `\n\nNenhum comentário na task — nunca houve movimentação via comentários.`;
          }
        }
      } catch (e) { console.error(`[COBRANCA] Erro ao buscar stories task ${t.gid}:`, e.message); }

      // 1C. MEMÓRIAS DO JARVIS — cruzar com dados do estudo do Asana + conversas do WhatsApp
      try {
        // Buscar pelo nome da task
        const taskMemories = await searchMemories(t.name, 'agent', null, 5);
        // Buscar pelo cliente (extrair do nome da task entre colchetes, ex: [MINNER])
        const clientMatch = t.name.match(/\[([^\]]+)\]/);
        let clientMemories = [];
        if (clientMatch) {
          clientMemories = await searchMemories(clientMatch[1], null, null, 5);
        }
        // Buscar pelo responsável
        const assigneeMemories = t.assignee && t.assignee !== 'Sem responsável'
          ? await searchMemories(t.assignee, null, null, 3) : [];

        const allMemories = [...taskMemories, ...clientMemories, ...assigneeMemories];
        // Deduplicar por conteúdo
        const seen = new Set();
        const uniqueMemories = allMemories.filter(m => {
          if (seen.has(m.content)) return false;
          seen.add(m.content);
          return true;
        });

        if (uniqueMemories.length > 0) {
          taskContext += `\n\nMEMÓRIAS RELEVANTES DO JARVIS (dados do estudo do Asana + conversas):`;
          for (const m of uniqueMemories.slice(0, 8)) {
            taskContext += `\n- [${m.category}] ${m.content}`;
          }
        }
      } catch (e) { console.error(`[COBRANCA] Erro ao buscar memórias:`, e.message); }

      // 1D. Mensagens recentes do WhatsApp sobre o assunto (se houver grupo do cliente)
      try {
        const clientMatch = t.name.match(/\[([^\]]+)\]/);
        if (clientMatch) {
          const clientName = clientMatch[1].toLowerCase();
          // Buscar memórias de chat que mencionem o cliente
          const chatMemories = await searchMemories(clientName, 'chat', null, 3);
          if (chatMemories.length > 0) {
            taskContext += `\n\nCONVERSAS RECENTES NO WHATSAPP sobre ${clientMatch[1]}:`;
            for (const m of chatMemories) {
              taskContext += `\n- ${m.content}`;
            }
          }
        }
      } catch (e) {}

      // ============================================
      // FASE 2: Gerar comentário inteligente via Claude
      // ============================================
      // Montar lista de TODOS os envolvidos pra mencionar
      const allInvolved = new Set();
      if (t.assignee && t.assignee !== 'Sem responsável') allInvolved.add(t.assignee);
      for (const f of followers) {
        // Só adicionar se é da equipe (tem GID no TEAM_ASANA)
        if (findTeamGid(f)) allInvolved.add(f);
      }

      let commentText = '';
      let mentionGids = []; // Quem mencionar no comentário do Asana
      try {
        const aiResponse = await anthropic.messages.create({
          model: CONFIG.AI_MODEL,
          max_tokens: 400,
          system: `Você é o Jarvis, gerente de projetos da agência Stream Lab. Gere um comentário para a task atrasada.

EQUIPE DA STREAM LAB (ÚNICOS nomes que você pode referenciar): ${teamList}
QUALQUER outro nome que apareça na descrição/comentários é CLIENTE ou EXTERNO — NUNCA mencione como se fosse da equipe.

CONTEXTO COMPLETO: Você tem acesso a dados do Asana, memórias e histórico. USE TUDO pra formular uma cobrança INTELIGENTE.

REGRAS ABSOLUTAS:
1. ENTENDA do que se trata a task — leia descrição, comentários, memórias
2. Cobrança ESPECÍFICA sobre o conteúdo — "o planner de março precisa ser finalizado" é bom, "pode dar retorno?" é PROIBIDO
3. Se já houve progresso nos comentários, reconheça e pergunte O QUE FALTA
4. Se tem conversa no WhatsApp relevante (ex: cliente cobrou), mencione — "o cliente já cobrou no grupo"
5. Se nunca teve comentário, pergunte se já foi iniciada
6. Se a seção indica fase específica (ex: "Aprovação cliente"), cobre sobre AQUELA fase
7. 2-3 frases no máximo. Tom direto, profissional, sem "Olá" nem "Oi"
8. NUNCA invente nomes de pessoas — só use nomes que aparecem EXPLICITAMENTE nos dados. Se a descrição menciona um nome externo (ex: "Gabriel", "Márcio", "Fernanda"), refira-se a eles como "o cliente" ou pelo contexto, NUNCA como se fossem da equipe
9. NUNCA comece com "@NomeDaPessoa" — a menção já é feita automaticamente pelo sistema
10. Responda SOMENTE o texto do comentário, sem aspas nem prefixo`,
          messages: [{ role: 'user', content: taskContext }],
        });
        commentText = aiResponse.content[0]?.text?.trim() || '';
      } catch (aiErr) {
        console.error(`[COBRANCA] Erro Claude:`, aiErr.message);
        commentText = `Essa task está com ${daysLate} dia(s) de atraso desde ${new Date(t.due_on).toLocaleDateString('pt-BR')}. Qual o status atual?`;
      }

      if (!commentText) commentText = `Essa task está com ${daysLate} dia(s) de atraso. Qual o status atual?`;

      // ============================================
      // FASE 3: Comentar no Asana mencionando TODOS os envolvidos
      // ============================================
      // Montar HTML com @mentions de todos os envolvidos
      let mentionsHtml = '';
      const mentionedNames = [];
      for (const person of allInvolved) {
        const gid = findTeamGid(person);
        if (gid) {
          mentionsHtml += `<a data-asana-gid="${gid}"/> `;
          mentionedNames.push(person);
        }
      }

      const commentBody = mentionsHtml
        ? { html_text: `<body>${mentionsHtml}${commentText}</body>` }
        : { text: commentText };

      const result = await asanaWrite('POST', `/tasks/${t.gid}/stories`, commentBody);
      if (result.success) {
        console.log(`[COBRANCA] ✅ Task ${t.gid} — mencionou [${mentionedNames.join(', ')}]: "${commentText.substring(0, 80)}..."`);
        allCommentResults.push({
          task: t, comment: commentText, daysLate,
          mentioned: mentionedNames, section: sectionName, project: projectName,
        });
      } else {
        console.error(`[COBRANCA] ❌ Erro ao comentar task ${t.gid}:`, result.error);
      }

      notified[t.gid] = today;
      await new Promise(r => setTimeout(r, 1500));
    }

    // ============================================
    // FASE 4: Expor no grupo Tarefas Diárias com menções REAIS no WhatsApp
    // ============================================
    if (allCommentResults.length > 0) {
      const sendWithMentions = getSendWithMentionsFunction();

      // Agrupar por responsável
      const byPerson = {};
      for (const r of allCommentResults) {
        const name = r.task.assignee || 'Sem responsável';
        if (!byPerson[name]) byPerson[name] = [];
        byPerson[name].push(r);
      }

      for (const [person, results] of Object.entries(byPerson)) {
        if (person === 'Sem responsável') continue;

        // Resolver JID do WhatsApp pra menção real
        const firstName = person.split(/\s+/)[0].toLowerCase();
        const whatsappJid = teamWhatsApp.get(firstName) || teamPhones.get(firstName);

        let msg = `📋 *Cobrança automática — @${person}*\n\n`;
        msg += `Comentei nas seguintes tasks no Asana:\n\n`;
        for (const { task: t, comment, daysLate, section } of results) {
          const url = `https://app.asana.com/0/${t.projectGid}/${t.gid}`;
          msg += `• *${t.name}*${section ? ` (${section})` : ''} — ${daysLate}d atraso\n`;
          msg += `  💬 _"${comment.substring(0, 120)}${comment.length > 120 ? '...' : ''}"_\n`;
          msg += `  ${url}\n\n`;
        }
        msg += `⚠️ Verifica no Asana e responde nos comentários das tasks.`;

        // Enviar com menção real no WhatsApp (a pessoa recebe notificação)
        if (whatsappJid && sendWithMentions) {
          await sendWithMentions(CONFIG.GROUP_TAREFAS, msg, [{ jid: whatsappJid }]);
          console.log(`[COBRANCA] WhatsApp com menção real: ${person} (${whatsappJid})`);
        } else {
          await sendFn(CONFIG.GROUP_TAREFAS, msg);
          console.log(`[COBRANCA] WhatsApp sem menção (JID não encontrado): ${person}`);
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      console.log(`[COBRANCA] Concluída: ${allCommentResults.length} tasks cobradas com inteligência completa`);
    }

    // Salvar controle anti-spam
    await pool.query(
      "INSERT INTO jarvis_config (key, value) VALUES ('overdue_notified', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [JSON.stringify(notified)]
    ).catch(() => {});

  } catch (err) {
    console.error('[COBRANCA] Erro:', err.message);
  }
}
