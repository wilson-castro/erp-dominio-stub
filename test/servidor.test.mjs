import { test as testNode, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { criarServidor } from '../src/servidor.mjs'

let servidor
let base

before(async () => {
  servidor = criarServidor()
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok))
  base = `http://127.0.0.1:${servidor.address().port}`
})

after(() => new Promise((ok) => { servidor.closeAllConnections(); servidor.close(ok) }))

// Uma exceção no listener não responde a requisição: sem timeout o fetch espera para
// sempre e a regressão trava a suíte em vez de reprová-la.
const test = (nome, fn) => testNode(nome, { timeout: 3000 }, fn)

const como = (usuario, extra = {}) => ({ headers: { authorization: `Bearer dev.${usuario}.x`, ...extra } })

test('gabrigas recebe 200 sem a chave condicaoComercial e com ETag da versao', async () => {
  const r = await fetch(`${base}/pedidos/8821`, como('gabrigas'))
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('etag'), '"42"')
  const corpo = await r.json()
  assert.ok(!('condicaoComercial' in corpo))
})

test('marina recebe a condicao comercial', async () => {
  const corpo = await (await fetch(`${base}/pedidos/8821`, como('marina'))).json()
  assert.equal(typeof corpo.condicaoComercial.margem, 'number')
})

test('404 de carla e identico, em corpo e headers, ao 404 de um id inexistente', async () => {
  const semData = (r) => [...r.headers].filter(([k]) => k !== 'date')
  const negado = await fetch(`${base}/pedidos/8821`, como('carla'))
  const inexistente = await fetch(`${base}/pedidos/9999`, como('marina'))
  assert.equal(negado.status, 404)
  assert.equal(inexistente.status, 404)
  assert.deepEqual(semData(negado), semData(inexistente))
  assert.equal(await negado.text(), await inexistente.text())
})

test('sem credencial recebe 401 sem descrever o motivo', async () => {
  const r = await fetch(`${base}/pedidos/8821`)
  assert.equal(r.status, 401)
  assert.deepEqual(await r.json(), { codigo: 'SESSAO_EXPIRADA' })
})

test('requisicao com os cabecalhos que o navegador manda recebe 403', async () => {
  const doNavegador = [
    { origin: 'http://localhost:3000' },
    // fetch cross-site de uma pagina
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
    // URL digitada na barra de endereco: sem Origin
    { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
  ]
  for (const h of doNavegador) {
    const r = await fetch(`${base}/pedidos/8821`, como('marina', h))
    assert.equal(r.status, 403, JSON.stringify(h))
  }
})

test('fetch de servidor do Node, o mesmo do adaptador do nucleo, passa apesar de sec-fetch-mode', async () => {
  // o undici injeta `sec-fetch-mode: cors` em todo fetch; recusar por ele bloquearia o BFF
  const r = await fetch(`${base}/pedidos/8821`, como('marina', { 'sec-fetch-mode': 'cors' }))
  assert.equal(r.status, 200)
})

test('/pedidos/:id so responde a GET; outros metodos recebem o mesmo 404 padrao', async () => {
  const padrao = await (await fetch(`${base}/pedidos/9999`, como('marina'))).text()
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = await fetch(`${base}/pedidos/8821`, { method, ...como('marina') })
    assert.equal(r.status, 404, method)
    assert.equal(await r.text(), padrao, method)
  }
})

test('id com percent-encoding malformado recebe 404 e o servidor continua de pe', async () => {
  const r = await fetch(`${base}/pedidos/%E0`, como('marina'))
  assert.equal(r.status, 404)
  assert.equal((await fetch(`${base}/pedidos/8821`, como('marina'))).status, 200)
})

test('/_dev/revogar com corpo que nao e JSON recebe 400 e o servidor continua de pe', async () => {
  const r = await fetch(`${base}/_dev/revogar`, { method: 'POST', body: '{nao-json' })
  assert.equal(r.status, 400)
  assert.equal((await fetch(`${base}/pedidos/8821`, como('marina'))).status, 200)
})

test('C7: revogar o grupo dono faz o pedido virar 404 para o ator', async () => {
  const r = await fetch(`${base}/_dev/revogar`, {
    method: 'POST', body: JSON.stringify({ usuario: 'gabrigas', grupo: 'OPS-NORDESTE' }),
  })
  assert.equal(r.status, 204)
  assert.equal((await fetch(`${base}/pedidos/8821`, como('gabrigas'))).status, 404)
})
