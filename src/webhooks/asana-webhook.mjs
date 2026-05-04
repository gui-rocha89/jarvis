// ============================================
// JARVIS 6.0 - Asana Webhook Handler
// Processa eventos em tempo real do Asana
// ============================================
import { CONFIG } from '../config.mjs';
import { asanaRequest, asanaWrite, getSendFunction } from '../skills/loader.mjs';
import { processMemory } from '../memory.mjs';

const JARVIS_ASANA_GID = '1213583219463912';

// ============================================
// PROCESSAR EVENTO DO WEBHOOK
// ============================================
export async function processAsanaWebhookEvent(event) {
  const { action, resource, user } = event;
  const taskGid = resource?.gid;

  // Ignorar eventos do próprio Jarvis (evita loops)
  if (user?.gid === JARVIS_ASANA_GID) return;

  // Só processar eventos de tasks
  if (resource?.resource_type !== 'task') return;

  switch (action) {
    case 'changed':
      await handleTaskChanged(taskGid, event);
      break;
    case 'added':
      await handleTaskAdded(taskGid, event);
      break;
    case 'deleted':
    case 'removed':
      console.log(`[WEBHOOK] Task ${taskGid} ${action}`);
      break;
  }
}

// ============================================
// TASK ALTERADA
// ============================================
async function handleTaskChanged(taskGid, event) {
  try {
    const task = await asanaRequest(
      `/tasks/${taskGid}?opt_fields=name,assignee.name,due_on,completed,completed_at,memberships.section.name,memberships.project.name`
    );
    if (!task) {
      console.log(`[WEBHOOK] Task ${taskGid} não encontrada (pode ter sido deletada)`);
      return;
    }

    console.log(`[WEBHOOK] Task alterada: "${task.name}" (${taskGid})`);

    // Detectar se foi movida para seção "Concluído"
    const concluido = task.memberships?.find(
      m => m.section?.name && /conclu[ií]d[oa]/i.test(m.section.name)
    );
    if (concluido) {
      const sendText = getSendFunction();
      if (sendText && CONFIG.GROUP_TAREFAS) {
        const assignee = task.assignee?.name || 'Sem responsável';
        const project = concluido.project?.name || '';
        await sendText(
          CONFIG.GROUP_TAREFAS,
          `✅ *Task concluída!*\n\n📋 ${task.name}\n👤 ${assignee}${project ? `\n📁 ${project}` : ''}`
        );
        console.log(`[WEBHOOK] Notificação enviada: task "${task.name}" concluída`);
      }
    }

    // Detectar mudança de due_date
    if (task.due_on) {
      console.log(`[WEBHOOK] Task "${task.name}" — due_on: ${task.due_on}`);
    }

    // Processar como memória (contexto de mudança)
    const memoryText = `Task "${task.name}" foi alterada no Asana. Responsável: ${task.assignee?.name || 'ninguém'}. Prazo: ${task.due_on || 'sem prazo'}.`;
    processMemory(memoryText, 'Asana Webhook', 'asana-webhook', 'asana', false).catch(() => {});
  } catch (err) {
    console.error(`[WEBHOOK] Erro ao processar mudança da task ${taskGid}:`, err.message);
  }
}

// ============================================
// TASK ADICIONADA
// ============================================
async function handleTaskAdded(taskGid, event) {
  try {
    const task = await asanaRequest(
      `/tasks/${taskGid}?opt_fields=name,assignee.name,due_on,memberships.project.name`
    );
    if (!task) {
      console.log(`[WEBHOOK] Task ${taskGid} adicionada mas não encontrada`);
      return;
    }

    console.log(`[WEBHOOK] Nova task: "${task.name}" (${taskGid})`);

    // Se não tem responsável, notificar grupo interno
    if (!task.assignee) {
      const sendText = getSendFunction();
      if (sendText && CONFIG.GROUP_TAREFAS) {
        const project = task.memberships?.[0]?.project?.name || '';
        await sendText(
          CONFIG.GROUP_TAREFAS,
          `📌 *Nova task sem responsável:*\n\n📋 ${task.name}${project ? `\n📁 ${project}` : ''}\n\nAtribuam alguém! 🎯`
        );
        console.log(`[WEBHOOK] Notificação enviada: task "${task.name}" sem responsável`);
      }
    }

    // Registrar como memória
    const memoryText = `Nova task criada no Asana: "${task.name}". Responsável: ${task.assignee?.name || 'ninguém'}. Prazo: ${task.due_on || 'sem prazo'}.`;
    processMemory(memoryText, 'Asana Webhook', 'asana-webhook', 'asana', false).catch(() => {});
  } catch (err) {
    console.error(`[WEBHOOK] Erro ao processar task adicionada ${taskGid}:`, err.message);
  }
}

// ============================================
// REGISTRAR WEBHOOKS NOS PROJETOS PÚBLICOS
// ============================================
export async function registerAsanaWebhooks(callbackUrl) {
  const { PUBLIC_ASANA_PROJECTS } = await import('../config.mjs');
  const projectGids = [...PUBLIC_ASANA_PROJECTS];
  const results = [];

  for (const projectGid of projectGids) {
    try {
      const resp = await asanaWrite('POST', '/webhooks', {
        resource: projectGid.trim(),
        target: callbackUrl,
      });
      if (resp.success) {
        console.log(`[WEBHOOK] Registrado para projeto ${projectGid}`);
        results.push({ project: projectGid, status: 'registered' });
      } else {
        console.log(`[WEBHOOK] Já registrado ou erro para ${projectGid}: ${resp.error}`);
        results.push({ project: projectGid, status: 'error', error: resp.error });
      }
    } catch (err) {
      console.log(`[WEBHOOK] Erro ao registrar ${projectGid}: ${err.message}`);
      results.push({ project: projectGid, status: 'error', error: err.message });
    }
  }

  return { registered: results.filter(r => r.status === 'registered').length, total: projectGids.length, details: results };
}
