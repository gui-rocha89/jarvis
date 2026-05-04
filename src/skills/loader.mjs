// ============================================
// JARVIS 3.0 - Skills Loader (Modular)
// Carrega e gerencia skills dinâmicamente
// ============================================
import { CONFIG, TEAM_ASANA, ASANA_PROJECTS, ASANA_SECTIONS, ASANA_CUSTOM_FIELDS, ASANA_CLIENTE_MAP, ASANA_URGENCIA_MAP, ASANA_TIER_MAP, ASANA_TIPO_DEMANDA_MAP, GCAL_KEY_PATH, GCAL_CALENDAR_ID, managedClients, saveManagedClients, teamWhatsApp, JARVIS_ALLOWED_GROUPS } from '../config.mjs';
import { listCampaigns, getCampaignInsights, createCampaign, updateCampaignStatus, getAccountInsights, publishPagePost, getPagePosts, resolvePageId, resolveWhatsAppNumber, listAvailablePages, listAllAccessiblePages, createAdSet, listAdSets, uploadAdImage, createAdCreative, createAd, updateEntityStatus, asanaGetAttachments, pipelineAsanaToAds, searchGeoLocation } from './meta-ads.mjs';
import { pool } from '../database.mjs';
import { searchMemories } from '../memory.mjs';
import OpenAI from 'openai';
import sharp from 'sharp';
import { readFile, readdir, stat } from 'fs/promises';
import { readFileSync } from 'fs';
import { google } from 'googleapis';
import path from 'path';

// Callbacks para enviar mensagens (registrados pelo jarvis-v2.mjs após criar o socket)
let _sendTextFn = null;
let _sendTextWithMentionsFn = null;
let _sendRawFn = null; // sock.sendMessage raw — para imagens, stickers, áudio
const _groupMessageDedup = new Map(); // JID → timestamp da última mensagem (dedup 60s)
export function registerSendFunction(fn) { _sendTextFn = fn; }
export function registerSendWithMentionsFunction(fn) { _sendTextWithMentionsFn = fn; }
export function registerSendRawFunction(fn) { _sendRawFn = fn; }
export function getSendFunction() { return _sendTextFn; }
export function getSendWithMentionsFunction() { return _sendTextWithMentionsFn; }
export function getSendRawFunction() { return _sendRawFn; }

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
    const projectGid = taskData.projects?.[0] || ASANA_PROJECTS.CAPTACAO;
    console.log('[ASANA] Task criada:', result.data.gid, '-', result.data.name);
    return { success: true, gid: result.data.gid, name: result.data.name, url: `https://app.asana.com/0/${projectGid}/${result.data.gid}` };
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
    // Usa FormData nativo do Node 20 (compatível com fetch nativo)
    const fileBuffer = readFileSync(filePath);
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', pdf: 'application/pdf' };
    const ext = fileName.split('.').pop().toLowerCase();
    const mime = mimeMap[ext] || 'application/octet-stream';

    const blob = new Blob([fileBuffer], { type: mime });
    const form = new FormData();
    form.append('parent', taskGid);
    form.append('file', blob, fileName);

    const resp = await fetch('https://app.asana.com/api/1.0/attachments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.ASANA_PAT}`,
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

// PUT/POST genérico para Asana (criar, atualizar, comentar)
export async function asanaWrite(method, endpoint, body = null) {
  if (!CONFIG.ASANA_PAT) return { error: 'Asana não configurado' };
  try {
    const options = {
      method,
      headers: { Authorization: `Bearer ${CONFIG.ASANA_PAT}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    };
    if (body) options.body = JSON.stringify({ data: body });
    const response = await fetch(`https://app.asana.com/api/1.0${endpoint}`, options);
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { error: err.errors?.[0]?.message || `HTTP ${response.status}` };
    }
    const data = await response.json();
    return { success: true, data: data.data };
  } catch (err) {
    return { error: err.message };
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
        overdue.push({ gid: task.gid, name: task.name, due_on: task.due_on, assignee: task.assignee?.name || 'Sem responsavel', project: project.name, projectGid: project.gid });
      }
    }
  }
  return overdue;
}

/**
 * Resumo completo de tasks: atrasadas, vencendo hoje, vencendo amanhã, concluídas ontem.
 */
export async function getTasksSummary() {
  const projects = await asanaRequest(`/projects?workspace=${CONFIG.ASANA_WORKSPACE}&opt_fields=name,archived&limit=100`);
  if (!projects) return { atrasadas: [], vencendo_hoje: [], vencendo_amanha: [], concluidas_ontem: [] };

  const now = new Date();
  const brDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const today = brDate.toISOString().split('T')[0];
  const tomorrow = new Date(brDate);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];
  const yesterday = new Date(brDate);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  const result = { atrasadas: [], vencendo_hoje: [], vencendo_amanha: [], concluidas_ontem: [] };
  const { PUBLIC_ASANA_PROJECTS } = await import('../config.mjs');

  for (const project of projects) {
    if (!PUBLIC_ASANA_PROJECTS.has(project.gid)) continue;
    if (project.archived) continue;

    // Tasks não concluídas
    const tasks = await asanaRequest(`/tasks?project=${project.gid}&opt_fields=name,due_on,completed,completed_at,assignee.name&completed_since=now&limit=100`);
    if (tasks) {
      for (const t of tasks) {
        if (t.completed) continue;
        const item = { gid: t.gid, name: t.name, due_on: t.due_on, assignee: t.assignee?.name || 'Sem responsável', project: project.name, projectGid: project.gid };
        if (t.due_on && t.due_on < today) result.atrasadas.push(item);
        else if (t.due_on === today) result.vencendo_hoje.push(item);
        else if (t.due_on === tomorrowStr) result.vencendo_amanha.push(item);
      }
    }

    // Tasks concluídas ontem
    const completed = await asanaRequest(`/tasks?project=${project.gid}&opt_fields=name,completed_at,assignee.name&completed_since=${yesterdayStr}T00:00:00Z&limit=50`);
    if (completed) {
      for (const t of completed) {
        if (t.completed_at && t.completed_at.startsWith(yesterdayStr)) {
          result.concluidas_ontem.push({ gid: t.gid, name: t.name, assignee: t.assignee?.name || 'Sem responsável', project: project.name });
        }
      }
    }
  }
  return result;
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
// RESOLVER CUSTOM FIELDS DO ASANA (Cabine de Comando)
// ============================================

/**
 * Resolve os custom fields da Cabine de Comando a partir dos nomes amigáveis.
 * Retorna objeto { "field_gid": "option_gid" } pronto para a API do Asana.
 */
function resolveCustomFields({ cliente, urgencia, tier, tipo_demanda }) {
  const fields = {};

  // Cliente (multi_enum — aceita array de GIDs)
  if (cliente && ASANA_CUSTOM_FIELDS.CLIENTE_FIELD) {
    const clienteLower = cliente.toLowerCase().trim();
    // Buscar por match parcial (ex: "minner" encontra "minner")
    let clienteGid = null;
    for (const [key, gid] of Object.entries(ASANA_CLIENTE_MAP)) {
      if (clienteLower.includes(key) || key.includes(clienteLower)) {
        clienteGid = gid;
        break;
      }
    }
    if (clienteGid) {
      fields[ASANA_CUSTOM_FIELDS.CLIENTE_FIELD] = [clienteGid]; // multi_enum = array
    }
  }

  // Urgência (enum)
  if (urgencia && ASANA_CUSTOM_FIELDS.URGENCIA_FIELD) {
    const urgLower = urgencia.toLowerCase().trim();
    const urgMap = {
      '24h': ASANA_URGENCIA_MAP['24h'], '24': ASANA_URGENCIA_MAP['24h'],
      '48h': ASANA_URGENCIA_MAP['48h'], '48': ASANA_URGENCIA_MAP['48h'],
      '72h': ASANA_URGENCIA_MAP['72h'], '72': ASANA_URGENCIA_MAP['72h'],
      'negociavel': ASANA_URGENCIA_MAP['negociavel'], 'negociável': ASANA_URGENCIA_MAP['negociavel'],
    };
    const urgGid = urgMap[urgLower] || ASANA_URGENCIA_MAP['negociavel'];
    if (urgGid) fields[ASANA_CUSTOM_FIELDS.URGENCIA_FIELD] = urgGid;
  }

  // Tier (enum)
  if (tier && ASANA_CUSTOM_FIELDS.TIER_FIELD) {
    const tierLower = tier.toLowerCase().trim();
    const tierGid = ASANA_TIER_MAP[tierLower];
    if (tierGid) fields[ASANA_CUSTOM_FIELDS.TIER_FIELD] = tierGid;
  }

  // Tipo de demanda (enum)
  if (tipo_demanda && ASANA_CUSTOM_FIELDS.TIPO_DEMANDA_FIELD) {
    const tipoLower = tipo_demanda.toLowerCase().trim().replace(/\s+/g, '_').replace('ã', 'a').replace('ç', 'c');
    let tipoGid = ASANA_TIPO_DEMANDA_MAP[tipoLower];
    // Fallback: busca parcial
    if (!tipoGid) {
      for (const [key, gid] of Object.entries(ASANA_TIPO_DEMANDA_MAP)) {
        if (tipoLower.includes(key) || key.includes(tipoLower)) {
          tipoGid = gid;
          break;
        }
      }
    }
    if (tipoGid) fields[ASANA_CUSTOM_FIELDS.TIPO_DEMANDA_FIELD] = tipoGid;
  }

  return Object.keys(fields).length > 0 ? fields : null;
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
    name: 'buscar_mensagens',
    description: 'Busca mensagens reais do WhatsApp no banco de dados. Usa para encontrar links, arquivos, aprovações ou qualquer conteúdo enviado nos grupos. Busca por palavras-chave nas mensagens dos últimos N dias.',
    input_schema: {
      type: 'object',
      properties: {
        palavras_chave: { type: 'array', items: { type: 'string' }, description: 'Palavras-chave para buscar (ex: ["roteiro", "aprovado", "Lívia"])' },
        horas: { type: 'number', description: 'Buscar nas últimas N horas (default: 72, máximo: 720 = 30 dias)' },
        grupo: { type: 'string', description: 'Nome do grupo para filtrar (opcional). Se não informar, busca em todos.' },
        limite: { type: 'number', description: 'Máximo de mensagens a retornar (default: 20, máximo: 50)' },
      },
      required: ['palavras_chave'],
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
    description: 'Criar uma nova demanda/task de cliente no projeto Cabine de Comando do Asana. Use quando identificar que um cliente mandou um pedido de trabalho novo. OBRIGATÓRIO preencher urgencia e tipo_demanda em TODA task.',
    input_schema: {
      type: 'object',
      properties: {
        nome_task: { type: 'string', description: 'Nome da task (ex: "Arte para post de lancamento")' },
        cliente: { type: 'string', description: 'Nome do cliente (ex: "Minner", "Pippi", "Digal", "Callegaro")' },
        detalhes: { type: 'string', description: 'Descricao completa da demanda (briefing, contexto)' },
        prazo: { type: 'string', description: 'Prazo em formato YYYY-MM-DD (se mencionado pelo cliente)' },
        responsavel: { type: 'string', description: 'Primeiro nome do responsavel (padrao: bruna)' },
        urgencia: {
          type: 'string',
          enum: ['24h', '48h', '72h', 'negociavel'],
          description: 'Nivel de urgencia: "24h", "48h", "72h" ou "negociavel" (padrao: negociavel). Se o cliente nao especificou prazo, use "negociavel".',
        },
        tipo_demanda: {
          type: 'string',
          enum: ['design', 'audiovisual', 'endomarketing', 'marketing', 'reuniao', 'planejamento', 'demanda_extra', 'captacao'],
          description: 'Tipo da demanda: "design" (artes, posts), "audiovisual" (videos, reels), "marketing" (estrategia), "planejamento" (planner), "reuniao", "captacao" (fotos/filmagem), "endomarketing", "demanda_extra" (outros)',
        },
        tier: {
          type: 'string',
          enum: ['s', 'a', 'b', 'c', 'm'],
          description: 'Tier do cliente (s=premium, a=alto, b=medio, c=baixo, m=micro). Use apenas se souber o tier do cliente.',
        },
      },
      required: ['nome_task', 'cliente', 'detalhes', 'urgencia', 'tipo_demanda'],
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
    description: 'Anexar TODOS os arquivos de midia recentes (imagens, videos, documentos) recebidos do WhatsApp a uma task do Asana. Basta informar o task_gid — a tool automaticamente encontra e envia todos os arquivos recentes.',
    input_schema: {
      type: 'object',
      properties: {
        task_gid: { type: 'string', description: 'GID da task no Asana onde anexar os arquivos' },
        chat_id: {
          type: 'string',
          description: 'Numero do WhatsApp do remetente (ex: 555599154868). Se informado, filtra arquivos somente desse chat. Se omitido, pega de todos os chats.',
        },
      },
      required: ['task_gid'],
    },
  },
  // ============================================
  // NOVAS TOOLS — Gestão de Projetos (estilo Camile)
  // ============================================
  {
    name: 'consultar_task',
    description: 'Consultar uma task ESPECIFICA do Asana pelo GID. Retorna nome, responsavel, prazo, secao, custom fields e ultimos comentarios. USE SEMPRE antes de responder sobre status de uma task. NUNCA invente dados — consulte primeiro.',
    input_schema: {
      type: 'object',
      properties: {
        task_gid: { type: 'string', description: 'GID da task no Asana (ex: 1213645436753789)' },
        incluir_comentarios: { type: 'boolean', description: 'Se true, inclui os ultimos 10 comentarios da task (default: true)' },
      },
      required: ['task_gid'],
    },
  },
  {
    name: 'comentar_task',
    description: 'Adicionar um comentario em uma task do Asana. Use para registrar informacoes, cobrar responsaveis, ou dar atualizacoes. IMPORTANTE: quando usar "mencionar", NAO repita o nome da pessoa no inicio do texto — a menção já aparece automaticamente como @NomePessoa. Exemplo CORRETO: mencionar="gui", texto="essa task está atrasada". Exemplo ERRADO: mencionar="gui", texto="Gui, essa task está atrasada" (nome apareceria duplicado).',
    input_schema: {
      type: 'object',
      properties: {
        task_gid: { type: 'string', description: 'GID da task no Asana' },
        texto: { type: 'string', description: 'Texto do comentario. NAO comece com o nome da pessoa se usar "mencionar" — a menção já inclui o nome automaticamente.' },
        mencionar: { type: 'string', description: 'Nome da pessoa para mencionar (ex: "gui", "bruna"). A menção aparece como @NomePessoa antes do texto automaticamente — NAO repita o nome no texto.' },
      },
      required: ['task_gid', 'texto'],
    },
  },
  {
    name: 'atualizar_task',
    description: 'Atualizar campos de uma task existente no Asana: responsavel, prazo, ou marcar como concluida. NUNCA altera a descricao (notes) da task — use comentar_task pra isso.',
    input_schema: {
      type: 'object',
      properties: {
        task_gid: { type: 'string', description: 'GID da task no Asana' },
        responsavel: { type: 'string', description: 'Nome do novo responsavel (ex: "bruno", "bruna", "nicolas")' },
        prazo: { type: 'string', description: 'Novo prazo em formato YYYY-MM-DD' },
        concluir: { type: 'boolean', description: 'Se true, marca a task como concluida' },
      },
      required: ['task_gid'],
    },
  },
  {
    name: 'buscar_memorias',
    description: 'Buscar na memoria de longo prazo do Jarvis. Use para consultar o que voce ja sabe sobre um cliente, pessoa, processo ou regra ANTES de responder. Evita inventar informacao.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'O que buscar (ex: "preferencias do cliente Minner", "regras do Asana", "estilo do Bruno")' },
        escopo: { type: 'string', enum: ['user', 'chat', 'agent'], description: 'Escopo da busca: "user" (pessoa), "chat" (grupo/conversa), "agent" (conhecimento geral do Jarvis). Default: todos.' },
        limite: { type: 'number', description: 'Maximo de resultados (default: 10)' },
      },
      required: ['query'],
    },
  },
  // ============================================
  // TOOLS — Tráfego Pago (Meta Ads)
  // ============================================
  {
    name: 'criar_campanha',
    description: 'Criar uma campanha de anúncios no Meta Ads (Facebook/Instagram). A campanha é SEMPRE criada como PAUSADA por segurança — o Gui ativa manualmente.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome da campanha (ex: "[ROSSATO] Tráfego Usados MT")' },
        objetivo: { type: 'string', enum: ['trafego', 'leads', 'engajamento', 'vendas', 'alcance'], description: 'Objetivo da campanha' },
        orcamento_diario: { type: 'number', description: 'Orçamento diário em reais (ex: 50 = R$50/dia)' },
      },
      required: ['nome', 'objetivo', 'orcamento_diario'],
    },
  },
  {
    name: 'listar_paginas_ads',
    description: 'Lista TODAS as páginas do Facebook/Instagram que o Jarvis tem acesso via Meta Business. USE quando alguém perguntar "quais páginas você acessa" ou quando precisar confirmar se uma página específica está disponível antes de criar campanha/anúncio. Retorna nome, ID e categoria de cada página.',
    input_schema: {
      type: 'object',
      properties: {
        filtro: { type: 'string', description: 'Filtro opcional por nome (busca parcial). Ex: "medical" retorna apenas páginas com "medical" no nome.' },
      },
    },
  },
  {
    name: 'relatorio_ads',
    description: 'Gerar relatório de desempenho de campanhas do Meta Ads com métricas reais (CPC, CTR, CPM, impressões, cliques, gasto, alcance). REGRA CRÍTICA: se a pergunta é sobre UM CLIENTE ESPECÍFICO (ex: "como foi o tráfego da Medical Planner?"), SEMPRE passe o parâmetro "cliente" pra filtrar. NUNCA use sem filtro quando o usuário perguntou sobre um cliente — vai vazar dados de outros clientes.',
    input_schema: {
      type: 'object',
      properties: {
        campanha_id: { type: 'string', description: 'ID da campanha específica (opcional)' },
        cliente: { type: 'string', description: 'Nome do cliente para FILTRAR campanhas (ex: "medical planner", "rossato"). USE SEMPRE quando a pergunta for sobre um cliente específico — evita misturar dados de outros clientes.' },
        periodo: { type: 'string', enum: ['hoje', 'ontem', '7dias', '30dias', 'mes'], description: 'Período do relatório' },
      },
      required: ['periodo'],
    },
  },
  {
    name: 'pausar_campanha',
    description: 'Pausar ou retomar uma campanha, conjunto de anúncios ou anúncio no Meta Ads. Para ativar/pausar vários de uma vez, use ativar_desativar_ads.',
    input_schema: {
      type: 'object',
      properties: {
        campanha_id: { type: 'string', description: 'ID da entidade no Meta Ads (campanha, conjunto ou anúncio)' },
        acao: { type: 'string', enum: ['pausar', 'retomar'], description: 'Ação a executar' },
        tipo: { type: 'string', enum: ['campanha', 'conjunto', 'anuncio'], description: 'Tipo da entidade (default: campanha)' },
      },
      required: ['campanha_id', 'acao'],
    },
  },
  {
    name: 'otimizar_campanha',
    description: 'Analisar métricas de uma campanha e sugerir otimizações inteligentes (ajuste de verba, segmentação, criativos). Puxa os dados reais e gera recomendações.',
    input_schema: {
      type: 'object',
      properties: {
        campanha_id: { type: 'string', description: 'ID da campanha para analisar' },
      },
      required: ['campanha_id'],
    },
  },
  // ============================================
  // TOOLS — Social Media (Publicações)
  // ============================================
  {
    name: 'agendar_post',
    description: 'Publicar ou agendar um post no Facebook/Instagram de um cliente. Resolve automaticamente a página pelo nome do cliente. NUNCA publique sem aprovação do Gui.',
    input_schema: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nome do cliente (ex: "minner", "rossato", "pippi", "carrion"). Resolve automaticamente a página do Facebook.' },
        texto: { type: 'string', description: 'Legenda/texto do post' },
        link: { type: 'string', description: 'Link para incluir no post (opcional)' },
        imagem_url: { type: 'string', description: 'URL pública da imagem para o post (opcional)' },
        agendar_para: { type: 'string', description: 'Data/hora para agendar no formato YYYY-MM-DDTHH:mm (fuso de Brasília). Se omitido, publica imediatamente.' },
      },
      required: ['cliente', 'texto'],
    },
  },
  {
    name: 'calendario_editorial',
    description: 'Consultar posts publicados recentemente ou planejar calendário editorial de um cliente.',
    input_schema: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nome do cliente (ex: "minner", "rossato"). Resolve a página automaticamente.' },
        acao: { type: 'string', enum: ['consultar', 'planejar'], description: 'Consultar posts recentes ou planejar novos' },
        limite: { type: 'number', description: 'Número de posts para consultar (default: 10)' },
      },
      required: ['acao'],
    },
  },
  {
    name: 'metricas_post',
    description: 'Consultar posts recentes da página de um cliente com suas métricas orgânicas. Resolve automaticamente a página pelo nome do cliente.',
    input_schema: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nome do cliente (ex: "minner", "rossato", "pippi"). Resolve automaticamente a página do Facebook.' },
        limite: { type: 'number', description: 'Número de posts recentes para consultar (default: 10)' },
      },
    },
  },
  // ============================================
  // TOOLS — Pipeline Criativo (Asana → Meta Ads)
  // ============================================
  {
    name: 'buscar_localizacao_ads',
    description: 'Busca IDs reais de cidades, estados ou regiões na API do Meta para usar na segmentação de conjuntos de anúncios. OBRIGATÓRIO usar ANTES de criar Ad Sets com segmentação geográfica. NUNCA invente IDs — sempre busque primeiro.',
    input_schema: {
      type: 'object',
      properties: {
        busca: { type: 'string', description: 'Nome da cidade, estado ou região (ex: "Cuiabá", "Mato Grosso", "Sinop", "Goiás")' },
        tipo: { type: 'string', enum: ['city', 'region', 'country', 'zip'], description: 'Tipo de localização: city (cidade), region (estado/região), country (país). Default: city' },
        pais: { type: 'string', description: 'Código do país (default: BR)' },
      },
      required: ['busca'],
    },
  },
  {
    name: 'criar_conjunto_anuncios',
    description: 'Criar um conjunto de anúncios (Ad Set) dentro de uma campanha existente no Meta Ads. Define segmentação, orçamento e otimização. Criado PAUSADO por segurança.',
    input_schema: {
      type: 'object',
      properties: {
        campanha_id: { type: 'string', description: 'ID da campanha pai no Meta Ads' },
        nome: { type: 'string', description: 'Nome do conjunto (ex: "[ROSSATO] Usados - Cuiabá 25-55")' },
        orcamento_diario: { type: 'number', description: 'Orçamento diário em reais (ex: 30 = R$30/dia)' },
        idade_min: { type: 'number', description: 'Idade mínima (default: 18)' },
        idade_max: { type: 'number', description: 'Idade máxima (default: 65)' },
        cidades: {
          type: 'array',
          description: 'Lista de cidades para segmentação. OBRIGATÓRIO buscar keys reais via buscar_localizacao_ads ANTES (ex: [{"key":"2684461","name":"Sinop"}]). Se omitido, Brasil inteiro.',
          items: { type: 'object', properties: { key: { type: 'string' }, name: { type: 'string' } } },
        },
        regioes: {
          type: 'array',
          description: 'Lista de estados/regiões para segmentação. OBRIGATÓRIO buscar keys reais via buscar_localizacao_ads com tipo=region ANTES (ex: [{"key":"448","name":"Mato Grosso"}]).',
          items: { type: 'object', properties: { key: { type: 'string' }, name: { type: 'string' } } },
        },
        interesses: {
          type: 'array',
          description: 'Lista de interesses para segmentação (ex: [{"id":"123","name":"Agronegócio"}])',
          items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
        },
        otimizacao: { type: 'string', enum: ['LINK_CLICKS', 'REACH', 'IMPRESSIONS', 'LANDING_PAGE_VIEWS', 'THRUPLAY', 'POST_ENGAGEMENT', 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS', 'LEAD_GENERATION', 'OFFSITE_CONVERSIONS'], description: 'Objetivo de otimização. IMPORTANTE: deve ser compatível com o objective da campanha pai. Sistema auto-corrige se incompatível. Para REELS/VÍDEO use THRUPLAY ou POST_ENGAGEMENT. Para tráfego: LINK_CLICKS. Para alcance/branding: REACH. Para leads: LEAD_GENERATION. Default: LINK_CLICKS.' },
        destino: { type: 'string', enum: ['WEBSITE', 'MESSENGER', 'WHATSAPP', 'APP'], description: 'Tipo de destino para campanhas de tráfego (default: WEBSITE). Use WHATSAPP quando o objetivo for direcionar pro WhatsApp do cliente — nesse caso PERGUNTE o número do WhatsApp antes de criar.' },
        cliente: { type: 'string', description: 'Nome do cliente (resolve Page ID e WhatsApp automaticamente). OBRIGATÓRIO para campanhas de tráfego.' },
        whatsapp_numero: { type: 'string', description: 'Número do WhatsApp do cliente com código do país (ex: "555599767916"). OBRIGATÓRIO quando destino=WHATSAPP e o número não está cadastrado no sistema.' },
        publico_advantage: { type: 'number', enum: [0, 1], description: 'Advantage+ Audience (Meta exige desde 2025). 1 = ativado (Meta expande público automaticamente para melhor entrega — RECOMENDADO e default), 0 = desativado (segmentação manual estrita, apenas o público definido).' },
      },
      required: ['campanha_id', 'nome', 'orcamento_diario'],
    },
  },
  {
    name: 'subir_imagem_ads',
    description: 'Faz upload de uma imagem para o Meta Ads. Retorna o hash da imagem para usar em criativos. Aceita URL pública da imagem.',
    input_schema: {
      type: 'object',
      properties: {
        imagem_url: { type: 'string', description: 'URL pública da imagem para upload' },
        nome_arquivo: { type: 'string', description: 'Nome do arquivo (ex: "banner_rossato.jpg")' },
      },
      required: ['imagem_url'],
    },
  },
  {
    name: 'criar_criativo_ads',
    description: 'Cria um criativo de anúncio no Meta Ads usando uma imagem já uploadada (hash). Define copy, link, headline e CTA.',
    input_schema: {
      type: 'object',
      properties: {
        image_hash: { type: 'string', description: 'Hash da imagem (obtido via subir_imagem_ads)' },
        cliente: { type: 'string', description: 'Nome do cliente (resolve Page ID automaticamente)' },
        texto: { type: 'string', description: 'Copy/texto principal do anúncio' },
        link: { type: 'string', description: 'URL de destino do anúncio' },
        titulo: { type: 'string', description: 'Título do anúncio (aparece no card)' },
        descricao: { type: 'string', description: 'Descrição abaixo do título (opcional)' },
        cta: { type: 'string', enum: ['LEARN_MORE', 'SHOP_NOW', 'SIGN_UP', 'CONTACT_US', 'BOOK_TRAVEL', 'DOWNLOAD', 'GET_OFFER', 'APPLY_NOW', 'SEND_WHATSAPP_MESSAGE'], description: 'Botão de ação (default: LEARN_MORE)' },
        nome_criativo: { type: 'string', description: 'Nome interno do criativo (opcional)' },
      },
      required: ['image_hash', 'cliente', 'texto', 'link'],
    },
  },
  {
    name: 'criar_anuncio',
    description: 'Cria um anúncio no Meta Ads vinculando um criativo a um conjunto de anúncios. Criado PAUSADO por segurança.',
    input_schema: {
      type: 'object',
      properties: {
        conjunto_id: { type: 'string', description: 'ID do conjunto de anúncios (Ad Set)' },
        criativo_id: { type: 'string', description: 'ID do criativo (Ad Creative)' },
        nome: { type: 'string', description: 'Nome do anúncio' },
      },
      required: ['conjunto_id', 'criativo_id'],
    },
  },
  {
    name: 'vincular_post_em_adset',
    description: 'PATROCINAR PUBLICAÇÃO EXISTENTE: vincula um reel/post/vídeo orgânico já postado a um Ad Set, criando o creative e o ad de uma vez. USE SEMPRE pra patrocinar reels existentes (mantém curtidas e comentários orgânicos). Cria PAUSADO. Equivale a "Usar publicação existente" do Ads Manager.',
    input_schema: {
      type: 'object',
      properties: {
        adset_id: { type: 'string', description: 'ID do Ad Set onde o anúncio será criado' },
        post_id: { type: 'string', description: 'ID do post/reel a patrocinar (formato curto, ex: "122111190848985174", OU formato completo "{pageId}_{postId}")' },
        cliente: { type: 'string', description: 'Nome do cliente (resolve Page ID automaticamente)' },
        nome: { type: 'string', description: 'Nome opcional do anúncio (default: "Ad - Post {postId}")' },
      },
      required: ['adset_id', 'post_id', 'cliente'],
    },
  },
  {
    name: 'baixar_anexos_task',
    description: 'Lista ou baixa os anexos (imagens, PDFs, etc.) de uma task do Asana. Útil para pegar criativos aprovados e subir pro Meta Ads.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'GID da task no Asana' },
        baixar: { type: 'boolean', description: 'Se true, baixa o conteúdo das imagens (para upload no Meta). Se false, só lista.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'pipeline_asana_meta',
    description: 'Pipeline COMPLETO: baixa imagens de uma task do Asana → sobe pro Meta Ads → cria criativos → cria anúncios. Tudo PAUSADO por segurança.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'GID da task no Asana com os criativos aprovados' },
        conjunto_id: { type: 'string', description: 'ID do conjunto de anúncios (Ad Set) onde os anúncios serão criados' },
        cliente: { type: 'string', description: 'Nome do cliente (resolve Page ID automaticamente)' },
        texto: { type: 'string', description: 'Copy/texto do anúncio' },
        link: { type: 'string', description: 'URL de destino' },
        titulo: { type: 'string', description: 'Título do anúncio (opcional)' },
        cta: { type: 'string', enum: ['LEARN_MORE', 'SHOP_NOW', 'SIGN_UP', 'CONTACT_US', 'SEND_WHATSAPP_MESSAGE'], description: 'Botão de ação (default: LEARN_MORE)' },
      },
      required: ['task_id', 'conjunto_id', 'cliente', 'texto', 'link'],
    },
  },
  {
    name: 'ativar_desativar_ads',
    description: 'Ativa ou desativa qualquer entidade do Meta Ads: campanha, conjunto de anúncios ou anúncio individual. Use para ativar/pausar em massa.',
    input_schema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          description: 'Lista de IDs para ativar/desativar. Pode ser mix de campanhas, conjuntos e anúncios.',
          items: { type: 'string' },
        },
        acao: { type: 'string', enum: ['ativar', 'pausar'], description: 'Ação a executar em todos os IDs' },
      },
      required: ['ids', 'acao'],
    },
  },
  {
    name: 'listar_conjuntos',
    description: 'Lista os conjuntos de anúncios (Ad Sets) de uma campanha no Meta Ads com seus status e orçamentos.',
    input_schema: {
      type: 'object',
      properties: {
        campanha_id: { type: 'string', description: 'ID da campanha' },
      },
      required: ['campanha_id'],
    },
  },
  // ============================================
  // TOOLS — Autonomia Nível 2 (mover seção + atribuir)
  // ============================================
  {
    name: 'mover_task_secao',
    description: 'Mover uma task para outra seção dentro de um projeto no Asana. Use para atualizar o status da task (ex: mover de "A Fazer" para "Em Andamento").',
    input_schema: {
      type: 'object',
      properties: {
        task_gid: { type: 'string', description: 'GID da task no Asana' },
        projeto: { type: 'string', description: 'Nome do projeto (ex: "cabine", "design", "audiovisual", "captacao")' },
        secao: { type: 'string', description: 'Nome da seção de destino (ex: "a_fazer", "em_andamento", "concluido", "revisao")' },
      },
      required: ['task_gid', 'projeto', 'secao'],
    },
  },
  {
    name: 'atribuir_task',
    description: 'Alterar o responsável de uma task no Asana. Atribui a task a um membro da equipe.',
    input_schema: {
      type: 'object',
      properties: {
        task_gid: { type: 'string', description: 'GID da task no Asana' },
        responsavel: { type: 'string', description: 'Primeiro nome do novo responsável (ex: "bruna", "bruno", "nicolas", "arthur", "rigon", "gui")' },
      },
      required: ['task_gid', 'responsavel'],
    },
  },
  {
    name: 'consultar_especialista',
    description: 'Consultar outro agente especialista do time do Jarvis para obter ajuda em uma área diferente. Use quando sua tarefa precisa de conhecimento de outra especialidade (ex: agente de tráfego precisa de uma legenda → consulta o criativo; gestor precisa de análise de dados → consulta o pesquisador). O especialista responde com sua análise e você integra na sua resposta final.',
    input_schema: {
      type: 'object',
      properties: {
        especialista: {
          type: 'string',
          enum: ['creative', 'manager', 'researcher', 'traffic', 'social'],
          description: 'Qual especialista consultar: creative (copy, legendas, roteiros), manager (tarefas, Asana, prazos), researcher (pesquisa, dados, tendências), traffic (campanhas, métricas pagas, Meta Ads), social (publicação, calendário editorial, métricas orgânicas)',
        },
        pedido: {
          type: 'string',
          description: 'O que você precisa que o especialista faça. Seja específico: inclua contexto do cliente, objetivo, restrições.',
        },
        contexto_adicional: {
          type: 'string',
          description: 'Dados ou resultados que você já coletou que podem ajudar o especialista (ex: métricas de campanha, briefing do cliente, etc.)',
        },
      },
      required: ['especialista', 'pedido'],
    },
  },
  // ============================================
  // TOOLS — Diversão (grupos internos apenas)
  // ============================================
  {
    name: 'gerar_imagem',
    description: 'Gera uma imagem via DALL-E 3 (OpenAI) e envia no grupo. SOMENTE funciona em grupos internos da equipe.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Descrição detalhada da imagem a ser gerada (em inglês para melhor resultado)' },
        estilo: { type: 'string', enum: ['vivid', 'natural'], description: 'Estilo da imagem: vivid (criativo/intenso) ou natural (realista). Default: vivid' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'criar_sticker',
    description: 'Gera uma imagem via DALL-E 3, converte para sticker (WebP 512x512) e envia no grupo. SOMENTE funciona em grupos internos da equipe. Ideal para stickers engraçados, memes e reações.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Descrição detalhada do sticker a ser gerado (em inglês para melhor resultado). Dica: peça fundo transparente ou branco para stickers melhores.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'enviar_audio',
    description: 'Grava e envia uma mensagem de voz (áudio) no grupo atual. Use quando alguém pedir explicitamente para mandar em áudio, ou quando a situação pedir voz (humor, explicações, saudações). SOMENTE funciona em grupos internos ou DMs autorizados.',
    input_schema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'O texto que será convertido em áudio via TTS. Escreva exatamente o que quer falar, com entonação e pausas naturais.' },
      },
      required: ['texto'],
    },
  },
];

/**
 * Fuzzy match: retorna true se duas strings têm distância de edição ≤ 2
 * Útil para "bruna" vs "brusna", "nicolas" vs "nícolas", etc.
 */
function fuzzyMatch(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 2) return false;
  // Levenshtein simplificado (máx 2)
  const lenA = a.length, lenB = b.length;
  const matrix = Array.from({ length: lenA + 1 }, (_, i) =>
    Array.from({ length: lenB + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,     // delete
        matrix[i][j - 1] + 1,     // insert
        matrix[i - 1][j - 1] + cost // substitute
      );
    }
  }
  return matrix[lenA][lenB] <= 2;
}

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

  if (toolName === 'buscar_mensagens') {
    if (!input.palavras_chave || input.palavras_chave.length === 0) {
      return { error: 'palavras_chave é obrigatório (array de strings)' };
    }
    try {
      const { searchRecentMessagesByKeyword } = await import('../database.mjs');
      const horas = Math.min(input.horas || 72, 720);
      const limite = Math.min(input.limite || 20, 50);

      const mensagens = await searchRecentMessagesByKeyword(input.palavras_chave, horas, limite);

      // Filtrar por grupo se especificado
      let filtered = mensagens;
      if (input.grupo) {
        const grupoLower = input.grupo.toLowerCase();
        // Buscar JID do grupo pelo nome
        const { rows: grupoRows } = await pool.query(
          `SELECT jid FROM jarvis_groups WHERE LOWER(name) LIKE $1 LIMIT 5`,
          [`%${grupoLower}%`]
        );
        if (grupoRows.length > 0) {
          const grupoJids = new Set(grupoRows.map(r => r.jid));
          filtered = mensagens.filter(m => grupoJids.has(m.chat_id));
        }
      }

      const resultado = filtered.map(m => ({
        de: m.push_name || '?',
        texto: (m.text || '').substring(0, 500),
        grupo: m.chat_id,
        data: m.hora_br ? new Date(m.hora_br).toLocaleString('pt-BR') : '?',
      }));

      return {
        sucesso: true,
        busca: input.palavras_chave.join(', '),
        periodo: `últimas ${horas}h`,
        total: resultado.length,
        mensagens: resultado,
      };
    } catch (err) {
      return { error: `Erro ao buscar mensagens: ${err.message}` };
    }
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

    // Resolver custom fields (Cliente, Urgência, Tier, Tipo de demanda)
    const customFields = resolveCustomFields({
      cliente: clienteName,
      urgencia: input.urgencia || 'negociavel',
      tier: input.tier || null,
      tipo_demanda: input.tipo_demanda || null,
    });
    if (customFields) {
      taskData.custom_fields = customFields;
      console.log(`[ASANA] Custom fields resolvidos:`, JSON.stringify(customFields));
    }

    const result = await asanaCreateTask(taskData);
    if (result.success) {
      result.url = `https://app.asana.com/0/${cabineGid}/${result.gid}`;
      result.cliente = clienteName;
      result.responsavel = input.responsavel || 'bruna';
      result.custom_fields_applied = !!customFields;
      console.log(`[PROACTIVE] Task criada: ${taskName} → ${result.url} (custom_fields: ${!!customFields})`);
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
        return { error: 'BLOQUEADO: essa mensagem contém informações internas do Lab. Nunca envie detalhes sobre Asana, tasks, ferramentas ou processos internos para o grupo do cliente. Reformule a mensagem com tom 100% profissional.' };
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
        // Versão sem caracteres especiais (ex: "brusna" → "brusna", "bruna" → "bruna")
        const nomeClean = nomeLower.replace(/[^a-záàâãéêíóôõúç]/gi, '').toLowerCase();

        // 1. Buscar no map teamWhatsApp — match exato, parcial, e fuzzy (tolerância a typos)
        let jidFromTeam = teamWhatsApp.get(nomeLower);
        if (!jidFromTeam) {
          // Parcial: procurar chaves que contenham o nome ou vice-versa
          for (const [key, jid] of teamWhatsApp) {
            const keyClean = key.replace(/[^a-záàâãéêíóôõúç]/gi, '').toLowerCase();
            if (keyClean.includes(nomeClean) || nomeClean.includes(keyClean)) {
              jidFromTeam = jid;
              break;
            }
          }
        }
        if (!jidFromTeam) {
          // Fuzzy: tolerância a 1-2 caracteres diferentes (ex: "bruna" vs "brusna")
          for (const [key, jid] of teamWhatsApp) {
            const keyClean = key.replace(/[^a-záàâãéêíóôõúç]/gi, '').toLowerCase();
            if (fuzzyMatch(nomeClean, keyClean)) {
              jidFromTeam = jid;
              break;
            }
          }
        }
        if (jidFromTeam) {
          mentionJids.push(jidFromTeam);
          continue;
        }

        // 2. Buscar na tabela jarvis_contacts por push_name (aceita @lid e @s.whatsapp.net)
        try {
          const { rows } = await pool.query(
            `SELECT jid FROM jarvis_contacts WHERE LOWER(push_name) LIKE $1 AND (jid LIKE '%@s.whatsapp.net' OR jid LIKE '%@lid') LIMIT 1`,
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
      // Substituir @Nome pelo @número no texto (WhatsApp exige @número para renderizar menção)
      let msgText = input.mensagem;
      if (input.mencoes && Array.isArray(input.mencoes)) {
        for (let i = 0; i < input.mencoes.length && i < mentionJids.length; i++) {
          const nome = input.mencoes[i];
          const jid = mentionJids[i];
          const phoneNum = jid.replace(/@s\.whatsapp\.net$/, '');
          // Substituir @Nome ou @nome pelo @número (case-insensitive)
          const mentionRegex = new RegExp(`@${nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
          msgText = msgText.replace(mentionRegex, `@${phoneNum}`);
        }
      }
      const mentions = mentionJids.map(jid => ({ jid }));
      await _sendTextWithMentionsFn(targetJid, msgText, mentions);
      console.log(`[TOOL] Mensagem enviada para ${input.grupo} com ${mentionJids.length} menções: ${msgText.substring(0, 60)}...`);
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
    const chatId = input.chat_id || '';
    if (!taskGid) return { error: 'task_gid é obrigatório' };

    const results = [];
    const mediaBaseDir = path.join(process.cwd(), 'media_files');
    let filesToUpload = [];

    // Sempre busca todos os arquivos recentes (simplificado)
    try {
      const subdirs = await readdir(mediaBaseDir).catch(() => []);
      const targetDirs = chatId ? subdirs.filter(d => d.includes(chatId.split('@')[0])) : subdirs;
      for (const subdir of (targetDirs.length > 0 ? targetDirs : subdirs)) {
        const dirPath = path.join(mediaBaseDir, subdir);
        const files = await readdir(dirPath).catch(() => []);
        for (const file of files) {
          const filePath = path.join(dirPath, file);
          const fileStat = await stat(filePath).catch(() => null);
          if (fileStat && fileStat.isFile()) {
            const ageHours = (Date.now() - fileStat.mtimeMs) / (1000 * 60 * 60);
            if (ageHours <= 24) {
              filesToUpload.push({ path: filePath, fileName: file });
            }
          }
        }
      }
      // Deduplicar por tamanho
      const seen = new Map();
      filesToUpload = filesToUpload.filter(f => {
        try {
          const s = readFileSync(f.path).length;
          if (seen.has(s)) return false;
          seen.set(s, true);
          return true;
        } catch { return false; }
      });
      console.log(`[TOOL] anexar_midia: ${filesToUpload.length} arquivos encontrados`);
    } catch (e) {
      console.error('[TOOL] Erro listando media_files:', e.message);
    }

    for (const file of filesToUpload) {
      const uploadResult = await asanaUploadAttachment(taskGid, file.path, file.fileName);
      results.push({ fileName: file.fileName, ...uploadResult });
    }

    const successCount = results.filter(r => r.success).length;
    console.log(`[TOOL] Anexos uploaded: ${successCount}/${filesToUpload.length} para task ${taskGid}`);
    return { success: successCount > 0, total: filesToUpload.length, uploaded: successCount, results };
  }

  // ============================================
  // NOVAS TOOLS — Gestão de Projetos
  // ============================================

  if (toolName === 'consultar_task') {
    const taskGid = input.task_gid;
    if (!taskGid) return { error: 'task_gid é obrigatório' };

    const task = await asanaRequest(`/tasks/${taskGid}?opt_fields=name,notes,assignee.name,due_on,completed,completed_at,custom_fields.name,custom_fields.display_value,memberships.section.name,memberships.project.name,tags.name,num_subtasks`);
    if (!task) return { error: `Task ${taskGid} não encontrada` };

    const result = {
      gid: task.gid,
      nome: task.name,
      responsavel: task.assignee?.name || 'Sem responsável',
      prazo: task.due_on || 'Sem prazo',
      concluida: task.completed,
      secao: task.memberships?.[0]?.section?.name || 'Desconhecida',
      projeto: task.memberships?.[0]?.project?.name || 'Desconhecido',
      campos_custom: (task.custom_fields || []).filter(f => f.display_value).map(f => ({ nome: f.name, valor: f.display_value })),
      subtasks: task.num_subtasks || 0,
      url: `https://app.asana.com/0/0/${taskGid}`,
    };

    // Incluir comentários recentes
    if (input.incluir_comentarios !== false) {
      const stories = await asanaRequest(`/tasks/${taskGid}/stories?opt_fields=text,created_by.name,created_at,type&limit=15`);
      if (stories) {
        result.comentarios = stories
          .filter(s => s.type === 'comment' && s.text)
          .slice(-10)
          .map(s => ({
            autor: s.created_by?.name || 'Desconhecido',
            texto: s.text.substring(0, 300),
            data: s.created_at ? new Date(s.created_at).toLocaleDateString('pt-BR') : '',
          }));
      }
    }

    console.log(`[TOOL] Task consultada: ${task.name} (${task.assignee?.name || 'sem resp.'}, prazo: ${task.due_on || 'sem'})`);
    return result;
  }

  if (toolName === 'comentar_task') {
    const taskGid = input.task_gid;
    const texto = input.texto;
    if (!taskGid || !texto) return { error: 'task_gid e texto são obrigatórios' };

    // Buscar comentários recentes ANTES de postar (evitar duplicatas e dar contexto)
    let comentariosExistentes = [];
    try {
      const stories = await asanaRequest(`/tasks/${taskGid}/stories?opt_fields=text,created_by.name,created_at,type&limit=10`);
      if (stories) {
        comentariosExistentes = stories
          .filter(s => s.type === 'comment' && s.text)
          .slice(-5);
        // Anti-duplicata: se último comentário do Jarvis < 1h e texto similar, não duplicar
        const lastJarvisComment = comentariosExistentes
          .filter(c => c.created_by?.name?.toLowerCase().includes('jarvis'))
          .pop();
        if (lastJarvisComment) {
          const commentAge = (Date.now() - new Date(lastJarvisComment.created_at).getTime()) / 1000 / 60;
          const isSimilar = lastJarvisComment.text.substring(0, 80) === texto.substring(0, 80);
          if (commentAge < 60 && isSimilar) {
            return {
              bloqueado: true,
              motivo: 'Comentário similar já postado pelo Jarvis há menos de 1 hora',
              ultimo_comentario: { texto: lastJarvisComment.text.substring(0, 200), data: lastJarvisComment.created_at },
            };
          }
        }
      }
    } catch {}

    // Resolver menção se informada
    let commentText = texto;
    if (input.mencionar) {
      const asanaGid = TEAM_ASANA[input.mencionar.toLowerCase()];
      if (asanaGid) {
        // Menção real do Asana via HTML
        commentText = `<a data-asana-gid="${asanaGid}"/> ${texto}`;
      }
    }

    // Usar endpoint com html_text pra suportar menções
    const useHtml = commentText.includes('data-asana-gid');
    const body = useHtml
      ? { html_text: `<body>${commentText}</body>` }
      : { text: commentText };

    const resp = await asanaWrite('POST', `/tasks/${taskGid}/stories`, body);
    if (resp.error) return { error: `Erro ao comentar: ${resp.error}` };

    console.log(`[TOOL] Comentário adicionado na task ${taskGid}: ${texto.substring(0, 60)}`);
    return {
      success: true, task_gid: taskGid, comentario: texto.substring(0, 100),
      comentarios_anteriores: comentariosExistentes.slice(-3).map(c => ({
        autor: c.created_by?.name || '?', texto: c.text?.substring(0, 200) || '',
        data: c.created_at ? new Date(c.created_at).toLocaleDateString('pt-BR') : '',
      })),
    };
  }

  if (toolName === 'atualizar_task') {
    const taskGid = input.task_gid;
    if (!taskGid) return { error: 'task_gid é obrigatório' };

    const updates = {};
    const actions = [];

    // Atualizar responsável
    if (input.responsavel) {
      const asanaGid = TEAM_ASANA[input.responsavel.toLowerCase()];
      if (asanaGid) {
        updates.assignee = asanaGid;
        actions.push(`responsável → ${input.responsavel}`);
      } else {
        return { error: `Responsável "${input.responsavel}" não encontrado na equipe` };
      }
    }

    // Atualizar prazo
    if (input.prazo) {
      updates.due_on = input.prazo;
      actions.push(`prazo → ${input.prazo}`);
    }

    // Marcar como concluída
    if (input.concluir) {
      updates.completed = true;
      actions.push('marcada como concluída');
    }

    if (Object.keys(updates).length === 0) {
      return { error: 'Nenhuma atualização informada (responsavel, prazo ou concluir)' };
    }

    const resp = await asanaWrite('PUT', `/tasks/${taskGid}`, updates);
    if (resp.error) return { error: `Erro ao atualizar: ${resp.error}` };

    console.log(`[TOOL] Task ${taskGid} atualizada: ${actions.join(', ')}`);
    return { success: true, task_gid: taskGid, atualizacoes: actions };
  }

  if (toolName === 'buscar_memorias') {
    const query = input.query;
    if (!query) return { error: 'query é obrigatória' };

    const escopo = input.escopo || null;
    const limite = input.limite || 10;

    try {
      const memories = await searchMemories(query, escopo, null, limite);
      if (memories.length === 0) {
        return { encontradas: 0, mensagem: 'Nenhuma memória encontrada para essa busca', memorias: [] };
      }
      return {
        encontradas: memories.length,
        memorias: memories.map(m => ({
          conteudo: m.content,
          categoria: m.category,
          importancia: m.importance,
          escopo: m.scope,
          criado_em: m.created_at ? new Date(m.created_at).toLocaleDateString('pt-BR') : '',
        })),
      };
    } catch (err) {
      return { error: `Erro ao buscar memórias: ${err.message}` };
    }
  }

  // ============================================
  // TOOLS — Tráfego Pago (Meta Ads)
  // ============================================
  if (toolName === 'criar_campanha') {
    if (!input.nome) return { error: 'nome é obrigatório' };
    if (!input.objetivo) return { error: 'objetivo é obrigatório' };
    if (!input.orcamento_diario) return { error: 'orcamento_diario é obrigatório' };

    try {
      const result = await createCampaign({
        name: input.nome,
        objective: input.objetivo,
        dailyBudget: input.orcamento_diario,
        status: 'PAUSED', // SEMPRE pausada por segurança
      });
      return {
        sucesso: true,
        campanha_id: result.id,
        nome: result.name,
        objetivo: result.objective,
        orcamento_diario: `R$ ${parseFloat(input.orcamento_diario).toFixed(2)}`,
        status: 'PAUSADA (ativar manualmente)',
        mensagem: `Campanha "${input.nome}" criada com sucesso! Status: PAUSADA. O Gui precisa ativar manualmente quando estiver pronto.`,
      };
    } catch (err) {
      return { error: `Erro ao criar campanha: ${err.message}` };
    }
  }

  if (toolName === 'listar_paginas_ads') {
    try {
      const todas = await listAllAccessiblePages();
      const filtro = (input.filtro || '').toLowerCase().trim();
      const paginas = filtro
        ? todas.filter(p => p.nome.toLowerCase().includes(filtro))
        : todas;
      return {
        sucesso: true,
        total: paginas.length,
        total_geral: todas.length,
        paginas: paginas.map(p => ({ nome: p.nome, id: p.id, categoria: p.categoria || '—' })),
      };
    } catch (err) {
      return { error: `Erro ao listar páginas: ${err.message}` };
    }
  }

  if (toolName === 'relatorio_ads') {
    if (!input.periodo) return { error: 'periodo é obrigatório' };

    try {
      if (input.campanha_id) {
        // Relatório de campanha específica
        const insights = await getCampaignInsights(input.campanha_id, input.periodo);
        return { sucesso: true, tipo: 'campanha', ...insights };
      }

      // BUG 2 FIX: Se user perguntou de cliente específico, FILTRAR campanhas pelo nome
      // Antes: cuspia conta inteira misturando clientes (vazou Stream Health no contexto Medical Planner)
      const todasCampanhas = await listCampaigns();
      let campanhasFiltradas = todasCampanhas;
      let clienteFiltrado = null;

      if (input.cliente) {
        const filtro = input.cliente.toLowerCase().trim();
        campanhasFiltradas = todasCampanhas.filter(c =>
          (c.name || c.nome || '').toLowerCase().includes(filtro)
        );
        clienteFiltrado = input.cliente;
      }

      // Se filtrou por cliente: agrega insights APENAS das campanhas dele
      if (clienteFiltrado) {
        if (campanhasFiltradas.length === 0) {
          return {
            sucesso: true,
            tipo: 'cliente_sem_campanhas',
            cliente: clienteFiltrado,
            mensagem: `Nenhuma campanha encontrada para "${clienteFiltrado}". Verifique se o nome do cliente está correto ou se ele tem campanhas ativas.`,
            sugestao: 'Use listar_paginas_ads pra ver os clientes disponíveis.',
          };
        }
        // Pega insights de cada campanha do cliente em paralelo (limite 10)
        const insightsList = await Promise.all(
          campanhasFiltradas.slice(0, 10).map(c =>
            getCampaignInsights(c.id, input.periodo).catch(() => null)
          )
        );
        // Agrega métricas
        const agregado = insightsList.filter(Boolean).reduce((acc, i) => {
          acc.impressoes += parseInt(i.impressoes || i.impressions || 0);
          acc.alcance += parseInt(i.alcance || i.reach || 0);
          acc.cliques += parseInt(i.cliques || i.clicks || 0);
          acc.gasto += parseFloat(i.gasto || i.spend || 0);
          return acc;
        }, { impressoes: 0, alcance: 0, cliques: 0, gasto: 0 });
        return {
          sucesso: true,
          tipo: 'cliente',
          cliente: clienteFiltrado,
          periodo: input.periodo,
          total_campanhas: campanhasFiltradas.length,
          campanhas: campanhasFiltradas.slice(0, 10).map(c => ({ id: c.id, nome: c.name || c.nome, status: c.status })),
          metricas_agregadas: agregado,
          aviso_filtro: `Filtrado APENAS por "${clienteFiltrado}". Métricas NÃO incluem outros clientes.`,
        };
      }

      // Sem filtro: relatório geral (com aviso explícito que está misturando)
      const insights = await getAccountInsights(input.periodo);
      return {
        sucesso: true,
        tipo: 'conta_geral',
        aviso: 'ATENÇÃO: este é o relatório AGREGADO da conta inteira (todos os clientes misturados). Pra dados de um cliente específico, chame relatorio_ads com parâmetro "cliente".',
        ...insights,
        campanhas: todasCampanhas.slice(0, 10),
        total_campanhas: todasCampanhas.length,
      };
    } catch (err) {
      return { error: `Erro ao gerar relatório: ${err.message}` };
    }
  }

  if (toolName === 'pausar_campanha') {
    if (!input.campanha_id) return { error: 'campanha_id é obrigatório' };
    if (!input.acao) return { error: 'acao é obrigatória (pausar ou retomar)' };

    try {
      const status = input.acao === 'retomar' ? 'ACTIVE' : 'PAUSED';
      const tipo = input.tipo || 'campanha';
      const result = await updateEntityStatus(input.campanha_id, status, tipo);
      return {
        sucesso: true,
        id: result.id,
        tipo: result.tipo,
        novo_status: result.status === 'ACTIVE' ? 'ATIVA' : 'PAUSADA',
        mensagem: `${tipo.charAt(0).toUpperCase() + tipo.slice(1)} ${input.acao === 'retomar' ? 'retomada' : 'pausada'} com sucesso.`,
      };
    } catch (err) {
      return { error: `Erro ao ${input.acao} ${input.tipo || 'campanha'}: ${err.message}` };
    }
  }

  if (toolName === 'otimizar_campanha') {
    if (!input.campanha_id) return { error: 'campanha_id é obrigatório' };

    try {
      // Puxa métricas de 7 dias e 30 dias pra comparar
      const [insights7d, insights30d] = await Promise.all([
        getCampaignInsights(input.campanha_id, '7dias'),
        getCampaignInsights(input.campanha_id, '30dias'),
      ]);
      return {
        sucesso: true,
        campanha_id: input.campanha_id,
        ultimos_7_dias: insights7d,
        ultimos_30_dias: insights30d,
        instrucao: 'Analise as métricas acima e sugira otimizações baseadas nos dados reais: ajustes de verba, segmentação, criativos, horários.',
      };
    } catch (err) {
      return { error: `Erro ao analisar campanha: ${err.message}` };
    }
  }

  // ============================================
  // TOOLS — Social Media
  // ============================================
  if (toolName === 'agendar_post') {
    if (!input.texto) return { error: 'texto é obrigatório' };

    try {
      const result = await publishPagePost({
        message: input.texto,
        link: input.link,
        imageUrl: input.imagem_url,
        scheduledTime: input.agendar_para,
        cliente: input.cliente,
      });
      return {
        sucesso: true,
        post_id: result.id,
        agendado: result.agendado,
        mensagem: result.agendado
          ? `Post agendado com sucesso para ${input.agendar_para}!`
          : 'Post publicado com sucesso!',
      };
    } catch (err) {
      return { error: `Erro ao publicar post: ${err.message}` };
    }
  }

  if (toolName === 'calendario_editorial') {
    if (!input.acao) return { error: 'acao é obrigatória (consultar ou planejar)' };

    try {
      if (input.acao === 'consultar') {
        const posts = await getPagePosts(input.limite || 10, input.cliente);
        return {
          sucesso: true,
          posts_recentes: posts,
          total: posts.length,
          mensagem: posts.length > 0
            ? `${posts.length} posts recentes encontrados.`
            : 'Nenhum post encontrado na página.',
        };
      } else {
        // Planejar: retorna posts recentes como base
        const posts = await getPagePosts(input.limite || 20, input.cliente);
        return {
          sucesso: true,
          posts_existentes: posts,
          instrucao: 'Baseado nos posts recentes acima, sugira um calendário editorial para as próximas semanas. Considere frequência, formatos e temas que tiveram melhor performance.',
        };
      }
    } catch (err) {
      return { error: `Erro no calendário editorial: ${err.message}` };
    }
  }

  if (toolName === 'metricas_post') {
    try {
      const posts = await getPagePosts(input.limite || 10, input.cliente);
      return {
        sucesso: true,
        posts: posts,
        total: posts.length,
      };
    } catch (err) {
      return { error: `Erro ao buscar métricas: ${err.message}` };
    }
  }

  // ============================================
  // TOOLS — Pipeline Criativo (Asana → Meta Ads)
  // ============================================

  if (toolName === 'buscar_localizacao_ads') {
    if (!input.busca) return { error: 'busca é obrigatório (nome da cidade, estado ou região)' };

    try {
      const tipo = input.tipo || 'city';
      const pais = input.pais || 'BR';
      const resultados = await searchGeoLocation(input.busca, tipo, pais);

      if (resultados.length === 0) {
        return {
          resultados: [],
          mensagem: `Nenhuma localização encontrada para "${input.busca}" (tipo: ${tipo}, país: ${pais}). Tente outro nome ou tipo diferente.`,
        };
      }

      return {
        sucesso: true,
        busca: input.busca,
        tipo,
        total: resultados.length,
        resultados,
        instrucao: 'Use o campo "key" de cada resultado para segmentar Ad Sets. Para cidades: cidades=[{"key":"<key>","name":"<name>"}]. Para regiões/estados: regioes=[{"key":"<key>","name":"<name>"}].',
      };
    } catch (err) {
      return { error: `Erro ao buscar localização: ${err.message}` };
    }
  }

  if (toolName === 'criar_conjunto_anuncios') {
    if (!input.campanha_id) return { error: 'campanha_id é obrigatório' };
    if (!input.nome) return { error: 'nome é obrigatório' };
    if (!input.orcamento_diario) return { error: 'orcamento_diario é obrigatório' };

    // Se destino é WHATSAPP, OBRIGATÓRIO ter o número do cliente
    if (input.destino === 'WHATSAPP') {
      let whatsappNumber = input.whatsapp_numero || null;

      // Tentar resolver pelo nome do cliente
      if (!whatsappNumber && input.cliente) {
        whatsappNumber = resolveWhatsAppNumber(input.cliente);
      }

      if (!whatsappNumber) {
        return {
          error: `Para anúncios com destino WhatsApp, preciso do número do WhatsApp do cliente. Informe o número com DDD e código do país (ex: 555599767916).`,
          campo_necessario: 'whatsapp_numero',
          dica: 'Pergunte ao Gui qual o número do WhatsApp do cliente para usar no anúncio.',
        };
      }
    }

    try {
      const targeting = {};
      if (input.cidades) targeting.cities = input.cidades;
      if (input.regioes) targeting.regions = input.regioes;
      if (input.interesses) targeting.interests = input.interesses;
      if (input.idade_min) targeting.ageMin = input.idade_min;
      if (input.idade_max) targeting.ageMax = input.idade_max;
      // Advantage+ Audience (Meta exige desde 2025): default 1 (ativado)
      // Para segmentação manual estrita, passar publico_advantage: 0
      if (input.publico_advantage !== undefined) targeting.advantageAudience = input.publico_advantage;

      // Resolver Page ID do cliente pra usar no promoted_object
      if (input.cliente) {
        const pageId = await resolvePageId(input.cliente);
        if (pageId) targeting.pageId = pageId;
      }

      const result = await createAdSet({
        campaignId: input.campanha_id,
        name: input.nome,
        dailyBudget: input.orcamento_diario,
        targeting,
        optimizationGoal: input.otimizacao || 'LINK_CLICKS',
        destinationType: input.destino || null,
        status: 'PAUSED',
      });

      // Montar info do link WhatsApp pra usar no criativo
      let whatsappLink = null;
      if (input.destino === 'WHATSAPP') {
        const numero = input.whatsapp_numero || resolveWhatsAppNumber(input.cliente);
        if (numero) whatsappLink = `https://wa.me/${numero}`;
      }

      return {
        sucesso: true,
        conjunto_id: result.id,
        nome: result.name,
        campanha_id: result.campaignId,
        orcamento_diario: `R$ ${parseFloat(input.orcamento_diario).toFixed(2)}`,
        status: 'PAUSADO',
        whatsapp_link: whatsappLink,
        mensagem: whatsappLink
          ? `Conjunto "${input.nome}" criado (PAUSADO). Use o link ${whatsappLink} como destino nos criativos.`
          : `Conjunto de anúncios "${input.nome}" criado com sucesso (PAUSADO).`,
      };
    } catch (err) {
      return { error: `Erro ao criar conjunto: ${err.message}` };
    }
  }

  if (toolName === 'subir_imagem_ads') {
    if (!input.imagem_url) return { error: 'imagem_url é obrigatório' };

    try {
      // Baixar a imagem da URL
      const imgResp = await fetch(input.imagem_url);
      if (!imgResp.ok) throw new Error(`Erro ao baixar imagem: ${imgResp.status}`);
      const buffer = Buffer.from(await imgResp.arrayBuffer());

      const fileName = input.nome_arquivo || input.imagem_url.split('/').pop()?.split('?')[0] || 'ad_image.jpg';
      const result = await uploadAdImage(buffer, fileName);

      return {
        sucesso: true,
        image_hash: result.hash,
        url: result.url,
        nome_arquivo: fileName,
        tamanho_bytes: buffer.length,
        mensagem: `Imagem "${fileName}" uploaded com sucesso. Hash: ${result.hash}. Use este hash para criar criativos.`,
      };
    } catch (err) {
      return { error: `Erro ao fazer upload: ${err.message}` };
    }
  }

  if (toolName === 'criar_criativo_ads') {
    if (!input.image_hash) return { error: 'image_hash é obrigatório (faça upload primeiro com subir_imagem_ads)' };
    if (!input.cliente) return { error: 'cliente é obrigatório' };
    if (!input.texto) return { error: 'texto é obrigatório' };
    if (!input.link) return { error: 'link é obrigatório' };

    try {
      const pageId = await resolvePageId(input.cliente);
      if (!pageId) return { error: `Página não encontrada para cliente "${input.cliente}". Use listAvailablePages() para ver as disponíveis.` };

      const result = await createAdCreative({
        imageHash: input.image_hash,
        pageId,
        message: input.texto,
        link: input.link,
        headline: input.titulo || '',
        description: input.descricao || '',
        callToAction: input.cta || 'LEARN_MORE',
        name: input.nome_criativo,
      });

      return {
        sucesso: true,
        criativo_id: result.id,
        nome: result.name,
        mensagem: `Criativo "${result.name}" criado com sucesso. Use este ID para criar anúncios.`,
      };
    } catch (err) {
      return { error: `Erro ao criar criativo: ${err.message}` };
    }
  }

  if (toolName === 'criar_anuncio') {
    if (!input.conjunto_id) return { error: 'conjunto_id é obrigatório' };
    if (!input.criativo_id) return { error: 'criativo_id é obrigatório' };

    try {
      const result = await createAd({
        adSetId: input.conjunto_id,
        creativeId: input.criativo_id,
        name: input.nome || undefined,
        status: 'PAUSED',
      });

      return {
        sucesso: true,
        anuncio_id: result.id,
        nome: result.name,
        conjunto_id: result.adSetId,
        criativo_id: result.creativeId,
        status: 'PAUSADO',
        mensagem: `Anúncio "${result.name}" criado com sucesso (PAUSADO).`,
      };
    } catch (err) {
      return { error: `Erro ao criar anúncio: ${err.message}` };
    }
  }

  if (toolName === 'vincular_post_em_adset') {
    if (!input.adset_id) return { error: 'adset_id é obrigatório' };
    if (!input.post_id) return { error: 'post_id é obrigatório' };
    if (!input.cliente) return { error: 'cliente é obrigatório (pra resolver o Page ID)' };

    try {
      const pageId = await resolvePageId(input.cliente);
      if (!pageId) return { error: `Página não encontrada para cliente "${input.cliente}"` };

      // Cria creative com object_story_id (publicação existente)
      const creative = await createAdCreative({
        postId: input.post_id,
        pageId,
        name: input.nome ? `Creative - ${input.nome}` : undefined,
      });

      // Cria ad vinculando creative ao adset
      const ad = await createAd({
        adSetId: input.adset_id,
        creativeId: creative.id,
        name: input.nome || `Ad - Post ${input.post_id.substring(0, 12)}`,
        status: 'PAUSED',
      });

      return {
        sucesso: true,
        criativo_id: creative.id,
        anuncio_id: ad.id,
        nome: ad.name,
        adset_id: input.adset_id,
        post_id: input.post_id,
        status: 'PAUSADO',
        mensagem: `Post ${input.post_id} vinculado ao adset ${input.adset_id} via Ad "${ad.name}" (PAUSADO). Curtidas e comentários orgânicos preservados.`,
      };
    } catch (err) {
      return { error: `Erro ao vincular post no adset: ${err.message}` };
    }
  }

  if (toolName === 'baixar_anexos_task') {
    if (!input.task_id) return { error: 'task_id é obrigatório' };

    try {
      const attachments = await asanaGetAttachments(input.task_id, input.baixar || false);

      if (!input.baixar) {
        return {
          sucesso: true,
          total: attachments.length,
          anexos: attachments,
          mensagem: attachments.length > 0
            ? `${attachments.length} anexo(s) encontrado(s). Use baixar=true para baixar as imagens.`
            : 'Nenhum anexo encontrado na task.',
        };
      }

      const imagens = attachments.filter(a => a.tipo === 'imagem');
      const outros = attachments.filter(a => a.tipo !== 'imagem');

      return {
        sucesso: true,
        total: attachments.length,
        imagens_encontradas: imagens.length,
        outros_arquivos: outros.length,
        anexos: attachments.map(a => ({
          nome: a.nome,
          tipo: a.tipo,
          tamanho: a.tamanho || null,
          error: a.error || null,
        })),
        mensagem: imagens.length > 0
          ? `${imagens.length} imagem(ns) baixada(s) com sucesso. Prontas para upload no Meta Ads.`
          : 'Nenhuma imagem encontrada nos anexos.',
      };
    } catch (err) {
      return { error: `Erro ao buscar anexos: ${err.message}` };
    }
  }

  if (toolName === 'pipeline_asana_meta') {
    if (!input.task_id) return { error: 'task_id é obrigatório' };
    if (!input.conjunto_id) return { error: 'conjunto_id é obrigatório' };
    if (!input.cliente) return { error: 'cliente é obrigatório' };
    if (!input.texto) return { error: 'texto é obrigatório' };
    if (!input.link) return { error: 'link é obrigatório' };

    try {
      const pageId = await resolvePageId(input.cliente);
      if (!pageId) return { error: `Página não encontrada para cliente "${input.cliente}".` };

      const results = await pipelineAsanaToAds({
        taskGid: input.task_id,
        adSetId: input.conjunto_id,
        pageId,
        message: input.texto,
        link: input.link,
        headline: input.titulo || '',
        callToAction: input.cta || 'LEARN_MORE',
      });

      const sucessos = results.filter(r => r.sucesso);
      const falhas = results.filter(r => !r.sucesso);

      return {
        sucesso: falhas.length === 0,
        total_imagens: results.length,
        anuncios_criados: sucessos.length,
        falhas: falhas.length,
        detalhes: results,
        mensagem: sucessos.length > 0
          ? `Pipeline concluído! ${sucessos.length} anúncio(s) criado(s) com sucesso (PAUSADOS). ${falhas.length > 0 ? `${falhas.length} falha(s).` : ''}`
          : 'Nenhum anúncio criado. Verifique se a task tem imagens nos anexos.',
      };
    } catch (err) {
      return { error: `Erro no pipeline: ${err.message}` };
    }
  }

  if (toolName === 'ativar_desativar_ads') {
    if (!input.ids || !Array.isArray(input.ids) || input.ids.length === 0) return { error: 'ids é obrigatório (array de IDs)' };
    if (!input.acao) return { error: 'acao é obrigatória (ativar ou pausar)' };

    try {
      const status = input.acao === 'ativar' ? 'ACTIVE' : 'PAUSED';
      const results = [];

      for (const id of input.ids) {
        try {
          const result = await updateEntityStatus(id, status, 'entidade');
          results.push({ id, sucesso: true, status: result.status });
        } catch (err) {
          results.push({ id, sucesso: false, error: err.message });
        }
      }

      const sucessos = results.filter(r => r.sucesso);
      const falhas = results.filter(r => !r.sucesso);

      return {
        sucesso: falhas.length === 0,
        total: results.length,
        ativados: input.acao === 'ativar' ? sucessos.length : 0,
        pausados: input.acao === 'pausar' ? sucessos.length : 0,
        falhas: falhas.length,
        detalhes: results,
        mensagem: `${sucessos.length}/${results.length} entidade(s) ${input.acao === 'ativar' ? 'ativada(s)' : 'pausada(s)'} com sucesso.`,
      };
    } catch (err) {
      return { error: `Erro ao ${input.acao}: ${err.message}` };
    }
  }

  if (toolName === 'listar_conjuntos') {
    if (!input.campanha_id) return { error: 'campanha_id é obrigatório' };

    try {
      const adSets = await listAdSets(input.campanha_id);
      return {
        sucesso: true,
        total: adSets.length,
        conjuntos: adSets,
        mensagem: adSets.length > 0
          ? `${adSets.length} conjunto(s) encontrado(s).`
          : 'Nenhum conjunto de anúncios encontrado nesta campanha.',
      };
    } catch (err) {
      return { error: `Erro ao listar conjuntos: ${err.message}` };
    }
  }

  if (toolName === 'mover_task_secao') {
    try {
      const projetoLower = (input.projeto || '').toLowerCase();
      const secaoLower = (input.secao || '').toLowerCase();

      // Resolver projeto → GID
      const projectMap = {
        cabine: ASANA_PROJECTS.CABINE,
        design: ASANA_PROJECTS.DESIGN,
        audiovisual: ASANA_PROJECTS.AUDIOVISUAL,
        captacao: ASANA_PROJECTS.CAPTACAO,
      };
      const projectGid = projectMap[projetoLower];
      if (!projectGid) {
        return { error: `Projeto "${input.projeto}" não encontrado. Opções: cabine, design, audiovisual, captacao` };
      }

      // Resolver seção → GID (buscar no ASANA_SECTIONS com match parcial)
      let sectionGid = null;
      for (const [key, gid] of Object.entries(ASANA_SECTIONS)) {
        if (key.toLowerCase().includes(secaoLower) || secaoLower.includes(key.toLowerCase())) {
          sectionGid = gid;
          break;
        }
      }

      if (!sectionGid) {
        // Fallback: buscar seções do projeto via API
        const sections = await asanaRequest(`/projects/${projectGid}/sections?opt_fields=name`);
        if (sections) {
          for (const s of sections) {
            if (s.name.toLowerCase().includes(secaoLower) || secaoLower.includes(s.name.toLowerCase())) {
              sectionGid = s.gid;
              break;
            }
          }
        }
      }

      if (!sectionGid) {
        return { error: `Seção "${input.secao}" não encontrada no projeto "${input.projeto}"` };
      }

      const result = await asanaAddToProject(input.task_gid, projectGid, sectionGid);
      if (result) {
        console.log(`[TOOL] Task ${input.task_gid} movida para seção ${input.secao} no projeto ${input.projeto}`);
        return { success: true, task_gid: input.task_gid, projeto: input.projeto, secao: input.secao };
      } else {
        return { error: 'Erro ao mover task para a seção' };
      }
    } catch (err) {
      return { error: `Erro ao mover task: ${err.message}` };
    }
  }

  if (toolName === 'atribuir_task') {
    try {
      const responsavelLower = (input.responsavel || '').toLowerCase();
      const asanaGid = TEAM_ASANA[responsavelLower];
      if (!asanaGid) {
        const availableNames = Object.keys(TEAM_ASANA).join(', ');
        return { error: `Responsável "${input.responsavel}" não encontrado. Opções: ${availableNames}` };
      }

      const result = await asanaWrite('PUT', `/tasks/${input.task_gid}`, { assignee: asanaGid });
      if (result.success) {
        console.log(`[TOOL] Task ${input.task_gid} atribuída para ${input.responsavel} (${asanaGid})`);
        return { success: true, task_gid: input.task_gid, responsavel: input.responsavel, asana_gid: asanaGid };
      } else {
        return { error: result.error || 'Erro ao atribuir task' };
      }
    } catch (err) {
      return { error: `Erro ao atribuir task: ${err.message}` };
    }
  }

  if (toolName === 'consultar_especialista') {
    try {
      const { JARVIS_IDENTITY, AGENT_EXPERTISE } = await import('../agents/master.mjs');
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

      const expertise = AGENT_EXPERTISE[input.especialista];
      if (!expertise) {
        return { error: `Especialista "${input.especialista}" não encontrado. Disponíveis: creative, manager, researcher, traffic, social` };
      }

      // Carregar cérebro persistente pra dar contexto ao especialista
      let brainContext = '';
      try {
        const { loadBrainDocument } = await import('../brain-document.mjs');
        brainContext = await loadBrainDocument();
      } catch {}

      // Identidade única + expertise específica + contexto de consulta
      const specialistSystem = `${JARVIS_IDENTITY}

${expertise}

${brainContext ? brainContext + '\n\n' : ''}CONTEXTO: Você está sendo consultado por outro agente do time. Responda de forma direta e acionável — sua resposta será integrada na resposta final ao usuário.
Vá direto ao ponto. Sem cumprimentos, sem introdução.`;

      const userMsg = input.contexto_adicional
        ? `${input.pedido}\n\nCONTEXTO/DADOS DISPONÍVEIS:\n${input.contexto_adicional}`
        : input.pedido;

      console.log(`[MULTI-AGENT] 🤝 Agente consultando especialista "${input.especialista}": "${input.pedido.substring(0, 80)}..."`);

      // Usar Sonnet pro especialista consultado — com retry pra 429/529
      let response;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          response = await anthropic.messages.create({
            model: CONFIG.AI_MODEL || 'claude-sonnet-4-6',
            max_tokens: 4000,
            system: specialistSystem,
            messages: [{ role: 'user', content: userMsg }],
          });
          break;
        } catch (err) {
          const status = err?.status || 0;
          if ((status === 429 || status === 529) && attempt < 3) {
            await new Promise(r => setTimeout(r, 2000 * attempt));
            continue;
          }
          throw err;
        }
      }

      const resposta = response.content[0]?.text || '';
      console.log(`[MULTI-AGENT] ✅ Especialista "${input.especialista}" respondeu (${resposta.length} chars)`);

      return {
        sucesso: true,
        especialista: input.especialista,
        resposta: resposta,
        nota: `Resposta do agente ${input.especialista}. Integre esse conteúdo na sua resposta final ao usuário.`,
      };
    } catch (err) {
      console.error(`[MULTI-AGENT] Erro ao consultar especialista:`, err.message);
      return { error: `Erro ao consultar especialista: ${err.message}` };
    }
  }

  // ============================================
  // TOOLS — Diversão (grupos internos apenas)
  // ============================================

  if (toolName === 'gerar_imagem') {
    // Validar que está em grupo interno
    const chatId = context.chatId || '';
    if (!JARVIS_ALLOWED_GROUPS.has(chatId)) {
      return { error: 'Esta tool só funciona nos grupos internos da equipe.' };
    }
    if (!_sendRawFn) return { error: 'WhatsApp não conectado — aguarde a reconexão' };

    try {
      const openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY || process.env.OPENAI_API_KEY });
      const estilo = input.estilo || 'vivid';

      console.log(`[TOOL] gerar_imagem: "${input.prompt.substring(0, 80)}..." (estilo: ${estilo})`);

      const imageResponse = await openai.images.generate({
        model: 'dall-e-3',
        prompt: input.prompt,
        n: 1,
        size: '1024x1024',
        style: estilo,
        response_format: 'url',
      });

      const imageUrl = imageResponse.data[0]?.url;
      if (!imageUrl) return { error: 'DALL-E não retornou imagem' };

      // Baixar imagem
      const imgResp = await fetch(imageUrl);
      if (!imgResp.ok) throw new Error(`Erro ao baixar imagem: ${imgResp.status}`);
      const buffer = Buffer.from(await imgResp.arrayBuffer());

      // Enviar como imagem no grupo
      const result = await _sendRawFn(chatId, {
        image: buffer,
        caption: `🎨 _Imagem gerada por IA_`,
        mimetype: 'image/png',
      });

      console.log(`[TOOL] Imagem gerada e enviada no grupo (${buffer.length} bytes)`);
      return { success: true, mensagem: 'Imagem gerada e enviada com sucesso!' };
    } catch (err) {
      console.error('[TOOL] Erro gerar_imagem:', err.message);
      return { error: `Erro ao gerar imagem: ${err.message}` };
    }
  }

  if (toolName === 'criar_sticker') {
    // Validar que está em grupo interno
    const chatId = context.chatId || '';
    if (!JARVIS_ALLOWED_GROUPS.has(chatId)) {
      return { error: 'Esta tool só funciona nos grupos internos da equipe.' };
    }
    if (!_sendRawFn) return { error: 'WhatsApp não conectado — aguarde a reconexão' };

    try {
      const openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY || process.env.OPENAI_API_KEY });

      console.log(`[TOOL] criar_sticker: "${input.prompt.substring(0, 80)}..."`);

      const imageResponse = await openai.images.generate({
        model: 'dall-e-3',
        prompt: input.prompt,
        n: 1,
        size: '1024x1024',
        style: 'vivid',
        response_format: 'url',
      });

      const imageUrl = imageResponse.data[0]?.url;
      if (!imageUrl) return { error: 'DALL-E não retornou imagem' };

      // Baixar imagem
      const imgResp = await fetch(imageUrl);
      if (!imgResp.ok) throw new Error(`Erro ao baixar imagem: ${imgResp.status}`);
      const pngBuffer = Buffer.from(await imgResp.arrayBuffer());

      // Converter para WebP 512x512 (formato sticker do WhatsApp)
      const webpBuffer = await sharp(pngBuffer)
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 80 })
        .toBuffer();

      // Enviar como sticker
      const result = await _sendRawFn(chatId, { sticker: webpBuffer });

      console.log(`[TOOL] Sticker criado e enviado no grupo (${webpBuffer.length} bytes)`);
      return { success: true, mensagem: 'Sticker criado e enviado com sucesso!' };
    } catch (err) {
      console.error('[TOOL] Erro criar_sticker:', err.message);
      return { error: `Erro ao criar sticker: ${err.message}` };
    }
  }

  if (toolName === 'enviar_audio') {
    const chatId = context.chatId || '';
    if (!chatId) return { error: 'chatId não disponível' };
    if (!input.texto) return { error: 'texto é obrigatório' };

    // Limitar a 50 segundos (~750 caracteres em português)
    let textoAudio = input.texto;
    if (textoAudio.length > 750) {
      textoAudio = textoAudio.substring(0, 750) + '...';
    }

    try {
      const { generateAudio } = await import('../audio.mjs');
      const audioBuffer = await generateAudio(textoAudio);

      if (!audioBuffer) {
        return { error: 'Falha ao gerar áudio via TTS' };
      }

      // Mostrar "gravando..." antes de enviar
      const sendRaw = getSendRawFunction();
      if (sendRaw) {
        await sendRaw(chatId, { audio: audioBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });
        console.log(`[TOOL] Áudio enviado no grupo (${audioBuffer.length} bytes, ${textoAudio.length} chars)`);
        return { success: true, mensagem: 'Áudio enviado com sucesso!' };
      } else {
        return { error: 'Função de envio raw não disponível' };
      }
    } catch (err) {
      console.error('[TOOL] Erro enviar_audio:', err.message);
      return { error: `Erro ao enviar áudio: ${err.message}` };
    }
  }

  return { error: 'Ferramenta desconhecida' };
}
