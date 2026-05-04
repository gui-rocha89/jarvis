// ============================================
// HEALTH MONITORING & BOOT VALIDATION (v6.0)
// ============================================
// Resolve auditoria de robustez:
// - Boot validation de modelos (alerta se modelo deprecado)
// - Cron de health check (banco, redis, whatsapp)
// - Alerta WhatsApp em incidentes críticos
// - Cost tracking integrado
// ============================================

import { CONFIG } from './config.mjs';
import { logIncident, getRecentIncidents, markIncidentNotified } from './database.mjs';

// ============================================
// 1. BOOT VALIDATION DE MODELOS
// ============================================
// Roda no boot — testa cada modelo configurado e alerta se algum retornar 404
// IMPORTANTE: lê de process.env direto (não de CONFIG), porque o loadKeysFromDb pode ter
// sobrescrito process.env com valores do banco DEPOIS do CONFIG ter sido importado.
export async function validateModelsAtBoot() {
  const apiKey = process.env.ANTHROPIC_API_KEY || CONFIG.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    await logIncident({
      component: 'models',
      severity: 'critical',
      message: 'ANTHROPIC_API_KEY não configurada — Jarvis não vai funcionar',
    });
    return { success: false, errors: ['ANTHROPIC_API_KEY ausente'] };
  }

  const modelsToTest = [
    { name: 'AI_MODEL', value: process.env.AI_MODEL || CONFIG.AI_MODEL || 'claude-sonnet-4-6' },
    { name: 'AI_MODEL_STRONG', value: process.env.AI_MODEL_STRONG || CONFIG.AI_MODEL_STRONG || 'claude-opus-4-6' },
    { name: 'MEMORY_MODEL', value: process.env.MEMORY_MODEL || 'claude-sonnet-4-5' },
  ];

  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const anthropic = new Anthropic({ apiKey });

  const errors = [];
  const ok = [];

  for (const model of modelsToTest) {
    try {
      // Chamada de teste minúscula (1 token, custo ~$0.000003)
      await anthropic.messages.create({
        model: model.value,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'ok' }],
      });
      ok.push(`${model.name}=${model.value}`);
      console.log(`[HEALTH] ✅ Modelo ${model.name}=${model.value} OK`);
    } catch (err) {
      const msg = err.message || String(err);
      const isDeprecated = msg.includes('not_found_error') || msg.includes('404');
      const severity = isDeprecated ? 'critical' : 'error';
      errors.push(`${model.name}=${model.value}: ${msg.substring(0, 200)}`);
      console.error(`[HEALTH] ❌ Modelo ${model.name}=${model.value} FALHOU: ${msg.substring(0, 150)}`);
      await logIncident({
        component: 'models',
        severity,
        message: `Modelo ${model.name}=${model.value} ${isDeprecated ? 'DEPRECADO (404)' : 'falhou'}: ${msg.substring(0, 200)}`,
        details: { model_name: model.name, model_value: model.value, error: msg.substring(0, 500), deprecated: isDeprecated },
      });
    }
  }

  console.log(`[HEALTH] Boot validation: ${ok.length} OK, ${errors.length} erros`);
  return { success: errors.length === 0, ok, errors };
}

// ============================================
// 2. HEALTH CHECK ATIVO (cron periódico)
// ============================================
let lastHealthOK = Date.now();
let consecutiveFails = 0;

export async function runHealthCheck(notifyFn = null) {
  const checks = {
    db: { ok: false, latency: 0, error: null },
    whatsapp: { ok: false, error: null },
    memory_ram: { ok: true, used_mb: 0, max_mb: 0 },
  };

  // 1. PostgreSQL
  try {
    const start = Date.now();
    const { pool } = await import('./database.mjs');
    await pool.query('SELECT 1');
    checks.db.latency = Date.now() - start;
    checks.db.ok = true;
  } catch (err) {
    checks.db.error = err.message;
    await logIncident({ component: 'database', severity: 'critical', message: `PostgreSQL down: ${err.message}` });
  }

  // 2. WhatsApp socket (verifica via global)
  try {
    const sock = global.__jarvisSock;
    checks.whatsapp.ok = sock && sock.user && sock.ws?.readyState === 1;
    if (!checks.whatsapp.ok) {
      await logIncident({
        component: 'whatsapp',
        severity: sock ? 'warn' : 'error',
        message: sock ? 'WhatsApp socket existe mas não está conectado' : 'WhatsApp socket inexistente',
      });
    }
  } catch (err) {
    checks.whatsapp.error = err.message;
  }

  // 3. Memória RAM
  const mem = process.memoryUsage();
  checks.memory_ram.used_mb = Math.round(mem.rss / 1024 / 1024);
  checks.memory_ram.max_mb = Math.round((mem.heapTotal + mem.external) / 1024 / 1024);
  if (checks.memory_ram.used_mb > 1500) {
    await logIncident({
      component: 'memory',
      severity: 'warn',
      message: `RAM alta: ${checks.memory_ram.used_mb}MB`,
    });
  }

  const allOK = checks.db.ok && checks.whatsapp.ok;
  if (allOK) {
    consecutiveFails = 0;
    lastHealthOK = Date.now();
  } else {
    consecutiveFails++;
  }

  // Alerta crítico se 3 fails consecutivos (15 min sem responder)
  if (consecutiveFails === 3 && notifyFn) {
    try {
      await notifyFn(`⚠️ JARVIS HEALTH CRÍTICO\n\n` +
        `DB: ${checks.db.ok ? 'OK' : 'FALHOU'}\n` +
        `WhatsApp: ${checks.whatsapp.ok ? 'OK' : 'FALHOU'}\n` +
        `RAM: ${checks.memory_ram.used_mb}MB\n` +
        `Última saúde OK há ${Math.round((Date.now() - lastHealthOK) / 60000)}min`);
    } catch {}
  }

  return checks;
}

// ============================================
// 3. NOTIFICA INCIDENTES PENDENTES (cron)
// ============================================
// Pega incidentes critical/error não notificados das últimas 24h e envia 1 mensagem agregada
export async function notifyPendingIncidents(sendTextFn) {
  if (!sendTextFn || !CONFIG.GUI_JID) return;
  try {
    const incidents = await getRecentIncidents(24);
    const pending = incidents.filter(i => !i.notified && ['error', 'critical'].includes(i.severity));
    if (pending.length === 0) return;

    // Limita 1 alerta a cada 30min pra não floodar
    const lastNotifyKey = '__lastHealthNotify';
    const last = global[lastNotifyKey] || 0;
    if (Date.now() - last < 30 * 60 * 1000) return;
    global[lastNotifyKey] = Date.now();

    const grouped = {};
    for (const inc of pending) {
      grouped[inc.component] = grouped[inc.component] || [];
      grouped[inc.component].push(inc);
    }

    let msg = `⚠️ *JARVIS — ${pending.length} incidente(s) pendente(s)*\n`;
    for (const [comp, list] of Object.entries(grouped)) {
      msg += `\n*${comp.toUpperCase()}* (${list.length}):\n`;
      for (const inc of list.slice(0, 3)) {
        msg += `• [${inc.severity}] ${inc.message.substring(0, 150)}\n`;
      }
      if (list.length > 3) msg += `... +${list.length - 3} mais\n`;
    }

    await sendTextFn(CONFIG.GUI_JID, msg);
    // Marcar como notificados
    for (const inc of pending) await markIncidentNotified(inc.id);
  } catch (err) {
    console.error('[HEALTH] Erro ao notificar incidentes:', err.message);
  }
}

// ============================================
// 4. WRAPPER PARA CHAMADAS CLAUDE COM COST TRACKING
// ============================================
// Use em vez de anthropic.messages.create direto pra ter custos automáticos
export async function callClaudeWithTracking(anthropic, params, { cliente = null, canal = null, operation = null } = {}) {
  const { logApiCost } = await import('./database.mjs');
  const response = await anthropic.messages.create(params);
  // Loga custo em background (não bloqueia resposta)
  logApiCost({
    provider: 'anthropic',
    model: params.model,
    operation,
    tokensIn: response.usage?.input_tokens || 0,
    tokensOut: response.usage?.output_tokens || 0,
    cliente,
    canal,
  }).catch(() => {});
  return response;
}
