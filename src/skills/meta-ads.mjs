// ============================================
// JARVIS 3.0 - Meta Ads Skill
// Integração com Meta Marketing API v25.0
// ============================================
import { CONFIG, META_PAGES_MAP, META_WHATSAPP_MAP } from '../config.mjs';

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
        const errMsg = data.error.error_user_msg || data.error.message;
        const subcode = data.error.error_subcode ? `, subcode: ${data.error.error_subcode}` : '';
        console.error(`[META-ADS] ❌ API Error: ${JSON.stringify(data.error)}`);
        throw new Error(`Meta API: ${errMsg} (code: ${data.error.code}${subcode})`);
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
 * Resolve nome do cliente para o número WhatsApp (para anúncios click-to-WhatsApp).
 * Busca em META_WHATSAPP_MAP (.env) por match parcial case-insensitive.
 * @param {string} clienteName - Nome do cliente (ex: "rossato", "minner")
 * @returns {string|null} Número WhatsApp formatado (ex: "555599767916") ou null
 */
export function resolveWhatsAppNumber(clienteName) {
  if (!clienteName) return null;

  const lower = clienteName.toLowerCase().trim();

  // Busca exata primeiro
  if (META_WHATSAPP_MAP[lower]) return META_WHATSAPP_MAP[lower];

  // Busca parcial
  for (const [key, number] of Object.entries(META_WHATSAPP_MAP)) {
    if (key.includes(lower) || lower.includes(key)) return number;
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
// AD SETS (Conjuntos de Anúncios)
// ============================================

/**
 * Cria um conjunto de anúncios (Ad Set) vinculado a uma campanha
 * @param {Object} params
 * @param {string} params.campaignId - ID da campanha pai
 * @param {string} params.name - Nome do conjunto
 * @param {number} params.dailyBudget - Orçamento diário em reais
 * @param {Object} params.targeting - Segmentação (cidades, idade, interesses)
 * @param {string} params.optimizationGoal - Objetivo de otimização (LINK_CLICKS, REACH, IMPRESSIONS, LANDING_PAGE_VIEWS)
 * @param {string} params.billingEvent - Evento de cobrança (IMPRESSIONS, LINK_CLICKS)
 * @param {string} params.status - Status inicial (default: PAUSED)
 */
export async function createAdSet({
  campaignId, name, dailyBudget, targeting = {},
  optimizationGoal = 'LINK_CLICKS', billingEvent = 'IMPRESSIONS',
  status = 'PAUSED', startTime = null, promotedObject = null,
  destinationType = null,
}) {
  const adAccount = CONFIG.META_AD_ACCOUNT_ID;
  if (!adAccount) throw new Error('META_AD_ACCOUNT_ID não configurado');
  if (!campaignId) throw new Error('campaignId é obrigatório');

  const budgetCents = Math.round(parseFloat(dailyBudget) * 100);

  // Buscar objetivo da campanha pai pra determinar promoted_object automaticamente
  let campaignObjective = null;
  try {
    const campaign = await metaRequest(`/${campaignId}?fields=objective`);
    campaignObjective = campaign?.objective;
    console.log(`[META-ADS] Campanha ${campaignId} objetivo: ${campaignObjective}`);
  } catch (err) {
    console.warn(`[META-ADS] Não conseguiu buscar objetivo da campanha: ${err.message}`);
  }

  // Montar targeting padrão se não especificado
  const targetingSpec = {
    geo_locations: targeting.geoLocations || { countries: ['BR'] },
    age_min: targeting.ageMin || 18,
    age_max: targeting.ageMax || 65,
  };

  // Cidades específicas (ex: [{ key: '123456', name: 'Cuiabá' }])
  if (targeting.cities) {
    targetingSpec.geo_locations = { cities: targeting.cities };
  }

  // Regiões/estados (ex: [{ key: '11' }] para MT)
  if (targeting.regions) {
    targetingSpec.geo_locations = { ...targetingSpec.geo_locations, regions: targeting.regions };
  }

  // Interesses (ex: [{ id: '123', name: 'Agronegócio' }])
  if (targeting.interests) {
    targetingSpec.flexible_spec = [{ interests: targeting.interests }];
  }

  const body = {
    campaign_id: campaignId,
    name,
    daily_budget: budgetCents,
    optimization_goal: optimizationGoal,
    billing_event: billingEvent,
    targeting: targetingSpec,
    status: status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED',
  };

  // promoted_object é OBRIGATÓRIO para a maioria dos objetivos de campanha
  // Se não foi passado manualmente, resolver automaticamente pelo objetivo
  if (promotedObject) {
    body.promoted_object = promotedObject;
  } else if (campaignObjective) {
    const pixelId = CONFIG.META_PIXEL_ID;
    const pageId = targeting.pageId || CONFIG.META_PAGE_ID;

    // Mapear objetivo → promoted_object correto
    if (['OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT'].includes(campaignObjective)) {
      if (pixelId) {
        body.promoted_object = { pixel_id: pixelId, custom_event_type: 'CONTENT_VIEW' };
      } else if (pageId) {
        body.promoted_object = { page_id: pageId };
      }
    } else if (campaignObjective === 'OUTCOME_LEADS') {
      if (pixelId) {
        body.promoted_object = { pixel_id: pixelId, custom_event_type: 'LEAD' };
      } else if (pageId) {
        body.promoted_object = { page_id: pageId };
      }
    } else if (campaignObjective === 'OUTCOME_SALES') {
      if (pixelId) {
        body.promoted_object = { pixel_id: pixelId, custom_event_type: 'PURCHASE' };
      }
    } else if (campaignObjective === 'OUTCOME_AWARENESS') {
      // Awareness não precisa de promoted_object obrigatoriamente
    }
  }

  // destination_type para campanhas de tráfego
  // Para click-to-WhatsApp: usar WEBSITE + link wa.me/numero no criativo (não requer integração WA Business)
  if (destinationType === 'WHATSAPP') {
    body.destination_type = 'WEBSITE';
  } else if (destinationType) {
    body.destination_type = destinationType;
  } else if (campaignObjective === 'OUTCOME_TRAFFIC' && !body.destination_type) {
    body.destination_type = 'WEBSITE';
  }

  if (startTime) {
    body.start_time = new Date(startTime).toISOString();
  }

  const logBody = { ...body, targeting: '(omitted)', access_token: '(omitted)' };
  console.log(`[META-ADS] Criando Ad Set com body:`, JSON.stringify(logBody));

  try {
    const data = await metaRequest(`/${adAccount}/adsets`, 'POST', body);
    console.log(`[META-ADS] Ad Set criado: ${data.id} "${name}" (campanha: ${campaignId})`);
    return { id: data.id, name, campaignId, dailyBudget, status: body.status };
  } catch (err) {
    // Se falhou com destination_type diferente de WEBSITE, retry com WEBSITE
    if (body.destination_type && body.destination_type !== 'WEBSITE' && err.message?.includes('code: 100')) {
      console.warn(`[META-ADS] ⚠️ Falhou com destination_type=${body.destination_type}, tentando WEBSITE...`);
      body.destination_type = 'WEBSITE';
      // Para WEBSITE, promoted_object com pixel é melhor, mas page_id funciona
      const data = await metaRequest(`/${adAccount}/adsets`, 'POST', body);
      console.log(`[META-ADS] Ad Set criado (fallback WEBSITE): ${data.id} "${name}" (campanha: ${campaignId})`);
      return { id: data.id, name, campaignId, dailyBudget, status: body.status, destinationFallback: 'WEBSITE' };
    }
    throw err;
  }
}

/**
 * Lista conjuntos de anúncios de uma campanha
 */
export async function listAdSets(campaignId) {
  if (!campaignId) throw new Error('campaignId é obrigatório');

  const data = await metaRequest(`/${campaignId}/adsets?fields=id,name,status,daily_budget,targeting,optimization_goal,start_time&limit=50`);
  return (data.data || []).map(a => ({
    id: a.id,
    nome: a.name,
    status: a.status,
    orcamento_diario: a.daily_budget ? (parseInt(a.daily_budget) / 100).toFixed(2) : null,
    objetivo_otimizacao: a.optimization_goal,
    inicio: a.start_time,
  }));
}

// ============================================
// CRIATIVOS E ANÚNCIOS
// ============================================

/**
 * Faz upload de uma imagem para a conta de anúncios do Meta
 * @param {Buffer} imageBuffer - Buffer da imagem
 * @param {string} fileName - Nome do arquivo
 * @returns {Object} { hash, url } - Hash para usar em criativos
 */
export async function uploadAdImage(imageBuffer, fileName = 'ad_image.jpg') {
  const adAccount = CONFIG.META_AD_ACCOUNT_ID;
  if (!adAccount) throw new Error('META_AD_ACCOUNT_ID não configurado');

  // Meta Ads API aceita upload via multipart/form-data com bytes em base64
  const base64 = imageBuffer.toString('base64');

  const formBody = new URLSearchParams();
  formBody.append('access_token', CONFIG.META_ACCESS_TOKEN);
  formBody.append('filename', fileName);
  formBody.append('bytes', base64);

  const url = `${META_BASE()}/${adAccount}/adimages`;

  let retries = 0;
  while (retries <= 2) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        body: formBody,
      });

      const data = await resp.json();
      if (data.error) throw new Error(`Meta API: ${data.error.message} (code: ${data.error.code})`);

      // Resposta vem em data.images.{filename}.hash
      const imageData = data.images?.[fileName] || Object.values(data.images || {})[0];
      if (!imageData?.hash) throw new Error('Upload retornou sem hash da imagem');

      console.log(`[META-ADS] Imagem uploaded: ${imageData.hash} (${fileName})`);
      return { hash: imageData.hash, url: imageData.url || null };
    } catch (err) {
      if (retries < 2 && err.message?.includes('fetch')) {
        retries++;
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Cria um criativo de anúncio (Ad Creative)
 * @param {Object} params
 * @param {string} params.imageHash - Hash da imagem (de uploadAdImage)
 * @param {string} params.pageId - Page ID do Facebook
 * @param {string} params.message - Texto/copy principal do anúncio
 * @param {string} params.link - URL de destino
 * @param {string} params.headline - Título do anúncio (aparece no card)
 * @param {string} params.description - Descrição abaixo do título
 * @param {string} params.callToAction - CTA (LEARN_MORE, SHOP_NOW, SIGN_UP, etc.)
 * @param {string} params.name - Nome interno do criativo
 */
export async function createAdCreative({
  imageHash, pageId, message, link,
  headline = '', description = '',
  callToAction = 'LEARN_MORE', name = null,
}) {
  const adAccount = CONFIG.META_AD_ACCOUNT_ID;
  if (!adAccount) throw new Error('META_AD_ACCOUNT_ID não configurado');
  if (!imageHash) throw new Error('imageHash é obrigatório (faça upload primeiro)');
  if (!pageId) throw new Error('pageId é obrigatório');

  const body = {
    name: name || `Creative - ${new Date().toISOString().split('T')[0]}`,
    object_story_spec: {
      page_id: pageId,
      link_data: {
        image_hash: imageHash,
        link: link || 'https://www.facebook.com/',
        message: message || '',
        name: headline || undefined,
        description: description || undefined,
        call_to_action: { type: callToAction },
      },
    },
  };

  const data = await metaRequest(`/${adAccount}/adcreatives`, 'POST', body);
  console.log(`[META-ADS] Creative criado: ${data.id}`);
  return { id: data.id, name: body.name };
}

/**
 * Cria um anúncio (Ad) vinculando criativo + conjunto
 * SEMPRE criado como PAUSED por segurança
 */
export async function createAd({ adSetId, creativeId, name, status = 'PAUSED' }) {
  const adAccount = CONFIG.META_AD_ACCOUNT_ID;
  if (!adAccount) throw new Error('META_AD_ACCOUNT_ID não configurado');
  if (!adSetId) throw new Error('adSetId é obrigatório');
  if (!creativeId) throw new Error('creativeId é obrigatório');

  const body = {
    name: name || `Ad - ${new Date().toISOString().split('T')[0]}`,
    adset_id: adSetId,
    creative: { creative_id: creativeId },
    status: status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED',
  };

  const data = await metaRequest(`/${adAccount}/ads`, 'POST', body);
  console.log(`[META-ADS] Anúncio criado: ${data.id} "${body.name}" (adset: ${adSetId})`);
  return { id: data.id, name: body.name, adSetId, creativeId, status: body.status };
}

// ============================================
// STATUS GENÉRICO (Campanha, Ad Set, Anúncio)
// ============================================

/**
 * Atualiza status de qualquer entidade Meta Ads (campanha, ad set ou anúncio)
 * @param {string} entityId - ID da entidade
 * @param {string} status - 'ACTIVE', 'PAUSED', 'retomar', 'pausar'
 * @param {string} entityType - 'campanha', 'conjunto', 'anuncio' (para log)
 */
export async function updateEntityStatus(entityId, status, entityType = 'entidade') {
  const newStatus = (status === 'ACTIVE' || status === 'retomar' || status === 'ativar') ? 'ACTIVE' : 'PAUSED';
  await metaRequest(`/${entityId}`, 'POST', { status: newStatus });
  console.log(`[META-ADS] ${entityType} ${entityId} → ${newStatus}`);
  return { id: entityId, status: newStatus, tipo: entityType };
}

// ============================================
// ASANA → ATTACHMENTS (baixar anexos de tasks)
// ============================================

/**
 * Lista e opcionalmente baixa anexos de uma task do Asana
 * @param {string} taskGid - GID da task
 * @param {boolean} download - Se true, baixa o conteúdo dos anexos
 * @returns {Array} Lista de anexos com download_url e opcionalmente buffer
 */
export async function asanaGetAttachments(taskGid, download = false) {
  if (!CONFIG.ASANA_PAT) throw new Error('ASANA_PAT não configurado');

  const resp = await fetch(`https://app.asana.com/api/1.0/tasks/${taskGid}/attachments?opt_fields=name,download_url,host,size,created_at,resource_type`, {
    headers: { Authorization: `Bearer ${CONFIG.ASANA_PAT}`, Accept: 'application/json' },
  });

  if (!resp.ok) throw new Error(`Asana API erro: ${resp.status}`);
  const json = await resp.json();
  const attachments = json.data || [];

  if (!download) {
    return attachments.map(a => ({
      gid: a.gid,
      nome: a.name,
      tamanho: a.size,
      host: a.host,
      download_url: a.download_url,
      criado_em: a.created_at,
    }));
  }

  // Baixar conteúdo de cada anexo (filtrar só imagens)
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  const results = [];

  for (const att of attachments) {
    const isImage = imageExts.some(ext => (att.name || '').toLowerCase().endsWith(ext));
    if (!isImage) {
      results.push({ gid: att.gid, nome: att.name, tipo: 'nao_imagem', buffer: null });
      continue;
    }

    if (!att.download_url) {
      results.push({ gid: att.gid, nome: att.name, tipo: 'sem_url', buffer: null });
      continue;
    }

    try {
      const dlResp = await fetch(att.download_url);
      if (!dlResp.ok) throw new Error(`Download falhou: ${dlResp.status}`);
      const buffer = Buffer.from(await dlResp.arrayBuffer());
      results.push({ gid: att.gid, nome: att.name, tipo: 'imagem', buffer, tamanho: buffer.length });
    } catch (err) {
      console.error(`[META-ADS] Erro ao baixar anexo ${att.name}:`, err.message);
      results.push({ gid: att.gid, nome: att.name, tipo: 'erro', error: err.message, buffer: null });
    }
  }

  return results;
}

// ============================================
// PIPELINE COMPLETO: Asana → Meta Ads
// ============================================

/**
 * Pipeline completo: pega imagens de uma task Asana, sobe pro Meta, cria criativo + anúncio
 * @param {Object} params
 * @param {string} params.taskGid - GID da task com os criativos
 * @param {string} params.adSetId - ID do conjunto de anúncios
 * @param {string} params.pageId - Page ID do Facebook
 * @param {string} params.message - Copy do anúncio
 * @param {string} params.link - URL de destino
 * @param {string} params.headline - Título
 * @param {string} params.callToAction - CTA
 * @returns {Array} Lista de anúncios criados
 */
export async function pipelineAsanaToAds({
  taskGid, adSetId, pageId, message, link,
  headline = '', callToAction = 'LEARN_MORE',
}) {
  if (!taskGid) throw new Error('taskGid é obrigatório');
  if (!adSetId) throw new Error('adSetId é obrigatório');
  if (!pageId) throw new Error('pageId é obrigatório');

  console.log(`[META-ADS] Pipeline: Task ${taskGid} → Meta Ads`);

  // 1. Baixar anexos de imagem da task
  const attachments = await asanaGetAttachments(taskGid, true);
  const images = attachments.filter(a => a.tipo === 'imagem' && a.buffer);

  if (images.length === 0) {
    throw new Error('Nenhuma imagem encontrada nos anexos da task do Asana');
  }

  console.log(`[META-ADS] ${images.length} imagens encontradas, subindo pro Meta...`);

  // 2. Upload de cada imagem e criar anúncio
  const results = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    try {
      // Upload
      const uploaded = await uploadAdImage(img.buffer, img.nome);

      // Criar criativo
      const creative = await createAdCreative({
        imageHash: uploaded.hash,
        pageId,
        message,
        link,
        headline,
        callToAction,
        name: `Creative - ${img.nome}`,
      });

      // Criar anúncio (PAUSED)
      const ad = await createAd({
        adSetId,
        creativeId: creative.id,
        name: `Ad - ${img.nome}`,
        status: 'PAUSED',
      });

      results.push({
        sucesso: true,
        imagem: img.nome,
        image_hash: uploaded.hash,
        creative_id: creative.id,
        ad_id: ad.id,
        status: 'PAUSADO',
      });
    } catch (err) {
      console.error(`[META-ADS] Erro no pipeline para ${img.nome}:`, err.message);
      results.push({ sucesso: false, imagem: img.nome, error: err.message });
    }
  }

  return results;
}

// ============================================
// EXPORTS PARA TESTES
// ============================================
export { metaRequest, objectiveMap, datePresetMap };
