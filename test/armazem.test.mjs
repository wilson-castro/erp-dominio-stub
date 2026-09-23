import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { criarArmazem, resetar } from '../src/armazem.mjs'
import { criarDominioC } from '../src/dominio-c.mjs'
import { criarEstadoDeAcesso, criarGestaoDeAcesso } from '../src/gestao-acesso.mjs'
import { test, subir, como, post } from './apoio.mjs'

const pasta = () => mkdtempSync(join(tmpdir(), 'stub-dados-'))

test('sem pasta: cada armazem parte da semente e nao grava nada', () => {
  const a = criarArmazem('dominio-c')
  const b = criarArmazem('dominio-c')
  a.dados.tarefas[0].concluida = true
  a.salvar()
  assert.equal(b.dados.tarefas[0].concluida, false)
  assert.equal(criarArmazem('dominio-c').dados.tarefas[0].concluida, false)
})

test('com pasta: o que foi salvo sobrevive a um armazem novo', () => {
  const dir = pasta()
  const a = criarArmazem('dominio-c', { dir })
  a.dados.tarefas[0].concluida = true
  a.salvar()
  assert.equal(JSON.parse(readFileSync(join(dir, 'dominio-c.json'), 'utf8')).tarefas[0].concluida, true)
  assert.equal(criarArmazem('dominio-c', { dir }).dados.tarefas[0].concluida, true)
})

test('resetar apaga o estado e o proximo armazem volta a semente', () => {
  const dir = pasta()
  const a = criarArmazem('dominio-c', { dir })
  a.dados.tarefas[0].concluida = true
  a.salvar()
  resetar(dir)
  assert.equal(existsSync(join(dir, 'dominio-c.json')), false)
  assert.equal(criarArmazem('dominio-c', { dir }).dados.tarefas[0].concluida, false)
})

test('arquivo de estado corrompido nao derruba: volta a semente', () => {
  const dir = pasta()
  writeFileSync(join(dir, 'dominio-c.json'), '{nao e json')
  assert.equal(criarArmazem('dominio-c', { dir }).dados.tarefas.length, 2)
})

test('nome de armazem fora do formato e recusado: nao le nem grava fora da pasta', () => {
  const dir = join(pasta(), 'dados')
  writeFileSync(join(dir, '..', 'fora.json'), '{"segredo":1}')
  assert.throws(() => criarArmazem('../fora', { dir }), /nome de armazém inválido/)
})

test('dominio C com pasta: tarefa concluida continua concluida depois de reiniciar', async () => {
  const dir = pasta()
  const s1 = await subir(criarDominioC({ dir }))
  const req = post('ana', {})
  req.headers['if-match'] = '"3"'   // versao da semente
  assert.equal((await fetch(`${s1}/v1/tarefas/t-1/concluir`, req)).status, 200)
  const s2 = await subir(criarDominioC({ dir }))
  const lista = await (await fetch(`${s2}/v1/tarefas`, como('ana'))).json()
  assert.deepEqual(lista.find((t) => t.id === 't-1'), { id: 't-1', titulo: 'Revisar cadastro', concluida: true, versao: 4 })
})

test('gestao de acesso com pasta: atribuicao feita pelo admin sobrevive a reiniciar', async () => {
  const dir = pasta()
  const s1 = await subir(criarGestaoDeAcesso(criarEstadoDeAcesso({ dir })))
  const r = await fetch(`${s1}/v1/atribuicoes`, post('carla', { usuario: 'davi', perfil: 'plataforma.usuario', atribuir: true }))
  assert.equal(r.status, 204)
  const e = criarEstadoDeAcesso({ dir })
  assert.deepEqual([...e.atribuicoes.get('davi')], ['plataforma.usuario'])
  assert.ok(e.atribuicoes.get('carla').has('plataforma.admin-acesso'))
})

test('servidor: todo dominio sobe com DADOS_DIR e responde a rota de leitura', async () => {
  const { DOMINIOS } = await import('../src/servidor.mjs')
  const dir = pasta()
  const leitura = {
    'dominio-a': '/v1/recursos', 'dominio-b': '/v1/indicadores', 'dominio-c': '/v1/tarefas',
    plataforma: '/v1/avisos', 'gestao-acesso': '/v1/modulos-permitidos', 'gestao-acesso-v2': '/v2/eu',
  }
  for (const [nome, { criar }] of Object.entries(DOMINIOS)) {
    const url = await subir(criar({ dir }))
    // a v2 tem as próprias pessoas (dados/semente/gestao-acesso-v2.json); os outros usam os atores de desenvolvimento
    const auth = nome === 'gestao-acesso-v2' ? { headers: { authorization: 'Bearer dev.admin1' } } : como('ana')
    assert.equal((await fetch(`${url}${leitura[nome]}`, auth)).status, 200, nome)
  }
})
