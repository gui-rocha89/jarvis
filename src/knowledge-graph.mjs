// ============================================
// KNOWLEDGE GRAPH — Migração inicial e ingestão (v6.0)
// ============================================
// Popula knowledge_entities a partir do que JÁ TEMOS no servidor:
// - Clientes: managedClients + META_PAGES_MAP + ASANA_CLIENTE_MAP + jarvis_profiles
// - Equipe: TEAM_ASANA + teamWhatsApp
// - Sub-marcas/projetos: descoberta via menções recorrentes em jarvis_messages
//
// CUSTO ZERO de IA — usa SQL e dados estruturados existentes.
// ============================================

import { CONFIG, TEAM_ASANA, ASANA_CLIENTE_MAP, managedClients, teamWhatsApp } from './config.mjs';
import { pool, upsertEntity, getEntityStats } from './database.mjs';

/**
 * Migração inicial — chamada uma vez no boot.
 * Idempotente (pode rodar várias vezes sem duplicar).
 */
export async function seedKnowledgeGraph() {
  console.log('[KG] Iniciando seed do Knowledge Graph...');
  let added = 0, updated = 0;

  // ============================================
  // 1. CLIENTES (de managedClients + ASANA_CLIENTE_MAP + META_PAGES_MAP)
  // ============================================
  const clientesMap = new Map(); // nome_normalizado -> { nome, aliases, metadata }

  // Source 1: managedClients (Map<jid, config>)
  if (managedClients) {
    for (const [jid, client] of managedClients) {
      const nome = client.groupName || client.name || client.slug;
      if (!nome) continue;
      const slug = (client.slug || nome).toLowerCase().replace(/[^a-z0-9]/g, '_');
      clientesMap.set(slug, {
        nome,
        aliases: [client.slug, client.groupName].filter(Boolean),
        metadata: { managed: true, group_jid: jid, ativo: client.active !== false },
      });
    }
  }

  // Source 2: ASANA_CLIENTE_MAP
  if (ASANA_CLIENTE_MAP) {
    for (const [nome, gid] of Object.entries(ASANA_CLIENTE_MAP)) {
      const slug = nome.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const existing = clientesMap.get(slug) || { nome, aliases: [], metadata: {} };
      existing.metadata = { ...existing.metadata, asana_gid: gid };
      existing.aliases = [...new Set([...existing.aliases, nome])];
      clientesMap.set(slug, existing);
    }
  }

  // Source 3: META_PAGES_MAP (do .env)
  let metaPages = {};
  try { metaPages = JSON.parse(process.env.META_PAGES_MAP || '{}'); } catch {}
  for (const [slug, pageId] of Object.entries(metaPages)) {
    const nome = slug.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const existing = clientesMap.get(slug) || { nome, aliases: [], metadata: {} };
    existing.metadata = { ...existing.metadata, meta_page_id: pageId };
    existing.aliases = [...new Set([...existing.aliases, slug])];
    clientesMap.set(slug, existing);
  }

  // Insere clientes
  for (const [slug, info] of clientesMap) {
    try {
      const result = await upsertEntity({
        nome: info.nome,
        tipo: 'cliente',
        aliases: info.aliases,
        metadata: { ...info.metadata, slug },
        source: 'seed_auto',
      });
      if (result.criado_em.getTime() === result.atualizado_em.getTime()) added++;
      else updated++;
    } catch (err) {
      console.error(`[KG] Erro seed cliente ${info.nome}:`, err.message);
    }
  }

  // ============================================
  // 2. EQUIPE (de TEAM_ASANA + teamWhatsApp)
  // ============================================
  const equipeMap = new Map();

  if (TEAM_ASANA) {
    for (const [nome, gid] of Object.entries(TEAM_ASANA)) {
      const slug = nome.toLowerCase().replace(/[^a-z0-9]/g, '_');
      equipeMap.set(slug, {
        nome,
        aliases: [nome.split(/\s+/)[0]], // primeiro nome como alias
        metadata: { asana_gid: gid },
      });
    }
  }

  if (teamWhatsApp) {
    for (const [key, jid] of teamWhatsApp) {
      const slug = key.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const existing = equipeMap.get(slug) || { nome: key, aliases: [], metadata: {} };
      existing.metadata = { ...existing.metadata, whatsapp_jid: jid };
      equipeMap.set(slug, existing);
    }
  }

  for (const [slug, info] of equipeMap) {
    try {
      const result = await upsertEntity({
        nome: info.nome,
        tipo: 'pessoa_equipe',
        aliases: info.aliases,
        metadata: { ...info.metadata, slug },
        source: 'seed_auto',
      });
      if (result.criado_em.getTime() === result.atualizado_em.getTime()) added++;
      else updated++;
    } catch (err) {
      console.error(`[KG] Erro seed equipe ${info.nome}:`, err.message);
    }
  }

  // ============================================
  // 3. FERRAMENTAS INTERNAS (conhecidas hardcoded)
  // ============================================
  const ferramentas = [
    { nome: 'Asana', aliases: ['asana', 'app.asana'], descricao: 'Plataforma de gestão de projetos. Stream Lab usa pra todas as tasks de clientes e equipe.' },
    { nome: 'GuardiaoLab', aliases: ['guardião lab', 'guardiao lab'], descricao: 'Servidor de arquivos interno da Stream Lab.' },
    { nome: 'Cabine de Comando', aliases: ['cabine'], descricao: 'Projeto principal no Asana onde entram todas as demandas novas dos clientes.' },
    { nome: 'Meta Ads', aliases: ['facebook ads', 'instagram ads'], descricao: 'Plataforma de tráfego pago da Meta. Stream Lab gerencia campanhas pra múltiplos clientes via API.' },
  ];

  for (const f of ferramentas) {
    try {
      const result = await upsertEntity({
        nome: f.nome,
        tipo: 'ferramenta_interna',
        aliases: f.aliases,
        descricao: f.descricao,
        source: 'seed_auto',
      });
      if (result.criado_em.getTime() === result.atualizado_em.getTime()) added++;
      else updated++;
    } catch {}
  }

  // ============================================
  // 4. CAMPANHAS (descoberta via Meta Ads — opcional, custo zero)
  // ============================================
  // Pega campanhas ativas/recentes via API direta — usa o token que já existe
  if (CONFIG.META_ACCESS_TOKEN && CONFIG.META_AD_ACCOUNT_ID) {
    try {
      const url = `https://graph.facebook.com/v25.0/${CONFIG.META_AD_ACCOUNT_ID}/campaigns?fields=id,name,status,objective,created_time&limit=100&access_token=${CONFIG.META_ACCESS_TOKEN}`;
      const resp = await fetch(url);
      const data = await resp.json();
      if (data.data) {
        for (const camp of data.data) {
          // Tenta inferir cliente do nome (ex: "[ROSSATO] Tráfego..." → cliente=rossato)
          const match = camp.name?.match(/\[([^\]]+)\]/);
          const cliente = match ? match[1].toLowerCase() : null;
          try {
            const result = await upsertEntity({
              nome: camp.name || `Campanha ${camp.id}`,
              tipo: 'campanha',
              aliases: [camp.id],
              descricao: `Status: ${camp.status} · Objetivo: ${camp.objective}`,
              metadata: { meta_id: camp.id, status: camp.status, cliente_inferido: cliente, created_time: camp.created_time },
              source: 'seed_meta_api',
              status: camp.status === 'DELETED' ? 'deprecated' : 'ativo',
            });
            if (result.criado_em.getTime() === result.atualizado_em.getTime()) added++;
            else updated++;
          } catch {}
        }
      }
    } catch (err) {
      console.warn('[KG] Erro buscar campanhas Meta:', err.message);
    }
  }

  // ============================================
  // 5. SUB-MARCAS / PROJETOS conhecidos (hardcoded das memórias do Gui)
  // ============================================
  // Adicionar as que já SABEMOS que existem (caso Stream Health, Stream Academy)
  const subMarcas = [
    {
      nome: 'Stream Lab',
      tipo: 'cliente',
      aliases: ['streamlab', 'lab', 'stream_lab'],
      descricao: 'A própria empresa. Laboratório criativo de marketing. Gui Rocha é o dono. Equipe: Bruna, Nicolas, Arthur, Bruno, Rigon.',
    },
    {
      nome: 'Stream Health',
      tipo: 'sub_marca',
      aliases: ['streamhealth', 'stream_health'],
      descricao: 'Sub-marca/projeto da Stream Lab. STATUS DESCONHECIDO — precisa ser confirmado pelo Gui se ainda está ativa, descontinuada ou era um teste. Aparece no Meta Ads como campanha. Pasta no servidor: \\\\GuardiaoLab\\Stream_Lab\\STREAM HEALTH\\LOGO',
      metadata: { confirmar_com: 'Gui', motivo: 'Aparece no Meta Ads e em arquivo, mas sem contexto explícito' },
    },
    {
      nome: 'Streamlab Academy',
      tipo: 'sub_marca',
      aliases: ['streamlab_academy', 'academy'],
      descricao: 'Sub-marca/iniciativa de educação da Stream Lab. Tem página no Facebook (ID 757838837423419).',
    },
    {
      nome: 'Medical Planner',
      tipo: 'cliente',
      aliases: ['medical_planner', 'medical', 'planner'],
      descricao: 'Cliente da Stream Lab. Ferramenta/produto pra médicos gestores. Tem campanha no Meta Ads (ID page 967500383121088). Evento associado: Jornada Sul Brasileira de Cirurgia Plástica (23-25/04/2026, Hilton POA).',
    },
  ];

  for (const sm of subMarcas) {
    try {
      const result = await upsertEntity({
        nome: sm.nome,
        tipo: sm.tipo,
        aliases: sm.aliases,
        descricao: sm.descricao,
        metadata: sm.metadata || {},
        source: 'seed_manual',
      });
      if (result.criado_em.getTime() === result.atualizado_em.getTime()) added++;
      else updated++;
    } catch {}
  }

  const stats = await getEntityStats();
  console.log(`[KG] Seed completo. ${added} novos, ${updated} atualizados.`);
  console.log(`[KG] Total por tipo:`, stats);
  return { added, updated, stats };
}
