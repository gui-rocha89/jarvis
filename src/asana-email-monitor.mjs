// ============================================
// JARVIS 3.0 - Asana Email Monitor (IMAP)
// Monitora @menções no Asana via email
// Responde com comentários na task
// ============================================
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import Anthropic from '@anthropic-ai/sdk';
import { CONFIG } from './config.mjs';
import { pool } from './database.mjs';
import { searchMemories } from './memory.mjs';
import { asanaAddComment, asanaRequest } from './skills/loader.mjs';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

// Estado do monitor (exposto pro dashboard)
export const emailMonitorState = {
  running: false,
  lastCheck: null,
  processed: 0,
  errors: 0,
  lastError: null,
  connectionStatus: 'disconnected',
};

// ============================================
// TABELA DE LOG (idempotente)
// ============================================
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS asana_email_log (
      id SERIAL PRIMARY KEY,
      email_uid TEXT UNIQUE NOT NULL,
      task_gid TEXT,
      commenter_name TEXT,
      comment_text TEXT,
      response_text TEXT,
      status TEXT DEFAULT 'processed',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ============================================
// FILTRO: É email de @mention do Asana?
// ============================================
function isAsanaMentionEmail(parsed) {
  const from = (parsed.from?.text || '').toLowerCase();
  if (!from.includes('asana')) return false;

  const subject = (parsed.subject || '').toLowerCase();
  // Asana manda emails com patterns como:
  // PT: "Gui Rocha te mencionou em [Task]" / "Gui Rocha comentou em [Task]"
  // EN: "Gui Rocha mentioned you in [Task]" / "Gui Rocha commented on [Task]"
  const mentionPatterns = [
    /te mencionou/,
    /mencionou voc/,
    /mentioned you/,
    /comentou em/,
    /commented on/,
    /replied to/,
    /respondeu/,
  ];
  return mentionPatterns.some(p => p.test(subject));
}

// ============================================
// PARSER: Extrai dados do email do Asana
// ============================================
function parseAsanaEmail(parsed) {
  const html = parsed.html || '';
  const text = parsed.text || '';
  const subject = parsed.subject || '';

  // Extrair Task GID da URL do Asana no email
  // Formato: https://app.asana.com/0/PROJECT_GID/TASK_GID ou /0/TASK_GID/f
  const taskGidMatch = html.match(/app\.asana\.com\/0\/\d+\/(\d+)/) || text.match(/app\.asana\.com\/0\/\d+\/(\d+)/);
  const taskGid = taskGidMatch ? taskGidMatch[1] : null;

  // Extrair nome do comentarista do subject
  // "Gui Rocha te mencionou em Task Name" → "Gui Rocha"
  const commenterMatch = subject.match(/^(.+?)\s+(?:te mencionou|mencionou|mentioned|comentou|commented|replied|respondeu)/i);
  const commenterName = commenterMatch ? commenterMatch[1].trim() : (parsed.from?.text?.split('<')[0]?.trim() || 'Alguém');

  // Extrair o texto do comentário do corpo do email
  // Asana coloca o comentário no corpo do email em texto plain
  let commentText = '';

  // Tentar extrair do texto plain (mais limpo)
  if (text) {
    // O texto do Asana geralmente começa com o comentário e termina com links
    const lines = text.split('\n').filter(l => l.trim());
    const commentLines = [];
    for (const line of lines) {
      // Parar quando chegar em links do Asana ou footers
      if (line.includes('app.asana.com') || line.includes('Asana, Inc') || line.includes('unsubscribe') || line.includes('View task')) break;
      // Pular header com nome do remetente (geralmente a primeira linha é o nome)
      if (commentLines.length === 0 && line.trim() === commenterName) continue;
      commentLines.push(line.trim());
    }
    commentText = commentLines.join(' ').trim();
  }

  // Fallback: extrair do HTML se texto vazio
  if (!commentText && html) {
    const htmlClean = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // Pegar primeiros 500 chars antes de links
    const beforeLink = htmlClean.split('app.asana.com')[0] || htmlClean;
    commentText = beforeLink.substring(0, 500).trim();
  }

  // Extrair nome da task do subject
  // "Gui Rocha te mencionou em [CLIENTE] Task Name" → "[CLIENTE] Task Name"
  const taskMatch = subject.match(/(?:em|in|on)\s+(.+)$/i);
  const taskName = taskMatch ? taskMatch[1].trim() : '';

  return { taskGid, commenterName, commentText, taskName, subject };
}

// ============================================
// GERAR RESPOSTA INTELIGENTE
// ============================================
async function generateMentionResponse(taskGid, commenterName, commentText, taskName) {
  // 1. Buscar detalhes da task no Asana
  let taskDetails = null;
  let recentComments = [];
  try {
    const taskData = await asanaRequest(`/tasks/${taskGid}?opt_fields=name,notes,assignee.name,due_on,completed,memberships.project.name`);
    taskDetails = taskData?.data || null;

    // Últimos comentários da task
    const stories = await asanaRequest(`/tasks/${taskGid}/stories?opt_fields=text,created_by.name,created_at,type&limit=10`);
    recentComments = (stories?.data || [])
      .filter(s => s.type === 'comment' && s.text)
      .slice(-5)
      .map(s => `${s.created_by?.name || '?'}: ${s.text.substring(0, 200)}`)
      .join('\n');
  } catch (e) {
    console.error('[EMAIL] Erro ao buscar task:', e.message);
  }

  // 2. Buscar memórias relevantes via RAG
  let memories = [];
  try {
    const searchTerms = [taskName, commenterName, commentText].filter(Boolean).join(' ');
    memories = await searchMemories(searchTerms, null, null, 8);
  } catch (e) {}

  const memoryContext = memories.length > 0
    ? memories.map(m => `- ${m.content}`).join('\n')
    : 'Sem memórias relevantes encontradas.';

  // 3. Montar contexto
  const taskContext = taskDetails ? [
    `Task: ${taskDetails.name}`,
    taskDetails.assignee?.name ? `Responsável: ${taskDetails.assignee.name}` : null,
    taskDetails.due_on ? `Prazo: ${taskDetails.due_on}` : null,
    `Status: ${taskDetails.completed ? 'Concluída' : 'Pendente'}`,
    taskDetails.memberships?.[0]?.project?.name ? `Projeto: ${taskDetails.memberships[0].project.name}` : null,
    taskDetails.notes ? `Descrição: ${taskDetails.notes.substring(0, 300)}` : null,
  ].filter(Boolean).join('\n') : `Task: ${taskName || 'desconhecida'}`;

  // 4. Chamar Claude
  const response = await anthropic.messages.create({
    model: CONFIG.AI_MODEL,
    max_tokens: 1024,
    system: `Você é o Jarvis, assistente de IA da agência de marketing Stream Lab. Estilo: direto, útil, personalidade inspirada no Jarvis do Tony Stark mas profissional.

Você foi @mencionado em um comentário de uma task no Asana. Responda de forma concisa e útil ao que foi pedido.

REGRAS:
- Responda como COMENTÁRIO no Asana (sem formatação HTML, só texto plain)
- Seja direto e útil — responda o que foi perguntado
- Se te pedirem ajuda com estratégia/ideias, dê sugestões concretas
- Se te pedirem status, dê o status baseado nos dados
- Use as memórias do contexto para personalizar a resposta
- NUNCA altere a descrição da task — apenas comente
- Português com acentos sempre`,
    messages: [{
      role: 'user',
      content: `${commenterName} te mencionou nesta task do Asana:

--- DETALHES DA TASK ---
${taskContext}

--- ÚLTIMOS COMENTÁRIOS ---
${recentComments || 'Nenhum comentário anterior.'}

--- COMENTÁRIO QUE TE MENCIONOU ---
${commenterName}: ${commentText}

--- CONTEXTO DA MEMÓRIA (RAG) ---
${memoryContext}

Responda ao que ${commenterName} pediu:`
    }],
  });

  return response.content?.[0]?.text || '';
}

// ============================================
// PROCESSAR UM EMAIL
// ============================================
async function processEmail(client, message) {
  const uid = message.uid?.toString();
  if (!uid) return;

  try {
    // Verificar dedup
    const { rows } = await pool.query('SELECT 1 FROM asana_email_log WHERE email_uid = $1', [uid]);
    if (rows.length > 0) return; // Já processado

    // Baixar e parsear o email
    const download = await client.download(uid, { uid: true });
    const parsed = await simpleParser(download.content);

    // Filtrar: só processar @mentions do Asana
    if (!isAsanaMentionEmail(parsed)) {
      // Marcar como lido pra não reprocessar
      await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      return;
    }

    // Extrair dados
    const { taskGid, commenterName, commentText, taskName, subject } = parseAsanaEmail(parsed);

    console.log(`[EMAIL] @menção detectada! De: ${commenterName} | Task: ${taskName || taskGid} | Comentário: ${commentText.substring(0, 80)}...`);

    if (!taskGid) {
      console.log('[EMAIL] Sem Task GID no email, pulando...');
      await pool.query(
        'INSERT INTO asana_email_log (email_uid, commenter_name, comment_text, status) VALUES ($1, $2, $3, $4) ON CONFLICT (email_uid) DO NOTHING',
        [uid, commenterName, commentText.substring(0, 500), 'no_task_gid']
      );
      await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      return;
    }

    // Gerar resposta com Claude
    const responseText = await generateMentionResponse(taskGid, commenterName, commentText, taskName);

    if (responseText) {
      // Postar comentário na task do Asana
      await asanaAddComment(taskGid, responseText);
      console.log(`[EMAIL] ✅ Resposta postada na task ${taskGid}: ${responseText.substring(0, 80)}...`);
    }

    // Salvar no log
    await pool.query(
      'INSERT INTO asana_email_log (email_uid, task_gid, commenter_name, comment_text, response_text, status) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (email_uid) DO NOTHING',
      [uid, taskGid, commenterName, commentText.substring(0, 500), (responseText || '').substring(0, 1000), responseText ? 'responded' : 'no_response']
    );

    // Marcar como lido
    await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
    emailMonitorState.processed++;

  } catch (err) {
    emailMonitorState.errors++;
    emailMonitorState.lastError = err.message;
    console.error(`[EMAIL] Erro processando email ${uid}:`, err.message);
    // Salvar erro no log pra não reprocessar
    await pool.query(
      'INSERT INTO asana_email_log (email_uid, status) VALUES ($1, $2) ON CONFLICT (email_uid) DO NOTHING',
      [uid, 'error']
    ).catch(() => {});
    // Marcar como lido mesmo com erro
    try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch {}
  }
}

// ============================================
// POLL: Conecta ao IMAP e processa emails
// ============================================
async function pollEmails() {
  if (!CONFIG.IMAP_HOST || !CONFIG.IMAP_PASSWORD) return;

  let client;
  try {
    client = new ImapFlow({
      host: CONFIG.IMAP_HOST,
      port: CONFIG.IMAP_PORT,
      secure: true,
      auth: {
        user: CONFIG.IMAP_USER,
        pass: CONFIG.IMAP_PASSWORD,
      },
      logger: false,
    });

    await client.connect();
    emailMonitorState.connectionStatus = 'connected';

    const lock = await client.getMailboxLock('INBOX');
    try {
      // Buscar emails não lidos
      let count = 0;
      for await (const msg of client.fetch({ seen: false }, { uid: true, envelope: true, source: true })) {
        await processEmail(client, msg);
        count++;
        if (count >= 20) break; // Limitar a 20 por poll pra não sobrecarregar
      }
    } finally {
      lock.release();
    }

    await client.logout();
    emailMonitorState.lastCheck = new Date().toISOString();

  } catch (err) {
    emailMonitorState.errors++;
    emailMonitorState.lastError = err.message;
    emailMonitorState.connectionStatus = 'error';
    console.error('[EMAIL] Erro no poll IMAP:', err.message);
  } finally {
    try { if (client) await client.logout().catch(() => {}); } catch {}
  }
}

// ============================================
// START / STOP
// ============================================
let pollInterval = null;

export function startEmailMonitor() {
  if (emailMonitorState.running) return;
  if (!CONFIG.IMAP_HOST || !CONFIG.IMAP_PASSWORD) {
    console.log('[EMAIL] IMAP não configurado, monitor desativado');
    return;
  }

  emailMonitorState.running = true;
  const intervalSec = CONFIG.IMAP_POLL_INTERVAL || 90;
  console.log(`[EMAIL] Monitor de @menções do Asana iniciado (poll a cada ${intervalSec}s)`);

  // Criar tabela e rodar primeiro poll
  ensureTable()
    .then(() => pollEmails())
    .catch(err => console.error('[EMAIL] Erro no poll inicial:', err.message));

  // Polls subsequentes
  pollInterval = setInterval(() => {
    pollEmails().catch(err => console.error('[EMAIL] Erro no poll:', err.message));
  }, intervalSec * 1000);
}

export function stopEmailMonitor() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  emailMonitorState.running = false;
  emailMonitorState.connectionStatus = 'stopped';
  console.log('[EMAIL] Monitor parado');
}
