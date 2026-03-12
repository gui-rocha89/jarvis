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
import { randomUUID, randomInt } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

// Módulos do Jarvis 2.0
import { CONFIG, AUDIO_ALLOWED, teamPhones, teamWhatsApp } from './src/config.mjs';
import { pool, initDB, storeMessage, getRecentMessages, getContactInfo, getGroupInfo, upsertContact, upsertGroup, getMessageCount } from './src/database.mjs';
import { initMemory, processMemory, getMemoryContext, getMemoryStats, searchMemories, storeFacts, extractFacts } from './src/memory.mjs';
import { shouldJarvisRespond, isValidResponse, generateResponse, markConversationActive, isConversationActive, findTeamJid, extractMentionsFromText, generateDailyReport } from './src/brain.mjs';
import { voiceConfig, loadVoiceConfig, saveVoiceConfig, transcribeAudio, generateAudio } from './src/audio.mjs';
import { synthesizeProfile, getProfile, listProfiles, syncProfiles } from './src/profiles.mjs';
import { asanaRequest, getOverdueTasks, getGCalClient, JARVIS_TOOLS } from './src/skills/loader.mjs';
import { getMediaType, extractSender } from './src/helpers.mjs';
import { startAsanaStudy, stopAsanaStudy, asanaBatchState } from './src/batch-asana.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let sock = null;
let connectionStatus = 'disconnected';
let jarvisPaused = false; // Modo pausa: recebe mensagens mas NAO responde
const sentByBot = new Set();

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

  // Aprendizado passivo em tempo real: aprende de TODAS as mensagens (grupos + privadas)
  if (text.length >= 20 && !text.startsWith('[')) {
    processMemory(text, pushName || 'Desconhecido', sender, from, isGroup).catch(err => {
      console.error('[MEMORY] Erro aprendizado passivo:', err.message);
    });
  }

  // Decidir se Jarvis deve responder
  const quotedParticipant = m.message?.extendedTextMessage?.contextInfo?.participant || '';
  const quotedStanzaId = m.message?.extendedTextMessage?.contextInfo?.stanzaId || '';
  const botNumber = CONFIG.GUI_JID.split('@')[0];
  const isReplyToJarvis = (botNumber && quotedParticipant.includes(botNumber)) || sentByBot.has(quotedStanzaId);

  if (!shouldJarvisRespond(text, from, isGroup, isReplyToJarvis)) return;

  // Modo pausa: loga mas nao responde
  if (jarvisPaused) {
    console.log('[JARVIS] PAUSADO - ignorando:', text.substring(0, 60));
    return;
  }

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

    // Senha correta — resetar tentativas e gerar código 2FA
    await pool.query('UPDATE dashboard_users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);

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

    res.json({ token, expiresIn: '8h' });
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
    // SISTEMA DE PATENTES - Inspirado nos Vingadores
    // ============================================
    // 6 eixos de conhecimento com thresholds progressivos (escala logarítmica)
    const logScore = (count, thresholds) => {
      // thresholds: [t1, t2, t3, t4, t5] → 0-20, 20-40, 40-60, 60-80, 80-100
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
        (catMap['general']?.count || 0) + (catMap['rule']?.count || 0) + (catMap['process']?.count || 0),
        [10, 50, 150, 400, 1000]
      ),
      equipe: logScore(
        (catMap['team_member']?.count || 0) + (catMap['style']?.count || 0) + (catMap['pattern']?.count || 0),
        [10, 40, 120, 300, 800]
      ),
      clientes: logScore(
        (catMap['client']?.count || 0) + (catMap['client_profile']?.count || 0),
        [10, 50, 150, 400, 1000]
      ),
      projetos: logScore(
        (catMap['decision']?.count || 0) + (catMap['deadline']?.count || 0) + (gcalCount.rows[0].cnt || 0),
        [10, 40, 120, 300, 800]
      ),
      comunicacao: logScore(
        (catMap['preference']?.count || 0) + (catMap['style']?.count || 0),
        [5, 25, 80, 200, 500]
      ),
      processos: logScore(
        (catMap['process']?.count || 0) + (catMap['rule']?.count || 0),
        [5, 20, 60, 150, 400]
      ),
    };

    const axesValues = Object.values(axes);
    const overallScore = Math.round(axesValues.reduce((a, b) => a + b, 0) / axesValues.length);

    // Patente baseada no TOTAL de memórias (não no score %)
    const patentes = [
      { id: 'recruta', nome: 'Recruta', cor: '#8B6914', icon: '🟤', min: 0, max: 49, desc: 'Acabou de chegar, aprendendo o básico' },
      { id: 'agente', nome: 'Agente', cor: '#00d4ff', icon: '🔵', min: 50, max: 199, desc: 'Conhece as pessoas e rotinas' },
      { id: 'especialista', nome: 'Especialista', cor: '#00ff88', icon: '🟢', min: 200, max: 499, desc: 'Entende padrões, clientes e processos' },
      { id: 'capitao', nome: 'Capitão', cor: '#ffd700', icon: '🟡', min: 500, max: 1499, desc: 'Domina a operação, antecipa necessidades' },
      { id: 'comandante', nome: 'Comandante', cor: '#ff8a00', icon: '🟠', min: 1500, max: 4999, desc: 'Conhecimento profundo de tudo e todos' },
      { id: 'diretor', nome: 'Diretor da S.H.I.E.L.D.', cor: '#ff3b3b', icon: '🔴', min: 5000, max: Infinity, desc: 'Sabe mais da empresa que qualquer humano' },
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
      allPatentes: patentes.filter(p => p.max !== Infinity).map(p => ({ ...p })).concat([
        { id: 'diretor', nome: 'Diretor da S.H.I.E.L.D.', cor: '#ff3b3b', icon: '🔴', min: 5000, desc: 'Sabe mais da empresa que qualquer humano' },
      ]),
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
      SELECT DATE(created_at) as day, COUNT(*)::int as count, category,
             ROUND(AVG(importance)::numeric, 1)::float as avg_importance
      FROM jarvis_memories
      WHERE created_at > NOW() - INTERVAL '1 day' * $1
      GROUP BY DATE(created_at), category
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
    await startAsanaStudy();
    res.json({ success: true, message: 'Estudo do Asana iniciado' });
  } catch (err) {
    res.status(400).json({ error: err.message });
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
    const { MASTER_SYSTEM_PROMPT, AGENT_PROMPTS } = await import('./src/agents/master.mjs');
    res.json({
      master: MASTER_SYSTEM_PROMPT,
      agents: {
        creative: AGENT_PROMPTS.creative || '',
        manager: AGENT_PROMPTS.manager || '',
        researcher: AGENT_PROMPTS.researcher || '',
      }
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

    if (!agent || agent === 'master') {
      // Substituir o MASTER_SYSTEM_PROMPT
      const start = content.indexOf('export const MASTER_SYSTEM_PROMPT = `');
      const end = content.indexOf('`;', start) + 2;
      if (start === -1 || end === 1) return res.status(500).json({ error: 'Nao encontrou MASTER_SYSTEM_PROMPT no arquivo' });
      content = content.substring(0, start) + 'export const MASTER_SYSTEM_PROMPT = `' + prompt.replace(/`/g, '\\`').replace(/\$/g, '\\$') + '`;' + content.substring(end);
    }

    await writeFile(filePath, content, 'utf-8');

    // Limpar cache do modulo para recarregar
    const modUrl = new URL('./src/agents/master.mjs', import.meta.url).href;
    delete globalThis[modUrl];

    res.json({ success: true, message: 'Prompt salvo. Reinicie o Jarvis para aplicar.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

  console.log('[CRON] Jobs ativados: syncProfiles a cada 6h');
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
