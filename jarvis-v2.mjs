// ============================================
// JARVIS 4.0 - Stream Lab AI Bot
// Agent Loop + Extended Thinking + Prompt Caching + Model Routing
// ============================================
import 'dotenv/config';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import express from 'express';
import cron from 'node-cron';
import { randomUUID, randomInt } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import helmet from 'helmet';
import cors from 'cors';
import { WebSocketServer } from 'ws';

// Módulos do Jarvis 4.0
import { CONFIG, AUDIO_ALLOWED, JARVIS_ALLOWED_GROUPS, teamPhones, teamWhatsApp, managedClients, loadManagedClients, saveManagedClients, isManagedClientGroup } from './src/config.mjs';
import { pool, initDB, storeMessage, getRecentMessages, getContactInfo, getGroupInfo, upsertContact, upsertGroup, getMessageCount } from './src/database.mjs';
import { initMemory, processMemory, getMemoryContext, getMemoryStats, searchMemories, smartSearchMemories, storeFacts, extractFacts, backfillEmbeddings } from './src/memory.mjs';
import { shouldJarvisRespond, isValidResponse, generateResponse, markConversationActive, isConversationActive, findTeamJid, extractMentionsFromText, generateDailyReport, handleManagedClientMessage, runOverdueCheck, handlePublicDM } from './src/brain.mjs';
import { voiceConfig, loadVoiceConfig, saveVoiceConfig, transcribeAudio, generateAudio } from './src/audio.mjs';
import { synthesizeProfile, getProfile, listProfiles, syncProfiles } from './src/profiles.mjs';
import { asanaRequest, getOverdueTasks, getGCalClient, JARVIS_TOOLS, registerSendFunction, registerSendWithMentionsFunction } from './src/skills/loader.mjs';
import { getMediaType, extractSender } from './src/helpers.mjs';
import { startAsanaStudy, stopAsanaStudy, asanaBatchState } from './src/batch-asana.mjs';
import { startEmailMonitor, stopEmailMonitor, emailMonitorState } from './src/asana-email-monitor.mjs';
import { generateBrainDocument, loadBrainDocument, invalidateBrainCache, getBrainStatus } from './src/brain-document.mjs';
import { processAsanaWebhookEvent, registerAsanaWebhooks } from './src/webhooks/asana-webhook.mjs';
import { processInstagramMessage } from './src/channels/instagram.mjs';
import { startChannelEmailMonitor, stopChannelEmailMonitor, channelEmailState } from './src/channels/email.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let sock = null;
let connectionStatus = 'disconnected';
let jarvisPaused = false; // Modo pausa: recebe mensagens mas NAO responde
const sentByBot = new Set();

// JIDs da equipe REAL (participantes dos grupos internos Tarefas/Galáxias)
// NÃO inclui clientes — usado exclusivamente pelo agente proativo
const realTeamJids = new Set();

// ============================================
// VALIDADOR DE HOMEWORK — Usa Haiku pra confirmar se é realmente uma instrução pro Jarvis
// Evita salvar áudios de clientes, conversas casuais, etc.
// ============================================
async function validateHomework(text, isAudio = false) {
  try {
    // Se o texto é muito longo (>500 chars) e é áudio, provavelmente é transcrição de conversa
    if (isAudio && text.length > 500) {
      console.log(`[HOMEWORK] Áudio longo (${text.length} chars) — provavelmente transcrição de conversa, rejeitando`);
      return false;
    }

    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

    const response = await anthropic.messages.create({
      model: process.env.MEMORY_MODEL || 'claude-haiku-3-5-20241022',
      max_tokens: 10,
      system: `Você é um classificador. Analise se o texto é uma INSTRUÇÃO DIRETA do dono da empresa para o assistente de IA (Jarvis), ou se é apenas conversa casual, transcrição de áudio de terceiros, ou conteúdo genérico.

INSTRUÇÃO DIRETA = ordens como "não faça X", "me chame de Y", "quando acontecer Z, faça W", "aprenda que...", "a partir de agora...", correções de comportamento.

NÃO É INSTRUÇÃO = conversas entre outras pessoas, áudios de clientes transcritos, discussões de negócios, conteúdo de terceiros encaminhado.

${isAudio ? 'ATENÇÃO: Este texto é uma TRANSCRIÇÃO DE ÁUDIO. Se parece alguém falando com outra pessoa (não com o Jarvis), NÃO é instrução.' : ''}

Responda APENAS "SIM" ou "NAO".`,
      messages: [{ role: 'user', content: text.substring(0, 500) }],
    });

    const answer = (response.content[0]?.text || '').trim().toUpperCase();
    return answer === 'SIM';
  } catch (err) {
    console.error('[HOMEWORK] Erro na validação:', err.message);
    // Em caso de erro, usa heurística simples: rejeita áudios longos, aceita texto curto
    if (isAudio && text.length > 200) return false;
    return text.length < 200;
  }
}

// ============================================
// WHATSAPP - Envio de mensagens
// ============================================
async function sendText(jid, text, quotedMsg) {
  if (!sock) return;
  try {
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    const msgPayload = { text };
    if (quotedMsg) msgPayload.quoted = quotedMsg;
    const result = await sock.sendMessage(jid, msgPayload);
    if (result?.key?.id) sentByBot.add(result.key.id);
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    if (sentByBot.size > 200) {
      const arr = [...sentByBot];
      arr.slice(0, 100).forEach(id => sentByBot.delete(id));
    }
    return result;
  } catch (err) {
    console.error('[WA] Erro ao enviar:', err.message);
  }
}

async function sendTextWithMentions(jid, text, mentions, quotedMsg) {
  if (!sock) return;
  try {
    const mentionJids = mentions.map(m => m.jid).filter(Boolean);
    const msgPayload = { text, mentions: mentionJids };
    if (quotedMsg) msgPayload.quoted = quotedMsg;
    const result = await sock.sendMessage(jid, msgPayload);
    if (result?.key?.id) sentByBot.add(result.key.id);
    if (sentByBot.size > 200) {
      const arr = [...sentByBot];
      arr.slice(0, 100).forEach(id => sentByBot.delete(id));
    }
    return result;
  } catch (err) {
    console.error('[WA] Erro ao enviar com mencao:', err.message);
    return sendText(jid, text);
  }
}

async function sendAudio(jid, text) {
  if (!sock || !AUDIO_ALLOWED.has(jid)) return sendText(jid, text);
  try {
    await sock.sendPresenceUpdate('recording', jid).catch(() => {});
    const audioBuffer = await generateAudio(text);
    const result = await sock.sendMessage(jid, { audio: audioBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });
    if (result?.key?.id) sentByBot.add(result.key.id);
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
  } catch (err) {
    console.error('[WA] Erro ao enviar audio:', err.message);
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    await sendText(jid, text);
  }
}

// ============================================
// CARREGAR CONTATOS DO BANCO (para @mentions)
// ============================================
// Mapeamento de TODOS os contatos (para @mentions — NÃO é filtro de equipe)
const allContacts = new Map(); // firstName → jid (usado apenas para @mentions)

async function loadTeamContacts() {
  try {
    const { rows } = await pool.query(
      "SELECT jid, push_name FROM jarvis_contacts WHERE push_name IS NOT NULL AND push_name != ''"
    );
    let loaded = 0;
    for (const row of rows) {
      const firstName = row.push_name.split(' ')[0].toLowerCase();
      if (!allContacts.has(firstName)) {
        allContacts.set(firstName, row.jid);
        loaded++;
      }
    }
    console.log(`[TEAM] ${loaded} contatos carregados do banco para @mentions`);
  } catch (err) {
    console.error('[TEAM] Erro ao carregar contatos:', err.message);
  }
}

// ============================================
// HANDLER DE MENSAGENS
// ============================================
async function handleIncomingMessage(m) {
  if (m.key.remoteJid === 'status@broadcast') return;
  // Ignorar TODAS as mensagens fromMe (enviadas pelo próprio bot)
  // Não depender do sentByBot — ele é efêmero e perde dados no restart do PM2
  if (m.key.fromMe) {
    sentByBot.delete(m.key.id); // limpar se existia
    return;
  }

  const from = m.key.remoteJid;
  const isGroup = from.endsWith('@g.us');
  const sender = extractSender(m, from, isGroup);

  let text = m.message?.conversation || m.message?.extendedTextMessage?.text || m.message?.imageMessage?.caption || m.message?.videoMessage?.caption || '';
  let isAudio = false;
  const audioMsg = m.message?.audioMessage;

  // Transcrever áudio + salvar arquivo
  if (audioMsg && process.env.OPENAI_API_KEY) {
    try {
      console.log('[AUDIO] Transcrevendo audio de', m.pushName || sender);
      const buffer = await downloadMediaMessage(m, 'buffer', {});
      const transcription = await transcribeAudio(buffer);
      text = transcription;
      isAudio = true;
      console.log('[AUDIO] Transcricao:', transcription.substring(0, 100));

      // Salvar arquivo de áudio em disco para consulta futura
      try {
        const audioDir = path.join(__dirname, 'audio_files');
        const { mkdir } = await import('fs/promises');
        await mkdir(audioDir, { recursive: true });
        const audioFile = path.join(audioDir, `${m.key.id}.ogg`);
        await writeFile(audioFile, buffer);
        console.log(`[AUDIO] Arquivo salvo: ${audioFile} (${Math.round(buffer.length / 1024)}KB)`);
      } catch (saveErr) {
        console.error('[AUDIO] Erro ao salvar arquivo:', saveErr.message);
      }
    } catch (err) {
      console.error('[AUDIO] Erro:', err.message);
    }
  }

  // Permitir mensagens de mídia sem texto passarem pelo fluxo
  const hasMedia = getMediaType(m) && !['audio', 'sticker', 'contact', 'location'].includes(getMediaType(m));
  if (!text && !hasMedia) return;
  const pushName = m.pushName || '';

  // Download de mídia (imagens, vídeos, documentos) — QUALQUER contexto (PV, grupo, proativo)
  const mediaFiles = [];
  if (hasMedia) {
    try {
      const buffer = await downloadMediaMessage(m, 'buffer', {});
      const mime = m.message?.imageMessage?.mimetype || m.message?.videoMessage?.mimetype || m.message?.documentMessage?.mimetype || '';
      const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'application/pdf': 'pdf' };
      const ext = extMap[mime] || mime.split('/')[1] || 'bin';
      const fileName = m.message?.documentMessage?.fileName || `${m.key.id}.${ext}`;
      const groupDir = path.join(__dirname, 'media_files', from.split('@')[0]);
      await mkdir(groupDir, { recursive: true });
      const filePath = path.join(groupDir, fileName);
      await writeFile(filePath, buffer);
      mediaFiles.push({ path: filePath, fileName, type: getMediaType(m), size: buffer.length, messageId: m.key.id });
      console.log(`[MEDIA] Mídia salva: ${filePath} (${Math.round(buffer.length / 1024)}KB)`);
    } catch (mediaErr) {
      console.error('[MEDIA] Erro ao baixar mídia:', mediaErr.message);
    }
  }

  const logText = text ? text.substring(0, 80) : `[${getMediaType(m) || 'mídia'}]`;
  console.log(`[MSG] ${isGroup ? 'GRUPO' : 'PV'} | ${pushName} (${sender.substring(0, 15)}): ${logText}`);

  // Salvar na memória (inclui message_key para reply futuro)
  await storeMessage({
    messageId: m.key.id, chatId: from, sender, pushName, text, isGroup, isAudio,
    mediaType: getMediaType(m), transcription: isAudio ? text : null,
    timestamp: (typeof m.messageTimestamp === 'object' && m.messageTimestamp?.low !== undefined) ? m.messageTimestamp.low : (Number(m.messageTimestamp) || Math.floor(Date.now() / 1000)),
    messageKey: JSON.stringify(m.key),
  });

  await upsertContact(sender, pushName);
  if (pushName) {
    const firstName = pushName.split(' ')[0].toLowerCase();
    if (!teamWhatsApp.has(firstName)) {
      teamWhatsApp.set(firstName, sender);
      console.log(`[TEAM] Novo membro mapeado: ${pushName} -> ${sender}`);
    }
  }

  // Aprendizado passivo em tempo real: aprende de TODAS as mensagens (grupos + privadas)
  // Monta contexto do grupo para o extrator saber se é cliente ou equipe
  let groupContext = null;
  if (isGroup) {
    const managedCheck = isManagedClientGroup(from);
    const isInternalGroup = from === CONFIG.GROUP_TAREFAS || from === CONFIG.GROUP_GALAXIAS;
    try {
      const { rows: gRows } = await pool.query('SELECT name FROM jarvis_groups WHERE jid = $1', [from]);
      groupContext = {
        groupName: gRows[0]?.name || 'Desconhecido',
        isClientGroup: !!managedCheck,
        isInternalGroup,
      };
    } catch {
      groupContext = { groupName: 'Desconhecido', isClientGroup: !!managedCheck, isInternalGroup };
    }
  }

  if (text.length >= 20 && !text.startsWith('[')) {
    processMemory(text, pushName || 'Desconhecido', sender, from, isGroup, groupContext).catch(err => {
      console.error('[MEMORY] Erro aprendizado passivo:', err.message);
    });
  }

  // Auto-detectar instruções/correções do Gui (WhatsApp) e salvar como homework
  // REGRA: Só salva se for REALMENTE uma instrução do Gui pro Jarvis
  // NÃO salva: áudios encaminhados de clientes, conversas casuais, transcrições
  if (sender === CONFIG.GUI_JID && text.length >= 15) {
    const lower = text.toLowerCase();
    // Regex mais restritivo: exige padrões que SÓ aparecem em instruções diretas pro Jarvis
    const isDirectInstruction = /\b(a partir de agora|nunca mais|sempre que|aprenda que|regra:|n[aã]o (fa[cç]a|chame|use|mande|envie|fale)|pode me chamar|me chame de|quero que voc[eê]|preciso que voc[eê]|jarvis.*(lembr|aprend|regra|entend))/i.test(lower);
    // Padrões de gestão (só conta se tiver "jarvis" ou for bem curto e direto)
    const isManagementOrder = /\b(autoriz|cuide|monitore|fique de olho|preste aten[cç][aã]o|tom[ea] conta|assuma|gerencie|acompanhe)\b/i.test(lower)
      && (lower.includes('jarvis') || text.length < 120);

    if (isDirectInstruction || isManagementOrder) {
      // Validação com Haiku: confirma se é instrução pro Jarvis (evita salvar áudio de cliente)
      validateHomework(text, isAudio).then(isValid => {
        if (isValid) {
          pool.query(
            'INSERT INTO homework (type, content, source) VALUES ($1, $2, $3)',
            ['whatsapp_instruction', text, 'whatsapp_gui']
          ).then(() => {
            console.log(`[HOMEWORK] ✅ Instrução do Gui salva: "${text.substring(0, 60)}..."`);
          }).catch(() => {});
        } else {
          console.log(`[HOMEWORK] ❌ Rejeitado (não é instrução pro Jarvis): "${text.substring(0, 60)}..."`);
        }
      }).catch(() => {});
    }

    // Detecção de autorização/revogação de clientes gerenciados
    const authMatch = lower.match(/autoriz[oe]\s+(?:voc[eê]\s+a\s+)?(?:operar|trabalhar|atuar|gerenciar|monitorar)\s+(?:no|na|no\s+cliente|o\s+cliente)?\s*(.+)/i);
    const revokeMatch = lower.match(/(?:pare|para|revog|desativ|deslig)\s+(?:de\s+)?(?:operar|trabalhar|atuar|gerenciar|monitorar)\s+(?:no|na|no\s+cliente|o\s+cliente)?\s*(.+)/i);

    if (authMatch && !isGroup) {
      const clientName = authMatch[1].replace(/[.,!?]+$/, '').trim();
      try {
        const { rows } = await pool.query(
          `SELECT jid, name FROM jarvis_groups WHERE LOWER(name) LIKE $1 LIMIT 1`,
          [`%${clientName.toLowerCase()}%`]
        );
        if (rows.length > 0) {
          const groupJid = rows[0].jid;
          const groupName = rows[0].name;
          managedClients.set(groupJid, {
            groupName, active: true,
            defaultAssignee: 'bruna',
            authorizedAt: new Date().toISOString(),
          });
          await saveManagedClients(pool);
          await sendText(from, `✅ Autorizado! Agora estou operando no grupo *${groupName}*.\n\nVou monitorar as mensagens do cliente, identificar demandas, criar tasks e notificar a equipe — tudo baseado no que já aprendi estudando o Asana.`);
          console.log(`[PROACTIVE] Cliente autorizado: ${groupName} (${groupJid})`);
        } else {
          await sendText(from, `Não encontrei nenhum grupo com o nome "${clientName}". Verifique o nome exato do grupo.`);
        }
      } catch (err) {
        console.error('[PROACTIVE] Erro ao autorizar cliente:', err.message);
      }
      return;
    }

    if (revokeMatch && !isGroup) {
      const clientName = revokeMatch[1].replace(/[.,!?]+$/, '').trim();
      let revoked = false;
      for (const [jid, client] of managedClients) {
        if (client.groupName?.toLowerCase().includes(clientName.toLowerCase()) || client.slug?.includes(clientName.toLowerCase())) {
          client.active = false;
          await saveManagedClients(pool);
          await sendText(from, `🔴 Operação no grupo *${client.groupName}* desativada. Não vou mais responder lá.`);
          console.log(`[PROACTIVE] Cliente revogado: ${client.groupName}`);
          revoked = true;
          break;
        }
      }
      if (!revoked) {
        await sendText(from, `Não encontrei cliente "${clientName}" nos gerenciados.`);
      }
      return;
    }
  }

  // AGENTE PROATIVO: Interceptar mensagens de grupos de clientes gerenciados
  if (isGroup) {
    const managedClient = isManagedClientGroup(from);
    if (managedClient) {
      // Verificar se o sender NÃO é da equipe Stream Lab
      // Usa realTeamJids (participantes dos grupos internos Tarefas/Galáxias)
      const isTeamMember = realTeamJids.has(sender);

      if (!isTeamMember) {
        console.log(`[PROACTIVE] Mensagem de cliente detectada: ${pushName} em ${managedClient.groupName}`);

        // mediaFiles já foi preenchido no download geral acima
        const result = await handleManagedClientMessage(text, sender, pushName, from, managedClient, sendText, mediaFiles);
        if (result?.text) {
          await sendText(from, result.text);
          // Salvar resposta do Jarvis
          await storeMessage({
            messageId: 'jarvis_proactive_' + randomUUID(), chatId: from, sender: CONFIG.GUI_JID,
            pushName: 'Jarvis', text: result.text, isGroup, isAudio: false,
            timestamp: Math.floor(Date.now() / 1000),
          });
        }
        return; // Não continua o fluxo normal
      }
    }
  }

  // ATENDIMENTO PÚBLICO: DM de desconhecidos (leads)
  // Se NÃO é grupo E sender NÃO é GUI_JID E sender NÃO é membro da equipe → handlePublicDM
  if (!isGroup && sender !== CONFIG.GUI_JID && !realTeamJids.has(sender)) {
    console.log(`[PUBLIC-DM] DM de desconhecido: ${pushName} (${sender.substring(0, 15)})`);

    // Modo pausa: não responder
    if (jarvisPaused) {
      console.log('[PUBLIC-DM] PAUSADO - ignorando');
      return;
    }

    const result = await handlePublicDM(text, sender, pushName, mediaFiles);
    if (result?.text) {
      await sendText(from, result.text);
      // Salvar resposta do Jarvis
      await storeMessage({
        messageId: 'jarvis_public_' + randomUUID(), chatId: from, sender: CONFIG.GUI_JID,
        pushName: 'Jarvis', text: result.text, isGroup: false, isAudio: false,
        timestamp: Math.floor(Date.now() / 1000),
      });

      // Notificar Gui no primeiro contato de um lead novo
      if (result.isFirstContact || result.notifyGui) {
        try {
          const notifyMsg = `📩 *Novo lead no WhatsApp*\n\nNome: ${pushName || 'Desconhecido'}\nNúmero: ${sender.replace('@s.whatsapp.net', '')}\nMensagem: "${text.substring(0, 150)}"\n\nJá respondi automaticamente.`;
          await sendText(CONFIG.GUI_JID, notifyMsg);
          console.log(`[PUBLIC-DM] Gui notificado sobre novo lead: ${pushName}`);
        } catch (notifyErr) {
          console.error('[PUBLIC-DM] Erro ao notificar Gui:', notifyErr.message);
        }
      }
    }
    return; // Não continua o fluxo normal
  }

  // Decidir se Jarvis deve responder
  // Extrair contextInfo de QUALQUER tipo de mensagem (não só extendedTextMessage)
  const contextInfo = m.message?.extendedTextMessage?.contextInfo
    || m.message?.imageMessage?.contextInfo
    || m.message?.videoMessage?.contextInfo
    || m.message?.documentMessage?.contextInfo
    || m.message?.audioMessage?.contextInfo
    || m.message?.stickerMessage?.contextInfo
    || null;

  const quotedParticipant = contextInfo?.participant || '';
  const quotedStanzaId = contextInfo?.stanzaId || '';
  const botNum = CONFIG.BOT_NUMBER || '';
  const botJid = CONFIG.BOT_JID || '';

  // Verificar se é reply ao Jarvis: por número OU por JID completo (inclui @lid) OU por sentByBot
  const isReplyToJarvis = sentByBot.has(quotedStanzaId)
    || (botNum && quotedParticipant.includes(botNum))
    || (botJid && quotedParticipant === botJid)
    || (botJid && quotedParticipant === botJid.replace(/:.*@/, '@')); // 555597337777:123@s.whatsapp.net → 555597337777@s.whatsapp.net

  // Verificar se Jarvis foi @mencionado na mensagem (metadata, não texto)
  const mentionedJids = contextInfo?.mentionedJid || [];
  const isMentionedByTag = mentionedJids.some(jid =>
    jid === botJid
    || (botNum && jid.includes(botNum))
    || (botJid && jid === botJid.replace(/:.*@/, '@'))
  );

  // Debug: logar detecção de replies e mentions em grupos
  if (isGroup && (quotedParticipant || mentionedJids.length > 0)) {
    console.log(`[REPLY-DEBUG] quotedParticipant=${quotedParticipant} | botJid=${botJid} | botNum=${botNum} | isReplyToJarvis=${isReplyToJarvis} | mentionedJids=${JSON.stringify(mentionedJids)} | isMentionedByTag=${isMentionedByTag}`);
  }

  if (!shouldJarvisRespond(text, from, isGroup, isReplyToJarvis, isMentionedByTag)) return;

  // Modo pausa: loga mas nao responde
  if (jarvisPaused) {
    console.log('[JARVIS] PAUSADO - ignorando:', text.substring(0, 60));
    return;
  }

  console.log('[JARVIS] Gerando resposta para:', text.substring(0, 60));

  const result = await generateResponse(text, from, sender, pushName, isGroup, mediaFiles);
  if (!result?.text) return;
  if (!isValidResponse(result.text)) {
    console.log('[JARVIS] Resposta bloqueada (lixo):', result.text.substring(0, 50));
    return;
  }

  const responseText = result.text;
  console.log(`[JARVIS] [${result.agent}] Resposta:`, responseText.substring(0, 80));

  // Enviar resposta
  const quotedMsg = isGroup ? m : null;
  if ((isAudio || result.sendAsAudio) && AUDIO_ALLOWED.has(from)) {
    await sendAudio(from, responseText);
  } else if (result.mentions?.length > 0) {
    await sendTextWithMentions(from, responseText, result.mentions, quotedMsg);
  } else {
    await sendText(from, responseText, quotedMsg);
  }

  // Modo conversa ativo
  if (isGroup) markConversationActive(from);

  // Salvar resposta do Jarvis
  await storeMessage({
    messageId: 'jarvis_' + randomUUID(), chatId: from, sender: CONFIG.GUI_JID,
    pushName: 'Jarvis', text: responseText, isGroup, isAudio: false,
    timestamp: Math.floor(Date.now() / 1000),
  });
}

// ============================================
// EXPRESS API
// ============================================
const app = express();
app.use(helmet({ contentSecurityPolicy: false })); // Headers de segurança (CSP desabilitado pra CDNs do dashboard)
app.use(cors({ origin: ['https://guardiaolab.com.br', 'http://localhost:3100'], credentials: true }));
app.use(express.json({ limit: '1mb' }));

// --- Auth: API key (interno) OU JWT (dashboard) ---
function auth(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  if (apiKey && apiKey === CONFIG.API_KEY) return next();

  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    try {
      if (!CONFIG.JWT_SECRET) return res.status(500).json({ error: 'JWT_SECRET não configurado' });
      const decoded = jwt.verify(authHeader.split(' ')[1], CONFIG.JWT_SECRET);
      req.user = decoded;
      return next();
    } catch { return res.status(401).json({ error: 'Token inválido ou expirado' }); }
  }

  return res.status(401).json({ error: 'Autenticação necessária' });
}

// --- Rate limiting para auth (anti brute-force) ---
const authRateLimit = new Map(); // ip -> { count, resetAt }
function checkAuthRateLimit(ip) {
  const now = Date.now();
  const entry = authRateLimit.get(ip);
  if (!entry || now > entry.resetAt) {
    authRateLimit.set(ip, { count: 1, resetAt: now + 60000 }); // 1 min window
    return true;
  }
  entry.count++;
  if (entry.count > 10) return false; // max 10 tentativas/min
  return true;
}

// Cache de geolocalização de IP
const geoCache = new Map(); // ip -> { data, cachedAt }
async function getGeoFromIP(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return { city: 'Local', region: '', country: 'LAN' };
  }
  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.cachedAt < 3600000) return cached.data;
  try {
    const resp = await fetch(`http://ip-api.com/json/${ip}?fields=city,regionName,country`);
    if (resp.ok) {
      const data = await resp.json();
      const geo = { city: data.city || '', region: data.regionName || '', country: data.country || '' };
      geoCache.set(ip, { data: geo, cachedAt: Date.now() });
      return geo;
    }
  } catch {}
  return { city: '', region: '', country: '' };
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || req.socket.remoteAddress || '';
}

async function logAccess(email, ip, userAgent, action, success) {
  const geo = await getGeoFromIP(ip);
  await pool.query(
    'INSERT INTO dashboard_access_log (email, ip, user_agent, action, success, city, region, country) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [email, ip, userAgent || '', action, success, geo.city, geo.region, geo.country]
  ).catch(() => {});
  return geo;
}

// --- Auth Endpoints (públicos — sem middleware) ---

// Verificar se já existe usuário cadastrado
app.get('/dashboard/auth/status', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*) as cnt FROM dashboard_users');
    const hasUsers = parseInt(rows[0].cnt) > 0;
    res.json({ hasUsers });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cadastro inicial (só funciona se não existe nenhum usuário)
app.post('/dashboard/auth/setup', async (req, res) => {
  try {
    const { email, password, phone_2fa } = req.body;
    if (!email || !password || !phone_2fa) return res.status(400).json({ error: 'Email, senha e telefone 2FA obrigatórios' });
    if (password.length < 8) return res.status(400).json({ error: 'Senha deve ter no mínimo 8 caracteres' });

    const { rows } = await pool.query('SELECT COUNT(*) as cnt FROM dashboard_users');
    if (parseInt(rows[0].cnt) > 0) return res.status(403).json({ error: 'Conta já existe. Use o login.' });

    const passwordHash = await bcrypt.hash(password, 12);
    // Normalizar telefone para JID WhatsApp (formato: 5555XXXXXXXX@s.whatsapp.net)
    let phoneDigits = phone_2fa.replace(/\D/g, '');
    // Se não começa com 55 (código do Brasil), adicionar
    if (!phoneDigits.startsWith('55')) phoneDigits = '55' + phoneDigits;
    // Se tem 12 dígitos (55 + DDD + 8 dígitos), adicionar 9 na frente do número
    if (phoneDigits.length === 12) phoneDigits = phoneDigits.slice(0, 4) + '9' + phoneDigits.slice(4);
    const phoneJid = phoneDigits + '@s.whatsapp.net';
    await pool.query(
      'INSERT INTO dashboard_users (email, password_hash, phone_2fa) VALUES ($1, $2, $3)',
      [email.toLowerCase(), passwordHash, phoneJid]
    );

    const ip = getClientIP(req);
    await logAccess(email, ip, req.headers['user-agent'], 'account_created', true);

    res.json({ success: true, message: 'Conta criada com sucesso!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Login Step 1: Email + Senha → envia código 2FA
app.post('/dashboard/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatórios' });

    const ip = getClientIP(req);
    const ua = req.headers['user-agent'] || '';

    // Rate limiting
    if (!checkAuthRateLimit(ip)) {
      await logAccess(email, ip, ua, 'rate_limited', false);
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde 1 minuto.' });
    }

    const { rows } = await pool.query('SELECT * FROM dashboard_users WHERE email = $1 AND is_active = true', [email.toLowerCase()]);
    if (rows.length === 0) {
      await logAccess(email, ip, ua, 'login_failed_email', false);
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const user = rows[0];

    // Verificar bloqueio
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      await logAccess(email, ip, ua, 'login_blocked', false);
      return res.status(423).json({ error: `Conta bloqueada. Tente novamente em ${minLeft} minuto(s).` });
    }

    // Verificar senha
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      const attempts = user.failed_attempts + 1;
      if (attempts >= 5) {
        await pool.query("UPDATE dashboard_users SET failed_attempts = $1, locked_until = NOW() + INTERVAL '15 minutes' WHERE id = $2", [attempts, user.id]);
        await logAccess(email, ip, ua, 'login_locked', false);
        // Alerta WhatsApp
        if (sock && user.phone_2fa) {
          sendText(user.phone_2fa, `🚨 *ALERTA DE SEGURANÇA*\n\nSua conta do Dashboard foi bloqueada após 5 tentativas de login falhadas.\nIP: ${ip}\nBloqueio: 15 minutos.\n\nSe não foi você, altere sua senha imediatamente.`).catch(() => {});
        }
        return res.status(423).json({ error: 'Conta bloqueada por 15 minutos após 5 tentativas.' });
      }
      await pool.query('UPDATE dashboard_users SET failed_attempts = $1 WHERE id = $2', [attempts, user.id]);
      await logAccess(email, ip, ua, 'login_failed_password', false);
      return res.status(401).json({ error: 'Credenciais inválidas', attemptsLeft: 5 - attempts });
    }

    // Senha correta — resetar tentativas
    await pool.query('UPDATE dashboard_users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);

    // Verificar se tem device_token confiável (pula 2FA)
    const { device_token } = req.body;
    if (device_token) {
      const { rows: trustedRows } = await pool.query(
        "SELECT * FROM dashboard_trusted_devices WHERE device_token = $1 AND email = $2 AND expires_at > NOW()",
        [device_token, email.toLowerCase()]
      );
      if (trustedRows.length > 0) {
        // Dispositivo confiável — emitir JWT direto sem 2FA
        if (!CONFIG.JWT_SECRET) return res.status(500).json({ error: 'JWT_SECRET não configurado' });
        const token = jwt.sign({ email: email.toLowerCase() }, CONFIG.JWT_SECRET, { expiresIn: '8h' });
        await logAccess(email, ip, ua, 'login_trusted_device', true);
        return res.json({ token, expiresIn: '8h', trusted: true });
      }
    }

    // Sem device confiável — gerar código 2FA
    const code = String(randomInt(100000, 999999));
    await pool.query(
      "INSERT INTO dashboard_2fa_codes (email, code, expires_at) VALUES ($1, $2, NOW() + INTERVAL '5 minutes')",
      [email.toLowerCase(), code]
    );

    // Enviar código via WhatsApp
    if (sock && user.phone_2fa) {
      await sendText(user.phone_2fa, `🔐 *Código de acesso ao Dashboard*\n\n*${code}*\n\nExpira em 5 minutos.\nSe não foi você, ignore esta mensagem.`).catch(() => {});
    }

    await logAccess(email, ip, ua, 'login_2fa_sent', true);
    res.json({ requires_2fa: true, message: 'Código enviado no seu WhatsApp' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Login Step 2: Verificar código 2FA → retorna JWT
app.post('/dashboard/auth/verify', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email e código obrigatórios' });

    const ip = getClientIP(req);
    const ua = req.headers['user-agent'] || '';

    if (!checkAuthRateLimit(ip)) {
      await logAccess(email, ip, ua, 'verify_rate_limited', false);
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde 1 minuto.' });
    }

    // Buscar código válido (não expirado, não usado)
    const { rows } = await pool.query(
      'SELECT * FROM dashboard_2fa_codes WHERE email = $1 AND code = $2 AND used = false AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
      [email.toLowerCase(), code]
    );

    if (rows.length === 0) {
      await logAccess(email, ip, ua, 'verify_failed', false);
      return res.status(401).json({ error: 'Código inválido ou expirado' });
    }

    // Marcar código como usado
    await pool.query('UPDATE dashboard_2fa_codes SET used = true WHERE id = $1', [rows[0].id]);

    // Gerar JWT
    if (!CONFIG.JWT_SECRET) return res.status(500).json({ error: 'JWT_SECRET não configurado no servidor' });
    const token = jwt.sign({ email: email.toLowerCase() }, CONFIG.JWT_SECRET, { expiresIn: '8h' });

    const geo = await logAccess(email, ip, ua, 'login_success', true);

    // Alerta para IP desconhecido
    const { rows: prevIPs } = await pool.query(
      "SELECT DISTINCT ip FROM dashboard_access_log WHERE email = $1 AND action = 'login_success' AND ip != $2 AND created_at > NOW() - INTERVAL '30 days'",
      [email.toLowerCase(), ip]
    );
    const knownIPs = await pool.query(
      "SELECT COUNT(*) as cnt FROM dashboard_access_log WHERE email = $1 AND ip = $2 AND action = 'login_success'",
      [email.toLowerCase(), ip]
    );
    if (parseInt(knownIPs.rows[0].cnt) <= 1 && prevIPs.rows.length > 0) {
      // IP novo — alerta
      const userRow = await pool.query('SELECT phone_2fa FROM dashboard_users WHERE email = $1', [email.toLowerCase()]);
      if (sock && userRow.rows[0]?.phone_2fa) {
        sendText(userRow.rows[0].phone_2fa, `⚠️ *Novo acesso ao Dashboard*\n\nIP: ${ip}\nLocal: ${geo.city}${geo.region ? ', ' + geo.region : ''} - ${geo.country}\nHora: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n\nFoi você? Se não, altere sua senha agora.`).catch(() => {});
      }
    }

    // Limpar códigos antigos
    pool.query("DELETE FROM dashboard_2fa_codes WHERE expires_at < NOW() OR used = true").catch(() => {});

    // Se pediu para confiar no dispositivo, gerar device_token (30 dias)
    const { trust_device } = req.body;
    let deviceToken = null;
    if (trust_device) {
      const { randomBytes } = await import('crypto');
      deviceToken = randomBytes(32).toString('hex');
      const browserLabel = ua.includes('Chrome') ? 'Chrome' : ua.includes('Firefox') ? 'Firefox' : ua.includes('Safari') ? 'Safari' : 'Navegador';
      await pool.query(
        "INSERT INTO dashboard_trusted_devices (email, device_token, ip, user_agent, label, expires_at) VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '30 days')",
        [email.toLowerCase(), deviceToken, ip, ua, browserLabel]
      );
      // Limpar dispositivos expirados
      pool.query("DELETE FROM dashboard_trusted_devices WHERE expires_at < NOW()").catch(() => {});
    }

    const response = { token, expiresIn: '8h' };
    if (deviceToken) response.device_token = deviceToken;
    res.json(response);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reenviar código 2FA
app.post('/dashboard/auth/resend', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email obrigatório' });

    const ip = getClientIP(req);
    if (!checkAuthRateLimit(ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 1 minuto.' });

    const { rows } = await pool.query('SELECT phone_2fa FROM dashboard_users WHERE email = $1 AND is_active = true', [email.toLowerCase()]);
    if (rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });

    // Invalidar códigos anteriores
    await pool.query('UPDATE dashboard_2fa_codes SET used = true WHERE email = $1 AND used = false', [email.toLowerCase()]);

    const code = String(randomInt(100000, 999999));
    await pool.query(
      "INSERT INTO dashboard_2fa_codes (email, code, expires_at) VALUES ($1, $2, NOW() + INTERVAL '5 minutes')",
      [email.toLowerCase(), code]
    );

    if (sock && rows[0].phone_2fa) {
      await sendText(rows[0].phone_2fa, `🔐 *Novo código de acesso ao Dashboard*\n\n*${code}*\n\nExpira em 5 minutos.`).catch(() => {});
    }

    res.json({ success: true, message: 'Novo código enviado' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Alterar senha (requer JWT)
app.post('/dashboard/auth/change-password', auth, async (req, res) => {
  try {
    if (!req.user?.email) return res.status(401).json({ error: 'Token JWT necessário' });
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Senha atual e nova obrigatórias' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Nova senha deve ter no mínimo 8 caracteres' });

    const { rows } = await pool.query('SELECT * FROM dashboard_users WHERE email = $1', [req.user.email]);
    if (rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });

    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Senha atual incorreta' });

    const newHash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE dashboard_users SET password_hash = $1, updated_at = NOW() WHERE email = $2', [newHash, req.user.email]);

    const ip = getClientIP(req);
    await logAccess(req.user.email, ip, req.headers['user-agent'], 'password_changed', true);

    res.json({ success: true, message: 'Senha alterada com sucesso!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Log de acessos (requer JWT)
app.get('/dashboard/auth/access-log', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT email, ip, user_agent, action, success, city, region, country, created_at FROM dashboard_access_log ORDER BY created_at DESC LIMIT 50'
    );
    res.json({ logs: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Intelligence Score ---
app.get('/dashboard/intelligence', auth, async (req, res) => {
  try {
    const memByCategory = await pool.query('SELECT category, COUNT(*)::int as cnt, AVG(importance)::float as avg_imp FROM jarvis_memories GROUP BY category');
    const memByScope = await pool.query('SELECT scope, COUNT(*)::int as cnt FROM jarvis_memories GROUP BY scope');
    const totalMemories = await pool.query('SELECT COUNT(*)::int as cnt FROM jarvis_memories');
    const totalMessages = await pool.query('SELECT COUNT(*)::int as cnt FROM jarvis_messages');
    const uniqueContacts = await pool.query('SELECT COUNT(DISTINCT sender)::int as cnt FROM jarvis_messages');
    const uniqueGroups = await pool.query('SELECT COUNT(DISTINCT chat_id)::int as cnt FROM jarvis_messages WHERE is_group = true');
    const profileCount = await pool.query('SELECT entity_type, COUNT(*)::int as cnt FROM jarvis_profiles GROUP BY entity_type').catch(() => ({ rows: [] }));
    const gcalCount = await pool.query('SELECT COUNT(*)::int as cnt FROM gcal_sync').catch(() => ({ rows: [{ cnt: 0 }] }));
    const daysActive = await pool.query("SELECT COALESCE(EXTRACT(DAY FROM NOW() - MIN(created_at)), 0)::int as days FROM jarvis_messages WHERE push_name = 'Jarvis' OR sender LIKE '%jarvis%'");

    const catMap = {};
    for (const row of memByCategory.rows) catMap[row.category] = { count: row.cnt, avgImp: row.avg_imp };
    const scopeMap = {};
    for (const row of memByScope.rows) scopeMap[row.scope] = row.cnt;
    const profileMap = {};
    for (const row of profileCount.rows) profileMap[row.entity_type] = row.cnt;

    const totalMem = totalMemories.rows[0].cnt;

    // ============================================
    // SISTEMA DE INTELIGÊNCIA - Recalibrado para escala real
    // ============================================
    // Score ponderado: quantidade × qualidade (importância média)
    // Importância vai de 1-10, divisor 5 → imp=5 dá 1x, imp=10 dá 2x, imp=1 dá 0.2x
    const weightedCount = (categories) => {
      let total = 0;
      for (const cat of categories) {
        const c = catMap[cat];
        if (!c) continue;
        const qualityFactor = Math.max(0.2, (c.avgImp || 5) / 5);
        total += c.count * qualityFactor;
      }
      return Math.round(total);
    };

    // 6 eixos com thresholds calibrados para 127K+ memórias
    // Cada threshold = [20%, 40%, 60%, 80%, 100%]
    const logScore = (count, thresholds) => {
      if (count <= 0) return 0;
      for (let i = 0; i < thresholds.length; i++) {
        if (count <= thresholds[i]) {
          const prev = i === 0 ? 0 : thresholds[i - 1];
          const range = thresholds[i] - prev;
          const progress = (count - prev) / range;
          return Math.round((i * 20) + (progress * 20));
        }
      }
      return 100;
    };

    const axes = {
      empresa: logScore(
        weightedCount(['general', 'rule', 'process']),
        [1000, 5000, 15000, 40000, 100000]
      ),
      equipe: logScore(
        weightedCount(['team_member', 'style', 'pattern']),
        [500, 3000, 10000, 30000, 80000]
      ),
      clientes: logScore(
        weightedCount(['client', 'client_profile']),
        [500, 3000, 10000, 30000, 80000]
      ),
      projetos: logScore(
        weightedCount(['decision', 'deadline']) + (gcalCount.rows[0].cnt || 0),
        [500, 2500, 8000, 25000, 70000]
      ),
      comunicacao: logScore(
        weightedCount(['preference', 'style']),
        [250, 1500, 5000, 15000, 40000]
      ),
      processos: logScore(
        weightedCount(['process', 'rule']),
        [250, 1500, 5000, 15000, 40000]
      ),
    };

    const axesValues = Object.values(axes);
    const overallScore = Math.round(axesValues.reduce((a, b) => a + b, 0) / axesValues.length);

    // Patente baseada no TOTAL de memórias (não no score %)
    // 10 níveis — escala realista para crescimento de longo prazo
    const patentes = [
      { id: 'recruta', nome: 'Recruta', cor: '#8B6914', icon: '🟤', min: 0, max: 999, desc: 'Acabou de chegar, aprendendo o básico' },
      { id: 'agente', nome: 'Agente', cor: '#00d4ff', icon: '🔵', min: 1000, max: 4999, desc: 'Conhece as pessoas e rotinas' },
      { id: 'especialista', nome: 'Especialista', cor: '#00ff88', icon: '🟢', min: 5000, max: 14999, desc: 'Entende padrões, clientes e processos' },
      { id: 'capitao', nome: 'Capitão', cor: '#ffd700', icon: '🟡', min: 15000, max: 39999, desc: 'Domina a operação, antecipa necessidades' },
      { id: 'comandante', nome: 'Comandante', cor: '#ff8a00', icon: '🟠', min: 40000, max: 79999, desc: 'Conhecimento profundo de tudo e todos' },
      { id: 'vingador', nome: 'Vingador', cor: '#a855f7', icon: '🟣', min: 80000, max: 149999, desc: 'Participa ativamente nas operações' },
      { id: 'lider', nome: 'Líder dos Vingadores', cor: '#ec4899', icon: '💎', min: 150000, max: 249999, desc: 'Lidera com inteligência e visão estratégica' },
      { id: 'conselheiro', nome: 'Conselheiro de Asgard', cor: '#06b6d4', icon: '⚡', min: 250000, max: 399999, desc: 'Sabedoria institucional do Lab' },
      { id: 'sentinela', nome: 'Sentinela Cósmico', cor: '#f59e0b', icon: '🌟', min: 400000, max: 699999, desc: 'Inteligência transcendente, visão total' },
      { id: 'diretor', nome: 'Diretor da S.H.I.E.L.D.', cor: '#ff3b3b', icon: '🔴', min: 700000, max: Infinity, desc: 'Onisciência operacional — sabe tudo' },
    ];

    const patente = patentes.find(p => totalMem >= p.min && totalMem <= p.max) || patentes[0];
    const nextPatente = patentes.find(p => p.min > totalMem) || null;
    const progressToNext = nextPatente
      ? Math.round(((totalMem - patente.min) / (nextPatente.min - patente.min)) * 100)
      : 100;

    res.json({
      // Patente
      patente: {
        id: patente.id,
        nome: patente.nome,
        cor: patente.cor,
        icon: patente.icon,
        desc: patente.desc,
        progressToNext,
        nextPatente: nextPatente ? { nome: nextPatente.nome, icon: nextPatente.icon, min: nextPatente.min } : null,
      },
      // Eixos de conhecimento (radar)
      axes,
      overallScore,
      // Contadores
      totalMemories: totalMem,
      totalMessages: totalMessages.rows[0].cnt,
      uniqueContacts: uniqueContacts.rows[0].cnt,
      uniqueGroups: uniqueGroups.rows[0].cnt,
      daysActive: daysActive.rows[0].days,
      // Breakdown
      memoriesByScope: scopeMap,
      memoriesByCategory: catMap,
      profilesCount: profileMap,
      // Todas as patentes para mostrar a progressão
      allPatentes: patentes.map(p => ({ id: p.id, nome: p.nome, cor: p.cor, icon: p.icon, min: p.min, desc: p.desc })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Status e Health ---
app.get('/status', auth, async (req, res) => {
  const msgCount = await getMessageCount();
  const memStats = await getMemoryStats();
  res.json({
    status: connectionStatus, version: CONFIG.JARVIS_VERSION,
    messages_stored: msgCount, memories_stored: memStats.total,
    ai_model: CONFIG.AI_MODEL, architecture: 'Jarvis 4.0 - Agent Loop + Extended Thinking + Prompt Caching',
  });
});

// --- Agentes & Inteligência ---
app.get('/dashboard/agents', auth, async (req, res) => {
  try {
    // 1. Memórias por escopo (o que cada "cérebro" sabe)
    const memByScope = await pool.query('SELECT scope, COUNT(*)::int as cnt FROM jarvis_memories GROUP BY scope');
    const scopeMap = {};
    for (const row of memByScope.rows) scopeMap[row.scope] = row.cnt;

    // 2. Memórias por categoria (distribuição de conhecimento)
    const memByCat = await pool.query('SELECT category, COUNT(*)::int as cnt, AVG(importance)::float as avg_imp FROM jarvis_memories GROUP BY category ORDER BY cnt DESC');
    const catMap = {};
    for (const row of memByCat.rows) catMap[row.category] = { count: row.cnt, avgImportance: Math.round(row.avg_imp * 10) / 10 };

    // 3. Aprendizado recente (últimas 24h, 7 dias, 30 dias)
    const learning = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int as last_24h,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int as last_7d,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int as last_30d,
        COUNT(*)::int as total
      FROM jarvis_memories
    `);

    // 4. Evolução diária (últimos 14 dias)
    const timeline = await pool.query(`
      SELECT DATE(created_at) as day, COUNT(*)::int as cnt
      FROM jarvis_memories
      WHERE created_at > NOW() - INTERVAL '14 days'
      GROUP BY DATE(created_at)
      ORDER BY day
    `);

    // 5. Perfis sintetizados
    const profiles = await pool.query('SELECT entity_type, COUNT(*)::int as cnt FROM jarvis_profiles GROUP BY entity_type').catch(() => ({ rows: [] }));
    const profileMap = {};
    for (const row of profiles.rows) profileMap[row.entity_type] = row.cnt;

    // 6. Estudo Asana (progresso) — agregado por entity_type
    const asanaStudy = await pool.query(`
      SELECT
        entity_type as phase,
        CASE WHEN bool_and(processed) THEN 'completed' ELSE 'pending' END as status,
        COUNT(*)::int as items_total,
        COUNT(*) FILTER (WHERE processed)::int as items_done,
        COALESCE(SUM(facts_extracted), 0)::int as facts_extracted,
        MIN(created_at) as started_at,
        MAX(created_at) as completed_at
      FROM asana_study_log
      GROUP BY entity_type
      ORDER BY MIN(created_at) DESC
    `).catch(() => ({ rows: [] }));

    // 7. Mensagens processadas (volume de aprendizado WhatsApp)
    const msgStats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int as msgs_24h,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int as msgs_7d,
        COUNT(*)::int as total
      FROM jarvis_messages
    `);

    // 8. Homework (instruções manuais)
    const hwCount = await pool.query('SELECT COUNT(*)::int as cnt FROM homework').catch(() => ({ rows: [{ cnt: 0 }] }));

    // 9. Top entidades com mais memórias (quem o Jarvis mais conhece)
    const topEntities = await pool.query(`
      SELECT scope_id as entity_id, scope, COUNT(*)::int as cnt
      FROM jarvis_memories
      WHERE scope_id IS NOT NULL AND scope_id != ''
      GROUP BY scope_id, scope
      ORDER BY cnt DESC
      LIMIT 15
    `).catch(() => ({ rows: [] }));

    // Definir agentes com suas especialidades
    const agents = [
      {
        id: 'master',
        nome: 'Master',
        icon: '🎯',
        cor: '#00d4ff',
        especialidade: 'Conversação geral, personalidade Jarvis (Tony Stark)',
        triggers: 'Resposta padrão, saudações, perguntas gerais',
        capabilities: ['Personalidade Jarvis', 'Contexto de conversa', 'Janela 3min', 'Modo áudio'],
        memoriasRelevantes: (scopeMap.chat || 0) + (scopeMap.user || 0),
      },
      {
        id: 'creative',
        nome: 'Creative',
        icon: '🎨',
        cor: '#a855f7',
        especialidade: 'Copy, legendas, roteiros, CTAs, conteúdo criativo',
        triggers: 'copy, arte, conteúdo, legenda, roteiro, headline, CTA',
        capabilities: ['Copywriting', 'Legendas para redes', 'Roteiros de vídeo', 'Headlines e CTAs'],
        memoriasRelevantes: (catMap.style?.count || 0) + (catMap.pattern?.count || 0) + (catMap.client_profile?.count || 0),
      },
      {
        id: 'manager',
        nome: 'Manager',
        icon: '📋',
        cor: '#ffd700',
        especialidade: 'Gestão de projetos, prazos, Asana, cobrança',
        triggers: 'tarefa, prazo, status, cobrança, task, projeto, atrasada',
        capabilities: ['Consultar tarefas Asana', 'Criar demandas', 'Cobrança automática', 'Relatório diário'],
        memoriasRelevantes: (catMap.deadline?.count || 0) + (catMap.decision?.count || 0) + (catMap.process?.count || 0) + (catMap.client?.count || 0),
      },
      {
        id: 'researcher',
        nome: 'Researcher',
        icon: '🔬',
        cor: '#00ff88',
        especialidade: 'Pesquisa, dados, tendências, análise',
        triggers: 'pesquisar, dados, benchmark, tendência, análise, relatório',
        capabilities: ['Busca na memória (RAG)', 'Análise de dados', 'Relatórios', 'Tendências'],
        memoriasRelevantes: (scopeMap.agent || 0),
      },
      {
        id: 'traffic',
        nome: 'Traffic',
        icon: '📈',
        cor: '#ff6b35',
        especialidade: 'Tráfego pago, Meta Ads, campanhas, métricas',
        triggers: 'campanha, CPC, CTR, CPM, ROAS, ads, verba, tráfego, pixel, anúncio',
        capabilities: ['Criar campanhas Meta Ads', 'Relatório de métricas', 'Pausar/ativar campanhas', 'Otimização de verba'],
        memoriasRelevantes: (catMap.client?.count || 0) + (catMap.process?.count || 0),
      },
      {
        id: 'social',
        nome: 'Social',
        icon: '📱',
        cor: '#ec4899',
        especialidade: 'Social media, publicação, calendário editorial',
        triggers: 'publicar, agendar, post, stories, reels, engajamento, alcance, calendário editorial',
        capabilities: ['Agendar posts FB/IG', 'Calendário editorial', 'Métricas orgânicas', 'Melhores horários'],
        memoriasRelevantes: (catMap.client_profile?.count || 0) + (catMap.pattern?.count || 0),
      },
    ];

    res.json({
      agents,
      scopes: scopeMap,
      categories: catMap,
      learning: learning.rows[0] || {},
      timeline: timeline.rows,
      profiles: profileMap,
      asanaStudy: asanaStudy.rows,
      msgStats: msgStats.rows[0] || {},
      homeworkCount: hwCount.rows[0].cnt,
      topEntities: topEntities.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Email Monitor (Asana @mentions) ---
app.get('/dashboard/email-monitor', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM asana_email_log ORDER BY created_at DESC LIMIT 20').catch(() => ({ rows: [] }));
    res.json({ status: emailMonitorState, recentLogs: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Email Channel Monitor (leads/contato genérico) ---
app.get('/dashboard/email-channel', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM email_log ORDER BY created_at DESC LIMIT 20').catch(() => ({ rows: [] }));
    res.json({ status: channelEmailState, recentLogs: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Channel Settings (Instagram + Email config via dashboard) ---
app.get('/dashboard/channels', auth, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT value FROM jarvis_config WHERE key = 'channel_settings'");
    const settings = rows[0]?.value || {
      instagram: { enabled: false, verify_token: '', allowed_pages: [] },
      email: { enabled: false, imap_host: '', imap_port: 993, smtp_host: '', smtp_port: 587, user: '', password: '' },
    };
    // Não expor senhas no GET
    if (settings.email?.password) {
      settings.email.password = '••••••••';
    }
    res.json(settings);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/dashboard/channels', auth, async (req, res) => {
  try {
    const settings = req.body;

    // Merge com existente (não sobrescrever senha se mascarada)
    const { rows } = await pool.query("SELECT value FROM jarvis_config WHERE key = 'channel_settings'");
    const existing = rows[0]?.value || {};

    if (settings.email?.password === '••••••••') {
      settings.email.password = existing.email?.password || '';
    }

    await pool.query(
      `INSERT INTO jarvis_config (key, value) VALUES ('channel_settings', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [JSON.stringify(settings)]
    );

    console.log('[DASHBOARD] Channel settings atualizadas');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/dashboard/health', auth, async (req, res) => {
  try {
    const msgCount = await getMessageCount();
    const memStats = await getMemoryStats();
    const uptime = process.uptime();
    const mem = process.memoryUsage();
    res.json({
      status: connectionStatus, version: CONFIG.JARVIS_VERSION,
      paused: jarvisPaused,
      uptime: Math.floor(uptime),
      uptimeFormatted: Math.floor(uptime / 3600) + 'h ' + Math.floor((uptime % 3600) / 60) + 'm',
      memory: { rss: Math.round(mem.rss / 1024 / 1024), heapUsed: Math.round(mem.heapUsed / 1024 / 1024) },
      whatsapp: connectionStatus,
      totalMessages: msgCount,
      totalMemories: memStats.total,
      memoriesByScope: memStats.byScope,
      memoriesByCategory: memStats.byCategory,
      architecture: { agents: ['master', 'creative', 'manager', 'researcher'], memorySystem: 'Mem0-inspired (3 scopes)', skills: ['asana', 'gcal', 'voice', 'memory'] },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Controle ON/OFF ---
app.post('/dashboard/power', auth, (req, res) => {
  const { action } = req.body;
  if (action === 'pause') {
    jarvisPaused = true;
    console.log('[JARVIS] PAUSADO pelo dashboard');
    res.json({ success: true, paused: true, message: 'Jarvis pausado. Ele ainda recebe mensagens mas nao responde.' });
  } else if (action === 'resume') {
    jarvisPaused = false;
    console.log('[JARVIS] RETOMADO pelo dashboard');
    res.json({ success: true, paused: false, message: 'Jarvis ativo novamente.' });
  } else {
    res.json({ paused: jarvisPaused });
  }
});

// --- Mensagens ---
app.post('/send/text', auth, async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'Campos to e message obrigatorios' });
    const jid = to.includes('@') ? to : to + '@s.whatsapp.net';
    const result = await sock.sendMessage(jid, { text: message });
    if (result?.key?.id) sentByBot.add(result.key.id);
    res.json({ success: true, messageId: result.key.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/send/group', auth, async (req, res) => {
  try {
    const { groupId, message } = req.body;
    const gid = groupId ? (groupId.includes('@') ? groupId : groupId + '@g.us') : CONFIG.GROUP_TAREFAS;
    if (!message) return res.status(400).json({ error: 'Campo message obrigatorio' });
    const result = await sock.sendMessage(gid, { text: message });
    if (result?.key?.id) sentByBot.add(result.key.id);
    res.json({ success: true, messageId: result.key.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/send/audio', auth, async (req, res) => {
  try {
    const { to, text, groupId, jid: bodyJid } = req.body;
    if (!text) return res.status(400).json({ error: 'Campo text obrigatorio' });
    const jid = bodyJid ? (bodyJid.includes('@') ? bodyJid : bodyJid + '@g.us') : groupId ? (groupId.includes('@') ? groupId : groupId + '@g.us') : to ? (to.includes('@') ? to : to + '@s.whatsapp.net') : CONFIG.GROUP_TAREFAS;
    if (!AUDIO_ALLOWED.has(jid)) return res.status(403).json({ error: 'Audio nao permitido neste chat' });
    await sock.sendPresenceUpdate('recording', jid).catch(() => {});
    const audioBuffer = await generateAudio(text);
    const result = await sock.sendMessage(jid, { audio: audioBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    res.json({ success: true, messageId: result.key.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// GRUPOS — Listar e toggle (ANTES do express.static!)
// ============================================
app.get('/dashboard/groups', auth, async (req, res) => {
  try {
    const groups = [];
    const listedJids = new Set();
    const internalJids = [CONFIG.GROUP_TAREFAS, CONFIG.GROUP_GALAXIAS].filter(Boolean);

    // 1. Grupos internos
    if (internalJids.length > 0) {
      const { rows } = await pool.query('SELECT jid, name FROM jarvis_groups WHERE jid = ANY($1)', [internalJids]);
      const nameMap = Object.fromEntries(rows.map(r => [r.jid, r.name]));
      for (const jid of internalJids) {
        groups.push({ jid, name: nameMap[jid] || jid, type: 'internal', active: JARVIS_ALLOWED_GROUPS.has(jid), canToggle: true });
        listedJids.add(jid);
      }
    }

    // 2. Clientes gerenciados
    for (const [jid, client] of managedClients) {
      groups.push({ jid, name: client.groupName || jid, type: 'client', active: !!client.active, canToggle: true, slug: client.slug, defaultAssignee: client.defaultAssignee, authorizedAt: client.authorizedAt });
      listedJids.add(jid);
    }

    // 3. Sync com WhatsApp real (quais grupos o bot está de verdade)
    let realGroupJids = new Set();
    try {
      if (sock?.ws?.isOpen) {
        const chats = await sock.groupFetchAllParticipating();
        for (const [gid, meta] of Object.entries(chats)) {
          realGroupJids.add(gid);
          // Atualizar nome no banco
          await upsertGroup(gid, meta.subject || gid);
        }
      }
    } catch (e) {
      console.error('[GROUPS] Erro ao sincronizar grupos do WhatsApp:', e.message);
    }

    // 4. TODOS os outros grupos do WhatsApp (do banco jarvis_groups)
    const { rows: allGroups } = await pool.query("SELECT jid, name FROM jarvis_groups WHERE jid LIKE '%@g.us' ORDER BY name");
    for (const g of allGroups) {
      if (listedJids.has(g.jid)) continue;
      // Se fez sync e o grupo não está no WhatsApp real, pula (saiu do grupo)
      if (realGroupJids.size > 0 && !realGroupJids.has(g.jid)) continue;
      const isActive = JARVIS_ALLOWED_GROUPS.has(g.jid);
      groups.push({ jid: g.jid, name: g.name || g.jid, type: 'other', active: isActive, canToggle: true });
    }

    res.json({ groups });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/dashboard/groups/toggle', auth, async (req, res) => {
  const { jid, active } = req.body;
  if (!jid) return res.status(400).json({ success: false, message: 'JID obrigatório' });
  try {
    const isInternal = jid === CONFIG.GROUP_TAREFAS || jid === CONFIG.GROUP_GALAXIAS;
    if (isInternal) {
      if (active) { JARVIS_ALLOWED_GROUPS.add(jid); AUDIO_ALLOWED.add(jid); }
      else { JARVIS_ALLOWED_GROUPS.delete(jid); AUDIO_ALLOWED.delete(jid); }
      console.log(`[DASHBOARD] Grupo interno ${jid} ${active ? 'ATIVADO' : 'DESATIVADO'}`);
      res.json({ success: true, jid, active, message: `Grupo interno ${active ? 'ativado' : 'desativado'}. Volta ao ativo ao reiniciar.` });
    } else if (managedClients.has(jid)) {
      const client = managedClients.get(jid);
      client.active = active;
      await saveManagedClients(pool);
      console.log(`[DASHBOARD] Cliente ${client.groupName} ${active ? 'ATIVADO' : 'DESATIVADO'}`);
      res.json({ success: true, jid, active, message: `${client.groupName || 'Cliente'} ${active ? 'ativado' : 'desativado'}.` });
    } else {
      // Qualquer outro grupo — toggle livre via dashboard, persiste no banco
      const { rows } = await pool.query("SELECT name FROM jarvis_groups WHERE jid = $1", [jid]);
      const groupName = rows[0]?.name || jid;
      if (active) {
        JARVIS_ALLOWED_GROUPS.add(jid);
      } else {
        JARVIS_ALLOWED_GROUPS.delete(jid);
      }
      // Persistir no banco (sobrevive restart)
      const existing = await pool.query("SELECT value FROM jarvis_config WHERE key = 'group_toggles'").catch(() => ({ rows: [] }));
      const toggles = existing.rows[0]?.value || {};
      toggles[jid] = active;
      await pool.query(
        `INSERT INTO jarvis_config (key, value) VALUES ('group_toggles', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [JSON.stringify(toggles)]
      );
      console.log(`[DASHBOARD] Grupo "${groupName}" ${active ? 'ATIVADO' : 'DESATIVADO'} (persistido)`);
      res.json({ success: true, jid, active, message: `${groupName} ${active ? 'ativado' : 'desativado'}.` });
    }
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// --- Dashboard v2 (Next.js) como principal ---
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard-v2', 'out'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// SPA fallback para rotas do dashboard (Express 5 não aceita wildcard *)
app.get(/^\/dashboard\/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard-v2', 'out', 'index.html'));
});

app.get('/groups', auth, async (req, res) => {
  try {
    const groups = await sock.groupFetchAllParticipating();
    const list = Object.values(groups).map(g => ({ id: g.id, name: g.subject, participants: g.participants.length }));
    res.json({ groups: list });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/dashboard/config', auth, async (req, res) => {
  try {
    const maskKey = k => (!k || k.length < 10) ? '***' : k.substring(0, 8) + '...' + k.substring(k.length - 4);
    res.json({
      api: { port: CONFIG.API_PORT }, ai: { model: CONFIG.AI_MODEL },
      asana: { workspace: CONFIG.ASANA_WORKSPACE }, whatsapp: { groupTarefas: CONFIG.GROUP_TAREFAS },
      architecture: 'Jarvis 4.0 - Agent Loop',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/dashboard/skills', auth, async (req, res) => {
  try {
    const gcalOk = await getGCalClient().then(() => true).catch(() => false);
    const memStats = await getMemoryStats();
    const skills = [
      { id: 'whatsapp', name: 'WhatsApp', description: 'Conexao via Baileys', status: connectionStatus === 'connected' ? 'active' : 'error' },
      { id: 'asana', name: 'Asana', description: 'Gestao de projetos', status: CONFIG.ASANA_PAT ? 'active' : 'inactive' },
      { id: 'gcal', name: 'Google Calendar', description: 'Agendamento', status: gcalOk ? 'active' : 'error' },
      { id: 'claude', name: 'Claude AI', description: 'Cerebro (Sonnet 4.6)', status: process.env.ANTHROPIC_API_KEY ? 'active' : 'inactive' },
      { id: 'openai', name: 'OpenAI (Whisper)', description: 'Transcricao de audio', status: process.env.OPENAI_API_KEY ? 'active' : 'inactive' },
      { id: 'memory', name: 'Memoria Inteligente', description: `${memStats.total} fatos armazenados (Mem0)`, status: 'active' },
      { id: 'agents', name: 'Agent Teams', description: 'Master + Criativo + Gestor + Pesquisador', status: 'active' },
      { id: 'postgresql', name: 'PostgreSQL', description: 'Banco + Memoria', status: 'active' },
      { id: 'redis', name: 'Redis', description: 'Cache', status: 'active' },
    ];
    res.json({ skills });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/dashboard/logs', auth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const type = req.query.type || null;
    let query = 'SELECT id, chat_id, sender, push_name, text, is_group, is_audio, created_at FROM jarvis_messages';
    const params = [];
    if (type === 'audio') query += ' WHERE is_audio = true';
    else if (type === 'group') query += ' WHERE is_group = true';
    else if (type === 'private') query += ' WHERE is_group = false AND is_audio = false';
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const { rows } = await pool.query(query, params);
    const countResult = await pool.query('SELECT COUNT(*) as total FROM jarvis_messages');
    res.json({
      logs: rows.map(r => ({ id: r.id, timestamp: r.created_at, type: r.is_audio ? 'audio' : r.is_group ? 'group' : 'private', from: r.push_name || r.sender, chatId: r.chat_id, text: (r.text || '').substring(0, 200) })),
      total: parseInt(countResult.rows[0].total), limit, offset,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Memory API (NOVO) ---
app.get('/dashboard/memory', auth, async (req, res) => {
  try {
    const stats = await getMemoryStats();
    // Mapear byScope para campos diretos que o frontend espera
    const scopeMap = {};
    for (const row of (stats.byScope || [])) scopeMap[row.scope] = parseInt(row.count);
    res.json({
      total: stats.total || 0,
      user: scopeMap['user'] || 0,
      chat: scopeMap['chat'] || 0,
      agent: scopeMap['agent'] || 0,
      byCategory: stats.byCategory || [],
      topMemories: stats.topMemories || [],
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/dashboard/memory/search', auth, async (req, res) => {
  try {
    const { q, scope, scopeId, limit } = req.query;
    const results = await searchMemories(q, scope || null, scopeId || null, parseInt(limit) || 20);
    res.json({ results, count: results.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/dashboard/memory/add', auth, async (req, res) => {
  try {
    const { content, category, importance, scope, scopeId } = req.body;
    if (!content) return res.status(400).json({ error: 'Conteudo obrigatorio' });
    await storeFacts([{ content, category: category || 'general', importance: importance || 7 }], scope || 'agent', scopeId || null);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Memory: Test Extract (diagnóstico) ---
app.post('/dashboard/memory/test-extract', auth, async (req, res) => {
  try {
    const { text, senderName } = req.body;
    if (!text) return res.status(400).json({ error: 'Texto obrigatório' });
    const facts = await extractFacts(text, senderName || 'Teste', 'test-chat', false);
    res.json({ facts, count: facts.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Memory: Batch Processing (processar histórico) ---
let batchState = { running: false, processed: 0, total: 0, errors: 0, startedAt: null, stoppedAt: null };

app.post('/dashboard/memory/batch/start', auth, async (req, res) => {
  if (batchState.running) return res.status(409).json({ error: 'Batch já em execução' });
  batchState = { running: true, processed: 0, total: 0, errors: 0, startedAt: new Date().toISOString(), stoppedAt: null };

  // Adicionar coluna se não existe
  await pool.query('ALTER TABLE jarvis_messages ADD COLUMN IF NOT EXISTS memory_processed BOOLEAN DEFAULT false').catch(() => {});

  // Contar total elegível
  const { rows: [{ cnt }] } = await pool.query(`
    SELECT COUNT(*)::int as cnt FROM jarvis_messages
    WHERE (memory_processed = false OR memory_processed IS NULL)
      AND text IS NOT NULL AND LENGTH(text) >= 30
      AND text NOT IN ('[audio]', '[midia]', '[sticker]', '[documento]', '[contato]', '[localização]')
      AND is_group = true
  `);
  batchState.total = cnt;

  res.json({ success: true, total: cnt, message: `Iniciando processamento de ${cnt} mensagens` });

  // Processar em background
  (async () => {
    try {
      while (batchState.running) {
        const { rows: messages } = await pool.query(`
          SELECT id, chat_id, sender, push_name, text, is_group FROM jarvis_messages
          WHERE (memory_processed = false OR memory_processed IS NULL)
            AND text IS NOT NULL AND LENGTH(text) >= 30
            AND text NOT IN ('[audio]', '[midia]', '[sticker]', '[documento]', '[contato]', '[localização]')
            AND is_group = true
          ORDER BY timestamp DESC LIMIT 50
        `);

        if (messages.length === 0) {
          console.log(`[BATCH] Concluído! ${batchState.processed} mensagens processadas, ${batchState.errors} erros`);
          batchState.running = false;
          batchState.stoppedAt = new Date().toISOString();
          // Auto-sync de perfis após batch concluir
          console.log('[BATCH] Iniciando sync de perfis automaticamente...');
          syncProfiles().then(r => console.log(`[BATCH] Perfis sincronizados: ${r.synced} perfis, ${r.errors} erros`)).catch(err => console.error('[BATCH] Erro ao sincronizar perfis:', err.message));
          break;
        }

        for (const msg of messages) {
          if (!batchState.running) break;
          try {
            const facts = await extractFacts(msg.text, msg.push_name || 'Desconhecido', msg.chat_id, msg.is_group);
            if (facts.length > 0) {
              await storeFacts(facts, 'user', msg.sender);
              if (msg.is_group) await storeFacts(facts, 'chat', msg.chat_id);
            }
            await pool.query('UPDATE jarvis_messages SET memory_processed = true WHERE id = $1', [msg.id]);
            batchState.processed++;
          } catch (err) {
            batchState.errors++;
            console.error(`[BATCH] Erro msg ${msg.id}:`, err.message);
            // Marcar como processada mesmo com erro para não travar
            await pool.query('UPDATE jarvis_messages SET memory_processed = true WHERE id = $1', [msg.id]).catch(() => {});
          }
          // Rate limit: ~2 chamadas/segundo
          await new Promise(r => setTimeout(r, 500));
        }

        if (batchState.processed % 100 === 0 && batchState.processed > 0) {
          console.log(`[BATCH] Progresso: ${batchState.processed}/${batchState.total} (${Math.round(batchState.processed / batchState.total * 100)}%)`);
        }
      }
    } catch (err) {
      console.error('[BATCH] Erro fatal:', err.message);
      batchState.running = false;
      batchState.stoppedAt = new Date().toISOString();
    }
  })();
});

app.get('/dashboard/memory/batch/status', auth, async (req, res) => {
  const elapsed = batchState.startedAt ? (Date.now() - new Date(batchState.startedAt).getTime()) / 1000 : 0;
  const speed = elapsed > 0 ? Math.round(batchState.processed / elapsed * 3600) : 0;
  const remaining = speed > 0 ? Math.round((batchState.total - batchState.processed) / speed * 60) : 0;
  res.json({
    ...batchState,
    speed, // mensagens/hora
    remainingMinutes: remaining,
    percentage: batchState.total > 0 ? Math.round(batchState.processed / batchState.total * 100) : 0,
  });
});

app.post('/dashboard/memory/batch/stop', auth, async (req, res) => {
  batchState.running = false;
  batchState.stoppedAt = new Date().toISOString();
  res.json({ success: true, message: 'Batch parado', processed: batchState.processed });
});

// Backfill embeddings (pgvector) — processa memórias sem embedding
app.post('/dashboard/memory/backfill', auth, async (req, res) => {
  try {
    const batchSize = Math.min(parseInt(req.body.batchSize) || 50, 200);
    const result = await backfillEmbeddings(batchSize);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Memory: Browse (listagem paginada) ---
app.get('/dashboard/memory/browse', auth, async (req, res) => {
  try {
    const { category, scope, page = 1, limit = 20, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let sql = 'SELECT id, scope, scope_id, category, content, importance, access_count, created_at, updated_at FROM jarvis_memories WHERE 1=1';
    const params = [];
    let idx = 1;
    if (category) { sql += ` AND category = $${idx++}`; params.push(category); }
    if (scope) { sql += ` AND scope = $${idx++}`; params.push(scope); }
    if (search) { sql += ` AND content ILIKE $${idx++}`; params.push(`%${search}%`); }
    const countSql = sql.replace(/SELECT .* FROM/, 'SELECT COUNT(*)::int as cnt FROM');
    const { rows: [{ cnt }] } = await pool.query(countSql, params);
    sql += ` ORDER BY importance DESC, updated_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(parseInt(limit), offset);
    const { rows } = await pool.query(sql, params);
    res.json({ memories: rows, total: cnt, page: parseInt(page), pages: Math.ceil(cnt / parseInt(limit)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Memory: Timeline (evolução do aprendizado) ---
app.get('/dashboard/memory/timeline', auth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const { rows } = await pool.query(`
      SELECT TO_CHAR(created_at, 'YYYY-MM-DD') as day, COUNT(*)::int as count, category,
             ROUND(AVG(importance)::numeric, 1)::float as avg_importance
      FROM jarvis_memories
      WHERE created_at > NOW() - INTERVAL '1 day' * $1
      GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD'), category
      ORDER BY day DESC
    `, [days]);
    res.json({ timeline: rows, days });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Memory: Atividade recente ---
app.get('/dashboard/memory/recent', auth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const { rows } = await pool.query(`
      SELECT content, category, importance, scope, scope_id, created_at
      FROM jarvis_memories ORDER BY created_at DESC LIMIT $1
    `, [limit]);
    res.json({ memories: rows, count: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Memory: Estatísticas do dia ---
app.get('/dashboard/memory/today', auth, async (req, res) => {
  try {
    const { rows: [{ total }] } = await pool.query(`SELECT COUNT(*)::int as total FROM jarvis_memories WHERE created_at >= CURRENT_DATE`);
    const { rows: byCategory } = await pool.query(`SELECT category, COUNT(*)::int as count FROM jarvis_memories WHERE created_at >= CURRENT_DATE GROUP BY category ORDER BY count DESC`);
    res.json({ total, byCategory });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Profiles (perfis sintetizados) ---
app.get('/dashboard/profiles', auth, async (req, res) => {
  try {
    const profiles = await listProfiles(req.query.type || null);
    res.json({ profiles, count: profiles.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/dashboard/profiles/:entityType/:entityId', auth, async (req, res) => {
  try {
    const profile = await getProfile(req.params.entityType, req.params.entityId);
    if (!profile) return res.status(404).json({ error: 'Perfil não encontrado' });
    res.json(profile);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/dashboard/profiles/sync', auth, async (req, res) => {
  try {
    const results = await syncProfiles();
    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/dashboard/profiles/synthesize', auth, async (req, res) => {
  try {
    const { entityType, entityId, entityName } = req.body;
    if (!entityType || !entityId) return res.status(400).json({ error: 'entityType e entityId obrigatórios' });
    const profile = await synthesizeProfile(entityType, entityId, entityName);
    res.json({ success: !!profile, profile });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Estudo Exaustivo do Asana ---
app.post('/dashboard/asana/study/start', auth, async (req, res) => {
  try {
    if (asanaBatchState.running) {
      return res.json({ success: true, message: 'Estudo já em execução', alreadyRunning: true });
    }
    const incremental = req.body?.incremental === true;
    await startAsanaStudy({ incremental });
    res.json({ success: true, message: `Estudo do Asana iniciado (${incremental ? 'incremental' : 'completo'})` });
  } catch (err) {
    console.error('[ASANA-STUDY] Erro ao iniciar:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/dashboard/asana/study/status', auth, async (req, res) => {
  try {
    const elapsed = asanaBatchState.startedAt
      ? Math.round((Date.now() - new Date(asanaBatchState.startedAt).getTime()) / 1000)
      : 0;
    res.json({ ...asanaBatchState, elapsedSeconds: elapsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/dashboard/asana/study/stop', auth, async (req, res) => {
  try {
    stopAsanaStudy();
    res.json({ success: true, message: 'Estudo do Asana parado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Voice Config (com sliders) ---
app.get('/dashboard/voice', auth, async (req, res) => {
  try {
    let elVoices = [];
    const elKey = process.env.ELEVENLABS_API_KEY;
    if (elKey) {
      const resp = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': elKey } });
      if (resp.ok) {
        const data = await resp.json();
        elVoices = (data.voices || []).map(v => ({ id: v.voice_id, name: v.name, description: [v.labels?.gender, v.labels?.accent, v.labels?.description].filter(Boolean).join(', '), preview_url: v.preview_url || '' }));
      }
    }
    res.json({
      provider: voiceConfig.provider,
      openai: voiceConfig.openai,
      elevenlabs: {
        voiceId: voiceConfig.elevenlabs.voiceId,
        model: voiceConfig.elevenlabs.model,
        stability: voiceConfig.elevenlabs.stability ?? 0.5,
        similarity_boost: voiceConfig.elevenlabs.similarity_boost ?? 0.75,
        style: voiceConfig.elevenlabs.style ?? 0.0,
        use_speaker_boost: voiceConfig.elevenlabs.use_speaker_boost ?? true,
        voices: elVoices,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/dashboard/voice', auth, async (req, res) => {
  try {
    const { provider, voice, model, elevenlabsVoiceId, elevenlabsModel, stability, similarity_boost, style, use_speaker_boost } = req.body;
    if (provider) voiceConfig.provider = provider;
    if (voice) voiceConfig.openai.voice = voice;
    if (model) voiceConfig.openai.model = model;
    if (elevenlabsVoiceId) voiceConfig.elevenlabs.voiceId = elevenlabsVoiceId;
    if (elevenlabsModel) voiceConfig.elevenlabs.model = elevenlabsModel;
    if (stability !== undefined) voiceConfig.elevenlabs.stability = parseFloat(stability);
    if (similarity_boost !== undefined) voiceConfig.elevenlabs.similarity_boost = parseFloat(similarity_boost);
    if (style !== undefined) voiceConfig.elevenlabs.style = parseFloat(style);
    if (use_speaker_boost !== undefined) voiceConfig.elevenlabs.use_speaker_boost = !!use_speaker_boost;
    await saveVoiceConfig();
    console.log('[VOICE] Config atualizada:', JSON.stringify(voiceConfig));
    res.json({ success: true, config: voiceConfig });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/dashboard/voice/test', auth, async (req, res) => {
  try {
    const { text, provider, voice, elevenlabsVoiceId, elevenlabsModel, stability, similarity_boost, style } = req.body;
    if (!text) return res.status(400).json({ error: 'Envie text' });
    // Usar config temporária para teste
    const origConfig = { ...voiceConfig.elevenlabs };
    if (stability !== undefined) voiceConfig.elevenlabs.stability = parseFloat(stability);
    if (similarity_boost !== undefined) voiceConfig.elevenlabs.similarity_boost = parseFloat(similarity_boost);
    if (style !== undefined) voiceConfig.elevenlabs.style = parseFloat(style);
    if (elevenlabsVoiceId) voiceConfig.elevenlabs.voiceId = elevenlabsVoiceId;
    if (elevenlabsModel) voiceConfig.elevenlabs.model = elevenlabsModel;

    const audioBuffer = await generateAudio(text);
    // Restaurar config
    Object.assign(voiceConfig.elevenlabs, origConfig);

    res.set('Content-Type', 'audio/mpeg');
    return res.send(audioBuffer);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Homework ---
app.post('/dashboard/homework', auth, async (req, res) => {
  try {
    const { content, type } = req.body;
    if (!content) return res.status(400).json({ error: 'Conteudo obrigatorio' });
    await pool.query('INSERT INTO homework (type, content, source) VALUES ($1, $2, $3)', [type || 'instruction', content, 'dashboard']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/dashboard/homework', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM homework ORDER BY created_at DESC LIMIT 50');
    res.json({ homework: rows });
  } catch (err) { res.json({ homework: [] }); }
});

// --- System Prompt (leitura + edicao via dashboard) ---
app.get('/dashboard/prompt', auth, async (req, res) => {
  try {
    const { JARVIS_IDENTITY, AGENT_EXPERTISE, CHANNEL_CONTEXT } = await import('./src/agents/master.mjs');
    res.json({
      master: JARVIS_IDENTITY,
      agents: {
        creative: AGENT_EXPERTISE.creative || '',
        manager: AGENT_EXPERTISE.manager || '',
        researcher: AGENT_EXPERTISE.researcher || '',
        traffic: AGENT_EXPERTISE.traffic || '',
        social: AGENT_EXPERTISE.social || '',
      },
      channels: CHANNEL_CONTEXT,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/dashboard/prompt', auth, async (req, res) => {
  try {
    const { readFile, writeFile } = await import('fs/promises');
    const { prompt, agent } = req.body;
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'Prompt obrigatorio' });

    const filePath = path.join(__dirname, 'src', 'agents', 'master.mjs');
    let content = await readFile(filePath, 'utf-8');

    const validAgents = ['master', 'creative', 'manager', 'researcher', 'traffic', 'social'];
    const targetAgent = agent || 'master';
    if (!validAgents.includes(targetAgent)) return res.status(400).json({ error: `Agente inválido. Válidos: ${validAgents.join(', ')}` });

    const escaped = prompt.replace(/`/g, '\\`').replace(/\$/g, '\\$');

    if (targetAgent === 'master') {
      // Substituir o MASTER_SYSTEM_PROMPT
      const start = content.indexOf('export const MASTER_SYSTEM_PROMPT = `');
      const end = content.indexOf('`;', start) + 2;
      if (start === -1 || end === 1) return res.status(500).json({ error: 'Nao encontrou MASTER_SYSTEM_PROMPT no arquivo' });
      content = content.substring(0, start) + 'export const MASTER_SYSTEM_PROMPT = `' + escaped + '`;' + content.substring(end);
    } else {
      // Substituir prompt de agente específico dentro de AGENT_PROMPTS
      const marker = `${targetAgent}: \``;
      const start = content.indexOf(marker);
      if (start === -1) return res.status(500).json({ error: `Nao encontrou prompt do agente ${targetAgent} no arquivo` });
      const promptStart = start + marker.length;
      // Encontrar o fechamento do template literal (backtick seguido de vírgula ou fechamento)
      let depth = 0;
      let promptEnd = promptStart;
      while (promptEnd < content.length) {
        if (content[promptEnd] === '\\') { promptEnd += 2; continue; }
        if (content[promptEnd] === '`') break;
        promptEnd++;
      }
      if (promptEnd >= content.length) return res.status(500).json({ error: `Nao encontrou fim do prompt do agente ${targetAgent}` });
      content = content.substring(0, promptStart) + escaped + content.substring(promptEnd);
    }

    await writeFile(filePath, content, 'utf-8');

    // Limpar cache do modulo para recarregar
    const modUrl = new URL('./src/agents/master.mjs', import.meta.url).href;
    delete globalThis[modUrl];

    res.json({ success: true, message: 'Prompt salvo. Reinicie o Jarvis para aplicar.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Dashboard Chat (com tools) ---
const dashboardChatHistory = [];

// Tools exclusivos do dashboard — acesso a mensagens e memórias
// Tools exclusivas do dashboard (busca de mensagens, memórias, perfis)
const DASHBOARD_EXTRA_TOOLS = [
  {
    name: 'buscar_mensagens',
    description: 'Buscar mensagens REAIS do WhatsApp por grupo ou contato. OBRIGATÓRIO usar antes de falar sobre qualquer conversa, mensagem ou grupo. Os horários retornados já estão em fuso de Brasília (UTC-3) — NÃO converta. NUNCA invente mensagens ou horários sem usar esta tool primeiro.',
    input_schema: {
      type: 'object',
      properties: {
        grupo: { type: 'string', description: 'Nome parcial do grupo (ex: "minner", "stream", "rossato")' },
        contato: { type: 'string', description: 'Nome parcial do contato (ex: "nicolas", "arthur")' },
        texto: { type: 'string', description: 'Texto para buscar dentro das mensagens' },
        limite: { type: 'number', description: 'Quantidade de mensagens (padrão: 20, máx: 50)' },
      },
    },
  },
  {
    name: 'buscar_memorias',
    description: 'Buscar nas memórias do Jarvis (fatos aprendidos sobre pessoas, clientes, projetos, regras, processos). Use para responder sobre conhecimento acumulado.',
    input_schema: {
      type: 'object',
      properties: {
        busca: { type: 'string', description: 'Termo de busca nas memórias' },
        categoria: { type: 'string', enum: ['client', 'preference', 'rule', 'deadline', 'decision', 'process', 'team_member', 'client_profile', 'style', 'pattern'], description: 'Filtrar por categoria' },
        escopo: { type: 'string', enum: ['user', 'chat', 'agent'], description: 'Filtrar por escopo (user=pessoas, chat=conversas, agent=operacional)' },
        limite: { type: 'number', description: 'Quantidade de resultados (padrão: 20, máx: 50)' },
      },
    },
  },
  {
    name: 'ver_perfil',
    description: 'Ver o perfil sintetizado de um cliente, membro da equipe ou grupo. Contém resumo completo do que o Jarvis sabe sobre a entidade.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome da pessoa, cliente ou grupo' },
      },
      required: ['nome'],
    },
  },
];

// Dashboard tem TODAS as tools: exclusivas + JARVIS_TOOLS (mesmo poder que WhatsApp)
// Deduplica por nome (DASHBOARD_EXTRA_TOOLS tem prioridade — descrições mais detalhadas)
const _dashExtraNames = new Set(DASHBOARD_EXTRA_TOOLS.map(t => t.name));
const DASHBOARD_TOOLS = [...DASHBOARD_EXTRA_TOOLS, ...JARVIS_TOOLS.filter(t => !_dashExtraNames.has(t.name))];

async function executeDashboardTool(toolName, input) {
  console.log(`[DASHBOARD-TOOL] Executando: ${toolName}`, JSON.stringify(input));

  if (toolName === 'buscar_mensagens') {
    const limit = Math.min(input.limite || 20, 50);
    let where = [];
    let params = [];
    let paramIdx = 1;

    if (input.grupo) {
      // Buscar JID do grupo pelo nome
      const { rows: groups } = await pool.query(
        'SELECT jid FROM jarvis_groups WHERE LOWER(name) LIKE $1 LIMIT 1',
        [`%${input.grupo.toLowerCase()}%`]
      );
      if (groups.length > 0) {
        where.push(`chat_id = $${paramIdx++}`);
        params.push(groups[0].jid);
      } else {
        return { resultado: `Nenhum grupo encontrado com "${input.grupo}"` };
      }
    }
    if (input.contato) {
      where.push(`LOWER(push_name) LIKE $${paramIdx++}`);
      params.push(`%${input.contato.toLowerCase()}%`);
    }
    if (input.texto) {
      where.push(`LOWER(text) LIKE $${paramIdx++}`);
      params.push(`%${input.texto.toLowerCase()}%`);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT push_name, text, created_at, chat_id FROM jarvis_messages ${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx}`,
      [...params, limit]
    );

    if (rows.length === 0) return { resultado: 'Nenhuma mensagem encontrada com esses filtros.' };

    // Buscar nome do grupo se houver
    let groupName = '';
    if (rows[0]?.chat_id?.includes('@g.us')) {
      const { rows: g } = await pool.query('SELECT name FROM jarvis_groups WHERE jid = $1', [rows[0].chat_id]);
      groupName = g[0]?.name || '';
    }

    return {
      grupo: groupName || undefined,
      total: rows.length,
      mensagens: rows.reverse().map(r => {
        // Converter UTC → horário de Brasília (UTC-3) para evitar confusão
        let quandoBR = r.created_at;
        try {
          const dt = new Date(r.created_at);
          quandoBR = dt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        } catch {}
        return {
          de: r.push_name || 'Desconhecido',
          texto: r.text?.substring(0, 300),
          quando: quandoBR,
          _aviso: 'Horário já em fuso de Brasília (UTC-3). NÃO converta novamente.',
        };
      }),
    };
  }

  if (toolName === 'buscar_memorias') {
    const limit = Math.min(input.limite || 20, 50);
    let where = ['1=1'];
    let params = [];
    let paramIdx = 1;

    if (input.busca) {
      where.push(`LOWER(content) LIKE $${paramIdx++}`);
      params.push(`%${input.busca.toLowerCase()}%`);
    }
    if (input.categoria) {
      where.push(`category = $${paramIdx++}`);
      params.push(input.categoria);
    }
    if (input.escopo) {
      where.push(`scope = $${paramIdx++}`);
      params.push(input.escopo);
    }

    const { rows } = await pool.query(
      `SELECT content, category, importance, scope, created_at FROM jarvis_memories WHERE ${where.join(' AND ')} ORDER BY importance DESC, created_at DESC LIMIT $${paramIdx}`,
      [...params, limit]
    );

    return { total: rows.length, memorias: rows.map(r => ({ conteudo: r.content, categoria: r.category, importancia: r.importance, escopo: r.scope })) };
  }

  if (toolName === 'ver_perfil') {
    const { listProfiles, getProfile } = await import('./src/profiles.mjs');
    const all = await listProfiles();
    const nome = (input.nome || '').toLowerCase();
    const match = all.find(p =>
      (p.entity_id || '').toLowerCase().includes(nome) ||
      (p.entity_name || '').toLowerCase().includes(nome)
    );
    if (match) {
      const profile = await getProfile(match.entity_type, match.entity_id);
      return profile || { resultado: `Perfil de "${input.nome}" encontrado mas sem dados.` };
    }
    return { resultado: `Nenhum perfil encontrado para "${input.nome}".` };
  }

  // Todas as outras tools (JARVIS_TOOLS): delegar para executeJarvisTool
  // Dashboard = Gui, então passa GUI_JID como contexto (mesmo poder que WhatsApp PV)
  const { executeJarvisTool } = await import('./src/skills/loader.mjs');
  return await executeJarvisTool(toolName, input, { senderJid: CONFIG.GUI_JID, chatId: 'dashboard' });
}

// ============================================
// DASHBOARD CHAT — Lógica compartilhada (texto + voz)
// ============================================
const DASHBOARD_SYSTEM_SUFFIX = `

CONTEXTO DO DASHBOARD:
Você está falando pelo Dashboard (guardiaolab.com.br) diretamente com o Gui (seu chefe).
Aqui pode falar de TODOS os projetos, sem sigilo — é conversa privada com o dono.

SUAS CAPACIDADES REAIS — USE SEMPRE:
- Você ESTÁ conectado ao WhatsApp e lê TODAS as mensagens em tempo real
- Você tem ferramentas para BUSCAR mensagens de qualquer grupo ou contato — USE buscar_mensagens
- Você tem ferramentas para BUSCAR suas memórias acumuladas — USE buscar_memorias
- Você pode CONSULTAR tarefas do Asana — USE consultar_tarefas
- Você pode VER perfis sintetizados de pessoas e clientes — USE ver_perfil
- Você pode ENVIAR mensagens em qualquer grupo do WhatsApp — USE enviar_mensagem_grupo
- Você pode CRIAR demandas no Asana (Cabine de Comando) — USE criar_demanda_cliente
- Você pode AGENDAR captações (Asana + Google Calendar) — USE agendar_captacao
- Você pode AUTORIZAR operação autônoma em grupos de clientes — USE autorizar_cliente
- Você pode REVOGAR operação autônoma — USE revogar_cliente
- Você pode SALVAR informações na memória — USE lembrar
- Seu estudo do Asana roda 5x por dia (08h/11h/13:30/15h/17h)

REGRAS ABSOLUTAS DO DASHBOARD:
1. NUNCA INVENTE informações — se não sabe, USE as tools para buscar dados REAIS
2. NUNCA fabrique horários, datas ou conteúdo de mensagens — USE buscar_mensagens para ver o que foi realmente dito
3. Quando perguntarem sobre mensagens, conversas ou grupos — USE buscar_mensagens PRIMEIRO, depois responda com dados reais
4. Quando perguntarem sobre pessoas, clientes, regras ou processos — USE buscar_memorias PRIMEIRO
5. Quando mandarem AGIR (autorizar cliente, enviar mensagem, criar task) — USE as tools de ação IMEDIATAMENTE
6. NUNCA diga "não tenho acesso" ou "não consigo" — você TEM e PODE. Use as ferramentas
7. Se não encontrar dados nas tools, diga "Não encontrei registros sobre isso" — NUNCA invente uma narrativa

ANTI-ALUCINAÇÃO: Você é PROIBIDO de inventar conteúdo de mensagens, horários ou eventos.
Se alguém perguntar "o que o Doug mandou no grupo Minner?" — você DEVE usar buscar_mensagens primeiro.
Se a tool não retornar dados, diga honestamente que não encontrou. NUNCA fabrique uma resposta com dados fictícios.
`;

async function processDashboardChat(message, isVoice = false) {
  const { JARVIS_IDENTITY, CHANNEL_CONTEXT } = await import('./src/agents/master.mjs');
  const memoryCtx = await getMemoryContext(CONFIG.GUI_JID, 'dashboard', message);

  dashboardChatHistory.push({ role: 'user', content: message });
  while (dashboardChatHistory.length > 30) dashboardChatHistory.shift();

  const msgs = [...dashboardChatHistory];
  if (msgs.length > 0 && msgs[0].role !== 'user') msgs.shift();

  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

  const channelCtx = isVoice ? CHANNEL_CONTEXT.dashboard_voice : CHANNEL_CONTEXT.dashboard;
  const dashboardSystemPrompt = JARVIS_IDENTITY + '\n\n' + channelCtx + '\n\n' + DASHBOARD_SYSTEM_SUFFIX + memoryCtx;

  // Agent Loop real — até 10 iterações com Extended Thinking
  const MAX_ITERATIONS = 10;
  let currentMessages = [...msgs];
  let finalText = '';
  let iterations = 0;
  const toolsUsed = new Set();

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    // Dashboard chat SEMPRE usa Opus — Gui quer qualidade máxima na comunicação direta
    const dashboardModel = CONFIG.AI_MODEL_STRONG || CONFIG.AI_MODEL;
    const apiParams = {
      model: dashboardModel,
      max_tokens: 12000,
      system: dashboardSystemPrompt,
      messages: currentMessages,
      tools: DASHBOARD_TOOLS,
      thinking: { type: 'enabled', budget_tokens: 8192 },
    };

    const response = await anthropic.messages.create(apiParams, {
      headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
    });

    let hasToolUse = false;
    const toolResults = [];
    const assistantContent = [];

    for (const block of response.content) {
      assistantContent.push(block);
      if (block.type === 'text') {
        finalText += block.text;
      } else if (block.type === 'tool_use') {
        hasToolUse = true;
        toolsUsed.add(block.name);
        console.log(`[DASHBOARD-CHAT] Iteração ${iterations} — tool: ${block.name}`, JSON.stringify(block.input).substring(0, 150));
        try {
          const result = await executeDashboardTool(block.name, block.input);
          console.log(`[DASHBOARD-CHAT] Tool ${block.name} OK:`, JSON.stringify(result).substring(0, 200));
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
        } catch (toolErr) {
          console.error(`[DASHBOARD-CHAT] Tool ${block.name} erro:`, toolErr.message);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ erro: toolErr.message }), is_error: true });
        }
      }
    }

    if (!hasToolUse || response.stop_reason !== 'tool_use') break;
    currentMessages = [...currentMessages, { role: 'assistant', content: assistantContent }, { role: 'user', content: toolResults }];
    finalText = '';
  }

  if (iterations > 1) console.log(`[DASHBOARD-CHAT] Agent Loop concluído em ${iterations} iterações`);
  if (!finalText) finalText = 'Desculpe, não consegui processar a consulta. Tente reformular a pergunta.';

  // Anti-alucinação
  const { antiHallucinationCheck } = await import('./src/brain.mjs');
  const hallucinationCheck = antiHallucinationCheck(finalText, toolsUsed);
  if (!hallucinationCheck.safe) {
    console.warn(`[ANTI-HALLUCINATION] Resposta bloqueada! Tools: [${[...toolsUsed].join(', ')}]. Razão: ${hallucinationCheck.reason}`);
    finalText = '⚠️ Detectei que ia te dar uma resposta com dados que não verifiquei. Pode repetir? Dessa vez vou consultar os dados antes de responder.';
  }

  dashboardChatHistory.push({ role: 'assistant', content: finalText });

  // Homework — Dashboard sempre é o Gui falando direto, mas ainda valida com Haiku
  const lower = message.toLowerCase();
  const isDashboardInstruction = /\b(a partir de agora|nunca mais|sempre que|aprenda que|regra:|n[aã]o (fa[cç]a|chame|use|mande|envie|fale)|pode me chamar|me chame de|quero que voc[eê]|preciso que voc[eê]|jarvis.*(lembr|aprend|regra|entend)|autoriz|cuide|monitore|fique de olho|preste aten[cç][aã]o|tom[ea] conta|assuma|gerencie|acompanhe)\b/i.test(lower);
  if (isDashboardInstruction) {
    validateHomework(message, isVoice).then(isValid => {
      if (isValid) {
        pool.query('INSERT INTO homework (type, content, source) VALUES ($1, $2, $3)', ['chat_instruction', message, isVoice ? 'dashboard_voice' : 'dashboard_chat']).catch(() => {});
        console.log(`[HOMEWORK] ✅ Instrução do dashboard salva: "${message.substring(0, 60)}..."`);
      } else {
        console.log(`[HOMEWORK] ❌ Dashboard: rejeitado (não é instrução): "${message.substring(0, 60)}..."`);
      }
    }).catch(() => {});
  }

  // Memória em background
  processMemory(message, 'Gui', CONFIG.GUI_JID, 'dashboard', false).catch(() => {});

  return finalText;
}

// --- Chat por texto ---
app.post('/dashboard/chat', auth, async (req, res) => {
  try {
    const { message, clearHistory } = req.body;
    if (clearHistory) { dashboardChatHistory.length = 0; return res.json({ response: 'Historico limpo.', cleared: true }); }
    if (!message) return res.status(400).json({ error: 'Mensagem obrigatoria' });

    console.log(`[DASHBOARD-CHAT] Mensagem recebida: "${message.substring(0, 80)}..."`);
    const startTime = Date.now();
    const finalText = await processDashboardChat(message, false);
    console.log(`[DASHBOARD-CHAT] Resposta gerada em ${((Date.now() - startTime) / 1000).toFixed(1)}s (${finalText.length} chars)`);
    res.json({ response: finalText });
  } catch (err) {
    console.error(`[DASHBOARD-CHAT] ERRO:`, err.message, err.stack?.substring(0, 300));
    res.status(500).json({ error: err.message });
  }
});

// --- Chat por voz (Modo Conversa) ---
// Voice Stream — experiência Tony Stark: streaming NDJSON com áudio por frases
app.post('/dashboard/chat/voice', auth, express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '10mb' }), async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Transfer-Encoding', 'chunked');

  const send = (type, data = {}) => { try { res.write(JSON.stringify({ type, ...data }) + '\n'); } catch(e) {} };

  try {
    const audioBuffer = req.body;
    if (!audioBuffer || audioBuffer.length < 100) {
      send('error', { message: 'Áudio vazio' });
      return res.end();
    }

    const startTime = Date.now();
    console.log(`[VOICE] Áudio recebido: ${(audioBuffer.length / 1024).toFixed(1)}KB`);

    // 1. Transcrever — Whisper (~1-2s)
    send('status', { phase: 'listening' });
    const { transcribeAudio, generateAudio } = await import('./src/audio.mjs');
    const transcription = await transcribeAudio(audioBuffer);

    if (!transcription || transcription.trim().length < 2) {
      send('skipped', {});
      return res.end();
    }

    console.log(`[VOICE] Transcrição (${Date.now() - startTime}ms): "${transcription.substring(0, 80)}"`);
    send('transcription', { text: transcription });

    // 2. Claude com Agent Loop + Tools — MESMO CÉREBRO de todos os canais
    send('status', { phase: 'thinking' });
    const { JARVIS_IDENTITY, CHANNEL_CONTEXT } = await import('./src/agents/master.mjs');
    const { agentLoop } = await import('./src/brain.mjs');
    const memoryCtx = await getMemoryContext(CONFIG.GUI_JID, 'dashboard', transcription);

    dashboardChatHistory.push({ role: 'user', content: transcription });
    while (dashboardChatHistory.length > 20) dashboardChatHistory.shift();

    const msgs = [...dashboardChatHistory];
    if (msgs.length > 0 && msgs[0].role !== 'user') msgs.shift();

    const voiceSystemPrompt = JARVIS_IDENTITY + '\n\n' + CHANNEL_CONTEXT.dashboard_voice + memoryCtx;

    // Sonnet + tools + sem thinking = velocidade + capacidade
    const voiceModel = CONFIG.AI_MODEL || 'claude-sonnet-4-20250514';
    const { text: finalText } = await agentLoop(
      voiceModel,
      voiceSystemPrompt,
      msgs,
      DASHBOARD_TOOLS,
      { senderJid: CONFIG.GUI_JID, chatId: 'dashboard', channel: 'voice' },
      { thinking: false, maxTokens: 600 } // Voice: curto e rápido
    );

    console.log(`[VOICE] agentLoop (${Date.now() - startTime}ms): ${finalText.length} chars`);

    dashboardChatHistory.push({ role: 'assistant', content: finalText });
    send('response', { text: finalText });

    // 3. TTS streaming por frases — pipeline paralelo
    send('status', { phase: 'speaking' });

    // Dividir em frases naturais (chunks menores = primeiro áudio chega mais rápido)
    const sentences = finalText.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) || [finalText];
    const chunks = [];
    let currentChunk = '';
    for (const s of sentences) {
      currentChunk += s;
      if (currentChunk.length >= 40) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
    }
    if (currentChunk.trim()) chunks.push(currentChunk.trim());

    // Gerar TTS em paralelo (todas as frases ao mesmo tempo)
    const ttsPromises = chunks.map((chunk, i) =>
      generateAudio(chunk)
        .then(audioOut => ({ index: i, data: audioOut.toString('base64'), ok: true }))
        .catch(err => { console.error(`[VOICE] TTS erro chunk ${i}:`, err.message); return { index: i, ok: false }; })
    );

    // Enviar na ordem correta conforme ficam prontos
    const ttsResults = await Promise.all(ttsPromises);
    for (const result of ttsResults.sort((a, b) => a.index - b.index)) {
      if (result.ok) send('audio', { data: result.data, index: result.index, total: chunks.length });
    }

    console.log(`[VOICE] Completo em ${((Date.now() - startTime) / 1000).toFixed(1)}s — ${chunks.length} chunks de áudio`);
    send('done', { duration: Date.now() - startTime });

    // Memória em background
    processMemory(transcription, 'Gui', CONFIG.GUI_JID, 'dashboard', false).catch(() => {});

  } catch (err) {
    console.error('[VOICE] Erro:', err.message);
    send('error', { message: err.message });
  }
  res.end();
});

// --- Team mapping ---
// --- Disparar cobrança manual ---
app.post('/dashboard/cobranca', auth, async (req, res) => {
  try {
    // Limpar cache anti-spam pra rodar de novo
    await pool.query("DELETE FROM jarvis_config WHERE key = 'overdue_notified'").catch(() => {});
    console.log('[COBRANCA] Disparo manual via dashboard');
    runOverdueCheck().catch(err => console.error('[COBRANCA] Erro manual:', err.message));
    res.json({ success: true, message: 'Cobrança disparada! Acompanhe no grupo Tarefas Diárias.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/team', auth, (req, res) => {
  res.json({ whatsapp_lid: Object.fromEntries(teamWhatsApp), whatsapp_phones: Object.fromEntries(teamPhones) });
});

app.post('/team/phone', auth, (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'name e phone obrigatorios' });
  const jid = phone.includes('@') ? phone : phone.replace(/\D/g, '') + '@s.whatsapp.net';
  teamPhones.set(name.toLowerCase(), jid);
  res.json({ success: true, name: name.toLowerCase(), jid });
});

// --- Cérebro Persistente ---
app.get('/dashboard/brain', auth, async (req, res) => {
  try {
    const status = await getBrainStatus();
    if (status.exists) {
      const { rows } = await pool.query("SELECT value FROM jarvis_config WHERE key = 'jarvis_brain'");
      const data = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
      res.json({ ...status, document: data.document });
    } else {
      res.json(status);
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/dashboard/brain/generate', auth, async (req, res) => {
  try {
    res.json({ status: 'generating', message: 'Geração do Cérebro Persistente iniciada em background' });
    // Rodar em background pra não travar o request
    generateBrainDocument().then(doc => {
      if (doc) {
        invalidateBrainCache();
        console.log(`[API] ✅ Cérebro Persistente gerado via dashboard: ${doc.length} chars`);
      }
    }).catch(err => {
      console.error('[API] Erro ao gerar Cérebro:', err.message);
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Reports ---
app.post('/report/daily', auth, async (req, res) => {
  try {
    const report = await generateDailyReport();
    await sendText(CONFIG.GROUP_TAREFAS, report);
    res.json({ success: true, report });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- QR Code ---
app.get('/dashboard/qr', auth, (req, res) => {
  if (connectionStatus === 'connected' || connectionStatus === 'open') return res.json({ status: 'connected', qr: null });
  if (globalThis.lastQR) return res.json({ status: 'needs_qr', qr: globalThis.lastQR });
  return res.json({ status: 'waiting', qr: null });
});

app.get('/dashboard/qr-image', auth, async (req, res) => {
  try {
    const { readFile: rf } = await import('fs/promises');
    const stat = await rf('/tmp/jarvis_qr.png').catch(() => null);
    if (stat) { res.setHeader('Content-Type', 'image/png'); return res.send(stat); }
    if (globalThis.lastQR) {
      const QRCode = await import('qrcode');
      const png = await QRCode.default.toBuffer(globalThis.lastQR, { width: 512, margin: 2 });
      res.setHeader('Content-Type', 'image/png');
      return res.send(png);
    }
    res.json({ status: connectionStatus });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// INSTAGRAM WEBHOOKS (público — Meta valida via verify_token)
// ============================================
app.get('/webhooks/instagram', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
    console.log('[INSTAGRAM] Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhooks/instagram', async (req, res) => {
  res.sendStatus(200); // Responder imediatamente

  const body = req.body;
  if (body.object !== 'instagram') return;

  for (const entry of body.entry || []) {
    // Verificar whitelist de páginas
    try {
      const channelConfig = await pool.query("SELECT value FROM jarvis_config WHERE key = 'channel_settings'");
      const channelSettings = channelConfig.rows[0]?.value;
      const allowedPages = channelSettings?.instagram?.allowed_pages || [];
      const pageId = entry.id;
      if (allowedPages.length > 0 && !allowedPages.includes(pageId)) {
        console.log(`[INSTAGRAM] Page ${pageId} não está na whitelist, ignorando`);
        continue;
      }
    } catch (err) {
      console.error('[INSTAGRAM] Erro ao verificar whitelist:', err.message);
    }

    for (const event of entry.messaging || []) {
      try {
        await processInstagramMessage(event);
      } catch (err) {
        console.error('[INSTAGRAM] Erro no webhook:', err.message);
      }
    }
  }
});

// ============================================
// ASANA WEBHOOKS (público — Asana valida via X-Hook-Secret)
// ============================================
app.post('/webhooks/asana', async (req, res) => {
  // Handshake: Asana envia X-Hook-Secret na primeira requisição
  const hookSecret = req.headers['x-hook-secret'];
  if (hookSecret) {
    console.log('[WEBHOOK] Asana handshake recebido');
    res.setHeader('X-Hook-Secret', hookSecret);
    return res.sendStatus(200);
  }

  // Processar eventos
  const events = req.body?.events || [];
  res.sendStatus(200); // Responder imediatamente (Asana exige < 5s)

  // Processar eventos de forma assíncrona
  for (const event of events) {
    try {
      await processAsanaWebhookEvent(event);
    } catch (err) {
      console.error('[WEBHOOK] Erro ao processar evento:', err.message);
    }
  }
});

// Registrar webhooks nos projetos do Asana (protegido)
app.post('/dashboard/webhooks/register', auth, async (req, res) => {
  try {
    const callbackUrl = 'https://guardiaolab.com.br/webhooks/asana';
    const result = await registerAsanaWebhooks(callbackUrl);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start API
const server = app.listen(CONFIG.API_PORT, async () => {
  console.log('[API] Rodando na porta', CONFIG.API_PORT);
  await loadVoiceConfig().catch(() => {});
});

// ============================================
// WEBSOCKET VOICE MODE — Streaming < 2s latência
// ============================================
const wss = new WebSocketServer({ server, path: '/ws/voice' });

wss.on('connection', (ws, req) => {
  // Validar JWT do query string: /ws/voice?token=xxx
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  try {
    jwt.verify(token, CONFIG.JWT_SECRET || process.env.JWT_SECRET);
  } catch {
    ws.close(4001, 'Unauthorized');
    return;
  }

  console.log('[WS-VOICE] Cliente conectado');
  let audioChunks = [];
  let isProcessing = false;

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      // Chunk de áudio binário
      audioChunks.push(data);
      return;
    }

    // Comando de texto (JSON)
    try {
      const cmd = JSON.parse(data.toString());

      if (cmd.type === 'stop') {
        // Interromper TTS em andamento
        isProcessing = false;
        audioChunks = [];
        ws.send(JSON.stringify({ type: 'stopped' }));
        return;
      }

      if (cmd.type === 'end_speech' && audioChunks.length > 0 && !isProcessing) {
        isProcessing = true;
        const fullAudio = Buffer.concat(audioChunks);
        audioChunks = [];
        const startTime = Date.now();

        try {
          // 1. Transcrever
          ws.send(JSON.stringify({ type: 'status', phase: 'transcribing' }));
          console.log(`[WS-VOICE] Áudio recebido: ${(fullAudio.length / 1024).toFixed(1)}KB`);
          const transcription = await transcribeAudio(fullAudio);
          ws.send(JSON.stringify({ type: 'transcription', text: transcription }));

          if (!transcription || transcription.trim().length < 2) {
            isProcessing = false;
            return;
          }

          console.log(`[WS-VOICE] Transcrição (${Date.now() - startTime}ms): "${transcription.substring(0, 80)}"`);

          // 2. Gerar resposta com Agent Loop + Tools (mesmo cérebro do voice HTTP)
          ws.send(JSON.stringify({ type: 'status', phase: 'thinking' }));
          const { JARVIS_IDENTITY, CHANNEL_CONTEXT } = await import('./src/agents/master.mjs');
          const { agentLoop } = await import('./src/brain.mjs');
          const memoryCtx = await getMemoryContext(CONFIG.GUI_JID, 'dashboard', transcription);

          dashboardChatHistory.push({ role: 'user', content: transcription });
          while (dashboardChatHistory.length > 20) dashboardChatHistory.shift();

          const msgs = [...dashboardChatHistory];
          if (msgs.length > 0 && msgs[0].role !== 'user') msgs.shift();

          const voiceSystemPrompt = JARVIS_IDENTITY + '\n\n' + CHANNEL_CONTEXT.dashboard_voice + memoryCtx;
          const voiceModel = CONFIG.AI_MODEL || 'claude-sonnet-4-20250514';

          const { text: response } = await agentLoop(
            voiceModel,
            voiceSystemPrompt,
            msgs,
            DASHBOARD_TOOLS,
            { senderJid: CONFIG.GUI_JID, chatId: 'dashboard', channel: 'voice' },
            { thinking: false, maxTokens: 600 }
          );

          console.log(`[WS-VOICE] agentLoop (${Date.now() - startTime}ms): ${response.length} chars`);
          dashboardChatHistory.push({ role: 'assistant', content: response });
          ws.send(JSON.stringify({ type: 'response', text: response }));

          // 3. TTS streaming por frases
          ws.send(JSON.stringify({ type: 'status', phase: 'speaking' }));
          const sentences = splitIntoSentences(response);

          for (let i = 0; i < sentences.length; i++) {
            if (!isProcessing) break; // interrompido pelo usuário
            try {
              const audioData = await generateAudio(sentences[i]);
              if (audioData && isProcessing) {
                ws.send(JSON.stringify({
                  type: 'audio',
                  data: audioData.toString('base64'),
                  index: i,
                  total: sentences.length,
                  text: sentences[i],
                }));
              }
            } catch (ttsErr) {
              console.error(`[WS-VOICE] TTS erro chunk ${i}:`, ttsErr.message);
            }
          }

          ws.send(JSON.stringify({ type: 'done', duration: Date.now() - startTime }));
          console.log(`[WS-VOICE] Completo em ${((Date.now() - startTime) / 1000).toFixed(1)}s — ${sentences.length} chunks`);

          // Homework + memória em background (mesmo fluxo do voice HTTP)
          const lower = transcription.toLowerCase();
          const isDashboardInstruction = /\b(a partir de agora|nunca mais|sempre que|aprenda que|regra:|n[aã]o (fa[cç]a|chame|use|mande|envie|fale)|pode me chamar|me chame de|quero que voc[eê]|preciso que voc[eê]|jarvis.*(lembr|aprend|regra|entend)|autoriz|cuide|monitore|fique de olho|preste aten[cç][aã]o|tom[ea] conta|assuma|gerencie|acompanhe)\b/i.test(lower);
          if (isDashboardInstruction) {
            validateHomework(transcription, true).then(isValid => {
              if (isValid) {
                pool.query('INSERT INTO homework (type, content, source) VALUES ($1, $2, $3)', ['chat_instruction', transcription, 'dashboard_voice_ws']).catch(() => {});
                console.log(`[HOMEWORK] Instrução do WS-voice salva: "${transcription.substring(0, 60)}..."`);
              }
            }).catch(() => {});
          }
          processMemory(transcription, 'Gui', CONFIG.GUI_JID, 'dashboard', false).catch(() => {});

        } catch (err) {
          console.error('[WS-VOICE] Erro no processamento:', err.message);
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
        }

        isProcessing = false;
      }
    } catch {
      // JSON inválido — ignorar
    }
  });

  ws.on('close', () => {
    console.log('[WS-VOICE] Cliente desconectado');
  });

  ws.on('error', (err) => {
    console.error('[WS-VOICE] Erro na conexão:', err.message);
  });
});

// Helper: dividir texto em frases para TTS streaming
function splitIntoSentences(text) {
  const raw = text.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) || [text];
  const sentences = [];
  let current = '';
  for (const s of raw) {
    current += s;
    if (current.length >= 20) {
      sentences.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) {
    // Merge tiny remainder with last sentence if possible
    if (sentences.length > 0 && current.trim().length < 20) {
      sentences[sentences.length - 1] += ' ' + current.trim();
    } else {
      sentences.push(current.trim());
    }
  }
  return sentences.length > 0 ? sentences : [text];
}

// ============================================
// CRON JOBS
// ============================================
function setupCronJobs() {
  // Limpeza periódica de Maps/Sets em memória (evita memory leak)
  setInterval(() => {
    const now = Date.now();
    // sentByBot: manter só últimos 100
    if (sentByBot.size > 100) {
      const arr = [...sentByBot];
      arr.slice(0, arr.length - 100).forEach(id => sentByBot.delete(id));
    }
    // authRateLimit: remover entradas expiradas
    for (const [ip, data] of authRateLimit) {
      if (now > data.resetAt) authRateLimit.delete(ip);
    }
    // geoCache: remover entradas > 2 horas
    for (const [ip, data] of geoCache) {
      if (now - data.cachedAt > 2 * 60 * 60 * 1000) geoCache.delete(ip);
    }
    console.log(`[CLEANUP] sentByBot: ${sentByBot.size}, authRateLimit: ${authRateLimit.size}, geoCache: ${geoCache.size}`);
  }, 60 * 60 * 1000); // A cada 1 hora

  // Sync de perfis a cada 6 horas (0h, 6h, 12h, 18h)
  cron.schedule('0 */6 * * *', async () => {
    console.log('[CRON] Iniciando sync de perfis...');
    try {
      const result = await syncProfiles();
      console.log(`[CRON] Perfis sincronizados: ${result.synced} perfis, ${result.errors} erros`);
    } catch (err) {
      console.error('[CRON] Erro no sync de perfis:', err.message);
    }
  });

  // Estudo incremental do Asana — 5x por dia (horário de Brasília = UTC-3)
  // 08:00 BRT = 11:00 UTC | 11:00 BRT = 14:00 UTC | 13:30 BRT = 16:30 UTC
  // 15:00 BRT = 18:00 UTC | 17:00 BRT = 20:00 UTC
  const asanaStudySchedules = [
    { cron: '0 11 * * 1-5', label: '08:00' },   // Segunda a sexta
    { cron: '0 14 * * 1-5', label: '11:00' },
    { cron: '30 16 * * 1-5', label: '13:30' },
    { cron: '0 18 * * 1-5', label: '15:00' },
    { cron: '0 20 * * 1-5', label: '17:00' },
  ];

  for (const schedule of asanaStudySchedules) {
    cron.schedule(schedule.cron, async () => {
      console.log(`[CRON] Estudo Asana incremental (${schedule.label} BRT)...`);
      try {
        if (asanaBatchState.running) {
          console.log('[CRON] Estudo Asana já em execução, pulando...');
          return;
        }
        await startAsanaStudy({ incremental: true });
      } catch (err) {
        console.error(`[CRON] Erro no estudo Asana (${schedule.label}):`, err.message);
      }
    });
  }

  // ============================================
  // COBRANÇA AUTOMÁTICA — 2x por dia (estilo Camile)
  // 09:30 BRT = 12:30 UTC | 14:30 BRT = 17:30 UTC
  // ============================================
  cron.schedule('30 12 * * 1-5', async () => {
    console.log('[CRON] Cobrança automática (09:30 BRT)...');
    try { await runOverdueCheck(); } catch (err) { console.error('[CRON] Erro na cobrança:', err.message); }
  });
  cron.schedule('30 17 * * 1-5', async () => {
    console.log('[CRON] Cobrança automática (14:30 BRT)...');
    try { await runOverdueCheck(); } catch (err) { console.error('[CRON] Erro na cobrança:', err.message); }
  });

  // ============================================
  // RELATÓRIO DIÁRIO — 08:00 BRT = 11:00 UTC
  // ============================================
  cron.schedule('0 11 * * 1-5', async () => {
    console.log('[CRON] Relatório diário (08:00 BRT)...');
    try {
      const report = await generateDailyReport();
      const { getSendFunction } = await import('./src/skills/loader.mjs');
      const sendFn = getSendFunction();
      if (sendFn && CONFIG.GROUP_TAREFAS) {
        await sendFn(CONFIG.GROUP_TAREFAS, report);
        console.log('[CRON] Relatório diário enviado no grupo Tarefas');
      }
    } catch (err) { console.error('[CRON] Erro no relatório:', err.message); }
  });

  // ============================================
  // CÉREBRO PERSISTENTE — 1x por dia às 04:00 BRT (07:00 UTC)
  // Sintetiza TODAS as memórias num documento estruturado
  // ============================================
  cron.schedule('0 7 * * *', async () => {
    console.log('[CRON] 🧠 Gerando Cérebro Persistente (04:00 BRT)...');
    try {
      const doc = await generateBrainDocument();
      if (doc) {
        invalidateBrainCache(); // Força reload do cache
        console.log(`[CRON] ✅ Cérebro Persistente atualizado: ${doc.length} chars`);
      }
    } catch (err) {
      console.error('[CRON] ❌ Erro ao gerar Cérebro:', err.message);
    }
  });

  console.log('[CRON] Jobs ativados: syncProfiles 6h + estudo Asana 5x/dia + cobrança 2x/dia + relatório diário 08h + Cérebro 1x/dia');
}

// ============================================
// BACKGROUND: Mapear TODOS os contatos conhecidos
// ============================================
async function mapAllKnownGroups(sock) {
  try {
    console.log('[MAP-ALL] Iniciando mapeamento de todos os contatos conhecidos...');
    let mapped = 0;

    // 1) Contatos do banco (jarvis_contacts) — histórico completo de quem já mandou msg
    const { rows: contacts } = await pool.query(
      `SELECT jid, push_name FROM jarvis_contacts WHERE push_name IS NOT NULL AND push_name != '' AND jid LIKE '%@s.whatsapp.net'`
    );
    for (const c of contacts) {
      const firstName = c.push_name.split(' ')[0].toLowerCase();
      if (!teamWhatsApp.has(firstName)) {
        teamWhatsApp.set(firstName, c.jid);
        mapped++;
      }
      // Alias limpo (só letras)
      const cleanName = firstName.replace(/[^a-záàâãéêíóôõúç]/gi, '').toLowerCase();
      if (cleanName && cleanName !== firstName && !teamWhatsApp.has(cleanName)) {
        teamWhatsApp.set(cleanName, c.jid);
      }
      // Nome completo sem emojis
      const fullClean = c.push_name.replace(/[^a-záàâãéêíóôõúç\s]/gi, '').trim().toLowerCase();
      if (fullClean && fullClean !== firstName && !teamWhatsApp.has(fullClean)) {
        teamWhatsApp.set(fullClean, c.jid);
      }
      // teamPhones também
      if (!teamPhones.has(firstName)) {
        teamPhones.set(firstName, c.jid);
      }
    }
    console.log(`[MAP-ALL] ${contacts.length} contatos do banco processados (${mapped} novos mapeados)`);

    // 2) Contatos com @lid — tentar resolver via mensagens que contenham o mesmo push_name
    const { rows: lidContacts } = await pool.query(
      `SELECT jid, push_name FROM jarvis_contacts WHERE push_name IS NOT NULL AND push_name != '' AND jid LIKE '%@lid'`
    );
    for (const c of lidContacts) {
      const firstName = c.push_name.split(' ')[0].toLowerCase();
      if (teamWhatsApp.has(firstName)) continue; // já mapeado com @s.whatsapp.net
      // Tentar achar o mesmo push_name em mensagens com JID @s.whatsapp.net
      const { rows: phoneMatch } = await pool.query(
        `SELECT DISTINCT sender FROM jarvis_messages WHERE push_name = $1 AND sender LIKE '%@s.whatsapp.net' LIMIT 1`,
        [c.push_name]
      );
      if (phoneMatch.length > 0) {
        teamWhatsApp.set(firstName, phoneMatch[0].sender);
        if (!teamPhones.has(firstName)) teamPhones.set(firstName, phoneMatch[0].sender);
        mapped++;
      }
    }
    console.log(`[MAP-ALL] ${lidContacts.length} contatos @lid processados (tentativa de resolução)`);

    // 3) Grupos conhecidos — tentar groupMetadata para pegar phoneNumber dos participantes
    const { rows: groups } = await pool.query(
      `SELECT jid, name FROM jarvis_groups WHERE jid LIKE '%@g.us'`
    );
    let groupsMapped = 0;
    for (const g of groups) {
      // Pular grupos que já foram mapeados no boot (internos + clientes gerenciados)
      if (g.jid === CONFIG.GROUP_TAREFAS || g.jid === CONFIG.GROUP_GALAXIAS) continue;
      if (managedClients.has(g.jid)) continue;
      try {
        const meta = await sock.groupMetadata(g.jid);
        for (const p of meta.participants) {
          const mentionJid = p.phoneNumber || p.id;
          if (!mentionJid.includes('@s.whatsapp.net')) continue;
          const contact = await getContactInfo(p.id);
          const contactByPhone = p.phoneNumber ? await getContactInfo(p.phoneNumber) : null;
          const pushName = contact?.push_name || contactByPhone?.push_name || p.notify;
          if (pushName) {
            const firstName = pushName.split(' ')[0].toLowerCase();
            if (!teamWhatsApp.has(firstName)) {
              teamWhatsApp.set(firstName, mentionJid);
              if (!teamPhones.has(firstName)) teamPhones.set(firstName, mentionJid);
            }
          }
        }
        groupsMapped++;
        // Rate limit: não sobrecarregar a API do WhatsApp
        if (groupsMapped % 5 === 0) await new Promise(r => setTimeout(r, 2000));
      } catch {
        // Grupo que o bot não participa mais — ignorar silenciosamente
      }
    }
    console.log(`[MAP-ALL] ${groupsMapped}/${groups.length} grupos adicionais mapeados via metadata`);
    console.log(`[MAP-ALL] Total: ${teamWhatsApp.size} contatos no mapa de menções`);
  } catch (err) {
    console.error('[MAP-ALL] Erro:', err.message);
  }
}

// ============================================
// WHATSAPP CONNECTION
// ============================================
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_session');
  const { version } = await fetchLatestBaileysVersion();

  const WASocket = makeWASocket.default || makeWASocket;
  sock = WASocket({ auth: state, printQRInTerminal: false, version, syncFullHistory: true, fireInitQueries: true });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (msg) => {
    if (msg.type === 'notify') {
      for (const m of msg.messages) await handleIncomingMessage(m);
    } else if (msg.type === 'append') {
      let stored = 0;
      for (const m of msg.messages) {
        try {
          const from = m.key.remoteJid;
          if (!from || from === 'status@broadcast') continue;
          const isGroup = from.endsWith('@g.us');
          const sender = extractSender(m, from, isGroup);
          let text = m.message?.conversation || m.message?.extendedTextMessage?.text || m.message?.imageMessage?.caption || m.message?.videoMessage?.caption || '';
          const hasAudio = !!m.message?.audioMessage;
          const hasMedia = !!(m.message?.imageMessage || m.message?.videoMessage || m.message?.documentMessage || m.message?.stickerMessage || m.message?.audioMessage);
          if (!text && !hasMedia) continue;
          if (!text && hasAudio) text = '[audio]';
          if (!text && hasMedia) text = '[midia]';

          await storeMessage({ messageId: m.key.id, chatId: from, sender, pushName: m.pushName || '', text, isGroup, isAudio: hasAudio, mediaType: getMediaType(m), timestamp: (typeof m.messageTimestamp === 'object' && m.messageTimestamp?.low !== undefined) ? m.messageTimestamp.low : (Number(m.messageTimestamp) || 0) });
          if (m.pushName) { await upsertContact(sender, m.pushName); const fn = m.pushName.split(' ')[0].toLowerCase(); if (!teamWhatsApp.has(fn)) teamWhatsApp.set(fn, sender); }
          stored++;
        } catch {}
      }
      if (stored > 0) console.log(`[HISTORY] ${stored} mensagens do historico armazenadas`);
    }
  });

  sock.ev.on('messaging-history.set', async ({ messages, isLatest }) => {
    console.log(`[HISTORY] Lote: ${messages.length} mensagens (isLatest: ${isLatest})`);
    let stored = 0;
    for (const m of messages) {
      try {
        const from = m.key.remoteJid;
        if (!from || from === 'status@broadcast') continue;
        const isGroup = from.endsWith('@g.us');
        const sender = extractSender(m, from, isGroup);
        let text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
        const hasMedia = !!(m.message?.imageMessage || m.message?.videoMessage || m.message?.documentMessage || m.message?.audioMessage);
        if (!text && !hasMedia) continue;
        if (!text) text = m.message?.audioMessage ? '[audio]' : '[midia]';

        await storeMessage({ messageId: m.key.id, chatId: from, sender, pushName: m.pushName || '', text, isGroup, isAudio: !!m.message?.audioMessage, mediaType: getMediaType(m), timestamp: (typeof m.messageTimestamp === 'object' && m.messageTimestamp?.low !== undefined) ? m.messageTimestamp.low : (Number(m.messageTimestamp) || 0) });
        if (m.pushName) { await upsertContact(sender, m.pushName); const fn = m.pushName.split(' ')[0].toLowerCase(); if (!teamWhatsApp.has(fn)) teamWhatsApp.set(fn, sender); }
        stored++;
      } catch {}
    }
    if (stored > 0) console.log(`[HISTORY] ${stored}/${messages.length} mensagens salvas`);
  });

  // Group events
  sock.ev.on('group-participants.update', async (event) => {
    try {
      const groupMeta = await sock.groupMetadata(event.id).catch(() => null);
      const groupName = groupMeta?.subject || event.id;
      for (const participant of event.participants) {
        const contact = await getContactInfo(participant);
        const name = contact?.push_name || participant.split('@')[0];
        await pool.query('INSERT INTO group_events (group_jid, group_name, participant_jid, participant_name, action) VALUES ($1, $2, $3, $4, $5)', [event.id, groupName, participant, name, event.action]).catch(() => {});
      }
    } catch {}
  });

  sock.ev.on('groups.update', async (updates) => {
    for (const u of updates) {
      if (u.id && u.subject) { await upsertGroup(u.id, u.subject); }
    }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('[JARVIS] QR Code necessario!');
      connectionStatus = 'needs_qr';
      globalThis.lastQR = qr;
      (async () => {
        try {
          const QRCode = await import('qrcode');
          await QRCode.default.toFile('/tmp/jarvis_qr.png', qr, { width: 512, margin: 2 });
        } catch {}
      })();
    }
    if (connection === 'open') {
      connectionStatus = 'connected';
      // Salvar JID do bot para identificação de mensagens próprias
      const botJid = sock.user?.id || '';
      CONFIG.BOT_JID = botJid;
      CONFIG.BOT_NUMBER = botJid.split(':')[0] || botJid.split('@')[0] || '';
      console.log(`[JARVIS] Conectado ao WhatsApp! (bot: ${CONFIG.BOT_NUMBER})`);
      // Registrar função de envio para o loader.mjs (proativo)
      registerSendFunction(sendText);
      registerSendWithMentionsFunction(sendTextWithMentions);
      console.log('[PROACTIVE] sendText + sendTextWithMentions registradas para tools proativas');
      // Notificação de deploy/reinício
      if (CONFIG.GROUP_TAREFAS) {
        sendText(CONFIG.GROUP_TAREFAS, 'Reiniciei. Versão 5.0. Todos os sistemas operacionais. ⚡').catch(err => {
          console.error('[STARTUP] Erro ao enviar notificação de deploy:', err.message);
        });
      }
      setTimeout(async () => {
        try {
          realTeamJids.clear();
          realTeamJids.add(CONFIG.GUI_JID);
          // Mapear participantes de TODOS os grupos relevantes (internos + clientes)
          const allGroups = [CONFIG.GROUP_TAREFAS, CONFIG.GROUP_GALAXIAS];
          // Adicionar grupos de clientes gerenciados
          for (const [jid] of managedClients) {
            if (jid && !allGroups.includes(jid)) allGroups.push(jid);
          }

          for (const gid of allGroups.filter(Boolean)) {
            try {
              const meta = await sock.groupMetadata(gid);
              const isInternalGroup = gid === CONFIG.GROUP_TAREFAS || gid === CONFIG.GROUP_GALAXIAS;
              for (const p of meta.participants) {
                if (isInternalGroup) realTeamJids.add(p.id);
                // Preferir phoneNumber (@s.whatsapp.net) para menções — LIDs não geram notificação
                const mentionJid = p.phoneNumber || p.id;
                const contact = await getContactInfo(p.id);
                const contactByPhone = p.phoneNumber ? await getContactInfo(p.phoneNumber) : null;
                const pushName = contact?.push_name || contactByPhone?.push_name || p.notify;
                if (pushName) {
                  const firstName = pushName.split(' ')[0].toLowerCase();
                  // Não sobrescrever equipe com contatos de cliente (equipe tem prioridade)
                  if (!teamWhatsApp.has(firstName) || isInternalGroup) {
                    teamWhatsApp.set(firstName, mentionJid);
                  }
                  // Alias limpo (só letras)
                  const cleanName = firstName.replace(/[^a-záàâãéêíóôõúç]/gi, '').toLowerCase();
                  if (cleanName !== firstName && (!teamWhatsApp.has(cleanName) || isInternalGroup)) {
                    teamWhatsApp.set(cleanName, mentionJid);
                  }
                  // push_name completo sem emojis
                  const fullClean = pushName.replace(/[^a-záàâãéêíóôõúç\s]/gi, '').trim().toLowerCase();
                  if (fullClean && fullClean !== firstName && (!teamWhatsApp.has(fullClean) || isInternalGroup)) {
                    teamWhatsApp.set(fullClean, mentionJid);
                  }
                  if (mentionJid.includes('@s.whatsapp.net') && !teamPhones.has(firstName)) {
                    teamPhones.set(firstName, mentionJid);
                  }
                }
              }
              if (!isInternalGroup) {
                console.log(`[TEAM] Grupo cliente "${meta.subject}" mapeado: ${meta.participants.length} participantes`);
              }
            } catch (err) {
              console.warn(`[TEAM] Erro ao mapear grupo ${gid}: ${err.message}`);
            }
          }
          console.log(`[TEAM] ${realTeamJids.size} membros da equipe real identificados`);
          console.log(`[TEAM] ${teamWhatsApp.size} contatos mapeados para menções`);
          console.log('[TEAM] Mapeamento:', JSON.stringify(Object.fromEntries(teamWhatsApp)));

          // Background: mapear TODOS os grupos conhecidos (30s depois, sem bloquear boot)
          setTimeout(() => mapAllKnownGroups(sock), 25000);
        } catch (err) { console.error('[TEAM] Erro:', err.message); }
      }, 5000);
    }
    if (connection === 'close') {
      connectionStatus = 'reconnecting';
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('[JARVIS] Conexao fechou, codigo:', code);
      if (code !== DisconnectReason.loggedOut) {
        console.log('[JARVIS] Reconectando em 5s...');
        setTimeout(() => startWhatsApp(), 5000);
      } else {
        connectionStatus = 'logged_out';
        console.log('[JARVIS] Deslogado!');
      }
    }
  });
}

// ============================================
// STARTUP
// ============================================
console.log('============================================');
console.log('  JARVIS v4.0 - Stream Lab AI Bot');
console.log('  Arquitetura: Modular + Agent Teams + Mem0');
console.log('  AI: Claude Sonnet 4.6 (Anthropic)');
console.log('  Audio: Whisper (STT) + ElevenLabs (TTS)');
console.log('============================================');

initDB().then(async () => {
  await initMemory();
  await loadTeamContacts();
  await loadManagedClients(pool);
  // Restaurar toggles de grupos salvos no dashboard
  try {
    const { rows } = await pool.query("SELECT value FROM jarvis_config WHERE key = 'group_toggles'");
    if (rows[0]?.value) {
      const toggles = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
      for (const [jid, active] of Object.entries(toggles)) {
        if (active) JARVIS_ALLOWED_GROUPS.add(jid);
        else JARVIS_ALLOWED_GROUPS.delete(jid);
      }
      console.log(`[STARTUP] ${Object.keys(toggles).length} toggle(s) de grupo restaurados do banco`);
    }
  } catch {}
  startWhatsApp();
  setupCronJobs();
  startEmailMonitor();
  startChannelEmailMonitor();
  console.log('[JARVIS] Todos os sistemas 5.0 inicializados.');
});
