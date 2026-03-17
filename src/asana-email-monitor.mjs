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
import { JARVIS_IDENTITY, CHANNEL_CONTEXT } from './agents/master.mjs';

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
  // Asana emails reais observados:
  // "👋 Gui mencionou você: [ROSSATO] TRAFEGO PAGO [Cabine_De_Comando]"
  // "💬 Novo comentário em: [MINNER] MARÇO"
  // "Gui Rocha te mencionou em [Task]"
  // "Gui Rocha mentioned you in [Task]"
  const mentionPatterns = [
    /mencionou/,           // "Gui mencionou você" ou "te mencionou"
    /mentioned/,           // EN: "mentioned you"
    /novo coment[áa]rio/,  // "Novo comentário em:"
    /new comment/,         // EN
    /comentou/,            // "comentou em"
    /commented/,           // EN: "commented on"
    /replied/,
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
  // Formato antigo: https://app.asana.com/0/PROJECT_GID/TASK_GID
  // Formato novo:   https://app.asana.com/1/WORKSPACE/project/PROJECT_GID/task/TASK_GID
  const fullText = html + '\n' + text;
  const taskGidMatch = fullText.match(/app\.asana\.com\/\d+\/\d+\/project\/\d+\/task\/(\d+)/)  // formato novo
    || fullText.match(/app\.asana\.com\/0\/\d+\/(\d+)/);  // formato antigo
  const taskGid = taskGidMatch ? taskGidMatch[1] : null;

  // Extrair nome do comentarista do subject
  // Formato antigo: "Gui Rocha te mencionou em Task Name"
  // Formato novo:   "👋 Gui mencionou você: [ROSSATO] TRAFEGO PAGO"
  //                 "💬 Novo comentário em: [MINNER] MARÇO"
  const cleanSubject = subject.replace(/^[^\w\s]+\s*/, ''); // Remove emojis no começo
  const commenterMatch = cleanSubject.match(/^(.+?)\s+(?:te mencionou|mencionou|mentioned|comentou|commented|replied|respondeu)/i);
  const commenterName = commenterMatch ? commenterMatch[1].trim() : (parsed.from?.text?.split('<')[0]?.trim() || 'Alguém');

  // Extrair o texto do comentário do corpo do email
  // Formato real do Asana (2026):
  //   "Avatar de Gui Rocha\n\nGui adicionou um comentário\n\nstreamlab.com.br (URL)\n\nVer a tarefa: URL\n\nURL_PROFILE texto do comentário real\n\nTarefa: [NOME]: URL\n\n..."
  let commentText = '';

  if (text) {
    const lines = text.split('\n');
    const commentLines = [];
    let foundComment = false;

    for (const line of lines) {
      const trimmed = line.trim();
      // Pular headers do Asana
      if (!foundComment) {
        if (trimmed.startsWith('Avatar de ')) continue;
        if (trimmed.includes('adicionou um coment') || trimmed.includes('added a comment')) continue;
        if (trimmed.match(/^streamlab|^Ver a tarefa|^View task/)) continue;
        if (trimmed === '') continue;
        // URLs de profile no começo do comentário — indica início do texto real
        if (trimmed.match(/^https:\/\/app\.asana\.com.*profile/)) {
          // A parte após a URL é o começo do comentário
          const afterUrl = trimmed.replace(/^https:\/\/app\.asana\.com\S+\s*/, '');
          if (afterUrl) commentLines.push(afterUrl);
          foundComment = true;
          continue;
        }
        // Se a linha não é header e não é URL, é o comentário
        if (!trimmed.includes('app.asana.com')) {
          commentLines.push(trimmed);
          foundComment = true;
          continue;
        }
        continue;
      }
      // Já encontrou o comentário — parar em footers/links/repetições
      if (trimmed.startsWith('Tarefa:') || trimmed.startsWith('Task:')) break;
      if (trimmed.includes('Não quer receber') || trimmed.includes('unsubscribe')) break;
      if (trimmed.match(/^\d+ .+ St .+, [A-Z]{2}/)) break; // Endereço Asana
      // Ignorar URLs de profile dentro do texto (Asana coloca link do @mention)
      const cleanLine = trimmed.replace(/https:\/\/app\.asana\.com\S+/g, '').trim();
      if (cleanLine) commentLines.push(cleanLine);
    }
    commentText = commentLines.join(' ').trim();
    // Limpar: remover duplicatas ÓBVIAS (Asana às vezes repete o texto inteiro no footer)
    // Só corta se a segunda metade é EXATAMENTE igual à primeira (duplicata real)
    if (commentText.length > 100) {
      const half = Math.floor(commentText.length / 2);
      const firstHalf = commentText.substring(0, half).trim();
      const secondHalf = commentText.substring(half).trim();
      // Só deduplica se >80% da primeira metade aparece na segunda (duplicata real, não coincidência)
      if (firstHalf.length > 50 && secondHalf.startsWith(firstHalf.substring(0, Math.min(firstHalf.length, 80)))) {
        commentText = firstHalf;
      }
    }
  }

  // Fallback: extrair do HTML se texto vazio
  if (!commentText && html) {
    const htmlClean = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const beforeLink = htmlClean.split('app.asana.com')[0] || htmlClean;
    commentText = beforeLink.substring(0, 500).trim();
  }

  // Extrair nome da task do subject
  // Formato antigo: "Gui Rocha te mencionou em [CLIENTE] Task Name"
  // Formato novo:   "👋 Gui mencionou você: [ROSSATO] TRAFEGO PAGO [Cabine_De_Comando]"
  //                 "💬 Novo comentário em: [MINNER] MARÇO"
  const taskMatch = subject.match(/(?:em|in|on|você|you)[:\s]+(.+)$/i);
  const taskName = taskMatch ? taskMatch[1].trim() : '';

  return { taskGid, commenterName, commentText, taskName, subject };
}

// ============================================
// GERAR RESPOSTA INTELIGENTE
// ============================================
async function generateMentionResponse(taskGid, commenterName, commentText, taskName) {
  // 1. Buscar TUDO da task — descrição completa + todos os comentários
  let taskDetails = null;
  let allComments = [];
  let recentComments = '';
  try {
    const taskData = await asanaRequest(`/tasks/${taskGid}?opt_fields=name,notes,assignee.name,due_on,completed,memberships.project.name,custom_fields.name,custom_fields.display_value`);
    taskDetails = taskData?.data || null;

    // TODOS os comentários via API — fonte CONFIÁVEL (email pode truncar)
    const stories = await asanaRequest(`/tasks/${taskGid}/stories?opt_fields=text,created_by.name,created_at,type&limit=50`);
    allComments = (stories?.data || [])
      .filter(s => s.type === 'comment' && s.text);

    recentComments = allComments
      .slice(-20) // últimos 20 comentários — contexto completo
      .map(s => `${s.created_by?.name || '?'}: ${s.text.substring(0, 500)}`)
      .join('\n');
  } catch (e) {
    console.error('[EMAIL] Erro ao buscar task:', e.message);
  }

  // 1.5. Usar o comentário REAL da API em vez do parseado do email
  // O email pode truncar/cortar o texto — a API tem o conteúdo completo
  let actualComment = commentText; // fallback: texto do email
  if (allComments.length > 0) {
    // Buscar o último comentário do commenterName (quem nos mencionou)
    const commenterLower = commenterName.toLowerCase();
    const matchingComments = allComments.filter(s => {
      const authorName = (s.created_by?.name || '').toLowerCase();
      return authorName.includes(commenterLower) || commenterLower.includes(authorName.split(' ')[0]);
    });
    if (matchingComments.length > 0) {
      // Pegar o ÚLTIMO comentário dessa pessoa — é o que gerou a notificação
      actualComment = matchingComments[matchingComments.length - 1].text;
      console.log(`[EMAIL] Comentário real da API (${actualComment.length} chars) substituiu parse do email (${commentText.length} chars)`);
    } else {
      // Se não achou por nome, pegar o último comentário geral (provavelmente é o que nos mencionou)
      actualComment = allComments[allComments.length - 1].text;
      console.log(`[EMAIL] Usando último comentário da task como referência (${actualComment.length} chars)`);
    }
  }

  // 2. Buscar memórias relevantes
  let memories = [];
  try {
    const searchTerms = [taskName, commenterName, actualComment.substring(0, 200)].filter(Boolean).join(' ');
    memories = await searchMemories(searchTerms, null, null, 8);
  } catch {}

  const memoryContext = memories.length > 0
    ? memories.map(m => `- [${m.category}] ${m.content}`).join('\n')
    : '';

  // 3. Montar contexto — descrição COMPLETA, custom fields, tudo
  const customFields = (taskDetails?.custom_fields || [])
    .filter(f => f.display_value)
    .map(f => `${f.name}: ${f.display_value}`)
    .join('\n');

  const taskContext = taskDetails ? [
    `Task: ${taskDetails.name}`,
    taskDetails.assignee?.name ? `Responsável: ${taskDetails.assignee.name}` : null,
    taskDetails.due_on ? `Prazo: ${taskDetails.due_on}` : null,
    `Status: ${taskDetails.completed ? 'Concluída' : 'Pendente'}`,
    taskDetails.memberships?.[0]?.project?.name ? `Projeto: ${taskDetails.memberships[0].project.name}` : null,
    customFields || null,
    taskDetails.notes ? `Descrição completa:\n${taskDetails.notes.substring(0, 2000)}` : 'Descrição: (vazia)',
  ].filter(Boolean).join('\n') : `Task: ${taskName || 'desconhecida'}`;

  // 4. Chamar Claude — Sonnet pra velocidade
  const model = CONFIG.AI_MODEL || 'claude-sonnet-4-20250514';
  const response = await anthropic.messages.create({
    model,
    max_tokens: 2048,
    system: `${JARVIS_IDENTITY}\n\n${CHANNEL_CONTEXT.asana}`,
    messages: [{
      role: 'user',
      content: `TASK NO ASANA:

${taskContext}

HISTÓRICO DE COMENTÁRIOS:
${recentComments || '(sem comentários anteriores)'}

COMENTÁRIO QUE TE MENCIONOU:
${commenterName}: ${actualComment}

${memoryContext ? `MEMÓRIAS RELEVANTES:\n${memoryContext}` : ''}

Responda ao comentário de forma direta e útil:`
    }],
  });

  const textBlock = response.content?.find(b => b.type === 'text');
  return textBlock?.text || '';
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

    // Baixar e parsear o email via fetch (download não funciona em alguns servidores IMAP)
    let parsed = null;
    for await (const msg of client.fetch(uid, { uid: true, source: true })) {
      parsed = await simpleParser(msg.source);
    }
    if (!parsed) return;

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
      socketTimeout: 30000,    // 30s timeout (default é muito curto)
      greetingTimeout: 15000,  // 15s para o greeting
    });

    await client.connect();
    emailMonitorState.connectionStatus = 'connected';

    const lock = await client.getMailboxLock('INBOX');
    try {
      // 1. Buscar UIDs dos emails não lidos (sem baixar corpo — rápido)
      const uids = [];
      for await (const msg of client.fetch({ seen: false }, { uid: true, envelope: true })) {
        uids.push(msg.uid);
        if (uids.length >= 10) break; // Limitar a 10 por poll
      }

      if (uids.length === 0) {
        emailMonitorState.lastCheck = new Date().toISOString();
        return;
      }

      console.log(`[EMAIL] ${uids.length} emails não lidos encontrados`);

      // 2. Processar cada email individualmente (download dentro do lock)
      for (const uid of uids) {
        try {
          await processEmail(client, { uid });
        } catch (err) {
          console.error(`[EMAIL] Erro no email ${uid}:`, err.message);
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
    emailMonitorState.lastCheck = new Date().toISOString();
    emailMonitorState.connectionStatus = 'idle';

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
