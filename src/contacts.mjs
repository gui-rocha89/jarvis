// ============================================
// CROSS-CHANNEL IDENTITY (v6.0 — Sprint 4)
// ============================================
// Resolve: mesma pessoa em WhatsApp + Instagram + Email = 3 perfis isolados.
// Agora todos os canais resolvem pra mesma identidade canônica.
//
// Lógica de matching:
// 1. Match exato por alias_id (mesmo JID já visto) → instant
// 2. Match por nome similar (Levenshtein ≤ 2) — só se nome ≥ 3 chars E não genérico
// 3. Caso incerto: cria nova identidade (nunca merge agressivo)
// ============================================

import { pool } from './database.mjs';

// Nomes muito comuns que NÃO devem causar match cross-channel
// (evita fundir "João Silva" do Insta com "João Pereira" do WhatsApp)
const NOMES_GENERICOS = new Set([
  'maria', 'joao', 'jose', 'ana', 'pedro', 'paulo', 'carlos', 'antonio',
  'francisco', 'luiz', 'lucas', 'daniel', 'rafael', 'felipe', 'fernando',
  'desconhecido', 'unknown', 'null', 'undefined', 'sem nome',
]);

/**
 * Distância Levenshtein iterativa (para fuzzy match de nomes)
 */
function levenshtein(a, b) {
  if (!a || !b) return Math.max((a || '').length, (b || '').length);
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99; // shortcut
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function _normalizeName(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function _isGenericName(name) {
  const norm = _normalizeName(name);
  if (!norm || norm.length < 3) return true;
  const firstWord = norm.split(/\s+/)[0];
  return NOMES_GENERICOS.has(firstWord);
}

function _detectChannel(aliasId) {
  if (!aliasId) return 'unknown';
  if (aliasId.includes('@s.whatsapp.net') || aliasId.includes('@g.us') || aliasId.includes('@lid')) return 'whatsapp';
  if (aliasId.startsWith('instagram_')) return 'instagram';
  if (aliasId.startsWith('email_') || aliasId.includes('@')) return 'email';
  return 'unknown';
}

/**
 * Inicializa tabelas (chamada no boot via initDB seria ideal, mas aqui é idempotente)
 */
export async function initContactAliases() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contact_aliases (
        id SERIAL PRIMARY KEY,
        canonical_id TEXT NOT NULL,
        alias_id TEXT NOT NULL UNIQUE,
        channel TEXT NOT NULL,
        display_name TEXT,
        confidence TEXT DEFAULT 'high',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_aliases_canonical ON contact_aliases(canonical_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_aliases_name ON contact_aliases(LOWER(display_name)) WHERE display_name IS NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_aliases_channel ON contact_aliases(channel)`);
  } catch (err) {
    console.error('[CONTACTS] Erro ao inicializar:', err.message);
  }
}

/**
 * Resolve uma identidade canônica para um alias (JID/email/etc).
 *
 * Retorna o canonical_id existente se já visto, ou cria novo.
 * Match por nome só acontece se nome NÃO é genérico (evita fusão errada).
 *
 * @param {string} aliasId - JID, email, instagram_id, etc
 * @param {string|null} displayName - Nome do contato (opcional)
 * @returns {Promise<string>} canonical_id
 */
export async function resolveCanonicalId(aliasId, displayName = null) {
  if (!aliasId) throw new Error('aliasId é obrigatório');

  const channel = _detectChannel(aliasId);

  try {
    // 1. Match exato por alias_id (já visto)
    const exact = await pool.query(
      'SELECT canonical_id, display_name FROM contact_aliases WHERE alias_id = $1 LIMIT 1',
      [aliasId]
    );
    if (exact.rows[0]) {
      // Atualiza display_name se mudou
      if (displayName && displayName !== exact.rows[0].display_name) {
        await pool.query(
          'UPDATE contact_aliases SET display_name = $2 WHERE alias_id = $1',
          [aliasId, displayName]
        );
      }
      return exact.rows[0].canonical_id;
    }

    // 2. Match por nome (só se nome confiável)
    if (displayName && !_isGenericName(displayName)) {
      const norm = _normalizeName(displayName);
      const candidates = await pool.query(
        `SELECT DISTINCT canonical_id, display_name, channel
         FROM contact_aliases
         WHERE display_name IS NOT NULL
           AND channel != $2
         LIMIT 50`,
        [aliasId, channel]
      );

      for (const c of candidates.rows) {
        if (!c.display_name) continue;
        const candNorm = _normalizeName(c.display_name);
        // Match exato OU Levenshtein ≤ 2
        if (candNorm === norm || levenshtein(candNorm, norm) <= 2) {
          // Mesmo nome em canal diferente = provável mesma pessoa
          await pool.query(
            `INSERT INTO contact_aliases (canonical_id, alias_id, channel, display_name, confidence)
             VALUES ($1, $2, $3, $4, 'medium') ON CONFLICT (alias_id) DO NOTHING`,
            [c.canonical_id, aliasId, channel, displayName]
          );
          console.log(`[CONTACTS] Cross-channel match: ${displayName} (${channel}) → ${c.canonical_id}`);
          return c.canonical_id;
        }
      }
    }

    // 3. Não achou: cria nova identidade
    const canonicalId = `c_${Date.now()}_${aliasId.replace(/[^a-z0-9]/gi, '').substring(0, 12)}`;
    await pool.query(
      `INSERT INTO contact_aliases (canonical_id, alias_id, channel, display_name, confidence)
       VALUES ($1, $2, $3, $4, 'high') ON CONFLICT (alias_id) DO NOTHING`,
      [canonicalId, aliasId, channel, displayName]
    );
    return canonicalId;
  } catch (err) {
    console.error('[CONTACTS] Erro resolveCanonicalId:', err.message);
    return aliasId; // fallback: usa o próprio alias como canonical
  }
}

/**
 * Lista todos os aliases vinculados a um canonical_id
 * (útil pra ver "essa pessoa fala em quantos canais?")
 */
export async function getAliasesForCanonical(canonicalId) {
  try {
    const { rows } = await pool.query(
      `SELECT alias_id, channel, display_name, confidence, created_at
       FROM contact_aliases WHERE canonical_id = $1 ORDER BY created_at`,
      [canonicalId]
    );
    return rows;
  } catch { return []; }
}

/**
 * Merge manual: une 2 canonicals (usado pra corrigir falsos positivos
 * ou quando user diz "esses 2 são a mesma pessoa")
 */
export async function mergeCanonicals(keepId, mergeFromId) {
  if (keepId === mergeFromId) return false;
  try {
    await pool.query(
      'UPDATE contact_aliases SET canonical_id = $1, confidence = $3 WHERE canonical_id = $2',
      [keepId, mergeFromId, 'manual']
    );
    return true;
  } catch (err) {
    console.error('[CONTACTS] Erro merge:', err.message);
    return false;
  }
}

/**
 * Estatísticas pra dashboard
 */
export async function getContactStats() {
  try {
    const { rows: byChannel } = await pool.query(
      'SELECT channel, COUNT(*)::int as total FROM contact_aliases GROUP BY channel ORDER BY total DESC'
    );
    const { rows: multiChannel } = await pool.query(`
      SELECT canonical_id, COUNT(DISTINCT channel)::int as num_canais,
             ARRAY_AGG(DISTINCT channel ORDER BY channel) as canais,
             MAX(display_name) as nome
      FROM contact_aliases
      GROUP BY canonical_id
      HAVING COUNT(DISTINCT channel) > 1
      ORDER BY num_canais DESC LIMIT 20
    `);
    const total = await pool.query('SELECT COUNT(DISTINCT canonical_id)::int as total FROM contact_aliases');
    return {
      total_pessoas_unicas: total.rows[0]?.total || 0,
      por_canal: byChannel,
      multi_canal: multiChannel,
    };
  } catch (err) {
    console.error('[CONTACTS] Erro stats:', err.message);
    return { total_pessoas_unicas: 0, por_canal: [], multi_canal: [] };
  }
}

// Exportado pra ser testado
export const _internal = { levenshtein, _normalizeName, _isGenericName, _detectChannel };
