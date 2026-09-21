import assert from 'node:assert/strict'
import { test, subir, como, post } from './apoio.mjs'
import { criarDominioA } from '../src/dominio-a.mjs'
import { criarDominioC } from '../src/dominio-c.mjs'

const a = await subir(criarDominioA())
const c = await subir(criarDominioC())

test('sem credencial: 401 sem motivo', async () => {
  const r = await fetch(`${a}/v1/recursos`)
  assert.equal(r.status, 401)
  assert.deepEqual(await r.json(), { codigo: 'SESSAO_EXPIRADA' })
})

test('requisicao vinda do navegador e recusada (dominio nao exposto)', async () => {
  for (const h of [{ origin: 'http://localhost:3000' }, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-dest': 'document' }]) {
    assert.equal((await fetch(`${a}/v1/recursos`, como('bruno', h))).status, 403)
  }
})

test('projecao: custo so existe para o FINANCEIRO; admin de acesso (carla) nao ganha dado', async () => {
  const bruno = await (await fetch(`${a}/v1/recursos/r-1`, como('bruno'))).json()
  assert.equal(typeof bruno.custo.valor, 'number')
  for (const u of ['carla', 'ana', 'davi']) {
    const r = await (await fetch(`${a}/v1/recursos/r-1`, como(u))).json()
    assert.ok(!('custo' in r), `${u} recebeu custo`)
  }
})

test('escopo: r-3 fora do escopo e identico a inexistente', async () => {
  const semData = (r) => [...r.headers].filter(([k]) => k !== 'date')
  const negado = await fetch(`${a}/v1/recursos/r-3`, como('carla'))
  const inexistente = await fetch(`${a}/v1/recursos/r-999`, como('bruno'))
  assert.equal(negado.status, 404)
  assert.deepEqual(semData(negado), semData(inexistente))
  assert.equal(await negado.text(), await inexistente.text())
  assert.equal((await fetch(`${a}/v1/recursos/r-3`, como('bruno'))).status, 200)
  const lista = await (await fetch(`${a}/v1/recursos`, como('carla'))).json()
  assert.deepEqual(lista.map((r) => r.id), ['r-1', 'r-2'])
})

test('id malformado nao derruba o dominio', async () => {
  assert.equal((await fetch(`${a}/v1/recursos/%E0`, como('bruno'))).status, 404)
  assert.equal((await fetch(`${a}/v1/recursos`, como('bruno'))).status, 200)
})

test('concluir tarefa exige grupo, If-Match e versao atual', async () => {
  const url = `${c}/v1/tarefas/t-1/concluir`
  assert.equal((await fetch(url, post('bruno', {}))).status, 403, 'sem grupo OPERACAO')
  assert.equal((await fetch(url, post('ana', {}))).status, 428, 'sem If-Match')
  const velho = post('ana', {}); velho.headers['if-match'] = '"0"'
  assert.equal((await fetch(url, velho)).status, 409, 'versao desatualizada')
  const certo = post('ana', {}); certo.headers['if-match'] = '"1"'
  const r = await fetch(url, certo)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('etag'), '"2"')
  assert.equal((await r.json()).concluida, true)
})
