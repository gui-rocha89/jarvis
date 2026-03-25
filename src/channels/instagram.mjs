// ============================================
// JARVIS 5.0 - Canal Instagram DM
// Recebe mensagens via webhook Meta Graph API
// Responde usando identidade + contexto instagram_dm
// ============================================
import { CONFIG } from '../config.mjs';
import { pool } from '../database.mjs';

const INSTAGRAM_API = `https://graph.instagram.com/${process.env.META_API_VERSION || 'v25.0'}`;

/**
 * Processa mensagem recebida via webhook do Instagram
 * Chamado pelo handler POST /webhooks/instagram em jarvis-v2.mjs
 */
export async function processInstagramMessage(event) {
  const senderId = event.sender?.id;
  const message = event.message;
  if (!senderId || !message?.text) return;

  const textPreview = message.text.substring(0, 60);
  console.log(`[INSTAGRAM] Mensagem de ${senderId}: ${textPreview}`);

  // Armazena mensagem no banco
  await storeInstagramMessage(senderId, message.text, 'received');

  // Gera resposta com brain + contexto instagram_dm
  const response = await generateInstagramResponse(senderId, message.text);
  if (!response) return;

  // Envia resposta
  await sendInstagramMessage(senderId, response);

  // Armazena resposta enviada
  await storeInstagramMessage(senderId, response, 'sent');
}

/**
 * Envia mensagem via Instagram Messaging API
 */
async function sendInstagramMessage(recipientId, text) {
  const url = `${INSTAGRAM_API}/me/messages`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
        access_token: process.env.META_ACCESS_TOKEN,
      }),
    });
    const data = await resp.json();
    if (data.error) {
      console.error('[INSTAGRAM] Erro ao enviar:', data.error.message);
    }
    return data;
  } catch (err) {
    console.error('[INSTAGRAM] Erro de rede ao enviar:', err.message);
    return null;
  }
}

/**
 * Gera resposta usando JARVIS_IDENTITY + CHANNEL_CONTEXT.instagram_dm
 * Importa dinamicamente para evitar dependências circulares
 */
async function generateInstagramResponse(senderId, text) {
  try {
    const { JARVIS_IDENTITY, CHANNEL_CONTEXT } = await import('../agents/master.mjs');
    const { getMemoryContext } = await import('../memory.mjs');
    const Anthropic = (await import('@anthropic-ai/sdk')).default;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });
    const chatId = `instagram_${senderId}`;

    // Buscar contexto de memória
    const memoryContext = await getMemoryContext(senderId, chatId, text);

    // Buscar histórico recente da conversa
    const history = await getInstagramHistory(senderId, 10);
    const historyText = history.length > 0
      ? '\n\nHISTÓRICO RECENTE:\n' + history.map(m =>
        `[${m.direction === 'sent' ? 'Jarvis' : 'Usuário'}]: ${m.text}`
      ).join('\n')
      : '';

    let response;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        response = await anthropic.messages.create({
          model: process.env.AI_MODEL || 'claude-sonnet-4-6-20250514',
          max_tokens: 500,
          system: `${JARVIS_IDENTITY}\n\n${CHANNEL_CONTEXT.instagram_dm}\n\n${memoryContext}${historyText}`,
          messages: [{ role: 'user', content: text }],
        });
        break;
      } catch (retryErr) {
        const status = retryErr?.status || 0;
        if ((status === 429 || status === 529) && attempt < 3) {
          await new Promise(r => setTimeout(r, 2000 * attempt));
          continue;
        }
        throw retryErr;
      }
    }

    return response.content[0]?.text || null;
  } catch (err) {
    console.error('[INSTAGRAM] Erro ao gerar resposta:', err.message);
    return null;
  }
}

/**
 * Armazena mensagem do Instagram no banco (jarvis_messages)
 */
async function storeInstagramMessage(senderId, text, direction = 'received') {
  try {
    const chatId = `instagram_${senderId}`;
    const messageId = `ig_${senderId}_${Date.now()}`;
    await pool.query(
      `INSERT INTO jarvis_messages (message_id, chat_id, sender, push_name, text, is_group, timestamp, created_at)
       VALUES ($1, $2, $3, $4, $5, false, $6, NOW())
       ON CONFLICT (message_id) DO NOTHING`,
      [messageId, chatId, direction === 'sent' ? 'jarvis@bot' : senderId, direction === 'sent' ? 'Jarvis' : `IG:${senderId}`, text, Math.floor(Date.now() / 1000)]
    );
  } catch (err) {
    console.error('[INSTAGRAM] Erro ao salvar mensagem:', err.message);
  }
}

/**
 * Busca histórico recente de mensagens do Instagram
 */
async function getInstagramHistory(senderId, limit = 10) {
  try {
    const chatId = `instagram_${senderId}`;
    const result = await pool.query(
      `SELECT text, sender, push_name, created_at
       FROM jarvis_messages
       WHERE chat_id = $1 AND text IS NOT NULL AND text != ''
       ORDER BY timestamp DESC LIMIT $2`,
      [chatId, limit]
    );
    return result.rows.reverse().map(row => ({
      text: row.text,
      direction: row.sender === 'jarvis@bot' ? 'sent' : 'received',
    }));
  } catch (err) {
    console.error('[INSTAGRAM] Erro ao buscar histórico:', err.message);
    return [];
  }
}
