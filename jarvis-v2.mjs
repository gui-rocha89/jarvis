// ============================================
// JARVIS 2.0 - Stream Lab AI Bot
// Arquitetura modular com Agent Teams + Memória
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
import { randomUUID } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// Módulos do Jarvis 2.0
import { CONFIG, AUDIO_ALLOWED, teamPhones, teamWhatsApp } from './src/config.mjs';
import { pool, initDB, storeMessage, getRecentMessages, getContactInfo, getGroupInfo, upsertContact, upsertGroup, getMessageCount } from './src/database.mjs';
import { initMemory, processMemory, getMemoryContext, getMemoryStats, searchMemories, storeFacts } from './src/memory.mjs';
import { shouldJarvisRespond, isValidResponse, generateResponse, markConversationActive, isConversationActive, findTeamJid, extractMentionsFromText, generateDailyReport } from './src/brain.mjs';
import { voiceConfig, loadVoiceConfig, saveVoiceConfig, transcribeAudio, generateAudio } from './src/audio.mjs';
import { asanaRequest, getOverdueTasks, getGCalClient, JARVIS_TOOLS } from './src/skills/loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let sock = null;
let connectionStatus = 'disconnected';
const sentByBot = new Set();

// ============================================
// HELPERS
// ============================================
function getMediaType(m) {
  if (!m.message) return null;
  if (m.message.audioMessage) return 'audio';
  if (m.message.imageMessage) return 'image';
  if (m.message.videoMessage) return 'video';
  if (m.message.documentMessage) return 'document';
  if (m.message.stickerMessage) return 'sticker';
  if (m.message.contactMessage) return 'contact';
  if (m.message.locationMessage) return 'location';
  return null;
}

function extractSender(m, from, isGroup) {
  if (!isGroup) return from;
  const participant = m.key?.participant || m.key?.participantAlt || m.participant || null;
  if (participant && participant !== '' && !participant.endsWith('@g.us') && !participant.endsWith('@broadcast')) {
    return participant;
  }
  if (m.key?.fromMe) return 'jarvis@bot';
  return from;
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
// HANDLER DE MENSAGENS
// ============================================
async function handleIncomingMessage(m) {
  if (m.key.remoteJid === 'status@broadcast') return;
  if (m.key.fromMe && sentByBot.has(m.key.id)) { sentByBot.delete(m.key.id); return; }

  const from = m.key.remoteJid;
  const isGroup = from.endsWith('@g.us');
  const sender = extractSender(m, from, isGroup);

  let text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
  let isAudio = false;
  const audioMsg = m.message?.audioMessage;

  // Transcrever áudio
  if (audioMsg && process.env.OPENAI_API_KEY) {
    try {
      console.log('[AUDIO] Transcrevendo audio de', m.pushName || sender);
      const buffer = await downloadMediaMessage(m, 'buffer', {});
      const transcription = await transcribeAudio(buffer);
      text = transcription;
      isAudio = true;
      console.log('[AUDIO] Transcricao:', transcription.substring(0, 100));
    } catch (err) {
      console.error('[AUDIO] Erro:', err.message);
    }
  }

  if (!text) return;
  const pushName = m.pushName || '';

  console.log(`[MSG] ${isGroup ? 'GRUPO' : 'PV'} | ${pushName} (${sender.substring(0, 15)}): ${text.substring(0, 80)}`);

  // Salvar na memória
  await storeMessage({
    messageId: m.key.id, chatId: from, sender, pushName, text, isGroup, isAudio,
    mediaType: getMediaType(m), transcription: isAudio ? text : null,
    timestamp: (typeof m.messageTimestamp === 'object' && m.messageTimestamp?.low !== undefined) ? m.messageTimestamp.low : (Number(m.messageTimestamp) || Math.floor(Date.now() / 1000)),
  });

  await upsertContact(sender, pushName);
  if (pushName) {
    const firstName = pushName.split(' ')[0].toLowerCase();
    if (!teamWhatsApp.has(firstName)) {
      teamWhatsApp.set(firstName, sender);
      console.log(`[TEAM] Novo membro mapeado: ${pushName} -> ${sender}`);
    }
  }

  // Decidir se Jarvis deve responder
  const quotedParticipant = m.message?.extendedTextMessage?.contextInfo?.participant || '';
  const quotedStanzaId = m.message?.extendedTextMessage?.contextInfo?.stanzaId || '';
  const botNumber = CONFIG.GUI_JID.split('@')[0];
  const isReplyToJarvis = (botNumber && quotedParticipant.includes(botNumber)) || sentByBot.has(quotedStanzaId);

  if (!shouldJarvisRespond(text, from, isGroup, isReplyToJarvis)) return;

  console.log('[JARVIS] Gerando resposta para:', text.substring(0, 60));

  const result = await generateResponse(text, from, sender, pushName, isGroup);
  if (!result?.text) return;
  if (!isValidResponse(result.text)) {
    console.log('[JARVIS] Resposta bloqueada (lixo):', result.text.substring(0, 50));
    return;
  }

  const responseText = result.text;
  console.log(`[JARVIS] [${result.agent}] Resposta:`, responseText.substring(0, 80));

  // Enviar resposta
  const quotedMsg = isGroup ? m : null;
  if (isAudio && AUDIO_ALLOWED.has(from)) {
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
app.use(express.json());

function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apikey;
  if (key !== CONFIG.API_KEY) return res.status(401).json({ error: 'API key invalida' });
  next();
}

// --- Status e Health ---
app.get('/status', auth, async (req, res) => {
  const msgCount = await getMessageCount();
  const memStats = await getMemoryStats();
  res.json({
    status: connectionStatus, version: CONFIG.JARVIS_VERSION,
    messages_stored: msgCount, memories_stored: memStats.total,
    ai_model: CONFIG.AI_MODEL, architecture: 'Jarvis 2.0 - Modular + Agent Teams + Mem0',
  });
});

app.get('/dashboard/health', auth, async (req, res) => {
  try {
    const msgCount = await getMessageCount();
    const memStats = await getMemoryStats();
    const uptime = process.uptime();
    const mem = process.memoryUsage();
    res.json({
      status: connectionStatus, version: CONFIG.JARVIS_VERSION,
      uptime: Math.floor(uptime),
      uptimeFormatted: Math.floor(uptime / 3600) + 'h ' + Math.floor((uptime % 3600) / 60) + 'm',
      memory: { rss: Math.round(mem.rss / 1024 / 1024), heapUsed: Math.round(mem.heapUsed / 1024 / 1024) },
      totalMessages: msgCount,
      totalMemories: memStats.total,
      memoriesByScope: memStats.byScope,
      memoriesByCategory: memStats.byCategory,
      architecture: { agents: ['master', 'creative', 'manager', 'researcher'], memorySystem: 'Mem0-inspired (3 scopes)', skills: ['asana', 'gcal', 'voice', 'memory'] },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

// --- Dashboard ---
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));

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
      architecture: 'Jarvis 2.0 - Modular',
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
    res.json(stats);
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

// --- Dashboard Chat ---
const dashboardChatHistory = [];
app.post('/dashboard/chat', auth, async (req, res) => {
  try {
    const { message, clearHistory } = req.body;
    if (clearHistory) { dashboardChatHistory.length = 0; return res.json({ response: 'Historico limpo.', cleared: true }); }
    if (!message) return res.status(400).json({ error: 'Mensagem obrigatoria' });

    const { MASTER_SYSTEM_PROMPT } = await import('./src/agents/master.mjs');
    const memoryCtx = await getMemoryContext(CONFIG.GUI_JID, 'dashboard', message);

    dashboardChatHistory.push({ role: 'user', content: message });
    while (dashboardChatHistory.length > 30) dashboardChatHistory.shift();

    const msgs = [...dashboardChatHistory];
    if (msgs.length > 0 && msgs[0].role !== 'user') msgs.shift();

    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

    const response = await anthropic.messages.create({
      model: CONFIG.AI_MODEL, max_tokens: 1500,
      system: MASTER_SYSTEM_PROMPT + '\n\nCONTEXTO: Dashboard (guardiaolab.com.br). Falando com o Gui. Pode falar de TODOS os projetos.' + memoryCtx,
      messages: msgs,
    });

    const text = response.content[0]?.text || 'Sem resposta.';
    dashboardChatHistory.push({ role: 'assistant', content: text });

    // Auto-salvar instruções como homework
    const lower = message.toLowerCase();
    if (/a partir de agora|lembre|regra|nunca mais|sempre que|aprenda|importante/.test(lower)) {
      await pool.query('INSERT INTO homework (type, content, source) VALUES ($1, $2, $3)', ['chat_instruction', message, 'dashboard_chat']).catch(() => {});
    }

    // Processar memória em background
    processMemory(message, 'Gui', CONFIG.GUI_JID, 'dashboard', false).catch(() => {});

    res.json({ response: text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Team mapping ---
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

// Start API
app.listen(CONFIG.API_PORT, async () => {
  console.log('[API] Rodando na porta', CONFIG.API_PORT);
  await loadVoiceConfig().catch(() => {});
});

// ============================================
// CRON JOBS
// ============================================
function setupCronJobs() {
  console.log('[CRON] Jobs DESATIVADOS temporariamente por ordem do Gui');
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
      console.log('[JARVIS] Conectado ao WhatsApp!');
      setTimeout(async () => {
        try {
          for (const gid of [CONFIG.GROUP_TAREFAS, CONFIG.GROUP_GALAXIAS]) {
            const meta = await sock.groupMetadata(gid);
            for (const p of meta.participants) {
              const contact = await getContactInfo(p.id);
              if (contact?.push_name) {
                const firstName = contact.push_name.split(' ')[0].toLowerCase();
                teamWhatsApp.set(firstName, p.id);
                if (p.id.includes('@s.whatsapp.net') && !teamPhones.has(firstName)) {
                  teamPhones.set(firstName, p.id);
                }
              }
            }
          }
          console.log('[TEAM] Mapeamento:', JSON.stringify(Object.fromEntries(teamWhatsApp)));
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
console.log('  JARVIS v2.0 - Stream Lab AI Bot');
console.log('  Arquitetura: Modular + Agent Teams + Mem0');
console.log('  AI: Claude Sonnet 4.6 (Anthropic)');
console.log('  Audio: Whisper (STT) + ElevenLabs (TTS)');
console.log('============================================');

initDB().then(async () => {
  await initMemory();
  startWhatsApp();
  setupCronJobs();
  console.log('[JARVIS] Todos os sistemas 2.0 inicializados.');
});
