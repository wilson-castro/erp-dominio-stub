import { createServer } from 'node:http'

/**
 * Atores de desenvolvimento. O token de dev tem a forma `dev.<usuario>.<uuid>`; um IdP
 * real traria claims. Os GRUPOS de cada domínio ficam no próprio domínio, não aqui.
 */
export const USUARIOS = ['ana', 'bruno', 'carla', 'davi']

export function usuarioDoToken(auth) {
  if (!auth?.startsWith('Bearer ')) return null
  const partes = auth.slice(7).split('.')
  if (partes[0] !== 'dev' || !USUARIOS.includes(partes[1])) return null
  return partes[1]
}

/** Token de serviço de dev: `svc.<aplicacao>`. */
export function servicoDoToken(auth) {
  if (!auth?.startsWith('Bearer svc.')) return null
  const app = auth.slice('Bearer svc.'.length)
  return /^[a-z][a-z0-9-]{0,31}$/.test(app) ? app : null
}

export const json = (res, status, corpo, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(corpo === undefined ? '' : JSON.stringify(corpo))
}

/** 404 idêntico para "não existe", "você não pode ver" e "rota desconhecida". */
export const naoEncontrado = (res) => json(res, 404, { codigo: 'ERRO_INTERNO' })

export function lerCorpo(req) {
  return new Promise((ok) => {
    let corpo = ''
    req.on('data', (c) => { corpo += c; if (corpo.length > 64_000) req.destroy() })
    req.on('end', () => { try { ok(JSON.parse(corpo || '{}')) } catch { ok(null) } })
  })
}

/**
 * Cada rota: `[metodo, /regex/, handler(ctx)]`. `ctx` traz `usuario`, `servico`, `params`,
 * `req`, `res`. O domínio recusa sozinho o que vem do navegador e o que vem sem credencial.
 */
export function criarDominio(rotas, { exigeUsuario = true } = {}) {
  return createServer(async (req, res) => {
    // O domínio não é alcançável a partir do navegador (invariante 10). Para loopback o
    // navegador sempre manda Sec-Fetch-Site e Sec-Fetch-Dest, e Origin em fetch
    // cross-origin. Sec-Fetch-Mode NÃO serve: o fetch do Node manda `sec-fetch-mode: cors`.
    if (req.headers.origin || req.headers['sec-fetch-site'] || req.headers['sec-fetch-dest']) {
      return json(res, 403, { codigo: 'OPERACAO_NAO_PERMITIDA' })
    }
    const usuario = usuarioDoToken(req.headers.authorization)
    const servico = servicoDoToken(req.headers.authorization)
    if (exigeUsuario && !usuario && !servico) return json(res, 401, { codigo: 'SESSAO_EXPIRADA' })

    const caminho = (req.url ?? '').split('?')[0]
    for (const [metodo, padrao, handler] of rotas) {
      const m = padrao.exec(caminho)
      if (!m || req.method !== metodo) continue
      let params
      // `%E0` lança URIError; sem o try, uma requisição derruba o stub
      try { params = m.slice(1).map(decodeURIComponent) } catch { return naoEncontrado(res) }
      try {
        return await handler({ req, res, usuario, servico, params })
      } catch {
        return json(res, 500, { codigo: 'ERRO_INTERNO' })
      }
    }
    return naoEncontrado(res)
  })
}
