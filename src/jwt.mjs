import { createPublicKey, verify } from 'node:crypto'

/**
 * Verificação do access token do IdP nos domínios falsos (ADR-0013, decisão 7). Só `node:crypto`:
 * - só RS256, com chave RSA (>= 2048 bits) do JWKS do emissor, escolhida pelo `kid` do cabeçalho;
 *   `alg: none`, HS256 (inclusive HMAC com a chave pública) e qualquer outro algoritmo são recusados,
 *   e `jwk`/`jku`/`x5u` do cabeçalho nunca são usados;
 * - `iss` igual ao emissor; `aud` contém `erp-dominios`; `exp` obrigatório e `nbf` respeitado, com a
 *   tolerância de relógio configurada; `preferred_username` obrigatório (é o ator);
 * - JWKS achado pelo discovery do emissor e só na origem dele; busca com timeout e sem seguir
 *   redirecionamento; cache por `kid` com TTL; `kid` desconhecido busca de novo no máximo uma vez
 *   por intervalo mínimo (o atacante escolhe o `kid`, não a taxa de busca).
 * Qualquer falha devolve `null`: o domínio responde 401 sem dizer o motivo.
 */

export const AUDIENCIA = 'erp-dominios'
const B64U = /^[A-Za-z0-9_-]+$/
const BITS_MINIMOS = 2048

/**
 * Inteiro da configuração (docs/CONFIGURACAO.md): ausente vale o padrão; inválido ou fora de
 * [minimo, teto] é erro na subida, com o nome da variável.
 */
function inteiro(valor, nome, padrao, teto, minimo = 1) {
  if (valor === undefined || valor === '') return padrao
  const n = Number(valor)
  if (!/^\d+$/.test(String(valor)) || !Number.isSafeInteger(n) || n < minimo || n > teto) {
    throw new Error(`${nome} invalido: inteiro de ${minimo} a ${teto}`)
  }
  return n
}

/**
 * Host de loopback, na forma já normalizada pelo `URL` (`hostname`), por igualdade. Espelha a regra do
 * núcleo (`borda/http-local.ts`, ADR-0013 adendo 2); o stub não depende do núcleo.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
export const ehLoopback = (hostname) => LOOPBACK.has(hostname)

/**
 * Configuração validada. Os valores chegam como texto do ambiente; os padrões são os de
 * docs/CONFIGURACAO.md §4. `http://` no emissor só fora de produção (ADR-0013, decisão 5), ou em produção
 * com `httpLocal` (`ERP_PERMITIR_HTTP_LOCAL=1`) e host de loopback (adendo 2).
 */
export function configuracaoJwt({ emissor, producao = false, httpLocal = false, timeoutMs, ttlS, intervaloMinS, toleranciaS } = {}) {
  let url
  try { url = new URL(String(emissor)) } catch { throw new Error('IDP_EMISSOR invalido: nao e URL absoluta') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('IDP_EMISSOR invalido: precisa de https')
  if (url.protocol === 'http:' && producao && !(httpLocal && ehLoopback(url.hostname))) throw new Error('IDP_EMISSOR invalido: precisa de https em producao')
  if (url.username || url.password || url.search || url.hash) throw new Error('IDP_EMISSOR invalido: sem credencial, query nem fragmento')
  const c = {
    emissor: String(emissor),
    timeoutMs: inteiro(timeoutMs, 'ERP_DESTINO_TIMEOUT_MS', 5000, 60_000),
    ttlMs: inteiro(ttlS, 'ERP_JWKS_TTL_S', 300, 86_400) * 1000,
    intervaloMinMs: inteiro(intervaloMinS, 'ERP_JWKS_INTERVALO_MIN_S', 30, 3600) * 1000,
    toleranciaS: inteiro(toleranciaS, 'ERP_JWT_TOLERANCIA_S', 5, 60, 0),
  }
  // com intervalo maior que o TTL, o cache venceria e ficaria sem poder buscar: só recusas
  if (c.intervaloMinMs > c.ttlMs) throw new Error('ERP_JWKS_INTERVALO_MIN_S invalido: maior que ERP_JWKS_TTL_S')
  return c
}

/** Verificador do processo, lido do ambiente uma vez; `null` sem `IDP_EMISSOR` (modo de desenvolvimento). */
export function verificadorDoAmbiente() {
  if (!process.env.IDP_EMISSOR) return null
  return criarVerificadorJwt(configuracaoJwt({
    emissor: process.env.IDP_EMISSOR,
    producao: process.env.NODE_ENV === 'production',
    httpLocal: process.env.ERP_PERMITIR_HTTP_LOCAL === '1',
    timeoutMs: process.env.ERP_DESTINO_TIMEOUT_MS,
    ttlS: process.env.ERP_JWKS_TTL_S,
    intervaloMinS: process.env.ERP_JWKS_INTERVALO_MIN_S,
    toleranciaS: process.env.ERP_JWT_TOLERANCIA_S,
  }))
}

const objeto = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
function json(parte) {
  try { return JSON.parse(Buffer.from(parte, 'base64url').toString('utf8')) } catch { return null }
}

/** Chave pública de verificação, ou `null` se a entrada do JWKS não serve para RS256. */
function chaveDoJwk(k) {
  if (!objeto(k) || k.kty !== 'RSA' || typeof k.kid !== 'string') return null
  if (k.use !== undefined && k.use !== 'sig') return null
  if (k.alg !== undefined && k.alg !== 'RS256') return null
  try {
    const chave = createPublicKey({ key: { kty: 'RSA', n: k.n, e: k.e }, format: 'jwk' })
    return chave.asymmetricKeyDetails.modulusLength >= BITS_MINIMOS ? chave : null
  } catch { return null }
}

export function criarVerificadorJwt(config, { agora = Date.now } = {}) {
  const { emissor, timeoutMs, ttlMs, intervaloMinMs, toleranciaS } = config
  const origem = new URL(emissor).origin
  let jwksUri = null
  let chaves = new Map()
  let obtidoEm = -Infinity
  let ultimaBusca = -Infinity
  let emCurso = null

  async function obterJson(url) {
    // redirect manual: um 3xx é status diferente de 200 e vira recusa, nunca uma busca em outro lugar
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } })
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
    return r.json()
  }

  async function descobrirJwks() {
    const doc = await obterJson(`${emissor}/.well-known/openid-configuration`)
    if (!objeto(doc) || doc.issuer !== emissor) throw new Error('discovery de outro emissor')
    const url = new URL(doc.jwks_uri)
    if (url.origin !== origem) throw new Error('jwks_uri fora da origem do emissor')
    return url.href
  }

  /** Uma busca por vez; quem chega durante ela espera a mesma. Falha deixa o cache como estava. */
  function buscar() {
    emCurso ??= (async () => {
      ultimaBusca = agora()
      try {
        jwksUri ??= await descobrirJwks()
        const doc = await obterJson(jwksUri)
        if (!objeto(doc) || !Array.isArray(doc.keys)) throw new Error('JWKS sem keys')
        const novas = new Map()
        for (const k of doc.keys) { const chave = chaveDoJwk(k); if (chave) novas.set(k.kid, chave) }
        chaves = novas
        obtidoEm = agora()
      } catch { /* recusa: sem chave, todo token é 401 até a próxima busca permitida */ } finally {
        emCurso = null
      }
    })()
    return emCurso
  }

  const valido = () => agora() - obtidoEm < ttlMs
  async function chaveDe(kid) {
    if (emCurso) await emCurso
    if (valido() && chaves.has(kid)) return chaves.get(kid)
    if (agora() - ultimaBusca < intervaloMinMs) return null
    await buscar()
    return valido() ? chaves.get(kid) ?? null : null
  }

  /** Claims do token, ou `null` para qualquer token que não passe em todas as regras. */
  async function verificar(token) {
    if (typeof token !== 'string') return null
    const partes = token.split('.')
    if (partes.length !== 3 || !partes.every((p) => B64U.test(p))) return null
    const cab = json(partes[0])
    // só RS256; `crit` pediria entender extensões que este verificador não conhece
    if (!objeto(cab) || cab.alg !== 'RS256' || typeof cab.kid !== 'string' || 'crit' in cab) return null
    const chave = await chaveDe(cab.kid)
    if (!chave) return null
    const assinado = Buffer.from(`${partes[0]}.${partes[1]}`)
    if (!verify('sha256', assinado, chave, Buffer.from(partes[2], 'base64url'))) return null

    const c = json(partes[1])
    if (!objeto(c) || c.iss !== emissor) return null
    const aud = typeof c.aud === 'string' ? [c.aud] : Array.isArray(c.aud) ? c.aud : []
    if (!aud.includes(AUDIENCIA)) return null
    const agoraS = agora() / 1000
    if (typeof c.exp !== 'number' || !Number.isFinite(c.exp) || agoraS >= c.exp + toleranciaS) return null
    if (c.nbf !== undefined && (typeof c.nbf !== 'number' || !Number.isFinite(c.nbf) || agoraS < c.nbf - toleranciaS)) return null
    if (typeof c.preferred_username !== 'string' || !c.preferred_username) return null
    return c
  }

  return { verificar }
}
