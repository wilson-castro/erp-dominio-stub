import assert from 'node:assert/strict'
import { test, subir } from './apoio.mjs'
import { criarGestaoDeAcessoV2 } from '../src/gestao-acesso-v2/servidor.mjs'
import { cpfValido } from '../src/gestao-acesso-v2/regras.mjs'

// "hoje" fixo: o convênio da unidade Sul terminou em 2026-06-30; o da Norte vale até 2027-12-31
const url = await subir(criarGestaoDeAcessoV2({ agora: () => new Date('2026-09-22T12:00:00Z') }))
const como = (login, corpo, metodo = corpo ? 'POST' : 'GET', extra = {}) => fetch(`${url}${extra.caminho}`, {
  method: metodo,
  headers: { authorization: login.startsWith('svc.') ? `Bearer ${login}` : `Bearer dev.${login}`, 'content-type': 'application/json', ...extra.headers },
  ...(corpo ? { body: JSON.stringify(corpo) } : {}),
})
const pedir = (login, caminho, corpo, metodo, headers) => como(login, corpo, metodo, { caminho, headers })

test('cpf: digitos verificadores', () => {
  assert.equal(cpfValido('52601815906'), true)
  assert.equal(cpfValido('52601815907'), false)
  assert.equal(cpfValido('11111111111'), false)
})

test('sem credencial 401; vindo do navegador 403', async () => {
  assert.equal((await fetch(`${url}/v2/eu`)).status, 401)
  assert.equal((await fetch(`${url}/v2/eu`, { headers: { authorization: 'Bearer dev.admin1', origin: 'http://localhost:3000' } })).status, 403)
})

test('acesso efetivo e intersecao: papel administrativo nao da acesso a modulo', async () => {
  const admin = await (await pedir('admin1', '/v2/eu')).json()
  assert.deepEqual(admin.modulos, [])
  const norte1 = await (await pedir('norte1', '/v2/eu')).json()
  assert.deepEqual(norte1.modulos.map((m) => m.id).sort(), ['zona1', 'zona2'])
  // convenio vencido: a pessoa da unidade Sul perde o acesso sem ninguem revogar
  assert.deepEqual((await (await pedir('sul1', '/v2/eu')).json()).modulos, [])
})

test('decisao para dominios: funcionalidade fora do perfil e negada com motivo', async () => {
  const d = async (corpo) => (await pedir('svc.zona2', '/v2/decisoes', corpo)).json()
  assert.equal((await d({ pessoa: 'p-12', modulo: 'zona2', funcionalidade: 'tarefas.concluir' })).permitido, true)
  assert.equal((await d({ pessoa: 'p-13', modulo: 'zona2', funcionalidade: 'tarefas.ver' })).motivo, 'SEM_ACESSO_AO_MODULO')
  assert.equal((await d({ pessoa: 'p-15', modulo: 'zona1', funcionalidade: 'painel.ver' })).motivo, 'UNIDADE_SEM_VIGENCIA')
})

test('escopo: gestor so ve a propria unidade; fora dela e 404; sem busca geral', async () => {
  assert.equal((await pedir('gnorte1', '/v2/pessoas?unidade=norte')).status, 200)
  assert.equal((await pedir('gnorte1', '/v2/pessoas?unidade=sul')).status, 404)
  assert.equal((await pedir('gnorte1', '/v2/pessoas/p-15')).status, 404)
  assert.equal((await pedir('admin1', '/v2/pessoas')).status, 404)
})

test('pre-cadastro: cpf valido, conta unica, modulo validado vira pendente', async () => {
  const base = { nome: 'Nova Pessoa', unidade: 'norte', emailFuncional: 'nova@norte.exemplo', cpf: '66392332154' }
  assert.equal((await pedir('gnorte1', '/v2/pessoas', { ...base, cpf: '66392332155' })).status, 422)
  assert.equal((await pedir('gnorte1', '/v2/pessoas', { ...base, cpf: '52601815906' })).status, 409)
  assert.equal((await pedir('gsul1', '/v2/pessoas', base)).status, 404)
  const r = await pedir('gnorte1', '/v2/pessoas', { ...base, modulosSolicitados: ['zona1', 'zona2'] })
  assert.equal(r.status, 201)
  const p = await r.json()
  assert.equal(p.status, 'cadastrado')
  const acessos = await (await pedir('gnorte1', `/v2/acessos`)).json()
  const meus = acessos.filter((a) => a.pessoa === p.id)
  assert.deepEqual(meus.map((a) => [a.modulo, a.situacao]).sort(), [['zona1', 'ativo'], ['zona2', 'pendente']])
})

test('primeiro acesso: cpf sem cadastro recebe a mesma resposta e vira evento', async () => {
  assert.equal((await pedir('svc.outro', '/v2/primeiro-acesso', { cpf: '54323194897', sub: 'x' })).status, 401)
  const sem = await pedir('svc.idp', '/v2/primeiro-acesso', { cpf: '46881973659', sub: 'x' })
  const com = await pedir('svc.idp', '/v2/primeiro-acesso', { cpf: '54323194897', sub: 'outro-sub' })
  assert.equal(sem.status, 403); assert.equal(com.status, 403)   // o sub nao casa com o ja vinculado
  assert.deepEqual(await sem.json(), await com.json())
  const ok = await pedir('svc.idp', '/v2/primeiro-acesso', { cpf: '34236671255', sub: 'idp-norte3' })
  assert.equal(ok.status, 200)
  const aud = await (await pedir('auditor1', '/v2/auditoria')).json()
  assert.ok(aud.some((ev) => ev.tipo === 'TENTATIVA_SEM_CADASTRO' && !JSON.stringify(ev).includes('46881973659')))
})

test('segregacao: administracao e auditoria nao se acumulam; ninguem se atribui; gestor nao cria gestor', async () => {
  const at = (autor, pessoa, corpo) => pedir(autor, `/v2/pessoas/${pessoa}/atribuicoes`, corpo)
  assert.equal((await (await at('admin1', 'p-03', { papel: 'gestor-unidade', escopo: 'norte' })).json()).codigo, 'SEGREGACAO_DE_FUNCOES')
  assert.equal((await at('admin1', 'p-01', { papel: 'auditor-plataforma' })).status, 403)
  assert.equal((await at('gnorte1', 'p-12', { papel: 'gestor-unidade', escopo: 'norte' })).status, 403)
  assert.equal((await at('admin1', 'p-11', { papel: 'gestor-unidade', escopo: 'norte' })).status, 201)
})

test('validacao pelo gestor do modulo: recusa exige justificativa; quem pediu nao valida', async () => {
  const pend = (await (await pedir('gmod1', '/v2/acessos?situacao=pendente&modulo=zona2')).json()).find((a) => a.pessoa === 'p-13')
  assert.equal((await pedir('gnorte1', `/v2/acessos/${pend.id}/decisao`, { aprovar: true, perfil: 'zona2.leitor' })).status, 404)
  assert.equal((await (await pedir('gmod1', `/v2/acessos/${pend.id}/decisao`, { aprovar: false })).json()).codigo, 'JUSTIFICATIVA_OBRIGATORIA')
  const r = await pedir('gmod1', `/v2/acessos/${pend.id}/decisao`, { aprovar: true, perfil: 'zona2.leitor' })
  assert.equal((await r.json()).situacao, 'ativo')
})

test('desligamento: revoga acessos e publica evento para encerrar sessoes', async () => {
  const antes = (await (await pedir('svc.shell', '/v2/eventos')).json()).length
  assert.equal((await pedir('gnorte2', '/v2/pessoas/p-12/desligamento', {})).status, 204)
  const ev = await (await pedir('svc.shell', `/v2/eventos?desde=0`)).json()
  assert.ok(ev.length > antes && ev.some((x) => x.tipo === 'PESSOA_DESLIGADA' && x.alvo === 'p-12'))
  assert.equal((await pedir('norte1', '/v2/eu')).status, 401)
})

test('PATCH exige If-Match; CPF e imutavel', async () => {
  assert.equal((await pedir('gnorte1', '/v2/pessoas/p-13', { nome: 'X' }, 'PATCH')).status, 428)
  assert.equal((await pedir('gnorte1', '/v2/pessoas/p-13', { nome: 'X' }, 'PATCH', { 'if-match': '"9"' })).status, 409)
  assert.equal((await pedir('gnorte1', '/v2/pessoas/p-13', { cpf: '52601815906' }, 'PATCH', { 'if-match': '"1"' })).status, 422)
})

test('categoria do modulo: so o administrador geral, com justificativa', async () => {
  assert.equal((await pedir('gmod1', '/v2/modulos/zona2/categoria', { categoria: 'direto', justificativa: 'x' }, 'PATCH')).status, 404)
  assert.equal((await pedir('admin1', '/v2/modulos/zona2/categoria', { categoria: 'validado' }, 'PATCH')).status, 422)
})

test('auditoria: somente para auditor; administrador acao em unidade parceira fica marcada como excecao', async () => {
  assert.equal((await pedir('admin1', '/v2/auditoria')).status, 404)
  await pedir('admin1', '/v2/pessoas', { nome: 'Por Excecao', unidade: 'norte', emailFuncional: 'exc@norte.exemplo', cpf: '99356327254' })
  const aud = await (await pedir('auditor1', '/v2/auditoria')).json()
  assert.ok(aud.some((ev) => ev.tipo === 'PESSOA_CADASTRADA' && ev.autor === 'p-01' && ev.excecao === true))
})

test('painel da unidade: gestores insuficientes e contato divergente do segundo fator', async () => {
  const leste = await (await pedir('gleste1', '/v2/unidades/leste/painel')).json()
  assert.ok(leste.pendencias.some((p) => p.tipo === 'GESTORES_INSUFICIENTES'))
  assert.equal((await pedir('gsul1', '/v2/unidades/norte/painel')).status, 404)
})

test('segregacao na validacao: quem solicitou nao valida, e ninguem valida o proprio acesso', async () => {
  // admin2 faz do admin1 gestor do modulo zona2; o admin1 solicita para uma pessoa e tenta validar
  assert.equal((await pedir('admin2', '/v2/pessoas/p-01/atribuicoes', { papel: 'gestor-modulo', escopo: 'zona2' })).status, 201)
  const sol = await (await pedir('admin1', '/v2/acessos', { pessoa: 'p-14', modulo: 'zona2' })).json()
  assert.equal((await (await pedir('admin1', `/v2/acessos/${sol.id}/decisao`, { aprovar: true, perfil: 'zona2.leitor' })).json()).codigo, 'SEGREGACAO_DE_FUNCOES')
  // o admin2 pede acesso para o gmod3, que tenta validar o proprio
  const meu = await (await pedir('admin2', '/v2/acessos', { pessoa: 'p-06', modulo: 'zona2' })).json()
  assert.equal((await pedir('gmod3', `/v2/acessos/${meu.id}/decisao`, { aprovar: true, perfil: 'zona2.operador' })).status, 403)
  assert.equal((await pedir('gmod2', `/v2/acessos/${meu.id}/decisao`, { aprovar: true, perfil: 'zona2.operador' })).status, 200)
})

// --- atores da base (ADR-0014, adendo 1): os mesmos do realm, do identidadeDev e do gate ---------
const UUID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'
const eu = async (login) => (await fetch(`${url}/v2/eu`, { headers: { authorization: `Bearer dev.${login}.${UUID}` } })).json()

test('o token de desenvolvimento do shell (dev.<login>.<uuid>) identifica a pessoa', async () => {
  assert.equal((await fetch(`${url}/v2/eu`, { headers: { authorization: `Bearer dev.ana.${UUID}` } })).status, 200)
  for (const t of ['dev.intruso', `dev.intruso.${UUID}`, 'dev.ana.nao-e-uuid', `dev.ana.${UUID}.x`]) {
    assert.equal((await fetch(`${url}/v2/eu`, { headers: { authorization: `Bearer ${t}` } })).status, 401, t)
  }
})

test('ana, bruno, carla e davi: acesso efetivo igual ao da v1, com o nome do modulo para o menu', async () => {
  const resumo = async (login) => {
    const e = await eu(login)
    return { modulos: Object.fromEntries(e.modulos.map((m) => [m.id, m.funcionalidades])), papeis: e.papeis.map((p) => p.papel), nomes: e.modulos.map((m) => m.nome) }
  }
  assert.deepEqual(await resumo('ana'), { modulos: { zona1: ['painel.ver'], zona2: ['tarefas.ver', 'tarefas.concluir'] }, papeis: [], nomes: ['Zona 1 — painel e relatórios', 'Zona 2 — tarefas'] })
  assert.deepEqual((await resumo('bruno')).modulos, { zona1: ['painel.ver', 'relatorios.ver'] })
  // segregação: carla administra, mas o papel não lhe dá módulo algum além do que tem por acesso
  assert.deepEqual(await resumo('carla'), { modulos: { zona1: ['painel.ver'] }, papeis: ['admin-geral'], nomes: ['Zona 1 — painel e relatórios'] })
  assert.deepEqual(await resumo('davi'), { modulos: { zona1: ['painel.ver'] }, papeis: [], nomes: ['Zona 1 — painel e relatórios'] })
})

test('os atores da base ficam na unidade central, sem convenio: o gate nao depende da data', async () => {
  for (const login of ['ana', 'bruno', 'carla', 'davi']) assert.equal((await eu(login)).pessoa.unidade, 'central')
})
