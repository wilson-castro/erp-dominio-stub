import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projetar } from '../src/projetar.mjs'
import { PEDIDO_8821 } from '../src/pedido-8821.mjs'
import { ATORES } from '../src/atores.mjs'

const proj = (u) => projetar(PEDIDO_8821, ATORES[u])

test('C1: gabrigas ve o operacional e NAO ve a condicao comercial', () => {
  const p = proj('gabrigas')
  assert.equal(p.id, '8821')
  assert.ok(p.itens.length > 0)
  // ausencia TOTAL: a chave nao existe. `null` ja informaria que o bloco existe.
  assert.ok(!('condicaoComercial' in p), 'a chave condicaoComercial nao pode existir')
  assert.ok(!JSON.stringify(p).includes('margem'))
  assert.ok(!JSON.stringify(p).includes('precoNegociado'))
})

test('C1: marina ve a condicao comercial', () => {
  const p = proj('marina')
  assert.ok('condicaoComercial' in p)
  assert.equal(typeof p.condicaoComercial.margem, 'number')
})

test('C1: rafael e ADMIN mas NAO ve a condicao comercial — role nao e grupo', () => {
  const p = proj('rafael')
  assert.ok(!('condicaoComercial' in p),
            'ADMIN nao concede o grupo COMERCIAL-NORDESTE')
})

test('C1: carla nao conhece o pedido', () => {
  assert.equal(proj('carla'), null)
})

test('_permissoes e Record completo para todos os atores autorizados', () => {
  const acoes = ['editar', 'remover_remessa', 'excluir', 'aprovar']
  for (const u of ['gabrigas', 'marina', 'rafael']) {
    assert.deepEqual(Object.keys(proj(u)._permissoes).sort(), [...acoes].sort(), u)
    for (const a of acoes) assert.equal(typeof proj(u)._permissoes[a], 'boolean')
  }
})

test('mutar a projecao nao altera o fixture visto pelos proximos atores', () => {
  const p = proj('marina')
  p.condicaoComercial.margem = 0.99
  p.itens[0].quantidade = 1
  p.fornecedor.nome = 'outro'
  assert.equal(PEDIDO_8821.condicaoComercial.margem, 0.17)
  assert.equal(PEDIDO_8821.itens[0].quantidade, 120)
  assert.equal(PEDIDO_8821.fornecedor.nome, 'Metalúrgica Aurora')
})
