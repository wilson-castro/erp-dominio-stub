import assert from 'node:assert/strict'
import { test, subir, como, post } from './apoio.mjs'
import { criarGestaoDeAcesso } from '../src/gestao-acesso.mjs'

const MANIFESTOS = {
  shell: { zona: 'shell', modulos: [{ id: 'shell.inicio', rotulo: 'Início', prefixo: '/', restritoPorPadrao: false }], perfis: [], concessoes: {} },
  zona1: {
    zona: 'zona1',
    modulos: [
      { id: 'zona1.painel', rotulo: 'Painel', prefixo: '/zona1', restritoPorPadrao: false },
      { id: 'zona1.relatorios', rotulo: 'Relatórios', prefixo: '/zona1/relatorios', restritoPorPadrao: true },
    ],
    perfis: [{ id: 'zona1.analista', rotulo: 'Analista' }],
    concessoes: { 'zona1.analista': ['zona1.relatorios'] },
  },
  zona2: {
    zona: 'zona2',
    modulos: [{ id: 'zona2.tarefas', rotulo: 'Tarefas', prefixo: '/zona2', restritoPorPadrao: true }],
    perfis: [{ id: 'zona2.operador', rotulo: 'Operador' }],
    concessoes: { 'zona2.operador': ['zona2.tarefas'] },
  },
  acesso: { zona: 'acesso', modulos: [{ id: 'acesso.admin', rotulo: 'Gestão de acesso', prefixo: '/acesso', restritoPorPadrao: true }], perfis: [], concessoes: {} },
}

async function novo() {
  const base = await subir(criarGestaoDeAcesso())
  for (const [zona, m] of Object.entries(MANIFESTOS)) {
    const r = await fetch(`${base}/v1/manifestos`, post(null, m, `Bearer svc.${zona}`))
    assert.equal(r.status, 204, `registro de ${zona}`)
  }
  return base
}
const permitidos = async (base, u) => (await (await fetch(`${base}/v1/modulos-permitidos`, como(u))).json()).map((m) => m.id).sort()

test('cada ator ve os modulos que a matriz concede', async () => {
  const b = await novo()
  assert.deepEqual(await permitidos(b, 'ana'), ['shell.inicio', 'zona1.painel', 'zona2.tarefas'])
  assert.deepEqual(await permitidos(b, 'bruno'), ['shell.inicio', 'zona1.painel', 'zona1.relatorios'])
  assert.deepEqual(await permitidos(b, 'carla'), ['acesso.admin', 'shell.inicio', 'zona1.painel'])
  assert.deepEqual(await permitidos(b, 'davi'), ['shell.inicio', 'zona1.painel'])
})

test('uma zona so registra o proprio manifesto', async () => {
  const b = await subir(criarGestaoDeAcesso())
  assert.equal((await fetch(`${b}/v1/manifestos`, post(null, MANIFESTOS.zona1, 'Bearer svc.zona2'))).status, 403)
  assert.equal((await fetch(`${b}/v1/manifestos`, post('ana', MANIFESTOS.zona1))).status, 401, 'usuario nao registra')
  const invalido = { ...MANIFESTOS.zona1, concessoes: { 'zona1.analista': ['acesso.admin'] } }
  assert.equal((await fetch(`${b}/v1/manifestos`, post(null, invalido, 'Bearer svc.zona1'))).status, 422)
})

test('administracao: quem nao e admin recebe 404, como se a rota nao existisse', async () => {
  const b = await novo()
  for (const u of ['ana', 'bruno', 'davi']) {
    assert.equal((await fetch(`${b}/v1/catalogo`, como(u))).status, 404)
    assert.equal((await fetch(`${b}/v1/concessoes`, post(u, { perfil: 'zona1.analista', modulo: 'zona1.relatorios', conceder: false }))).status, 404)
  }
  assert.deepEqual(await permitidos(b, 'bruno'), ['shell.inicio', 'zona1.painel', 'zona1.relatorios'], 'nada mudou')
})

test('revogar a concessao tira o modulo na proxima consulta, sem novo login', async () => {
  const b = await novo()
  const r = await fetch(`${b}/v1/concessoes`, post('carla', { perfil: 'zona1.analista', modulo: 'zona1.relatorios', conceder: false }))
  assert.equal(r.status, 204)
  assert.deepEqual(await permitidos(b, 'bruno'), ['shell.inicio', 'zona1.painel'])
})

test('marcar modulo como restrito o tira de quem nao tem concessao', async () => {
  const b = await novo()
  assert.equal((await fetch(`${b}/v1/restricoes`, post('carla', { modulo: 'zona1.painel', restrito: true }))).status, 204)
  assert.deepEqual(await permitidos(b, 'davi'), ['shell.inicio'])
  assert.equal((await fetch(`${b}/v1/restricoes`, post('carla', { modulo: 'acesso.admin', restrito: false }))).status, 403,
    'a tela de administracao nao pode ficar livre')
})

test('D8: perfil de zona nao concede modulo de outra zona; perfil de plataforma pode', async () => {
  const b = await novo()
  assert.equal((await fetch(`${b}/v1/concessoes`, post('carla', { perfil: 'zona1.analista', modulo: 'zona2.tarefas', conceder: true }))).status, 403)
  assert.equal((await fetch(`${b}/v1/concessoes`, post('carla', { perfil: 'plataforma.usuario', modulo: 'zona2.tarefas', conceder: true }))).status, 204)
  assert.ok((await permitidos(b, 'bruno')).includes('zona2.tarefas'))
})

test('atribuir e retirar perfil de usuario; admin nao se remove', async () => {
  const b = await novo()
  assert.equal((await fetch(`${b}/v1/atribuicoes`, post('carla', { usuario: 'davi', perfil: 'zona2.operador', atribuir: true }))).status, 204)
  assert.ok((await permitidos(b, 'davi')).includes('zona2.tarefas'))
  assert.equal((await fetch(`${b}/v1/atribuicoes`, post('carla', { usuario: 'carla', perfil: 'plataforma.admin-acesso', atribuir: false }))).status, 403)
})

test('catalogo mostra zonas, perfis federados e concessoes', async () => {
  const b = await novo()
  const cat = await (await fetch(`${b}/v1/catalogo`, como('carla'))).json()
  assert.deepEqual(cat.zonas, ['acesso', 'shell', 'zona1', 'zona2'])
  assert.ok(cat.perfis.some((p) => p.id === 'zona1.analista' && p.zona === 'zona1'))
  const rel = cat.modulos.find((m) => m.id === 'zona1.relatorios')
  assert.deepEqual([rel.restrito, rel.perfis], [true, ['zona1.analista']])
  assert.ok(!rel.perfisPossiveis.includes('zona2.operador'), 'D8 no catalogo')
  assert.ok(rel.perfisPossiveis.includes('plataforma.usuario'))
})

test('reenviar o manifesto nao desfaz o que o administrador mudou', async () => {
  const b = await novo()
  await fetch(`${b}/v1/concessoes`, post('carla', { perfil: 'zona1.analista', modulo: 'zona1.relatorios', conceder: false }))
  await fetch(`${b}/v1/manifestos`, post(null, MANIFESTOS.zona1, 'Bearer svc.zona1'))
  assert.ok(!(await permitidos(b, 'bruno')).includes('zona1.relatorios'))
})

test('manifesto que se diz plataforma e recusado: perfil global nao nasce de manifesto', async () => {
  const b = await subir(criarGestaoDeAcesso())
  const m = { zona: 'plataforma', modulos: [{ id: 'plataforma.x', rotulo: 'X', prefixo: '/plataforma', restritoPorPadrao: false }],
              perfis: [{ id: 'plataforma.super', rotulo: 'Super' }], concessoes: {} }
  assert.equal((await fetch(`${b}/v1/manifestos`, post(null, m, 'Bearer svc.plataforma'))).status, 422)
})
