// ============================================
// JARVIS 6.0 - Canal Email (IMAP + SMTP)
// Monitora caixa de entrada genérica (leads/contato)
// Classifica, notifica equipe e auto-responde
// ============================================
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { CONFIG } from '../config.mjs';
import { pool } from '../database.mjs';

// Estado do monitor (exposto pro dashboard)
export const channelEmailState = {
  running: false,
  lastCheck: null,
  processed: 0,
  errors: 0,
  lastError: null,
};

let emailMonitorInterval = null;

/**
 * Carrega configurações de email do banco (jarvis_config) ou .env como fallback
 */
async function loadEmailConfig() {
  try {
    const { rows } = await pool.query("SELECT value FROM jarvis_config WHERE key = 'channel_settings'");
    const settings = rows[0]?.value?.email;
    if (settings && settings.imap_host && settings.user) {
      return {
        imap_host: settings.imap_host,
        imap_port: settings.imap_port || 993,
        smtp_host: settings.smtp_host || '',
        smtp_port: settings.smtp_port || 587,
        user: settings.user,
        password: settings.password || '',
        enabled: settings.enabled !== false,
      };
    }
  } catch (err) {
    console.log('[EMAIL-CHANNEL] Erro ao ler config do banco, usando .env:', err.message);
  }
  // Fallback para variáveis de ambiente
  return {
    imap_host: process.env.EMAIL_IMAP_HOST || '',
    imap_port: parseInt(process.env.EMAIL_IMAP_PORT) || 993,
    smtp_host: process.env.EMAIL_SMTP_HOST || '',
    smtp_port: parseInt(process.env.EMAIL_SMTP_PORT) || 587,
    user: process.env.EMAIL_USER || '',
    password: process.env.EMAIL_PASSWORD || '',
    enabled: true,
  };
}

/**
 * Inicia o monitor de email genérico (leads/contato)
 * Diferente do asana-email-monitor que só processa @menções do Asana
 */
export async function startChannelEmailMonitor() {
  const config = await loadEmailConfig();
  if (!config.imap_host || !config.user) {
    console.log('[EMAIL-CHANNEL] Não configurado — monitor desativado');
    return;
  }

  channelEmailState.running = true;
  console.log('[EMAIL-CHANNEL] Monitor iniciado');

  // Verificar a cada 5 minutos
  emailMonitorInterval = setInterval(checkEmails, 5 * 60 * 1000);
  checkEmails(); // Verificação inicial
}

/**
 * Para o monitor de email
 */
export function stopChannelEmailMonitor() {
  channelEmailState.running = false;
  if (emailMonitorInterval) {
    clearInterval(emailMonitorInterval);
    emailMonitorInterval = null;
  }
  console.log('[EMAIL-CHANNEL] Monitor parado');
}

/**
 * Verifica emails não lidos via IMAP
 */
async function checkEmails() {
  if (!channelEmailState.running) return;

  let client = null;
  try {
    const config = await loadEmailConfig();
    if (!config.imap_host || !config.user) return;

    client = new ImapFlow({
      host: config.imap_host,
      port: config.imap_port,
      secure: true,
      auth: {
        user: config.user,
        pass: config.password,
      },
      logger: false,
    });

    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      // Buscar emails não lidos
      const messages = client.fetch({ seen: false }, { source: true });

      for await (const msg of messages) {
        try {
          const mail = await simpleParser(msg.source);
          await processEmail(mail);

          // Marcar como lido
          await client.messageFlagsAdd(msg.seq, ['\\Seen']);
        } catch (err) {
          console.error('[EMAIL-CHANNEL] Erro ao processar email:', err.message);
          channelEmailState.errors++;
          channelEmailState.lastError = err.message;
        }
      }
    } finally {
      lock.release();
    }

    channelEmailState.lastCheck = new Date().toISOString();
    await client.logout();
  } catch (err) {
    console.error('[EMAIL-CHANNEL] Erro no monitor:', err.message);
    channelEmailState.errors++;
    channelEmailState.lastError = err.message;
    if (client) {
      try { await client.logout(); } catch {}
    }
  }
}

/**
 * Processa um email individual: classifica, armazena, age
 */
async function processEmail(mail) {
  const from = mail.from?.text || 'unknown';
  const subject = mail.subject || '(sem assunto)';
  const text = mail.text || mail.html?.replace(/<[^>]+>/g, '') || '';

  console.log(`[EMAIL-CHANNEL] De: ${from} | Assunto: ${subject}`);

  // Classificar email
  const classification = classifyEmail(from, subject, text);

  // Armazenar no banco
  await pool.query(
    `INSERT INTO email_log (from_address, subject, body_preview, classification, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [from, subject, text.substring(0, 500), classification]
  ).catch(err => {
    console.error('[EMAIL-CHANNEL] Erro ao salvar no banco:', err.message);
  });

  channelEmailState.processed++;

  // Agir com base na classificação
  if (classification === 'urgent') {
    // Notificar Gui + equipe via WhatsApp
    try {
      const { getSendFunction } = await import('../skills/loader.mjs');
      const sendText = getSendFunction();
      if (sendText) {
        const preview = text.substring(0, 300).replace(/\n/g, ' ');
        await sendText(CONFIG.GUI_JID, `*EMAIL URGENTE*\nDe: ${from}\nAssunto: ${subject}\n\n${preview}`);
      }
    } catch (err) {
      console.error('[EMAIL-CHANNEL] Erro ao notificar via WhatsApp:', err.message);
    }
  } else if (classification === 'normal') {
    // Auto-responder
    const replyTo = mail.from?.value?.[0]?.address;
    await sendAutoReply(replyTo, subject);
  }
  // newsletter/spam → ignora silenciosamente
}

/**
 * Classifica email em: urgent, normal, newsletter
 */
function classifyEmail(from, subject, text) {
  const lowerSubject = (subject || '').toLowerCase();
  const lowerText = (text || '').toLowerCase();

  // Detecção de spam/newsletter
  if (lowerSubject.includes('unsubscribe') || lowerSubject.includes('newsletter') ||
      lowerText.includes('unsubscribe') || from.includes('noreply') || from.includes('no-reply') ||
      from.includes('mailer-daemon') || from.includes('postmaster')) {
    return 'newsletter';
  }

  // Detecção de urgente
  if (lowerSubject.includes('urgent') || lowerSubject.includes('urgente') ||
      lowerSubject.includes('asap') || lowerSubject.includes('importante') ||
      lowerSubject.includes('critical') || lowerSubject.includes('emergencia') ||
      lowerSubject.includes('emergência')) {
    return 'urgent';
  }

  return 'normal';
}

/**
 * Envia auto-resposta via SMTP
 */
async function sendAutoReply(toAddress, originalSubject) {
  if (!toAddress) return;

  try {
    const config = await loadEmailConfig();
    if (!config.smtp_host || !config.user) return;

    const transporter = nodemailer.createTransport({
      host: config.smtp_host,
      port: config.smtp_port,
      secure: config.smtp_port === 465,
      auth: {
        user: config.user,
        pass: config.password,
      },
    });

    await transporter.sendMail({
      from: `"Stream Lab" <${config.user}>`,
      to: toAddress,
      subject: `Re: ${originalSubject}`,
      text: 'Recebemos seu email! Nossa equipe irá retornar em breve.\n\nStream Lab — Laboratório Criativo',
    });

    console.log(`[EMAIL-CHANNEL] Auto-resposta enviada para ${toAddress}`);
  } catch (err) {
    console.error('[EMAIL-CHANNEL] Erro ao enviar auto-resposta:', err.message);
  }
}

// Exportar classifyEmail para testes
export { classifyEmail };
