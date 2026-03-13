// ============================================
// JARVIS 3.0 - Skills Loader (Modular)
// Carrega e gerencia skills dinâmicamente
// ============================================
import { CONFIG, TEAM_ASANA, ASANA_PROJECTS, ASANA_SECTIONS, GCAL_KEY_PATH, GCAL_CALENDAR_ID, managedClients, saveManagedClients, teamWhatsApp } from '../config.mjs';
import { pool } from '../database.mjs';
import { readFile, readdir } from 'fs/promises';
import { createReadStream } from 'fs';
import { google } from 'googleapis';
import FormData from 'form-data';
import path from 'path';

// Callbacks para enviar mensagens (registrados pelo jarvis-v2.mjs após criar o socket)
let _sendTextFn = null;
let _sendTextWithMentionsFn = null;
const _groupMessageDedup = new Map(); // JID → timestamp da última mensagem (dedup 60s)
export function registerSendFunction(fn) { _sendTextFn = fn; }
export function registerSendWithMentionsFunction(fn) { _sendTextWithMentionsFn = fn; }
export function getSendFunction() { return _sendTextFn; }

// ============================================
// SKILL: ASANA
// ============================================
export async function asanaRequest(endpoint) {
  if (!CONFIG.ASANA_PAT) return null;
  try {
    const response = await fetch(`https://app.asana.com/api/1.0${endpoint}`, {
      headers: { Authorization: `Bearer ${CONFIG.ASANA_PAT}`, Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.data;
  } catch (err) {
    console.error('[ASANA] Erro:', err.message);
    return null;
  }
}

export async function asanaCreateTask(taskData) {
  if (!CONFIG.ASANA_PAT) return { error: 'Asana nao configurado' };
  try {
    const response = await fetch('https://app.asana.com/api/1.0/tasks', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CONFIG.ASANA_PAT}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ data: taskData }),
    });
    const result = await response.json();
    if (!response.ok) return { error: result.errors?.[0]?.message || 'Erro desconhecido' };
    console.log('[ASANA] Task criada:', result.data.gid, '-', result.data.name);
    return { success: true, gid: result.data.gid, name: result.data.name, url: `https://app.asana.com/0/${ASANA_PROJECTS.CAPTACAO}/${result.data.gid}` };
  } catch (err) {
    return { error: err.message };
  }
}

export async function asanaAddToProject(taskGid, projectGid, sectionGid) {
  try {
    const body = { data: { project: projectGid } };
    if (sectionGid) body.data.section = sectionGid;
    const response = await fetch(`https://app.asana.com/api/1.0/tasks/${taskGid}/addProject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CONFIG.ASANA_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.ok;
  } catch { return false; }
}

export async function asanaAddComment(taskGid, text) {
  try {
    const response = await fetch(`https://app.asana.com/api/1.0/tasks/${taskGid}/stories`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CONFIG.ASANA_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { text } }),
    });
    return response.ok;
  } catch { return false; }
}

export async function asanaUploadAttachment(taskGid, filePath, fileName) {
  try {
    const form = new FormData();
    form.append('parent', taskGid);
    form.append('file', createReadStream(filePath), { filename: fileName });

    const resp = await fetch('https://app.asana.com/api/1.0/attachments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.ASANA_PAT}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`Asana attachment upload failed: ${resp.status} ${errBody.substring(0, 200)}`);
    }
    const data = await resp.json();
    console.log(`[ASANA] Anexo uploaded: ${fileName} → task ${taskGid}`);
    return { success: true, gid: data.data.gid, name: data.data.name };
  } catch (err) {
    console.error('[ASANA] Erro upload attachment:', err.message);
    return { success: false, error: err.message };
  }
}

export async function getOverdueTasks() {
  const projects = await asanaRequest(`/projects?workspace=${CONFIG.ASANA_WORKSPACE}&opt_fields=name,archived&limit=100`);
  if (!projects) return [];
  const today = new Date().toISOString().split('T')[0];
  const overdue = [];
  const { PUBLIC_ASANA_PROJECTS } = await import('../config.mjs');
  for (const project of projects) {
    if (!PUBLIC_ASANA_PROJECTS.has(project.gid)) continue;
    if (project.archived) continue;
    const tasks = await asanaRequest(`/tasks?project=${project.gid}&opt_fields=name,due_on,completed,assignee.name&completed_since=now&limit=100`);
    if (!tasks) continue;
    for (const task of tasks) {
      if (!task.completed && task.due_on && task.due_on < today) {
        overdue.push({ name: task.name, due_on: task.due_on, assignee: task.assignee?.name || 'Sem responsavel', project: project.name });
      }
    }
  }
  return overdue;
}

// ============================================
// SKILL: GOOGLE CALENDAR
// ============================================
let gcalClient = null;

export async function getGCalClient() {
  if (gcalClient) return gcalClient;
  try {
    const keyData = JSON.parse(await readFile(GCAL_KEY_PATH, 'utf-8'));
    const auth = new google.auth.JWT({ email: keyData.client_email, key: keyData.private_key, scopes: ['https://www.googleapis.com/auth/calendar'] });
    gcalClient = google.calendar({ version: 'v3', auth });
    console.log('[GCAL] Cliente autenticado:', keyData.client_email);
    return gcalClient;
  } catch (err) {
    console.error('[GCAL] Erro ao criar cliente:', err.message);
    return null;
  }
}

export async function createGoogleCalendarEvent({ summary, date, time, location, description }) {
  const cal = await getGCalClient();
  if (!cal) return { success: false, error: 'Google Calendar nao configurado' };
  try {
    let start, end;
    if (time) {
      const startDT = `${date}T${time.padStart(5, '0')}:00-03:00`;
      const endH = parseInt(time.split(':')[0]) + 2;
      const endTime = `${String(endH).padStart(2, '0')}:${time.split(':')[1] || '00'}`;
      const endDT = `${date}T${endTime.padStart(5, '0')}:00-03:00`;
      start = { dateTime: startDT, timeZone: 'America/Sao_Paulo' };
      end = { dateTime: endDT, timeZone: 'America/Sao_Paulo' };
    } else {
      start = { date };
      end = { date };
    }
    const res = await cal.events.insert({
      calendarId: GCAL_CALENDAR_ID,
      resource: { summary: summary || 'Captacao', description: description || '', location: location || '', start, end },
    });
    console.log(`[GCAL] Evento criado: ${res.data.id} — ${summary} em ${date}`);
    return { success: true, eventId: res.data.id, htmlLink: res.data.htmlLink };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================
// TOOLS DO JARVIS (Claude tool_use)
// ============================================
export const JARVIS_TOOLS = [
  {
    name: 'agendar_captacao',
    description: 'Agendar uma captacao no Calendario de Captacao do Asana e Google Calendar.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome/titulo da captacao' },
        data: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
        horario: { type: 'string', description: 'Horario (ex: 13:00)' },
        local: { type: 'string', description: 'Local da captacao' },
        responsavel: { type: 'string', description: 'Primeiro nome do responsavel' },
        detalhes: { type: 'string', description: 'Detalhes adicionais' },
      },
      required: ['nome', 'data'],
    },
  },
  {
    name: 'consultar_tarefas',
    description: 'Consultar tarefas pendentes, atrasadas ou status de projetos no Asana.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['atrasadas', 'pendentes', 'todas'], description: 'Tipo de consulta' },
        projeto: { type: 'string', description: 'Nome do projeto (captacao, audiovisual, design, cabine)' },
        responsavel: { type: 'string', description: 'Nome do responsavel para filtrar' },
      },
      required: ['tipo'],
    },
  },
  {
    name: 'lembrar',
    description: 'Salvar uma informacao importante na memoria de longo prazo do Jarvis.',
    input_schema: {
      type: 'object',
      properties: {
        fato: { type: 'string', description: 'O fato ou informacao a ser lembrado' },
        categoria: { type: 'string', enum: ['client', 'preference', 'rule', 'deadline', 'decision'], description: 'Categoria da informacao' },
        importancia: { type: 'number', description: 'Importancia de 1 a 10' },
      },
      required: ['fato'],
    },
  },
  {
    name: 'criar_demanda_cliente',
    description: 'Criar uma nova demanda/task de cliente no projeto Cabine de Comando do Asana. Use quando identificar que um cliente mandou um pedido de trabalho novo.',
    input_schema: {
      type: 'object',
      properties: {
        nome_task: { type: 'string', description: 'Nome da task (ex: "Arte para post de lancamento")' },
        cliente: { type: 'string', description: 'Nome do cliente (ex: "Minner")' },
        detalhes: { type: 'string', description: 'Descricao completa da demanda (briefing, contexto)' },
        prazo: { type: 'string', description: 'Prazo em formato YYYY-MM-DD (se mencionado pelo cliente)' },
        responsavel: { type: 'string', description: 'Primeiro nome do responsavel (padrao: bruna)' },
      },
      required: ['nome_task', 'cliente', 'detalhes'],
    },
  },
  {
    name: 'enviar_mensagem_grupo',
    description: 'Enviar uma mensagem em um grupo do WhatsApp (interno ou de cliente autorizado). Para MARCAR pessoas no grupo, use o campo "mencoes" com os nomes — a menção real do WhatsApp será feita automaticamente (a pessoa recebe notificação).',
    input_schema: {
      type: 'object',
      properties: {
        grupo: { type: 'string', description: 'Nome do grupo: "tarefas", "galaxias", ou nome do cliente (ex: "minner")' },
        mensagem: { type: 'string', description: 'Texto da mensagem. Use @Nome no texto para marcar pessoas (ex: "@Douglas, tudo bem?")' },
        mencoes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lista de nomes de pessoas para marcar/mencionar na mensagem (ex: ["douglas", "bruna"]). A menção real do WhatsApp será resolvida automaticamente.',
        },
      },
      required: ['grupo', 'mensagem'],
    },
  },
  {
    name: 'autorizar_cliente',
    description: 'Ativar operacao autonoma do Jarvis em um grupo de cliente. Quando o Gui autorizar voce a operar/atuar/trabalhar em um grupo de cliente, use esta tool. SOMENTE funciona quando chamada pelo Gui.',
    input_schema: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nome do cliente ou grupo (ex: "minner", "acme")' },
        responsavel: { type: 'string', description: 'Primeiro nome do responsavel padrao para tasks (default: bruna)' },
      },
      required: ['cliente'],
    },
  },
  {
    name: 'revogar_cliente',
    description: 'Desativar operacao autonoma do Jarvis em um grupo de cliente. Quando o Gui pedir para parar de operar em um cliente, use esta tool.',
    input_schema: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nome do cliente ou grupo a desativar' },
      },
      required: ['cliente'],
    },
  },
  {
    name: 'anexar_midia_asana',
    description: 'Anexar arquivos de midia (imagens, videos, documentos) recebidos do WhatsApp a uma task do Asana. Use SEMPRE que o cliente enviar material (fotos, videos, PDFs) junto com uma demanda e voce criar a task. Os arquivos ja estao baixados — basta informar os message_ids.',
    input_schema: {
      type: 'object',
      properties: {
        task_gid: { type: 'string', description: 'GID da task no Asana onde anexar os arquivos' },
        message_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lista de message_ids do WhatsApp cujas midias devem ser anexadas (vem no contexto da mensagem como [msg_id: xxx])',
        },
      },
      required: ['task_gid', 'message_ids'],
    },
  },
];

export async function executeJarvisTool(toolName, input, context = {}) {
  console.log(`[TOOL] Executando: ${toolName}`, JSON.stringify(input));

  if (toolName === 'agendar_captacao') {
    const taskData = { name: input.nome, projects: [ASANA_PROJECTS.CAPTACAO], due_on: input.data };
    if (input.responsavel) {
      const asanaGid = TEAM_ASANA[input.responsavel.toLowerCase()];
      if (asanaGid) taskData.assignee = asanaGid;
    }
    const notes = [];
    if (input.horario) notes.push(`Horario: ${input.horario}`);
    if (input.local) notes.push(`Local: ${input.local}`);
    if (input.detalhes) notes.push(`Detalhes: ${input.detalhes}`);
    if (notes.length > 0) taskData.notes = notes.join('\n');

    const result = await asanaCreateTask(taskData);
    if (result.success) {
      await asanaAddToProject(result.gid, ASANA_PROJECTS.AUDIOVISUAL, ASANA_SECTIONS.AV_CAPTACAO);
      if (input.data) {
        const calResult = await createGoogleCalendarEvent({
          summary: input.nome, date: input.data, time: input.horario || null,
          location: input.local || null, description: notes.join('\n') + (result.url ? `\n\nAsana: ${result.url}` : ''),
        });
        if (calResult.success) {
          result.calendar_event = calResult.eventId;
          await pool.query('INSERT INTO gcal_sync (asana_gid, gcal_event_id, task_name, event_date) VALUES ($1, $2, $3, $4) ON CONFLICT (asana_gid) DO NOTHING', [result.gid, calResult.eventId, input.nome, input.data]).catch(() => {});
        }
      }
    }
    return result;
  }

  if (toolName === 'consultar_tarefas') {
    const overdue = await getOverdueTasks();
    if (input.tipo === 'atrasadas') {
      return { tasks: overdue, count: overdue.length };
    }
    // Para outros tipos, buscar do Asana
    const projectMap = { captacao: ASANA_PROJECTS.CAPTACAO, audiovisual: ASANA_PROJECTS.AUDIOVISUAL, design: ASANA_PROJECTS.DESIGN, cabine: ASANA_PROJECTS.CABINE };
    const projectGid = projectMap[input.projeto?.toLowerCase()] || ASANA_PROJECTS.CAPTACAO;
    const tasks = await asanaRequest(`/tasks?project=${projectGid}&opt_fields=name,due_on,completed,assignee.name&completed_since=now&limit=50`);
    return { tasks: (tasks || []).filter(t => !t.completed).map(t => ({ name: t.name, due_on: t.due_on, assignee: t.assignee?.name })), count: tasks?.length || 0 };
  }

  if (toolName === 'lembrar') {
    const { storeFacts } = await import('../memory.mjs');
    await storeFacts([{ content: input.fato, category: input.categoria || 'general', importance: input.importancia || 7 }], 'agent', null);
    return { success: true, message: 'Informacao armazenada na memoria' };
  }

  if (toolName === 'criar_demanda_cliente') {
    const clienteName = input.cliente || 'Cliente';
    const taskName = `[${clienteName}] ${input.nome_task}`;
    const assigneeGid = TEAM_ASANA[(input.responsavel || 'bruna').toLowerCase()];
    const cabineGid = ASANA_PROJECTS.CABINE;
    if (!cabineGid) return { error: 'Projeto Cabine de Comando nao configurado' };

    const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const taskData = {
      name: taskName,
      projects: [cabineGid],
      notes: `Demanda recebida via WhatsApp em ${now}\n\n${input.detalhes}`,
    };
    if (assigneeGid) taskData.assignee = assigneeGid;
    if (input.prazo) taskData.due_on = input.prazo;

    const result = await asanaCreateTask(taskData);
    if (result.success) {
      result.url = `https://app.asana.com/0/${cabineGid}/${result.gid}`;
      result.cliente = clienteName;
      result.responsavel = input.responsavel || 'bruna';
      console.log(`[PROACTIVE] Task criada: ${taskName} → ${result.url}`);
    }
    return result;
  }

  if (toolName === 'enviar_mensagem_grupo') {
    if (!_sendTextFn) return { error: 'WhatsApp nao conectado — aguarde a reconexao' };
    const grupoLower = (input.grupo || '').toLowerCase();
    let targetJid = null;

    // 1. Resolver nomes fixos
    if (grupoLower === 'tarefas') targetJid = CONFIG.GROUP_TAREFAS;
    else if (grupoLower === 'galaxias') targetJid = CONFIG.GROUP_GALAXIAS;

    // 2. Buscar nos clientes gerenciados
    if (!targetJid) {
      for (const [jid, client] of managedClients) {
        if (client.groupName?.toLowerCase().includes(grupoLower) || client.slug?.includes(grupoLower)) {
          targetJid = jid;
          break;
        }
      }
    }

    // 3. Fallback: buscar na tabela jarvis_groups (todos os grupos conhecidos)
    if (!targetJid) {
      try {
        const { rows } = await pool.query(
          `SELECT jid, name FROM jarvis_groups WHERE LOWER(name) LIKE $1 LIMIT 1`,
          [`%${grupoLower}%`]
        );
        if (rows.length > 0) targetJid = rows[0].jid;
      } catch {}
    }

    if (!targetJid) return { error: `Grupo "${input.grupo}" nao encontrado` };

    // SALVAGUARDA 1: Anti-vazamento — bloquear conteúdo interno em grupos de clientes
    const isClientGroup = managedClients.has(targetJid);
    if (isClientGroup) {
      const msgLower = (input.mensagem || '').toLowerCase();
      const internalPatterns = [
        /\basana\b/i, /\btask\s?(criada|criado|criou)\b/i, /\bcabine\s?de\s?comando\b/i,
        /tudo\s?executado/i, /resumo\s?do\s?que\s?(foi\s?)feito/i, /✅\s*(task|tarefa|mensagem|bruna|equipe)/i,
        /avise[i]?\s?(a\s?)?(bruna|equipe|gui)/i, /grupo\s?de\s?tarefas/i,
        /internamente/i, /processo\s?interno/i, /ferramenta/i,
      ];
      const leaked = internalPatterns.some(p => p.test(input.mensagem));
      if (leaked) {
        console.warn(`[TOOL] ⚠️ BLOQUEADO: mensagem com conteúdo interno para grupo de cliente ${input.grupo}`);
        console.warn(`[TOOL] Mensagem bloqueada: ${input.mensagem.substring(0, 120)}`);
        return { error: 'BLOQUEADO: essa mensagem contém informações internas da agência. Nunca envie detalhes sobre Asana, tasks, ferramentas ou processos internos para o grupo do cliente. Reformule a mensagem com tom 100% profissional.' };
      }
    }

    // SALVAGUARDA 2: Dedup — máximo 1 mensagem por grupo a cada 60s
    const lastSent = _groupMessageDedup.get(targetJid);
    const now = Date.now();
    if (lastSent && now - lastSent < 60000) {
      console.warn(`[TOOL] ⚠️ DEDUP: mensagem duplicada bloqueada para ${input.grupo} (${Math.round((now - lastSent) / 1000)}s desde a última)`);
      return { error: `Você já enviou uma mensagem para "${input.grupo}" há ${Math.round((now - lastSent) / 1000)}s atrás. Aguarde pelo menos 60s entre mensagens para o mesmo grupo. NÃO envie novamente.` };
    }
    _groupMessageDedup.set(targetJid, now);

    // Resolver menções (nomes → JIDs reais do WhatsApp)
    const mentionJids = [];
    if (input.mencoes && Array.isArray(input.mencoes) && input.mencoes.length > 0 && _sendTextWithMentionsFn) {
      for (const nome of input.mencoes) {
        const nomeLower = nome.toLowerCase().trim();
        // 1. Buscar no map teamWhatsApp (equipe já mapeada)
        const jidFromTeam = teamWhatsApp.get(nomeLower);
        if (jidFromTeam) {
          mentionJids.push(jidFromTeam);
          continue;
        }
        // 2. Buscar na tabela jarvis_contacts por push_name
        try {
          const { rows } = await pool.query(
            `SELECT jid FROM jarvis_contacts WHERE LOWER(push_name) LIKE $1 AND jid LIKE '%@s.whatsapp.net' LIMIT 1`,
            [`%${nomeLower}%`]
          );
          if (rows.length > 0) {
            mentionJids.push(rows[0].jid);
          }
        } catch {}
      }
    }

    // Enviar com ou sem menções reais
    if (mentionJids.length > 0 && _sendTextWithMentionsFn) {
      const mentions = mentionJids.map(jid => ({ jid }));
      await _sendTextWithMentionsFn(targetJid, input.mensagem, mentions);
      console.log(`[TOOL] Mensagem enviada para ${input.grupo} com ${mentionJids.length} menções: ${input.mensagem.substring(0, 60)}...`);
    } else {
      await _sendTextFn(targetJid, input.mensagem);
      console.log(`[TOOL] Mensagem enviada para ${input.grupo}: ${input.mensagem.substring(0, 60)}...`);
    }
    return { success: true, grupo: input.grupo, mencoes_resolvidas: mentionJids.length };
  }

  if (toolName === 'autorizar_cliente') {
    // Somente o Gui pode autorizar
    const senderJid = context.senderJid || '';
    if (senderJid !== CONFIG.GUI_JID) {
      return { error: 'Somente o Gui pode autorizar clientes' };
    }

    const clienteName = (input.cliente || '').trim();
    if (!clienteName) return { error: 'Nome do cliente nao informado' };

    try {
      const { rows } = await pool.query(
        `SELECT jid, name FROM jarvis_groups WHERE LOWER(name) LIKE $1 LIMIT 1`,
        [`%${clienteName.toLowerCase()}%`]
      );

      if (rows.length === 0) {
        return { error: `Grupo "${clienteName}" nao encontrado. Verifique o nome exato do grupo no WhatsApp.` };
      }

      const groupJid = rows[0].jid;
      const groupName = rows[0].name;

      managedClients.set(groupJid, {
        groupName,
        active: true,
        defaultAssignee: (input.responsavel || 'bruna').toLowerCase(),
        authorizedAt: new Date().toISOString(),
      });
      await saveManagedClients(pool);

      console.log(`[PROACTIVE] Cliente autorizado via tool: ${groupName} (${groupJid})`);
      return { success: true, groupName, groupJid, message: `Operacao ativada no grupo ${groupName}` };
    } catch (err) {
      return { error: `Erro ao autorizar: ${err.message}` };
    }
  }

  if (toolName === 'revogar_cliente') {
    const senderJid = context.senderJid || '';
    if (senderJid !== CONFIG.GUI_JID) {
      return { error: 'Somente o Gui pode revogar clientes' };
    }

    const clienteName = (input.cliente || '').toLowerCase().trim();
    let revoked = false;

    for (const [jid, client] of managedClients) {
      if (client.groupName?.toLowerCase().includes(clienteName) || client.slug?.includes(clienteName)) {
        client.active = false;
        await saveManagedClients(pool);
        console.log(`[PROACTIVE] Cliente revogado via tool: ${client.groupName}`);
        return { success: true, groupName: client.groupName, message: `Operacao desativada no grupo ${client.groupName}` };
      }
    }

    return { error: `Cliente "${input.cliente}" nao encontrado nos gerenciados` };
  }

  if (toolName === 'anexar_midia_asana') {
    const taskGid = input.task_gid;
    const messageIds = input.message_ids || [];
    if (!taskGid) return { error: 'task_gid é obrigatório' };
    if (messageIds.length === 0) return { error: 'Nenhum message_id informado' };

    const results = [];
    const mediaBaseDir = path.join(process.cwd(), 'media_files');

    for (const msgId of messageIds) {
      // Buscar arquivo em todos os subdiretórios de media_files/
      let found = false;
      try {
        const subdirs = await readdir(mediaBaseDir).catch(() => []);
        for (const subdir of subdirs) {
          const dirPath = path.join(mediaBaseDir, subdir);
          const files = await readdir(dirPath).catch(() => []);
          const match = files.find(f => f.startsWith(msgId));
          if (match) {
            const filePath = path.join(dirPath, match);
            const uploadResult = await asanaUploadAttachment(taskGid, filePath, match);
            results.push({ messageId: msgId, fileName: match, ...uploadResult });
            found = true;
            break;
          }
        }
      } catch {}
      if (!found) {
        results.push({ messageId: msgId, success: false, error: 'Arquivo não encontrado em media_files/' });
      }
    }

    const successCount = results.filter(r => r.success).length;
    console.log(`[TOOL] Anexos uploaded: ${successCount}/${messageIds.length} para task ${taskGid}`);
    return { success: successCount > 0, total: messageIds.length, uploaded: successCount, results };
  }

  return { error: 'Ferramenta desconhecida' };
}
