import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { createServer } from 'node:http'
import { test, subir, como } from './apoio.mjs'

// Verificação do access token do IdP nos domínios falsos (ADR-0013, decisão 7): com IDP_EMISSOR, só
// JWT RS256 de chave do JWKS do emissor; o ator é o `preferred_username`. O "IdP" daqui é um servidor
// node:http numa porta efêmera, com discovery e JWKS; os tokens são assinados aqui mesmo.

const par = (bits = 2048) => generateKeyPairSync('rsa', { modulusLength: bits })
const K1 = par()
const K2 = par()
const CURTA = par(1024)
const jwk = (chave, kid, extra = {}) => ({ ...chave.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256', ...extra })

/** Estado do IdP falso; cada teste ajusta o que precisa e conta as buscas. */
const idp = {
  chaves: [jwk(K1, 'k1')],
  buscasJwks: 0,
  buscasDiscovery: 0,
  modo: 'normal', // 'redirecionar' | 'travar' | 'jwks-outra-origem' | 'emissor-divergente' | 'erro'
  outraOrigemTocada: 0,
}
const outra = createServer((req, res) => { idp.outraOrigemTocada++; res.end(JSON.stringify({ keys: [jwk(K2, 'k1')] })) })
const OUTRA = await subir(outra)

const servidorIdp = createServer((req, res) => {
  if (req.url === '/realms/erp/.well-known/openid-configuration') {
    idp.buscasDiscovery++
    const jwksUri = idp.modo === 'jwks-outra-origem' ? `${OUTRA}/certs` : `${EMISSOR}/protocol/openid-connect/certs`
    const issuer = idp.modo === 'emissor-divergente' ? `${EMISSOR}-outro` : EMISSOR
    return res.end(JSON.stringify({ issuer, jwks_uri: jwksUri }))
  }
  if (req.url === '/realms/erp/protocol/openid-connect/certs') {
    idp.buscasJwks++
    if (idp.modo === 'travar') return // nunca responde: só o timeout encerra
    if (idp.modo === 'erro') { res.writeHead(500); return res.end() }
    if (idp.modo === 'redirecionar') { res.writeHead(302, { location: `${OUTRA}/certs` }); return res.end() }
    return res.end(JSON.stringify({ keys: idp.chaves }))
  }
  res.writeHead(404); res.end()
})
const RAIZ_IDP = await subir(servidorIdp)
const EMISSOR = `${RAIZ_IDP}/realms/erp`

// um modo por processo: o ambiente é lido na primeira requisição a um domínio deste arquivo
process.env.IDP_EMISSOR = EMISSOR
process.env.ERP_DESTINO_TIMEOUT_MS = '300'
process.env.ERP_JWKS_TTL_S = '300'
process.env.ERP_JWKS_INTERVALO_MIN_S = '30'
process.env.ERP_JWT_TOLERANCIA_S = '5'

const { criarVerificadorJwt, configuracaoJwt } = await import('../src/jwt.mjs')
const { criarDominioA } = await import('../src/dominio-a.mjs')
const { criarGestaoDeAcessoV2 } = await import('../src/gestao-acesso-v2/servidor.mjs')

const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')
const agoraS = () => Math.floor(Date.now() / 1000)
const claims = (extra = {}) => ({
  iss: EMISSOR, aud: ['erp-dominios', 'account'], typ: 'Bearer', iat: agoraS(), exp: agoraS() + 300,
  preferred_username: 'bruno', ...extra,
})
function assinar(payload = claims(), { chave = K1.privateKey, kid = 'k1', alg = 'RS256', cabecalho = {}, digest = 'sha256' } = {}) {
  const h = b64u({ alg, typ: 'JWT', ...(kid === null ? {} : { kid }), ...cabecalho })
  const p = b64u(payload)
  return `${h}.${p}.${sign(digest, Buffer.from(`${h}.${p}`), chave).toString('base64url')}`
}

/** Verificador novo, com relógio controlável e a configuração do teste. */
function verificador(extra = {}) {
  return criarVerificadorJwt(configuracaoJwt({
    emissor: EMISSOR, timeoutMs: '300', ttlS: '300', intervaloMinS: '30', toleranciaS: '5', ...extra,
  }))
}
const reiniciarIdp = () => Object.assign(idp, { chaves: [jwk(K1, 'k1')], buscasJwks: 0, buscasDiscovery: 0, modo: 'normal', outraOrigemTocada: 0 })

// --- verificação do token ------------------------------------------------------------------------

test('token RS256 valido do emissor: devolve as claims; aud em texto tambem serve', async () => {
  reiniciarIdp()
  const v = verificador()
  assert.equal((await v.verificar(assinar()))?.preferred_username, 'bruno')
  assert.equal((await v.verificar(assinar(claims({ aud: 'erp-dominios' }))))?.preferred_username, 'bruno')
})

test('alg none e recusado, com ou sem assinatura', async () => {
  reiniciarIdp()
  const v = verificador()
  const valido = assinar()
  const [, p, s] = valido.split('.')
  for (const alg of ['none', 'None', 'NONE']) {
    const h = b64u({ alg, typ: 'JWT', kid: 'k1' })
    assert.equal(await v.verificar(`${h}.${p}.`), null, `${alg} sem assinatura`)
    assert.equal(await v.verificar(`${h}.${p}.${s}`), null, `${alg} com assinatura`)
  }
})

test('HS256 assinado com a chave publica RSA (confusao de algoritmo) e recusado', async () => {
  reiniciarIdp()
  const v = verificador()
  const pem = K1.publicKey.export({ type: 'spki', format: 'pem' })
  const der = K1.publicKey.export({ type: 'spki', format: 'der' })
  for (const segredo of [pem, der, JSON.stringify(jwk(K1, 'k1'))]) {
    const h = b64u({ alg: 'HS256', typ: 'JWT', kid: 'k1' })
    const p = b64u(claims())
    const s = createHmac('sha256', segredo).update(`${h}.${p}`).digest('base64url')
    assert.equal(await v.verificar(`${h}.${p}.${s}`), null)
  }
})

test('outro algoritmo que nao RS256 e recusado, mesmo assinado com a chave certa', async () => {
  reiniciarIdp()
  const v = verificador()
  assert.equal(await v.verificar(assinar(claims(), { alg: 'RS512', digest: 'sha512' })), null, 'RS512')
  assert.equal(await v.verificar(assinar(claims(), { alg: 'RS384', digest: 'sha384' })), null, 'RS384')
  assert.equal(await v.verificar(assinar(claims(), { alg: 'PS256' })), null, 'PS256')
  // cabeçalho dizendo RS256 com assinatura de outro digest: a verificação é sempre SHA-256
  assert.equal(await v.verificar(assinar(claims(), { digest: 'sha512' })), null, 'RS256 com digest sha512')
})

test('assinatura de outra chave, ou payload alterado depois de assinar, e recusado', async () => {
  reiniciarIdp()
  const v = verificador()
  assert.equal(await v.verificar(assinar(claims(), { chave: K2.privateKey })), null, 'chave fora do JWKS com kid conhecido')
  const [h, , s] = assinar().split('.')
  assert.equal(await v.verificar(`${h}.${b64u(claims({ preferred_username: 'ana' }))}.${s}`), null, 'payload trocado')
})

test('iss errado ou ausente e recusado', async () => {
  reiniciarIdp()
  const v = verificador()
  assert.equal(await v.verificar(assinar(claims({ iss: `${EMISSOR}-outro` }))), null)
  assert.equal(await v.verificar(assinar(claims({ iss: `${EMISSOR}/` }))), null, 'barra a mais')
  assert.equal(await v.verificar(assinar(claims({ iss: undefined }))), null)
})

test('aud sem erp-dominios e recusado', async () => {
  reiniciarIdp()
  const v = verificador()
  for (const aud of [undefined, 'account', ['account', 'erp-shell'], [], 'erp-dominios-x', ['ERP-DOMINIOS'], { 0: 'erp-dominios' }]) {
    assert.equal(await v.verificar(assinar(claims({ aud }))), null, JSON.stringify(aud))
  }
})

test('exp vencido, ausente ou nao numerico e recusado; dentro da tolerancia passa', async () => {
  reiniciarIdp()
  const v = verificador()
  assert.equal(await v.verificar(assinar(claims({ exp: agoraS() - 10 }))), null, 'vencido ha 10 s (tolerancia 5)')
  assert.equal(await v.verificar(assinar(claims({ exp: undefined }))), null, 'sem exp')
  assert.equal(await v.verificar(assinar(claims({ exp: String(agoraS() + 300) }))), null, 'exp em texto')
  assert.ok(await v.verificar(assinar(claims({ exp: agoraS() - 2 }))), 'vencido ha 2 s, dentro da tolerancia')
  const semTolerancia = verificador({ toleranciaS: '0' })
  assert.equal(await semTolerancia.verificar(assinar(claims({ exp: agoraS() - 2 }))), null, 'tolerancia 0')
})

test('nbf no futuro e recusado; dentro da tolerancia passa', async () => {
  reiniciarIdp()
  const v = verificador()
  assert.equal(await v.verificar(assinar(claims({ nbf: agoraS() + 60 }))), null)
  assert.equal(await v.verificar(assinar(claims({ nbf: 'amanha' }))), null, 'nbf nao numerico')
  assert.ok(await v.verificar(assinar(claims({ nbf: agoraS() + 2 }))))
  assert.ok(await v.verificar(assinar(claims({ nbf: agoraS() - 60 }))))
})

test('preferred_username ausente, vazio ou nao texto e recusado (e o ator)', async () => {
  reiniciarIdp()
  const v = verificador()
  for (const preferred_username of [undefined, '', 42, ['bruno']]) {
    assert.equal(await v.verificar(assinar(claims({ preferred_username }))), null, JSON.stringify(preferred_username))
  }
})

test('token malformado e recusado sem lancar', async () => {
  reiniciarIdp()
  const v = verificador()
  const [h, p, s] = assinar().split('.')
  const casos = [
    undefined, null, '', 'abc', `${h}.${p}`, `${h}.${p}.${s}.x`, `${h}..${s}`, `.${p}.${s}`,
    `${h}.${p}.${s}=`, `${h}+.${p}.${s}`, `${b64u('nao e json')}.${p}.${s}`, `${b64u([1, 2])}.${p}.${s}`,
    `${b64u('null')}.${p}.${s}`, `${h}.${b64u('[]')}.${s}`, `${h}.${b64u('nao e json')}.${s}`,
  ]
  for (const t of casos) assert.equal(await v.verificar(t), null, String(t))
})

test('cabecalho sem kid, com crit ou com chave embutida (jwk/jku) nao escolhe a chave', async () => {
  reiniciarIdp()
  const v = verificador()
  assert.equal(await v.verificar(assinar(claims(), { kid: null })), null, 'sem kid')
  assert.equal(await v.verificar(assinar(claims(), { cabecalho: { crit: ['exp'] } })), null, 'crit')
  // atacante assina com a própria chave e a embute no cabeçalho, com um kid que o JWKS não tem
  const embutida = assinar(claims(), { chave: K2.privateKey, kid: 'atacante', cabecalho: { jwk: jwk(K2, 'atacante'), jku: `${OUTRA}/certs` } })
  assert.equal(await v.verificar(embutida), null)
  assert.equal(idp.outraOrigemTocada, 0, 'jku foi buscado')
})

test('JWKS: chave de cifra (use enc), de outro alg ou RSA curta nao serve para verificar', async () => {
  reiniciarIdp()
  idp.chaves = [jwk(K1, 'enc', { use: 'enc', alg: 'RSA-OAEP' }), jwk(K2, 'ps', { alg: 'PS256' }), jwk(CURTA, 'curta')]
  const v = verificador()
  assert.equal(await v.verificar(assinar(claims(), { kid: 'enc' })), null, 'use enc')
  assert.equal(await v.verificar(assinar(claims(), { kid: 'ps', chave: K2.privateKey })), null, 'chave PS256')
  assert.equal(await v.verificar(assinar(claims(), { kid: 'curta', chave: CURTA.privateKey })), null, 'RSA 1024')
})

// --- JWKS: cache, kid desconhecido, rede -----------------------------------------------------------

test('cache: o JWKS e buscado uma vez para muitos tokens, e de novo depois do TTL', async () => {
  reiniciarIdp()
  let agora = Date.now()
  const v = criarVerificadorJwt(configuracaoJwt({ emissor: EMISSOR, timeoutMs: '300', ttlS: '60', intervaloMinS: '30', toleranciaS: '5' }), { agora: () => agora })
  for (let i = 0; i < 10; i++) assert.ok(await v.verificar(assinar(claims({ exp: Math.floor(agora / 1000) + 300 }))))
  assert.equal(idp.buscasJwks, 1)
  agora += 61_000
  assert.ok(await v.verificar(assinar(claims({ iat: Math.floor(agora / 1000), exp: Math.floor(agora / 1000) + 300 }))))
  assert.equal(idp.buscasJwks, 2, 'TTL vencido sem nova busca')
})

test('kid desconhecido: no maximo uma busca por intervalo minimo, mesmo com 20 kids em paralelo', async () => {
  reiniciarIdp()
  let agora = Date.now()
  const v = criarVerificadorJwt(configuracaoJwt({ emissor: EMISSOR, timeoutMs: '300', ttlS: '300', intervaloMinS: '30', toleranciaS: '5' }), { agora: () => agora })
  const exp = () => Math.floor(agora / 1000) + 300
  assert.ok(await v.verificar(assinar(claims({ exp: exp() }))))
  assert.equal(idp.buscasJwks, 1)
  // primeira busca foi agora: kid desconhecido dentro do intervalo não busca
  const kids = Array.from({ length: 20 }, (_, i) => assinar(claims({ exp: exp() }), { kid: `forjado-${i}` }))
  assert.deepEqual(await Promise.all(kids.map((t) => v.verificar(t))), kids.map(() => null))
  assert.equal(idp.buscasJwks, 1, 'kid escolhido pelo atacante fez buscar o JWKS')
  // passado o intervalo, a rotação de chave do IdP é aceita com uma busca só
  agora += 31_000
  idp.chaves = [jwk(K1, 'k1'), jwk(K2, 'k2')]
  const rodada = Array.from({ length: 20 }, () => assinar(claims({ iat: Math.floor(agora / 1000), exp: exp() }), { kid: 'k2', chave: K2.privateKey }))
  const r = await Promise.all(rodada.map((t) => v.verificar(t)))
  assert.ok(r.every((c) => c?.preferred_username === 'bruno'))
  assert.equal(idp.buscasJwks, 2, '20 pedidos simultaneos fizeram mais de uma busca')
  // e outro kid desconhecido logo depois não busca de novo
  assert.equal(await v.verificar(assinar(claims({ exp: exp() }), { kid: 'outro' })), null)
  assert.equal(idp.buscasJwks, 2)
})

test('JWKS com redirecionamento: recusado, e o destino do redirect nunca e tocado', async () => {
  reiniciarIdp()
  idp.modo = 'redirecionar'
  assert.equal(await verificador().verificar(assinar()), null)
  assert.equal(idp.outraOrigemTocada, 0)
})

test('JWKS fora da origem do emissor, ou discovery com outro issuer: recusado sem buscar', async () => {
  reiniciarIdp()
  idp.modo = 'jwks-outra-origem'
  assert.equal(await verificador().verificar(assinar()), null)
  assert.equal(idp.outraOrigemTocada, 0, 'jwks_uri de outra origem foi buscado')
  reiniciarIdp()
  idp.modo = 'emissor-divergente'
  assert.equal(await verificador().verificar(assinar()), null)
  assert.equal(idp.buscasJwks, 0)
})

test('JWKS travado: o timeout configurado encerra a busca e o token e recusado', async () => {
  reiniciarIdp()
  idp.modo = 'travar'
  const inicio = Date.now()
  assert.equal(await verificador({ timeoutMs: '200' }).verificar(assinar()), null)
  assert.ok(Date.now() - inicio < 2000, `levou ${Date.now() - inicio} ms`)
})

test('JWKS com erro 500: recusado, e o erro nao e repetido a cada requisicao', async () => {
  reiniciarIdp()
  idp.modo = 'erro'
  const v = verificador()
  assert.equal(await v.verificar(assinar()), null)
  assert.equal(await v.verificar(assinar()), null)
  assert.equal(idp.buscasJwks, 1)
})

// --- configuração ------------------------------------------------------------------------------------

test('configuracao: padroes, valor invalido e http em producao sao erro na subida com o nome', () => {
  const c = configuracaoJwt({ emissor: EMISSOR })
  assert.deepEqual([c.timeoutMs, c.ttlMs, c.intervaloMinMs, c.toleranciaS], [5000, 300_000, 30_000, 5])
  const erro = (extra, nome) => assert.throws(() => configuracaoJwt({ emissor: EMISSOR, ...extra }), new RegExp(nome))
  erro({ timeoutMs: 'x' }, 'ERP_DESTINO_TIMEOUT_MS')
  erro({ timeoutMs: '0' }, 'ERP_DESTINO_TIMEOUT_MS')
  erro({ timeoutMs: '60001' }, 'ERP_DESTINO_TIMEOUT_MS')
  erro({ ttlS: '-1' }, 'ERP_JWKS_TTL_S')
  erro({ ttlS: '86401' }, 'ERP_JWKS_TTL_S')
  erro({ intervaloMinS: '1.5' }, 'ERP_JWKS_INTERVALO_MIN_S')
  erro({ intervaloMinS: '3601' }, 'ERP_JWKS_INTERVALO_MIN_S')
  erro({ toleranciaS: '61' }, 'ERP_JWT_TOLERANCIA_S')
  erro({ toleranciaS: '-1' }, 'ERP_JWT_TOLERANCIA_S')
  assert.equal(configuracaoJwt({ emissor: EMISSOR, toleranciaS: '0' }).toleranciaS, 0)
  erro({ emissor: 'nao-e-url' }, 'IDP_EMISSOR')
  erro({ emissor: 'ftp://idp/realms/erp' }, 'IDP_EMISSOR')
  erro({ emissor: 'http://u:s@idp/realms/erp' }, 'IDP_EMISSOR')
  erro({ producao: true }, 'IDP_EMISSOR')
  assert.equal(configuracaoJwt({ emissor: 'https://idp.exemplo/realms/erp', producao: true }).emissor, 'https://idp.exemplo/realms/erp')
})

// --- no domínio: um modo por processo ----------------------------------------------------------------

test('dominio com IDP_EMISSOR: o ator e o preferred_username; o token dev e recusado', async () => {
  reiniciarIdp()
  const a = await subir(criarDominioA())
  const ver = (token) => fetch(`${a}/v1/recursos/r-1`, { headers: { authorization: `Bearer ${token}` } })
  const bruno = await ver(assinar())
  assert.equal(bruno.status, 200)
  assert.equal(typeof (await bruno.json()).custo?.valor, 'number', 'bruno (financeiro) sem custo: ator nao mapeado')
  const ana = await ver(assinar(claims({ preferred_username: 'ana' })))
  assert.equal(ana.status, 200)
  assert.ok(!('custo' in await ana.json()))
  const dev = await fetch(`${a}/v1/recursos/r-1`, como('bruno'))
  assert.equal(dev.status, 401, 'token dev aceito em modo JWT')
  assert.deepEqual(await dev.json(), { codigo: 'SESSAO_EXPIRADA' })
})

test('dominio com IDP_EMISSOR: toda recusa e 401 com o corpo normalizado, sem eco do token', async () => {
  reiniciarIdp()
  const a = await subir(criarDominioA())
  const valido = assinar()
  const [, p, s] = valido.split('.')
  const pem = K1.publicKey.export({ type: 'spki', format: 'pem' })
  const hs = b64u({ alg: 'HS256', typ: 'JWT', kid: 'k1' })
  const recusados = {
    'alg none': `${b64u({ alg: 'none', kid: 'k1' })}.${p}.`,
    'HS256 com a chave publica': `${hs}.${p}.${createHmac('sha256', pem).update(`${hs}.${p}`).digest('base64url')}`,
    'iss errado': assinar(claims({ iss: 'http://127.0.0.1:1/realms/erp' })),
    'sem erp-dominios': assinar(claims({ aud: 'account' })),
    vencido: assinar(claims({ exp: agoraS() - 60 })),
    'nbf futuro': assinar(claims({ nbf: agoraS() + 60 })),
    'sem preferred_username': assinar(claims({ preferred_username: undefined })),
    malformado: `${p}.${s}`,
  }
  for (const [caso, token] of Object.entries(recusados)) {
    const r = await fetch(`${a}/v1/recursos`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(r.status, 401, caso)
    const corpo = await r.text()
    assert.deepEqual(JSON.parse(corpo), { codigo: 'SESSAO_EXPIRADA' }, caso)
    assert.ok(!corpo.includes(token.slice(0, 20)), `${caso}: token ecoado`)
  }
})

test('gestao de acesso v2 com IDP_EMISSOR: pessoa pelo login = preferred_username; token dev recusado', async () => {
  reiniciarIdp()
  const v2 = await subir(criarGestaoDeAcessoV2())
  const eu = (auth) => fetch(`${v2}/v2/eu`, { headers: { authorization: auth } })
  const r = await eu(`Bearer ${assinar(claims({ preferred_username: 'ana' }))}`)
  assert.equal(r.status, 200)
  assert.equal((await eu(`Bearer ${assinar(claims({ preferred_username: 'ninguem' }))}`)).status, 401, 'login fora da semente')
  assert.equal((await eu('Bearer dev.ana.00000000-0000-4000-8000-000000000000')).status, 401, 'token dev aceito em modo JWT')
  assert.equal((await eu('Bearer dev.admin1')).status, 401, 'token dev curto aceito em modo JWT')
})

// --- token de serviço em modo JWT (ADR-0013, adendo 1) -----------------------------------------------
// `svc.<aplicacao>` não tem segredo: com IDP_EMISSOR ele só vale para o módulo registrar o PRÓPRIO
// manifesto. Toda outra rota de todo domínio o recusa com 401, inclusive `svc.idp`.

const { readFileSync } = await import('node:fs')
const { criarDominioB } = await import('../src/dominio-b.mjs')
const { criarDominioC } = await import('../src/dominio-c.mjs')
const { criarDominioPlataforma } = await import('../src/dominio-plataforma.mjs')
const { criarGestaoDeAcesso } = await import('../src/gestao-acesso.mjs')

const SERVIDORES = {
  'dominio-a.mjs': criarDominioA, 'dominio-b.mjs': criarDominioB, 'dominio-c.mjs': criarDominioC,
  'dominio-plataforma.mjs': criarDominioPlataforma, 'gestao-acesso.mjs': () => criarGestaoDeAcesso(),
  'gestao-acesso-v2/servidor.mjs': criarGestaoDeAcessoV2,
}
const MANIFESTO = new Set(['POST /v1/manifestos', 'POST /v2/modulos/manifesto'])

/** Toda rota declarada no fonte de cada domínio, com um caminho de exemplo: rota nova entra sozinha. */
function rotasDe(arquivo) {
  const fonte = readFileSync(new URL(`../src/${arquivo}`, import.meta.url), 'utf8')
  return [...fonte.matchAll(/\['(GET|POST|PUT|PATCH|DELETE)', \/\^(.*?)\$\//g)]
    .map(([, metodo, re]) => [metodo, re.replaceAll('([^/]+)', 'x').replaceAll('\\/', '/')])
}

test('modo JWT: token de servico recusado com 401 em toda rota de todo dominio, menos o registro de manifesto', async () => {
  reiniciarIdp()
  let total = 0
  for (const [arquivo, criar] of Object.entries(SERVIDORES)) {
    const url = await subir(criar())
    const rotas = rotasDe(arquivo)
    assert.ok(rotas.length > 0, `${arquivo}: nenhuma rota achada`)
    for (const [metodo, caminho] of rotas) {
      if (MANIFESTO.has(`${metodo} ${caminho}`)) continue
      for (const svc of ['svc.idp', 'svc.zona1', 'svc.acesso']) {
        const corpo = metodo === 'GET' ? undefined : JSON.stringify({ cpf: '52998224725', sub: 'x', pessoa: 'p-1', modulo: 'zona1', id: 'zona1' })
        const r = await fetch(`${url}${caminho}`, { method: metodo, headers: { authorization: `Bearer ${svc}`, 'content-type': 'application/json', 'if-match': '"1"' }, body: corpo })
        assert.equal(r.status, 401, `${arquivo} ${metodo} ${caminho} com ${svc}`)
        assert.deepEqual(await r.json(), { codigo: 'SESSAO_EXPIRADA' })
        total++
      }
    }
  }
  assert.ok(total >= 3 * 39, `so ${total} chamadas: a varredura de rotas encolheu`)
})

test('modo JWT: primeiro-acesso, decisoes e eventos fecham para svc.idp e para qualquer servico', async () => {
  reiniciarIdp()
  const v2 = await subir(criarGestaoDeAcessoV2())
  const pedir = (caminho, svc, corpo) => fetch(`${v2}${caminho}`, {
    method: corpo ? 'POST' : 'GET', headers: { authorization: `Bearer ${svc}`, 'content-type': 'application/json' }, body: corpo && JSON.stringify(corpo),
  })
  for (const svc of ['svc.idp', 'svc.zona1', 'svc.bff']) {
    assert.equal((await pedir('/v2/primeiro-acesso', svc, { cpf: '52998224725', sub: 'sub-forjado' })).status, 401, `primeiro-acesso ${svc}`)
    assert.equal((await pedir('/v2/decisoes', svc, { pessoa: 'p-1', modulo: 'zona1', funcionalidade: 'recursos.ver' })).status, 401, `decisoes ${svc}`)
    assert.equal((await pedir('/v2/eventos', svc)).status, 401, `eventos ${svc}`)
  }
  // dentes: um JWT válido de usuário nessas rotas não é 401 de credencial ausente por acaso do stub
  assert.equal((await fetch(`${v2}/v2/eu`, { headers: { authorization: `Bearer ${assinar(claims({ preferred_username: 'ana' }))}` } })).status, 200)
})

test('modo JWT: registro de manifesto aceita so o modulo do proprio servico (v2: 200; v1: 204), outro id e 403', async () => {
  reiniciarIdp()
  const v2 = await subir(criarGestaoDeAcessoV2())
  const manifesto = (svc, corpo) => fetch(`${v2}/v2/modulos/manifesto`, {
    method: 'POST', headers: { authorization: `Bearer ${svc}`, 'content-type': 'application/json' }, body: JSON.stringify(corpo),
  })
  const zona1 = { id: 'zona1', nome: 'Zona 1', funcionalidades: ['recursos.ver'] }
  assert.equal((await manifesto('svc.zona1', zona1)).status, 200, 'proprio modulo')
  assert.equal((await manifesto('svc.zona2', zona1)).status, 403, 'modulo de outro servico')
  assert.equal((await manifesto('svc.idp', zona1)).status, 403, 'svc.idp registrando zona1')
  assert.equal((await manifesto('dev.ana.x', zona1)).status, 401, 'token dev')

  const v1 = await subir(criarGestaoDeAcesso())
  const m1 = { zona: 'zona2', modulos: [{ id: 'zona2.tarefas', rotulo: 'Tarefas', prefixo: '/zona2', restritoPorPadrao: true }], perfis: [], concessoes: {} }
  const registrar = (svc) => fetch(`${v1}/v1/manifestos`, { method: 'POST', headers: { authorization: `Bearer ${svc}`, 'content-type': 'application/json' }, body: JSON.stringify(m1) })
  assert.equal((await registrar('svc.zona2')).status, 204, 'v1: proprio modulo')
  assert.equal((await registrar('svc.zona1')).status, 403, 'v1: modulo de outro servico')
})
