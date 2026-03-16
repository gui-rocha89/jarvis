// ============================================
// JARVIS 3.0 - Meta Ads Skill
// Integração com Meta Marketing API v25.0
// ============================================
import { CONFIG, META_PAGES_MAP } from '../config.mjs';

const META_BASE = () => `https://graph.facebook.com/${CONFIG.META_API_VERSION || 'v25.0'}`;

// ============================================
// HELPER: Requisição genérica ao Graph API
// ============================================
async function metaRequest(endpoint, method = 'GET', body = null) {
  const url = new URL(`${META_BASE()}${endpoint}`);

  const options = { method, headers: {} };

  if (method === 'GET') {
    url.searchParams.set('access_token', CONFIG.META_ACCESS_TOKEN);
  }

  if (body && method === 'POST') {
    body.access_token = CONFIG.META_ACCESS_TOKEN;
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let retries = 0;
  const maxRetries = 2;

  while (retries <= maxRetries) {
    try {
      const resp = await fetch(url, options);

      // Rate limit — espera e tenta de novo
      if (resp.status === 429 && retries < maxRetries) {
        const retryAfter = parseInt(resp.headers.get('retry-after') || '5');
        console.warn(`[META-ADS] Rate limit (429), aguardando ${retryAfter}s...`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        retries++;
        continue;
      }

      const data = await resp.json();

      if (data.error) {
        throw new Error(`Meta API: ${data.error.message} (code: ${data.error.code})`);
      }

      return data;
    } catch (err) {
      if (retries < maxRetries && err.message?.includes('fetch')) {
        retries++;
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
}

// ============================================
// MAPEAMENTOS
// ============================================
const objectiveMap = {
  'trafego': 'OUTCOME_TRAFFIC',
  'leads': 'OUTCOME_LEADS',
  'engajamento': 'OUTCOME_ENGAGEMENT',
  'vendas': 'OUTCOME_SALES',
  'alcance': 'OUTCOME_AWARENESS',
  'reconhecimento': 'OUTCOME_AWARENESS',
};

const datePresetMap = {
  'hoje': 'today',
  'ontem': 'yesterday',
  '7dias': 'last_7d',
  '30dias': 'last_30d',
  'mes': 'this_month',
};

// ============================================
// RESOLVER CLIENTE → PAGE ID
// ============================================
/**
 * Resolve nome do cliente para o Page ID do Facebook.
 * Busca em META_PAGES_MAP (.env) por match parcial case-insensitive.
 * @param {string} clienteName - Nome do cliente (ex: "minner", "rossato", "pippi")
 * @returns {string|null} Page ID ou null
 */
export function resolvePageId(clienteName) {
  if (!clienteName) return CONFIG.META_PAGE_ID || null;

  const lower = clienteName.toLowerCase().trim();

  // Busca exata primeiro
  if (META_PAGES_MAP[lower]) return META_PAGES_MAP[lower];

  // Busca parcial (ex: "rossato" match "rossato_stara")
  for (const [key, pageId] of Object.entries(META_PAGES_MAP)) {
    if (key.includes(lower) || lower.includes(key)) return pageId;
  }

  return null;
}

/**
 * Lista todas as páginas disponíveis no mapeamento
 */
export function listAvailablePages() {
  return Object.entries(META_PAGES_MAP).map(([nome, pageId]) => ({ nome, pageId }));
}

// ============================================
// CAMPANHAS
// ============================================

/**
 * Lista campanhas da conta de anúncios
 * @param {string} statusFilter - 'ACTIVE', 'PAUSED', ou null para todas
 */
export async function listCampaigns(statusFilter = null) {
  const adAccount = CONFIG.META_AD_ACCOUNT_ID;
  if (!adAccount) throw new Error('META_AD_ACCOUNT_ID não configurado');

  let endpoint = `/${adAccount}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time,created_time&limit=50`;
  if (statusFilter) endpoint += `&filtering=[{"field":"status","operator":"EQUAL","value":"${statusFilter}"}]`;

  const data = await metaRequest(endpoint);
  return (data.data || []).map(c => ({
    id: c.id,
    nome: c.name,
    status: c.status,
    objetivo: c.objective,
    orcamento_diario: c.daily_budget ? (parseInt(c.daily_budget) / 100).toFixed(2) : null,
    orcamento_total: c.lifetime_budget ? (parseInt(c.lifetime_budget) / 100).toFixed(2) : null,
    inicio: c.start_time,
    fim: c.stop_time,
    criado_em: c.created_time,
  }));
}

/**
 * Busca métricas de uma campanha ou da conta toda
 * @param {string|null} campaignId - ID da campanha (null = conta toda)
 * @param {string} periodo - 'hoje', 'ontem', '7dias', '30dias', 'mes'
 */
export async function getCampaignInsights(campaignId, periodo = '7dias') {
  const target = campaignId || CONFIG.META_AD_ACCOUNT_ID;
  if (!target) throw new Error('ID da campanha ou META_AD_ACCOUNT_ID necessário');

  const datePreset = datePresetMap[periodo] || periodo;
  const fields = 'impressions,clicks,spend,cpc,ctr,cpm,reach,frequency,actions,cost_per_action_type';

  const data = await metaRequest(`/${target}/insights?fields=${fields}&date_preset=${datePreset}`);
  const insights = data.data?.[0];

  if (!insights) return { periodo, mensagem: 'Sem dados para o período selecionado', metricas: null };

  // Extrair conversões do array actions
  const conversoes = {};
  if (insights.actions) {
    for (const action of insights.actions) {
      conversoes[action.action_type] = parseInt(action.value);
    }
  }

  return {
    periodo,
    metricas: {
      impressoes: parseInt(insights.impressions || 0),
      cliques: parseInt(insights.clicks || 0),
      alcance: parseInt(insights.reach || 0),
      gasto: `R$ ${parseFloat(insights.spend || 0).toFixed(2)}`,
      cpc: `R$ ${parseFloat(insights.cpc || 0).toFixed(2)}`,
      ctr: `${parseFloat(insights.ctr || 0).toFixed(2)}%`,
      cpm: `R$ ${parseFloat(insights.cpm || 0).toFixed(2)}`,
      frequencia: parseFloat(insights.frequency || 0).toFixed(2),
      conversoes,
    },
  };
}

/**
 * Cria uma nova campanha
 * SEMPRE cria como PAUSED por segurança
 */
export async function createCampaign({ name, objective, dailyBudget, status = 'PAUSED' }) {
  const adAccount = CONFIG.META_AD_ACCOUNT_ID;
  if (!adAccount) throw new Error('META_AD_ACCOUNT_ID não configurado');

  const objectiveApi = objectiveMap[objective?.toLowerCase()] || objective;
  if (!objectiveApi) throw new Error(`Objetivo inválido: ${objective}. Use: trafego, leads, engajamento, vendas, alcance`);

  // Converte reais para centavos
  const budgetCents = Math.round(parseFloat(dailyBudget) * 100);

  const body = {
    name,
    objective: objectiveApi,
    daily_budget: budgetCents,
    status: status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED', // Segurança: default PAUSED
    special_ad_categories: [],
  };

  const data = await metaRequest(`/${adAccount}/campaigns`, 'POST', body);
  console.log(`[META-ADS] Campanha criada: ${data.id} "${name}" (${status})`);
  return { id: data.id, name, objective: objectiveApi, dailyBudget, status: body.status };
}

/**
 * Atualiza status de uma campanha (pausar/retomar)
 */
export async function updateCampaignStatus(campaignId, status) {
  const newStatus = status === 'ACTIVE' || status === 'retomar' ? 'ACTIVE' : 'PAUSED';
  await metaRequest(`/${campaignId}`, 'POST', { status: newStatus });
  console.log(`[META-ADS] Campanha ${campaignId} → ${newStatus}`);
  return { id: campaignId, status: newStatus };
}

/**
 * Métricas gerais da conta de anúncios
 */
export async function getAccountInsights(periodo = '30dias') {
  return getCampaignInsights(null, periodo);
}

// ============================================
// SOCIAL MEDIA (Pages API)
// ============================================

/**
 * Lista posts recentes de uma página (resolve por nome do cliente)
 * @param {number} limit - Quantidade de posts
 * @param {string|null} cliente - Nome do cliente (resolve via META_PAGES_MAP)
 */
export async function getPagePosts(limit = 10, cliente = null) {
  const pageId = resolvePageId(cliente) || CONFIG.META_PAGE_ID;
  if (!pageId) throw new Error('Página não encontrada. Informe o nome do cliente ou configure META_PAGE_ID.');

  const data = await metaRequest(`/${pageId}/feed?fields=id,message,created_time,permalink_url&limit=${limit}`);
  return (data.data || []).map(p => ({
    id: p.id,
    texto: p.message || '(sem texto)',
    data: p.created_time,
    link: p.permalink_url,
  }));
}

/**
 * Publica ou agenda um post na página (resolve por nome do cliente)
 * @param {string|null} cliente - Nome do cliente (resolve via META_PAGES_MAP)
 */
export async function publishPagePost({ message, link, imageUrl, scheduledTime, cliente = null }) {
  const pageId = resolvePageId(cliente) || CONFIG.META_PAGE_ID;
  if (!pageId) throw new Error('Página não encontrada. Informe o nome do cliente ou configure META_PAGE_ID.');

  const body = { message };
  if (link) body.link = link;

  // Agendar para o futuro (timestamp Unix)
  if (scheduledTime) {
    const ts = Math.floor(new Date(scheduledTime).getTime() / 1000);
    body.scheduled_publish_time = ts;
    body.published = false;
  }

  let endpoint = `/${pageId}/feed`;

  // Se tem imagem, usa endpoint de photos
  if (imageUrl) {
    endpoint = `/${pageId}/photos`;
    body.url = imageUrl;
  }

  const data = await metaRequest(endpoint, 'POST', body);
  console.log(`[META-ADS] Post ${scheduledTime ? 'agendado' : 'publicado'}: ${data.id} (página: ${pageId})`);
  return { id: data.id, agendado: !!scheduledTime, pageId };
}

// ============================================
// EXPORTS PARA TESTES
// ============================================
export { metaRequest, objectiveMap, datePresetMap };
