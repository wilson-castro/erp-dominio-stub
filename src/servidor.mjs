import { createServer } from 'node:http'
import { ATORES, revogar } from './atores.mjs'
import { PEDIDO_8821 } from './pedido-8821.mjs'
import { projetar } from './projetar.mjs'

const PORTA = Number(process.env.PORTA ?? 4000)

/** O token de dev tem a forma `dev.<usuario>.<uuid>`. Um IdP real traria claims. */
function atorDoToken(auth) {
  if (!auth?.startsWith('Bearer ')) return null
  const partes = auth.slice(7).split('.')
  if (partes[0] !== 'dev') return null
  return ATORES[partes[1]] ?? null
}

const json = (res, status, corpo, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(corpo === undefined ? '' : JSON.stringify(corpo))
}

export const criarServidor = () => createServer((req, res) => {
  // Elemento 3 do núcleo: o domínio não é alcançável a partir do navegador.
  // Para loopback o navegador sempre manda Sec-Fetch-Site e Sec-Fetch-Dest, e
  // Origin em fetch cross-origin. Sec-Fetch-Mode NÃO serve de sinal: o fetch do
  // Node (undici), que é o que o adaptador do BFF usa, manda `sec-fetch-mode: cors`.
  if (req.headers.origin || req.headers['sec-fetch-site'] || req.headers['sec-fetch-dest']) {
    return json(res, 403, { codigo: 'OPERACAO_NAO_PERMITIDA' })
  }

  if (req.method === 'POST' && req.url === '/_dev/revogar') {
    let corpo = ''
    req.on('data', (c) => { corpo += c })
    req.on('end', () => {
      let pedido
      // exceção dentro de um listener derruba o processo inteiro, não só a requisição
      try { pedido = JSON.parse(corpo || '{}') } catch { return json(res, 400, undefined) }
      json(res, revogar(pedido?.usuario, pedido?.grupo) ? 204 : 404, undefined)
    })
    return
  }

  const ator = atorDoToken(req.headers.authorization)
  // sem credencial: recusa sem descrever o motivo
  if (!ator) return json(res, 401, { codigo: 'SESSAO_EXPIRADA' })

  const m = /^\/pedidos\/([^/?]+)$/.exec(req.url ?? '')
  // fatia 1 é somente leitura: outro verbo recebe o mesmo 404, sem anunciar a rota
  if (!m || req.method !== 'GET') return json(res, 404, { codigo: 'ERRO_INTERNO' })

  let id
  // `%E0` lança URIError; sem o try, uma requisição derruba o stub
  try { id = decodeURIComponent(m[1]) } catch { id = null }
  const pedido = id === PEDIDO_8821.id ? PEDIDO_8821 : null
  const projetado = pedido ? projetar(pedido, ator) : null

  // 404 idêntico para "não existe" e "você não pode ver" — mesmo corpo, mesmos headers
  if (!projetado) return json(res, 404, { codigo: 'ERRO_INTERNO' })

  json(res, 200, projetado, { etag: `"${projetado.versao}"` })
})

if (import.meta.main) {
  criarServidor().listen(PORTA, '127.0.0.1', () => {
    console.log(`stub do domínio em http://127.0.0.1:${PORTA} (somente loopback)`)
  })
}
