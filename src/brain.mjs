// ============================================
// JARVIS 4.0 - Cérebro (Agent Loop + Extended Thinking + Prompt Caching)
// ============================================
import Anthropic from '@anthropic-ai/sdk';
import { CONFIG, JARVIS_ALLOWED_GROUPS, teamPhones, teamWhatsApp, isManagedClientGroup } from './config.mjs';
import { pool } from './database.mjs';
import { getRecentMessages, getContactInfo, getGroupInfo, getMessageCount, upsertPublicConversation, getPublicConversation, incrementPublicMessages } from './database.mjs';
import { getMemoryContext, processMemory, searchMemories, smartSearchMemories } from './memory.mjs';
import { loadBrainDocument } from './brain-document.mjs';
import { classifyIntent, JARVIS_IDENTITY, AGENT_EXPERTISE, CHANNEL_CONTEXT, MASTER_SYSTEM_PROMPT, AGENT_PROMPTS } from './agents/master.mjs';
import { JARVIS_TOOLS, executeJarvisTool } from './skills/loader.mjs';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

// Máximo de iterações no agent loop (evita loops infinitos)
const MAX_AGENT_ITERATIONS = 10;

/**
 * Decide qual modelo usar baseado na complexidade da mensagem.
 * Queries complexas (multi-step, análise profunda, estratégia) → Opus
 * Queries simples (cumprimento, pergunta direta, status) → Sonnet
 */
function chooseModel(text, intent, context = {}) {
  const strong = CONFIG.AI_MODEL_STRONG;
  if (!strong || strong === CONFIG.AI_MODEL) return CONFIG.AI_MODEL;

  // DM com o Gui ou Dashboard = SEMPRE Opus (ele quer qualidade máxima)
  if (context.isDM || context.isDashboard) {
    console.log(`[AI] Modelo forte selecionado: ${strong} (comunicação direta — Opus obrigatório)`);
    return strong;
  }

  // Agentes especializados que precisam de raciocínio complexo = Opus
  if (intent?.agent && ['traffic', 'manager', 'researcher'].includes(intent.agent)) {
    console.log(`[AI] Modelo forte selecionado: ${strong} (agente ${intent.agent} — requer raciocínio)`);
    return strong;
  }

  // Indicadores de complexidade que justificam Opus
  const complexPatterns = [
    /\b(analise|analis[ae]r|estrateg|planejar|planejamento|comparar|avaliar)\b/i,
    /\b(relat[oó]rio|diagn[oó]stico|revis[aã]o|auditoria)\b/i,
    /\b(como (funciona|posso|fazer|melhorar|resolver))\b/i,
    /\b(por que|qual (a |o )?melhor|prós e contras)\b/i,
    /\b(crie|monte|elabore|desenvolva|proponha)\b/i,
  ];

  // Texto com complexidade = Opus (removido requisito de >100 chars)
  const isComplex = complexPatterns.some(p => p.test(text));
  // Agente criativo com briefing = Opus
  const isCreativeComplex = intent?.agent === 'creative' && text.length > 80;

  if (isComplex || isCreativeComplex) {
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
export async function agentLoop(model, systemPrompt, messages, tools, context = {}, options = {}) {
  let currentMessages = [...messages];
  let finalText = '';
  const allMentions = [];
  const toolsUsed = new Set(); // Rastrear tools usadas (anti-alucinação)
  let iterations = 0;

  // Configurar thinking — pode ser desabilitado via options.thinking = false
  const useThinking = options.thinking !== false;
  const thinkingConfig = useThinking
    ? { type: 'enabled', budget_tokens: options.thinkingBudget || (model.includes('opus') ? 8192 : 4096) }
    : undefined;

  while (iterations < MAX_AGENT_ITERATIONS) {
    iterations++;

    const apiParams = {
      model,
      max_tokens: options.maxTokens || (useThinking ? 12000 : 2048),
      system: systemPrompt,
      messages: currentMessages,
      tools: tools || undefined,
    };
    if (thinkingConfig) apiParams.thinking = thinkingConfig;

    // Interleaved thinking para ver raciocínio entre tool calls
    const headers = useThinking ? { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } : {};
    const response = await anthropic.messages.create(apiParams, { headers });

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
  if (toolsUsed.has('buscar_mensagens') || toolsUsed.has('consultar_tarefas') || toolsUsed.has('consultar_task') || toolsUsed.has('buscar_memorias') || toolsUsed.has('relatorio_ads') || toolsUsed.has('metricas_post') || toolsUsed.has('calendario_editorial') || toolsUsed.has('otimizar_campanha') || toolsUsed.has('baixar_anexos_task') || toolsUsed.has('listar_conjuntos') || toolsUsed.has('buscar_localizacao_ads')) {
    return { safe: true };
  }

  // Se usou tools de ação (lembrar, criar_demanda, enviar_mensagem, ads, posts, mover, atribuir), tá agindo — não bloquear
  if (toolsUsed.has('lembrar') || toolsUsed.has('criar_demanda_cliente') || toolsUsed.has('enviar_mensagem_grupo') || toolsUsed.has('autorizar_cliente') || toolsUsed.has('revogar_cliente') || toolsUsed.has('criar_campanha') || toolsUsed.has('pausar_campanha') || toolsUsed.has('agendar_post') || toolsUsed.has('criar_conjunto_anuncios') || toolsUsed.has('subir_imagem_ads') || toolsUsed.has('criar_criativo_ads') || toolsUsed.has('criar_anuncio') || toolsUsed.has('pipeline_asana_meta') || toolsUsed.has('ativar_desativar_ads') || toolsUsed.has('mover_task_secao') || toolsUsed.has('atribuir_task')) {
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

export function shouldJarvisRespond(text, chatId, isGroup, isReplyToJarvis, isMentionedByTag = false) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();

  if (isGroup) {
    if (!JARVIS_ALLOWED_GROUPS.has(chatId)) return false;
    if (lower.includes('jarvis')) return true;
    if (isMentionedByTag) {
      console.log('[JARVIS] @menção detectada via metadata, respondendo...');
      return true;
    }
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
      // Timestamp só nas mensagens dos usuários — NUNCA nas do assistente (o Claude copia o padrão)
      const timeTag = m.hora_br ? `[${new Date(m.hora_br).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}] ` : '';
      if (isJarvisMsg) {
        chatHistory.push({ role: 'assistant', content: m.text });
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

    // Buscar Cérebro Persistente (conhecimento sintetizado, atualizado 1x/dia)
    const brainDocument = await loadBrainDocument();

    // Buscar memórias relevantes específicas à conversa (complementa o cérebro)
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

    // Expertise do agente (NÃO redefine personalidade, só foca)
    let expertiseSection = '';
    if (intent.agent !== 'master' && intent.confidence >= 0.8) {
      const expertise = AGENT_EXPERTISE[intent.agent];
      if (expertise) {
        expertiseSection = '\n\n' + expertise;
        console.log(`[AGENT] Agente ${intent.agent} ativado (confianca ${(intent.confidence * 100).toFixed(0)}%)`);
      }
    }

    // Prompt Caching: system prompt como array com cache_control
    // Bloco 1: Identidade + canal + expertise = cacheável
    // Bloco 2: Cérebro Persistente = cacheável (muda 1x/dia)
    // Bloco 3: Contexto dinâmico = NÃO cacheável (muda a cada request)
    const systemPrompt = [
      {
        type: 'text',
        text: JARVIS_IDENTITY + '\n\n' + CHANNEL_CONTEXT.whatsapp_internal + expertiseSection,
        cache_control: { type: 'ephemeral' },
      },
    ];

    // Injetar Cérebro Persistente como bloco cacheável (se existir)
    if (brainDocument) {
      systemPrompt.push({
        type: 'text',
        text: '\n\n' + brainDocument,
        cache_control: { type: 'ephemeral' },
      });
    }

    systemPrompt.push({
      type: 'text',
      text: contextNote,
    });

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

    // Escolher modelo — DM com Gui = SEMPRE Opus, grupos = depende da complexidade
    const isDM = !isGroup && senderJid === CONFIG.GUI_JID;
    const model = chooseModel(text, intent, { isDM });

    // Agent Loop: executa tools em loop até resposta final
    const { text: finalText, mentions } = await agentLoop(
      model, systemPrompt, consolidatedHistory, JARVIS_TOOLS, { senderJid, chatId }
    );

    // ANTI-LEAK: se está em grupo de cliente, aplicar filtros de segurança
    if (isGroup && finalText) {
      const managedClient = isManagedClientGroup(chatId);
      if (managedClient) {
        // Check [SILENCIO] normalizado
        if (/\[\s*sil[eê]ncio\s*\]/i.test(finalText)) {
          console.log(`[BRAIN] Silêncio detectado em grupo de cliente ${managedClient.groupName}`);
          return { text: null, mentions: [], agent: intent.agent };
        }
        // Anti-leak: bloquear vazamento de info interna
        const leakCheck = checkInternalLeak(finalText);
        if (leakCheck.leaked) {
          console.warn(`[BRAIN] ⚠️ VAZAMENTO BLOQUEADO em ${managedClient.groupName}: "${leakCheck.match}"`);
          console.warn(`[BRAIN] Texto bloqueado: ${finalText.substring(0, 300)}`);
          return { text: null, mentions: [], agent: intent.agent };
        }
      }
    }

    // Auto-detectar @mentions adicionais no texto
    const textMentions = extractMentionsFromText(finalText);
    for (const tm of textMentions) {
      if (!mentions.some(m => m.jid === tm.jid)) mentions.push(tm);
    }

    // Nota: processMemory agora roda no handler principal (aprendizado passivo em tempo real)
    // Não precisa rodar aqui de novo — evita duplicação

    // Detectar respostas curtas de humor/brincadeira → sugerir envio como áudio (mais humano)
    const sendAsAudio = isGroup && finalText && finalText.length <= 120 && finalText.length >= 5
      && !finalText.includes('http') && !finalText.includes('asana.com')
      && mentions.length === 0
      && Math.random() < 0.35; // 35% de chance de mandar como áudio em respostas curtas

    return { text: finalText || null, mentions, agent: intent.agent, sendAsAudio };
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
      // Timestamp só nas mensagens dos usuários (para noção temporal). NUNCA nas do assistente — o Claude copia o padrão e inclui [HH:MM] na resposta
      const timeTag = m.hora_br ? `[${new Date(m.hora_br).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}] ` : '';
      if (isJarvisMsg) {
        chatHistory.push({ role: 'assistant', content: m.text });
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

    // Carregar Cérebro Persistente pro agente proativo também
    const brainDoc = await loadBrainDocument();

    // Prompt Caching: separar parte estática (prompt do agente) da dinâmica (contexto)
    const systemPrompt = [
      {
        type: 'text',
        text: clientPromptText,
        cache_control: { type: 'ephemeral' },
      },
    ];

    // Injetar Cérebro Persistente (se existir)
    if (brainDoc) {
      systemPrompt.push({
        type: 'text',
        text: '\n\n' + brainDoc,
        cache_control: { type: 'ephemeral' },
      });
    }

    // Agent Loop: executa tools em loop até resposta final
    const { text: finalText, toolsUsed } = await agentLoop(
      CONFIG.AI_MODEL, systemPrompt, consolidatedHistory, JARVIS_TOOLS, { senderJid, chatId }
    );

    // Decisão do modelo: se retornou texto vazio ou [SILENCIO] (normalizado), não responde
    if (!finalText || finalText.trim() === '' || /\[\s*sil[eê]ncio\s*\]/i.test(finalText)) {
      console.log(`[PROACTIVE] Jarvis decidiu ficar em silêncio para ${managedClient.groupName}`);
      return null;
    }

    if (!isValidResponse(finalText)) {
      console.log('[PROACTIVE] Resposta inválida, ignorando');
      return null;
    }

    // SALVAGUARDA ANTI-VAZAMENTO: bloquear menções a processos internos na resposta ao cliente
    // REGRA ABSOLUTA: detectou vazamento → SILÊNCIO TOTAL. Nunca tentar sanitizar — risco alto demais.
    const leakCheck = checkInternalLeak(finalText);
    if (leakCheck.leaked) {
      console.warn(`[PROACTIVE] ⚠️ VAZAMENTO BLOQUEADO para ${managedClient.groupName}: "${leakCheck.match}"`);
      console.warn(`[PROACTIVE] Texto bloqueado (silêncio total): ${finalText.substring(0, 300)}`);
      return null; // SILÊNCIO TOTAL — nunca sanitizar parcialmente
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
    // 1. Memórias de ALTA IMPORTÂNCIA — filtradas por escopo do cliente (NUNCA vazar dados de outro cliente)
    try {
      const { rows: topMems } = await pool.query(
        `SELECT DISTINCT ON (content) content, category, importance
         FROM jarvis_memories WHERE importance >= 8
         AND (scope = 'agent' OR scope_id = $1 OR scope_id = $2)
         ORDER BY content, importance DESC LIMIT 20`,
        [chatId, senderJid]
      );
      if (topMems.length > 0) {
        contexts.push('🧠 CONHECIMENTO FUNDAMENTAL (alta importância):');
        topMems.forEach(m => contexts.push(`- [${m.category}] ${m.content}`));
      }
    } catch {}

    // 2. Memórias do chat/grupo deste cliente (busca inteligente)
    const chatMemories = await smartSearchMemories(text, 'chat', chatId, 15);
    if (chatMemories.length > 0) {
      contexts.push('\nHISTÓRICO E MEMÓRIAS DESTE CLIENTE:');
      chatMemories.forEach(m => contexts.push(`- [${m.category}] ${m.content}`));
    }

    // 3. Memórias sobre a pessoa que mandou a mensagem
    const senderMemories = await smartSearchMemories(text, 'user', senderJid, 10);
    if (senderMemories.length > 0) {
      contexts.push('\nSOBRE QUEM MANDOU A MENSAGEM:');
      senderMemories.forEach(m => contexts.push(`- [${m.category}] ${m.content}`));
    }

    // 4. Conhecimento operacional do Jarvis (processos, regras) — busca ampla
    const agentMemories = await smartSearchMemories(text + ' cliente demanda task fluxo processo regra', 'agent', null, 15);
    if (agentMemories.length > 0) {
      contexts.push('\nCONHECIMENTO OPERACIONAL (como o Lab funciona):');
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

    // 6. Homework — NÃO injetar em contexto de cliente (são instruções internas do Gui)
    // Homework só aparece em generateResponse() via getMemoryContext() (contextos internos)
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
// ============================================
// FILTRO ANTI-VAZAMENTO — bloqueia menções internas na resposta ao cliente
// ============================================
const INTERNAL_LEAK_PATTERNS = [
  // Nomes da equipe (case-insensitive)
  /\b(bruna|nicolas|nícolas|arthur|bruno|rigon|guilherme)\b/i,
  // "Gui" case-sensitive (evita pegar "guia", "guitarra", etc)
  /\bGui\b/,
  // Nomes de outros clientes (cross-client leak)
  /\b(rossato|minner|pippi|digal|quintino|villa rica|masterleds|subsolo|carrion|barazzetti)\b/i,
  // Ferramentas internas
  /\b(asana|trello|cabine de comando|monday|notion)\b/i,
  // Termos de AI/sistema
  /\b(claude|sonnet|opus|anthropic|brain document|c[eé]rebro persistente|model[oa]? de ia|token[s]? de ia)\b/i,
  // Termos de aprendizado interno
  /\b(homework|instru[çc][ãa]o do gui|mem[oó]ria[s]? do jarvis|processMemory|agentLoop)\b/i,
  // Termos de processo interno
  /\b(task criada|task registrada|tarefa criada|equipe (avisada|notificada|informada)|notificad[oa] internamente|registrad[oa] internamente|grupo (tarefas|interno)|notifica[çc][ãa]o interna)\b/i,
  // Ações internas expostas
  /\b(avisei (a |o |ao |à )?(equipe|bruna|nicolas|arthur|gui)|mandei (pra|para|pro|no) (grupo|equipe)|criei (uma |a )?(task|tarefa) (no|do|na))\b/i,
  // Resumos/relatórios internos expostos ao cliente
  /\b(feito,?\s*gui|aqui o resumo|no grupo d[ao]|grupo d[ao]\s+\w+:|resumo.*interno|repassei|encaminhei.*(equipe|interno))\b/i,
  // Referências ao próprio Jarvis como sistema/bot
  /\b(vou anexar|vou registrar|já registrei|preciso do gid|gid da task|anexar na task)\b/i,
  // Raciocínio interno exposto
  /\b(n[ãa]o respondo|n[ãa]o direcionada|mensagem casual|n[ãa]o vou responder|n[ãa]o preciso intervir|vou ignorar|sem necessidade de resposta)\b/i,
];

function checkInternalLeak(text) {
  for (const pattern of INTERNAL_LEAK_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return { leaked: true, match: match[0] };
    }
  }
  return { leaked: false };
}

function sanitizeClientResponse(text) {
  // Tenta remover frases que contêm vazamento, mantendo o resto
  const lines = text.split('\n');
  const cleanLines = lines.filter(line => {
    for (const pattern of INTERNAL_LEAK_PATTERNS) {
      if (pattern.test(line)) return false;
    }
    return true;
  });

  const result = cleanLines.join('\n').trim();
  // Se removeu tudo ou sobrou muito pouco, retorna null
  if (!result || result.length < 15) return null;
  return result;
}

function buildClientAgentPrompt(managedClient, memoryContext, dateStr, timeStr, dayOfWeek) {
  const clientName = managedClient.groupName?.split('🔛')[0]?.trim() || 'Cliente';

  return `${JARVIS_IDENTITY}

${CHANNEL_CONTEXT.whatsapp_client}

CONTEXTO DO GRUPO:
- Data/hora: ${dayOfWeek}, ${dateStr} ${timeStr} (horário de Brasília)
- Grupo: ${managedClient.groupName || clientName}
- Cliente: ${clientName}
- Responsável: equipe interna

INTELIGÊNCIA ATIVA:
- Se NÃO SABE algo → PERGUNTE no grupo "tarefas" (tool enviar_mensagem_grupo)
- Dúvida → escale internamente via grupo "tarefas"
- Quando aprender algo novo → salve com a tool "lembrar"

QUANDO AGIR:
- Demanda de trabalho → confirme, pergunte o que faltar, crie task, anexe material, avise equipe
- Material (fotos/vídeos) → crie task + anexar_midia_asana + avise equipe
- Dúvida sobre andamento → responda ou pergunte internamente
- Aprovação/feedback → REGISTRE VOCÊ MESMO (comentar_task) + notifique equipe
- Conversa casual/saudação ("bom dia", "é os guri", "opa") → responda SOMENTE a palavra [SILENCIO] e NADA MAIS. NUNCA explique por que não vai responder. NUNCA diga "mensagem casual, não respondo". Simplesmente retorne [SILENCIO].

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
// ============================================
// PIPELINE MULTI-AGENTE DE GESTÃO DE PROJETOS
// ============================================
// 3 agentes colaboram em pipeline:
//   🔍 RESEARCHER → coleta e cruza todos os dados (Asana + RAG + perfis)
//   🧠 MANAGER    → analisa o contexto e decide o que cobrar e como
//   ✍️  WRITER     → formula as mensagens no tom certo pra cada pessoa
// ============================================

// AGENTE 1: RESEARCHER — Coleta de inteligência
async function agentResearcher(task, { asanaRequest, searchMemories, getProfile }) {
  const t = task;
  const now = new Date();
  const daysLate = Math.floor((now - new Date(t.due_on)) / (1000 * 60 * 60 * 24));

  const intel = {
    task: t, daysLate,
    asana: { description: '', section: '', project: t.project, customFields: [], followers: [], subtasks: 0 },
    comments: [],
    activities: [],
    memories: { asana: [], whatsapp: [], people: [] },
    profiles: { assignee: null, client: null },
    recentWhatsApp: [],
  };

  // 1. Detalhes completos da task no Asana
  try {
    const taskDetail = await asanaRequest(`/tasks/${t.gid}?opt_fields=name,notes,memberships.section.name,memberships.project.name,custom_fields.name,custom_fields.display_value,followers.name,num_subtasks`);
    if (taskDetail?.data) {
      const td = taskDetail.data;
      intel.asana.description = (td.notes || '').substring(0, 800);
      if (td.memberships?.[0]?.section?.name) intel.asana.section = td.memberships[0].section.name;
      if (td.memberships?.[0]?.project?.name) intel.asana.project = td.memberships[0].project.name;
      intel.asana.customFields = (td.custom_fields || []).filter(cf => cf.display_value).map(cf => `${cf.name}: ${cf.display_value}`);
      intel.asana.followers = (td.followers || []).map(f => f.name).filter(Boolean);
      intel.asana.subtasks = td.num_subtasks || 0;
    }
  } catch (e) { console.error(`[RESEARCHER] Erro detalhes task ${t.gid}:`, e.message); }

  // 2. Comentários E atividades da task (histórico completo de interações)
  try {
    const stories = await asanaRequest(`/tasks/${t.gid}/stories?opt_fields=text,created_by.name,created_at,type,resource_subtype&limit=50`);
    if (stories?.data) {
      // Comentários reais
      intel.comments = stories.data
        .filter(s => s.type === 'comment' && s.text)
        .slice(-8)
        .map(c => ({
          author: c.created_by?.name || '?',
          date: new Date(c.created_at).toLocaleDateString('pt-BR'),
          text: c.text.substring(0, 400),
        }));
      // Atividades do sistema (movimentações, atribuições, mudanças de seção, etc.)
      intel.activities = stories.data
        .filter(s => s.type === 'system' && s.text)
        .slice(-6)
        .map(a => ({
          date: new Date(a.created_at).toLocaleDateString('pt-BR'),
          text: a.text.substring(0, 200),
        }));
    }
  } catch (e) { console.error(`[RESEARCHER] Erro stories task ${t.gid}:`, e.message); }

  // 3. BUSCA PROFUNDA NO RAG — 8 queries paralelas cruzando tudo
  try {
    const clientMatch = t.name.match(/\[([^\]]+)\]/);
    const clientName = clientMatch ? clientMatch[1] : '';
    const assigneeName = t.assignee && t.assignee !== 'Sem responsável' ? t.assignee : '';
    const assigneeFirst = assigneeName.split(/\s+/)[0] || '';
    const taskKeywords = t.name.replace(/\[.*?\]/g, '').trim().split(/\s+/).filter(w => w.length > 3).slice(0, 3);

    const searches = await Promise.allSettled([
      searchMemories(t.name, 'agent', null, 10),
      clientName ? searchMemories(clientName, null, null, 10) : Promise.resolve([]),
      assigneeName ? searchMemories(assigneeName, null, null, 8) : Promise.resolve([]),
      clientName ? searchMemories(clientName, 'chat', null, 8) : Promise.resolve([]),
      assigneeFirst ? searchMemories(assigneeFirst, 'chat', null, 5) : Promise.resolve([]),
      taskKeywords.length > 0 ? searchMemories(taskKeywords.join(' '), null, null, 5) : Promise.resolve([]),
      (assigneeFirst && clientName) ? searchMemories(`${assigneeFirst} ${clientName}`, null, null, 5) : Promise.resolve([]),
      clientName ? searchMemories(clientName, 'user', null, 5) : Promise.resolve([]),
    ]);

    const seen = new Set();
    for (const result of searches) {
      if (result.status !== 'fulfilled' || !Array.isArray(result.value)) continue;
      for (const m of result.value) {
        if (seen.has(m.content)) continue;
        seen.add(m.content);
        if (m.scope === 'agent') intel.memories.asana.push(m);
        else if (m.scope === 'chat') intel.memories.whatsapp.push(m);
        else intel.memories.people.push(m);
      }
    }

    // Limitar pra não estourar contexto
    intel.memories.asana = intel.memories.asana.slice(0, 12);
    intel.memories.whatsapp = intel.memories.whatsapp.slice(0, 12);
    intel.memories.people = intel.memories.people.slice(0, 8);

    console.log(`[RESEARCHER] Task ${t.gid}: ${seen.size} memórias únicas (asana:${intel.memories.asana.length} whatsapp:${intel.memories.whatsapp.length} people:${intel.memories.people.length})`);
  } catch (e) { console.error(`[RESEARCHER] Erro memórias:`, e.message); }

  // 3.5 Conversas recentes do WhatsApp (últimas 24h) sobre este cliente/task
  try {
    const { searchRecentMessagesByKeyword } = await import('./database.mjs');
    const searchTerms = [clientName, ...taskKeywords].filter(k => k && k.length >= 3);
    if (searchTerms.length > 0) {
      const recentMsgs = await searchRecentMessagesByKeyword(searchTerms, 24, 15);
      intel.recentWhatsApp = recentMsgs.map(m => ({
        from: m.push_name || '?',
        text: (m.text || '').substring(0, 300),
        date: m.hora_br ? new Date(m.hora_br).toLocaleString('pt-BR') : '?',
        chat: m.chat_id,
      }));
      if (intel.recentWhatsApp.length > 0) {
        console.log(`[RESEARCHER] Task ${t.gid}: ${intel.recentWhatsApp.length} mensagens recentes do WhatsApp sobre "${searchTerms.join(', ')}"`);
      }
    }
  } catch (e) { console.error(`[RESEARCHER] Erro busca WhatsApp:`, e.message); }

  // 4. Perfis sintetizados (responsável + cliente)
  try {
    if (t.assignee && t.assignee !== 'Sem responsável') {
      const firstName = t.assignee.split(/\s+/)[0].toLowerCase();
      const profile = await getProfile('team_member', firstName);
      if (profile?.profile) {
        intel.profiles.assignee = typeof profile.profile === 'string' ? JSON.parse(profile.profile) : profile.profile;
      }
    }
  } catch (e) {}

  try {
    const clientMatch = t.name.match(/\[([^\]]+)\]/);
    if (clientMatch) {
      const clientSlug = clientMatch[1].toLowerCase().replace(/\s+/g, '_');
      const profile = await getProfile('client', clientSlug);
      if (profile?.profile) {
        intel.profiles.client = typeof profile.profile === 'string' ? JSON.parse(profile.profile) : profile.profile;
      }
    }
  } catch (e) {}

  return intel;
}

// AGENTE 2: MANAGER — Analisa e decide o que cobrar
async function agentManager(intel, { anthropic, teamList }) {
  // Montar dossiê completo pro Claude analisar
  let dossier = `TASK: ${intel.task.name}\nGID: ${intel.task.gid}`;
  dossier += `\nPrazo: ${intel.task.due_on} (${intel.daysLate} dias de atraso)`;
  dossier += `\nResponsável: ${intel.task.assignee || 'Sem responsável'}`;
  dossier += `\nProjeto: ${intel.asana.project}`;
  if (intel.asana.section) dossier += `\nSeção: ${intel.asana.section}`;
  if (intel.asana.description) dossier += `\nDescrição: ${intel.asana.description}`;
  if (intel.asana.customFields.length) dossier += `\nCampos: ${intel.asana.customFields.join(', ')}`;
  if (intel.asana.followers.length) dossier += `\nEnvolvidos: ${intel.asana.followers.join(', ')}`;
  if (intel.asana.subtasks > 0) dossier += `\nSubtasks: ${intel.asana.subtasks}`;

  if (intel.comments.length > 0) {
    dossier += `\n\nHISTÓRICO DE COMENTÁRIOS (${intel.comments.length}):`;
    for (const c of intel.comments) dossier += `\n- ${c.author} (${c.date}): ${c.text}`;
  } else {
    dossier += `\n\nSEM COMENTÁRIOS escritos na task.`;
  }
  if (intel.activities?.length > 0) {
    dossier += `\n\nATIVIDADES RECENTES NA TASK (movimentações, atribuições, mudanças):`;
    for (const a of intel.activities) dossier += `\n- (${a.date}): ${a.text}`;
  }

  if (intel.memories.asana.length > 0) {
    dossier += `\n\nCONHECIMENTO DO ASANA (estudo completo de tasks e projetos):`;
    for (const m of intel.memories.asana) dossier += `\n- [${m.category}] ${m.content}`;
  }
  if (intel.memories.whatsapp.length > 0) {
    dossier += `\n\nCONHECIMENTO DO WHATSAPP (conversas processadas dos grupos):`;
    for (const m of intel.memories.whatsapp) dossier += `\n- [${m.category}] ${m.content}`;
  }
  if (intel.memories.people.length > 0) {
    dossier += `\n\nCONHECIMENTO SOBRE PESSOAS:`;
    for (const m of intel.memories.people) dossier += `\n- [${m.category}] ${m.content}`;
  }

  if (intel.recentWhatsApp?.length > 0) {
    dossier += `\n\n⚠️ CONVERSAS RECENTES NO WHATSAPP (últimas 24h sobre este cliente/task):`;
    for (const m of intel.recentWhatsApp) dossier += `\n- ${m.from} (${m.date}): ${m.text}`;
  }

  if (intel.profiles.assignee) {
    dossier += `\n\nPERFIL DO RESPONSÁVEL:`;
    if (intel.profiles.assignee.summary) dossier += `\n${intel.profiles.assignee.summary}`;
    if (intel.profiles.assignee.patterns) dossier += `\nPadrões: ${JSON.stringify(intel.profiles.assignee.patterns)}`;
  }
  if (intel.profiles.client) {
    dossier += `\n\nPERFIL DO CLIENTE:`;
    if (intel.profiles.client.summary) dossier += `\n${intel.profiles.client.summary}`;
    if (intel.profiles.client.tier) dossier += `\nTier: ${intel.profiles.client.tier}`;
  }

  try {
    const response = await anthropic.messages.create({
      model: CONFIG.AI_MODEL,
      max_tokens: 600,
      system: `Você é o AGENTE MANAGER do Jarvis — gerente de projetos sênior da Stream Lab.

Seu papel: analisar o dossiê completo que o Agente Researcher coletou e DECIDIR o que cobrar.

EQUIPE: ${teamList}

Você recebe dados REAIS — do Asana, das conversas do WhatsApp, dos perfis da equipe. CRUZE TUDO:
- Comentários mostram progresso? Reconheça e pergunte O QUE FALTA
- ATIVIDADES RECENTES (movimentações, atribuições, mudanças de seção) = sinal de que HOUVE TRABALHO. NUNCA diga "sem atualização" ou "sem comentário" se existem atividades recentes. Reconheça o progresso e pergunte o próximo passo
- WhatsApp mostra que o cliente já cobrou? Mencione isso na cobrança
- Perfil do membro mostra padrão de atraso? Adapte a abordagem
- Seção indica fase específica? Cobre sobre aquela fase
- Sem comentários E sem atividades recentes? Aí sim pergunte se já iniciou
- Memórias mostram decisões/reuniões? Referencie
- ⚠️ CONVERSAS RECENTES DO WHATSAPP mostram que o assunto JÁ FOI DISCUTIDO nas últimas 24h? Retorne comentario_asana: null — NÃO cobrar, o assunto está sendo tratado ativamente

Responda em JSON:
{
  "analise": "sua análise em 1-2 frases do que está acontecendo",
  "urgencia": "baixa|media|alta|critica",
  "comentario_asana": "o texto do comentário pro Asana (2-4 frases, específico, humano) OU null se o assunto já foi discutido recentemente",
  "resumo_whatsapp": "resumo de 1 frase pro grupo do WhatsApp OU null se não cobrar"
}

REGRAS:
1. ESPECÍFICO — "as artes do feed precisam ir pra aprovação" SIM. "pode dar retorno?" NUNCA
2. Tom de colega, não de robô
3. Pode mencionar nomes de CLIENTES dos dados. NUNCA invente nomes
4. NUNCA comece com "@NomeDaPessoa" — a menção é automática
5. Se há CONVERSAS RECENTES sobre o tema (últimas 24h), NÃO COBRE — retorne null em comentario_asana
6. Responda SOMENTE o JSON, sem markdown nem explicação`,
      messages: [{ role: 'user', content: dossier + (intel.escalationContext || '') }],
    });

    const text = response.content[0]?.text?.trim() || '';
    // Extrair JSON (pode vir com ```json ... ```)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const decision = JSON.parse(jsonMatch[0]);
      console.log(`[MANAGER] Task ${intel.task.gid}: urgência=${decision.urgencia} — "${decision.analise?.substring(0, 80)}"`);
      return decision;
    }
    // Fallback: texto direto
    return { analise: 'análise automática', urgencia: 'media', comentario_asana: text, resumo_whatsapp: text.substring(0, 100) };
  } catch (err) {
    console.error(`[MANAGER] Erro Claude:`, err.message);
    return {
      analise: 'erro na análise',
      urgencia: 'media',
      comentario_asana: `Essa task está com ${intel.daysLate} dia(s) de atraso desde ${new Date(intel.task.due_on).toLocaleDateString('pt-BR')}. Qual o status atual?`,
      resumo_whatsapp: `${intel.daysLate} dias de atraso`,
    };
  }
}

// AGENTE 3: WRITER — Formula mensagem do WhatsApp no tom certo pra cada pessoa
async function agentWriter(personName, taskResults, { anthropic, teamList }) {
  const tasksSummary = taskResults.map(r => {
    const url = `https://app.asana.com/0/${r.intel.task.projectGid}/${r.intel.task.gid}`;
    return `- Task: ${r.intel.task.name} (${r.intel.daysLate} dias de atraso, seção: ${r.intel.asana.section || 'N/A'})
  Análise: ${r.decision.analise}
  Urgência: ${r.decision.urgencia}
  Comentário no Asana: ${r.decision.comentario_asana}
  Link: ${url}`;
  }).join('\n\n');

  try {
    const response = await anthropic.messages.create({
      model: CONFIG.AI_MODEL,
      max_tokens: 500,
      system: `Você é o AGENTE WRITER do Jarvis — responsável por formular mensagens HUMANAS e AMIGÁVEIS pro WhatsApp.

O Agente Manager já analisou as tasks e decidiu o que cobrar. Seu papel é formular a mensagem pro grupo de forma que pareça um colega de equipe fazendo um check-in natural, NÃO um robô automatizado.

REGRAS DE TOM:
1. Fale como colega — "Fala Bruno!", "E aí Arthur", "Opa Nicolas"
2. NUNCA use "cobrança automática", "alerta", "notificação" ou qualquer termo robótico
3. Se tem 1 task: seja conversacional ("vi que a arte do feed da Minner tá pendente, consegue ver isso hoje?")
4. Se tem várias: agrupe naturalmente ("separei umas tasks que precisam de atenção")
5. Mencione o conteúdo REAL ("as artes do feed", "o planner de março") — nunca genérico
6. Feche de forma leve — "qualquer coisa grita!", "me avisa se precisar de algo", "tmj!"
7. Use emojis com moderação (1-2 no máximo)
8. A mensagem TEM que começar com @${personName} pra funcionar a menção no WhatsApp
9. NUNCA inclua timestamps como [11:57] ou horários entre colchetes na mensagem
10. Seja CURTO e DIRETO — máximo 3-4 linhas por task. Ninguém lê textão no WhatsApp
11. NUNCA repita o nome da pessoa depois do @menção inicial

Responda SOMENTE o texto da mensagem, sem aspas nem prefixo.`,
      messages: [{ role: 'user', content: `Pessoa: ${personName}\n\nTasks para mencionar:\n${tasksSummary}` }],
    });
    return response.content[0]?.text?.trim() || '';
  } catch (err) {
    console.error(`[WRITER] Erro Claude:`, err.message);
    // Fallback amigável
    let msg = `@${personName}, passei no Asana e vi algumas tasks pendentes:\n\n`;
    for (const r of taskResults) {
      const url = `https://app.asana.com/0/${r.intel.task.projectGid}/${r.intel.task.gid}`;
      msg += `• *${r.intel.task.name}* — ${r.intel.daysLate} dias de atraso\n  ${url}\n\n`;
    }
    msg += `Dá uma olhada quando puder! 💪`;
    return msg;
  }
}

// ORQUESTRADOR — Conecta os 3 agentes
export async function runOverdueCheck() {
  if (!CONFIG.ASANA_PAT) return;
  try {
    const { getOverdueTasks, getSendFunction, getSendWithMentionsFunction, asanaRequest, asanaWrite } = await import('./skills/loader.mjs');
    const { searchMemories } = await import('./memory.mjs');
    const { getProfile } = await import('./profiles.mjs');
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

    // Resolver nomes → GIDs do Asana (match parcial)
    const teamEntries = Object.entries(TEAM_ASANA);
    function findTeamGid(fullName) {
      if (!fullName) return null;
      const lower = fullName.toLowerCase();
      for (const [name, gid] of teamEntries) { if (lower === name) return gid; }
      const firstName = lower.split(/\s+/)[0];
      for (const [name, gid] of teamEntries) { if (firstName === name) return gid; }
      for (const [name, gid] of teamEntries) { if (lower.includes(name)) return gid; }
      return null;
    }

    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });
    const teamNames = Object.keys(TEAM_ASANA).map(n => n.charAt(0).toUpperCase() + n.slice(1));
    const teamList = [...new Set(teamNames)].join(', ');

    // Carregar log de cobranças para escalação
    const { getCobrancaLog, upsertCobrancaLog } = await import('./database.mjs');

    console.log(`[PIPELINE] Iniciando pipeline multi-agente para ${toCobrar.slice(0, 10).length} tasks`);
    const allResults = [];

    // ============================================
    // ETAPA 1: RESEARCHER coleta inteligência (paralelo por task)
    // ============================================
    console.log(`[PIPELINE] 🔍 Agente Researcher coletando dados...`);
    const intelResults = [];
    for (const t of toCobrar.slice(0, 10)) {
      if (notified[t.gid]) continue;

      // Verificar nível de escalação
      const cobrancaInfo = await getCobrancaLog(t.gid);
      const cobrancaCount = cobrancaInfo ? cobrancaInfo.cobranca_count : 0;
      const lastCobrada = cobrancaInfo ? new Date(cobrancaInfo.last_cobrada_at) : null;
      const hoursSinceLastCobranca = lastCobrada ? (Date.now() - lastCobrada.getTime()) / (1000 * 60 * 60) : Infinity;

      // Lógica de escalação:
      // 1ª cobrança: normal (sem histórico)
      // 2ª cobrança: 24h após a 1ª → tom mais urgente
      // 3ª cobrança: 48h após a 1ª → escalar para o Gui
      let escalationLevel = 'normal';
      if (cobrancaCount >= 2 && hoursSinceLastCobranca >= 24) {
        escalationLevel = 'escalate_gui'; // 3ª+: escalar pro Gui
      } else if (cobrancaCount >= 1 && hoursSinceLastCobranca >= 24) {
        escalationLevel = 'urgent'; // 2ª: tom mais urgente
      } else if (cobrancaCount >= 1 && hoursSinceLastCobranca < 24) {
        // Já cobrado hoje, pular
        notified[t.gid] = today;
        continue;
      }

      const intel = await agentResearcher(t, { asanaRequest, searchMemories, getProfile });
      intel.escalationLevel = escalationLevel;
      intel.cobrancaCount = cobrancaCount;
      intelResults.push(intel);
      await new Promise(r => setTimeout(r, 500)); // Rate limit Asana
    }
    console.log(`[PIPELINE] 🔍 Researcher concluído: ${intelResults.length} tasks analisadas`);

    // ============================================
    // ETAPA 2: MANAGER analisa e decide (1 chamada por task)
    // ============================================
    console.log(`[PIPELINE] 🧠 Agente Manager analisando...`);
    const decisions = [];
    for (const intel of intelResults) {
      // Passar informação de escalação para o Manager
      const escalationContext = intel.escalationLevel === 'urgent'
        ? '\n\n⚠️ ESCALAÇÃO: Esta é a 2ª cobrança. Use tom mais urgente e direto. Exija prazo concreto.'
        : intel.escalationLevel === 'escalate_gui'
        ? '\n\n🚨 ESCALAÇÃO NÍVEL 3: Esta task já foi cobrada 2+ vezes sem resolução. Sua análise será enviada diretamente ao Gui (dono). Seja claro sobre o problema e a gravidade.'
        : '';
      const decision = await agentManager({ ...intel, escalationContext }, { anthropic, teamList });
      decisions.push({ intel, decision });
      await new Promise(r => setTimeout(r, 300));
    }
    console.log(`[PIPELINE] 🧠 Manager concluído: ${decisions.length} decisões`);

    // ============================================
    // ETAPA 3: Executar decisões — comentar no Asana
    // ============================================
    console.log(`[PIPELINE] 📝 Postando comentários no Asana...`);
    const commentResults = [];
    for (const { intel, decision } of decisions) {
      const t = intel.task;
      const commentText = decision.comentario_asana;
      if (!commentText || commentText === 'null') {
        notified[t.gid] = today;
        console.log(`[PIPELINE] ⏭️ Task ${t.gid} pulada — assunto já discutido recentemente`);
        continue;
      }

      // Montar menções dos envolvidos
      const allInvolved = new Set();
      if (t.assignee && t.assignee !== 'Sem responsável') allInvolved.add(t.assignee);
      for (const f of intel.asana.followers) {
        if (findTeamGid(f)) allInvolved.add(f);
      }

      let mentionsHtml = '';
      const mentionedNames = [];
      for (const person of allInvolved) {
        const gid = findTeamGid(person);
        if (gid) { mentionsHtml += `<a data-asana-gid="${gid}"/> `; mentionedNames.push(person); }
      }

      const commentBody = mentionsHtml
        ? { html_text: `<body>${mentionsHtml}${commentText}</body>` }
        : { text: commentText };

      const result = await asanaWrite('POST', `/tasks/${t.gid}/stories`, commentBody);
      if (result.success) {
        console.log(`[PIPELINE] ✅ Asana ${t.gid} [${mentionedNames.join(',')}]: "${commentText.substring(0, 80)}..."`);
        commentResults.push({ intel, decision, mentionedNames });

        // Registrar cobrança no log de escalação
        await upsertCobrancaLog(t.gid);

        // Escalação nível 3: notificar Gui diretamente com contexto completo
        if (intel.escalationLevel === 'escalate_gui') {
          try {
            const guiMsg = `🚨 *Escalação — Task atrasada (${intel.cobrancaCount + 1}ª cobrança)*\n\n📋 *${t.name}*\n👤 Responsável: ${t.assignee}\n📅 Prazo: ${t.due_on} (${intel.daysLate || '?'} dias de atraso)\n📁 Projeto: ${t.project}\n\n💬 Análise: ${decision.analise || 'Sem análise'}\n\nJá cobrei ${intel.cobrancaCount} vez(es) sem resolução. Precisa de intervenção direta.`;
            await sendFn(CONFIG.GUI_JID, guiMsg);
            console.log(`[PIPELINE] 🚨 Escalação enviada ao Gui para task ${t.gid}`);
          } catch (escErr) {
            console.error(`[PIPELINE] Erro ao escalar pro Gui:`, escErr.message);
          }
        }
      } else {
        console.error(`[PIPELINE] ❌ Erro Asana ${t.gid}:`, result.error);
      }

      notified[t.gid] = today;
      await new Promise(r => setTimeout(r, 1000));
    }

    // ============================================
    // ETAPA 4: WRITER formula mensagens + envia no WhatsApp
    // ============================================
    if (commentResults.length > 0) {
      console.log(`[PIPELINE] ✍️ Agente Writer formulando mensagens...`);
      const sendWithMentions = getSendWithMentionsFunction();

      // Agrupar por responsável
      const byPerson = {};
      for (const r of commentResults) {
        const name = r.intel.task.assignee || 'Sem responsável';
        if (!byPerson[name]) byPerson[name] = [];
        byPerson[name].push(r);
      }

      for (const [person, results] of Object.entries(byPerson)) {
        if (person === 'Sem responsável') continue;

        // Writer gera a mensagem no tom certo
        const whatsappMsg = await agentWriter(person, results, { anthropic, teamList });

        // Resolver JID com 3 fallbacks: teamWhatsApp → teamPhones → banco de dados
        const firstName = person.split(/\s+/)[0].toLowerCase();
        let whatsappJid = teamWhatsApp.get(firstName) || teamPhones.get(firstName);

        // Fallback: buscar no banco jarvis_contacts pelo push_name
        if (!whatsappJid) {
          try {
            const { rows } = await pool.query(
              `SELECT jid FROM jarvis_contacts WHERE LOWER(push_name) LIKE $1 AND jid LIKE '%@s.whatsapp.net' LIMIT 1`,
              [`${firstName}%`]
            );
            if (rows.length > 0) {
              whatsappJid = rows[0].jid;
              teamPhones.set(firstName, whatsappJid); // Cache pra próxima vez
              console.log(`[PIPELINE] JID encontrado no banco pra ${person}: ${whatsappJid}`);
            }
          } catch (e) {}
        }

        // Fallback 2: buscar por @lid no banco (participantes de grupo)
        if (!whatsappJid) {
          try {
            const { rows } = await pool.query(
              `SELECT jid FROM jarvis_contacts WHERE LOWER(push_name) LIKE $1 AND jid LIKE '%@lid' LIMIT 1`,
              [`${firstName}%`]
            );
            if (rows.length > 0) {
              whatsappJid = rows[0].jid;
              console.log(`[PIPELINE] JID @lid encontrado pra ${person}: ${whatsappJid}`);
            }
          } catch (e) {}
        }

        if (whatsappJid && sendWithMentions) {
          // Substituir @Nome pelo @número no texto (WhatsApp exige @número para renderizar menção)
          let msgText = whatsappMsg;
          const phoneNum = whatsappJid.replace(/@s\.whatsapp\.net$/, '').replace(/@lid$/, '');
          // Substituir qualquer @NomePessoa pelo @número (case-insensitive, nome completo ou primeiro nome)
          const firstName = person.split(/\s+/)[0];
          const namePatterns = [person, firstName].filter(Boolean);
          for (const name of namePatterns) {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            msgText = msgText.replace(new RegExp(`@${escaped}`, 'gi'), `@${phoneNum}`);
          }
          await sendWithMentions(CONFIG.GROUP_TAREFAS, msgText, [{ jid: whatsappJid }]);
          console.log(`[PIPELINE] ✍️ WhatsApp enviado pra ${person} com menção real (${whatsappJid})`);
        } else {
          await sendFn(CONFIG.GROUP_TAREFAS, whatsappMsg);
          console.log(`[PIPELINE] ✍️ WhatsApp enviado pra ${person} (sem menção — JID não encontrado)`);
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      console.log(`[PIPELINE] ✅ Pipeline concluído: ${commentResults.length} tasks cobradas via 3 agentes`);
    }

    // Salvar controle anti-spam
    await pool.query(
      "INSERT INTO jarvis_config (key, value) VALUES ('overdue_notified', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [JSON.stringify(notified)]
    ).catch(() => {});

  } catch (err) {
    console.error('[PIPELINE] Erro:', err.message);
  }
}

// ============================================
// ATENDIMENTO PÚBLICO — DM de desconhecidos (leads)
// ============================================

// Cache em memória de contagem de mensagens por conversa (TTL 24h)
const publicDMCounters = new Map(); // jid → { count, lastReset }
const PUBLIC_DM_TTL = 24 * 60 * 60 * 1000; // 24 horas

function getPublicDMCount(jid) {
  const entry = publicDMCounters.get(jid);
  if (!entry) return 0;
  if (Date.now() - entry.lastReset > PUBLIC_DM_TTL) {
    publicDMCounters.delete(jid);
    return 0;
  }
  return entry.count;
}

function incrementPublicDMCount(jid) {
  const entry = publicDMCounters.get(jid);
  if (!entry || Date.now() - entry.lastReset > PUBLIC_DM_TTL) {
    publicDMCounters.set(jid, { count: 1, lastReset: Date.now() });
    return 1;
  }
  entry.count++;
  return entry.count;
}

/**
 * Verifica se estamos no horário comercial (8h-18h BRT)
 */
function isBusinessHours() {
  const now = new Date();
  const brTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const hour = brTime.getHours();
  return hour >= 8 && hour < 18;
}

/**
 * Trata DM de pessoas desconhecidas (leads/público externo).
 * Usa JARVIS_IDENTITY + CHANNEL_CONTEXT.whatsapp_public.
 *
 * @param {string} text - Texto da mensagem
 * @param {string} senderJid - JID do remetente
 * @param {string} pushName - Nome do remetente
 * @param {Array} mediaFiles - Arquivos de mídia recebidos
 * @returns {{ text: string, isFirstContact: boolean } | null}
 */
export async function handlePublicDM(text, senderJid, pushName, mediaFiles = []) {
  try {
    // Verificar horário comercial
    if (!isBusinessHours()) {
      // Fora do horário: resposta automática
      console.log(`[PUBLIC-DM] Mensagem fora do horário de ${pushName} (${senderJid})`);

      // Registrar conversa no banco
      await upsertPublicConversation(senderJid, pushName);

      return {
        text: 'Recebemos sua mensagem! Retornamos no próximo dia útil. 🕐',
        isFirstContact: false,
        notifyGui: true,
      };
    }

    // Contar mensagens na conversa
    const msgCount = incrementPublicDMCount(senderJid);

    // Verificar se é primeiro contato
    const existingConv = await getPublicConversation(senderJid);
    const isFirstContact = !existingConv;

    // Registrar/atualizar conversa no banco
    await upsertPublicConversation(senderJid, pushName);

    // Se excedeu 10 mensagens → sugerir reunião
    if (msgCount > 10) {
      console.log(`[PUBLIC-DM] Limite de ${msgCount} mensagens atingido para ${pushName}`);
      return {
        text: 'Que tal agendarmos uma reunião com nosso time pra conversarmos melhor sobre isso? 📅 Posso verificar os horários disponíveis!',
        isFirstContact: false,
        notifyGui: false,
      };
    }

    // Gerar resposta com IA
    const recentMessages = await getRecentMessages(senderJid, 15);
    const chatHistory = [];
    for (const m of recentMessages) {
      const isJarvisMsg = m.push_name === 'Jarvis' || m.message_id?.startsWith('jarvis_');
      if (isJarvisMsg) {
        chatHistory.push({ role: 'assistant', content: m.text });
      } else {
        chatHistory.push({ role: 'user', content: m.text });
      }
    }
    // Adicionar mensagem atual
    chatHistory.push({ role: 'user', content: text });

    // System prompt: identidade + canal público
    const systemPrompt = [
      {
        type: 'text',
        text: JARVIS_IDENTITY + '\n\n' + CHANNEL_CONTEXT.whatsapp_public,
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: `CONTEXTO DA CONVERSA:
- Remetente: ${pushName || 'Desconhecido'}
- Mensagem #${msgCount} nesta conversa
- ${isFirstContact ? 'PRIMEIRO CONTATO — seja especialmente acolhedor' : 'Conversa em andamento'}
- Horário: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
      },
    ];

    // Usar Sonnet para respostas rápidas
    const model = CONFIG.AI_MODEL;
    const response = await anthropic.messages.create({
      model,
      max_tokens: 512,
      system: systemPrompt,
      messages: chatHistory,
    });

    let responseText = '';
    for (const block of response.content) {
      if (block.type === 'text') responseText += block.text;
    }

    if (!responseText || responseText.trim().length < 3) return null;

    // Anti-leak check: garantir que não vaza informação interna
    const leakCheck = checkInternalLeak(responseText);
    if (leakCheck.leaked) {
      console.warn(`[PUBLIC-DM] ⚠️ Vazamento detectado na resposta pública: "${leakCheck.match}"`);
      const sanitized = sanitizeClientResponse(responseText);
      if (!sanitized) {
        // Fallback seguro
        responseText = `Obrigado pela mensagem, ${pushName || ''}! A Stream Lab é um laboratório criativo de marketing. Posso te ajudar a saber mais sobre nossos serviços ou agendar uma reunião com nosso time. Como posso ajudar?`;
      } else {
        responseText = sanitized;
      }
    }

    console.log(`[PUBLIC-DM] Resposta gerada para ${pushName} (msg #${msgCount}): ${responseText.substring(0, 80)}`);

    return {
      text: responseText,
      isFirstContact,
      notifyGui: isFirstContact,
    };
  } catch (err) {
    console.error('[PUBLIC-DM] Erro:', err.message);
    return null;
  }
}

/**
 * Trata mensagens no Modo Apresentação (Showcase).
 * Usa Opus para máxima inteligência. Sem limite de mensagens.
 * Retorna { text, sendAsAudio } onde sendAsAudio indica se deve enviar como voz.
 *
 * @param {string} text - Texto da mensagem
 * @param {string} senderJid - JID do remetente
 * @param {string} pushName - Nome do remetente
 * @param {Array} mediaFiles - Arquivos de mídia recebidos
 * @param {number} messageCount - Contagem de mensagens na conversa showcase
 * @returns {{ text: string, sendAsAudio: boolean } | null}
 */
export async function handleShowcaseMessage(text, senderJid, pushName, mediaFiles = [], messageCount = 1) {
  try {
    // Buscar histórico da conversa (últimas 20 mensagens)
    const recentMessages = await getRecentMessages(senderJid, 20);
    const chatHistory = [];
    for (const m of recentMessages) {
      const isJarvisMsg = m.push_name === 'Jarvis' || m.message_id?.startsWith('jarvis_');
      if (isJarvisMsg) {
        chatHistory.push({ role: 'assistant', content: m.text });
      } else {
        chatHistory.push({ role: 'user', content: m.text });
      }
    }
    // Adicionar mensagem atual
    chatHistory.push({ role: 'user', content: text });

    // Buscar memórias genéricas (sem dados internos) para conhecimento geral
    let memoryContext = '';
    try {
      const memories = await searchMemories(text, 'agent', null, 5);
      if (memories?.length > 0) {
        const safeMemories = memories.filter(m => {
          const check = checkInternalLeak(m.content);
          return !check.leaked;
        });
        if (safeMemories.length > 0) {
          memoryContext = '\n\nCONHECIMENTO RELEVANTE:\n' + safeMemories.map(m => `- ${m.content}`).join('\n');
        }
      }
    } catch (memErr) {
      // Silencioso — memória é complementar
    }

    // System prompt: identidade + canal showcase + contexto
    const systemPrompt = [
      {
        type: 'text',
        text: JARVIS_IDENTITY + '\n\n' + CHANNEL_CONTEXT.whatsapp_showcase,
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: `CONTEXTO DA CONVERSA:
- Remetente: ${pushName || 'Visitante'}
- Mensagem #${messageCount} no modo apresentação
- Horário: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
- DICA: responda de forma que IMPRESSIONE. Mostre inteligência, criatividade e personalidade.
- Para respostas mais longas (insights, explicações, estratégia) → marque para enviar como ÁUDIO
- Inclua no final da sua resposta, em uma linha separada, exatamente: [AUDIO:sim] ou [AUDIO:nao] para indicar se esta resposta deve ser enviada como áudio de voz.${memoryContext}`,
      },
    ];

    // Usar Opus para máxima inteligência
    const model = CONFIG.AI_MODEL_STRONG || CONFIG.AI_MODEL;
    console.log(`[SHOWCASE] Gerando resposta com ${model} para ${pushName} (msg #${messageCount})`);

    const response = await anthropic.messages.create({
      model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: chatHistory,
    });

    let responseText = '';
    for (const block of response.content) {
      if (block.type === 'text') responseText += block.text;
    }

    if (!responseText || responseText.trim().length < 3) return null;

    // Detectar marcação de áudio
    let sendAsAudio = false;
    const audioMatch = responseText.match(/\[AUDIO:(sim|nao|não)\]/i);
    if (audioMatch) {
      sendAsAudio = audioMatch[1].toLowerCase() === 'sim';
      responseText = responseText.replace(/\[AUDIO:(sim|nao|não)\]/i, '').trim();
    } else {
      // Fallback: ~60% das respostas longas como áudio
      sendAsAudio = responseText.length > 100 && Math.random() < 0.6;
    }

    // Anti-leak check: garantir que não vaza informação interna
    const leakCheck = checkInternalLeak(responseText);
    if (leakCheck.leaked) {
      console.warn(`[SHOWCASE] ⚠️ Vazamento detectado: "${leakCheck.match}"`);
      const sanitized = sanitizeClientResponse(responseText);
      if (!sanitized) {
        responseText = `Boa pergunta! A Stream Lab é um laboratório criativo de marketing que combina inteligência artificial com criatividade humana. Quer saber mais sobre como posso ajudar o seu negócio?`;
        sendAsAudio = false;
      } else {
        responseText = sanitized;
      }
    }

    // Detectar interesse em contratação/preço para notificar Gui
    const hotLeadPatterns = /\b(pre[çc]o|valor|quanto custa|or[çc]amento|contratar|fechar|proposta|investimento|pacote|plano|mensalidade)\b/i;
    const isHotLead = hotLeadPatterns.test(text);

    console.log(`[SHOWCASE] Resposta para ${pushName} (msg #${messageCount}, audio=${sendAsAudio}): ${responseText.substring(0, 80)}`);

    return {
      text: responseText,
      sendAsAudio,
      isHotLead,
    };
  } catch (err) {
    console.error('[SHOWCASE] Erro:', err.message);
    return null;
  }
}
