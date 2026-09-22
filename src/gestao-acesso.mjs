import { validarManifesto } from '@erp/contratos'
import { criarDominio, json, naoEncontrado, lerCorpo } from './base.mjs'
import { criarArmazem } from './armazem.mjs'

/**
 * Domínio de gestão de acesso (N5, N6). Guarda:
 * - os catálogos federados: cada zona registra o próprio manifesto (módulos, perfis,
 *   concessões padrão), e só o próprio (D5);
 * - a atribuição central: perfil × módulo, módulo restrito e usuário × perfil, que só a
 *   zona de gestão de acesso administra.
 *
 * Perfis de zona têm o prefixo da zona e só concedem módulos dela (D8). Perfis de
 * plataforma (`plataforma.*`) são globais e explícitos, e nascem aqui, não num manifesto.
 */
export const PERFIS_DE_PLATAFORMA = [
  { id: 'plataforma.usuario', rotulo: 'Usuário da plataforma' },
  { id: 'plataforma.admin-acesso', rotulo: 'Administrador de acesso' },
]
const PERFIL_ADMIN = 'plataforma.admin-acesso'

/** Estado vindo de `dados/semente/gestao-acesso.json` (ou de `<dir>/gestao-acesso.json`). */
export function criarEstadoDeAcesso({ dir } = {}) {
  const armazem = criarArmazem('gestao-acesso', { dir })
  const d = armazem.dados
  const conjuntos = (o) => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]))
  const e = {
    manifestos: new Map(Object.entries(d.manifestos)),
    /** perfil -> Set(modulo) */
    concessoes: conjuntos(d.concessoes),
    /** modulo -> boolean */
    restrito: new Map(Object.entries(d.restrito)),
    /** usuario -> Set(perfil) */
    atribuicoes: conjuntos(d.atribuicoes),
    salvar() {
      const listas = (m) => Object.fromEntries([...m].map(([k, s]) => [k, [...s]]))
      armazem.dados.manifestos = Object.fromEntries(e.manifestos)
      armazem.dados.concessoes = listas(e.concessoes)
      armazem.dados.restrito = Object.fromEntries(e.restrito)
      armazem.dados.atribuicoes = listas(e.atribuicoes)
      armazem.salvar()
    },
  }
  return e
}

const zonaDe = (id) => id.split('.')[0]
const perfisConhecidos = (e) => new Set([
  ...PERFIS_DE_PLATAFORMA.map((p) => p.id),
  ...[...e.manifestos.values()].flatMap((m) => m.perfis.map((p) => p.id)),
])
const modulosConhecidos = (e) => new Map(
  [...e.manifestos.values()].flatMap((m) => m.modulos.map((mod) => [mod.id, { ...mod, zona: m.zona }])),
)

export function modulosPermitidos(e, usuario) {
  const perfis = e.atribuicoes.get(usuario) ?? new Set()
  const permitidos = []
  for (const mod of modulosConhecidos(e).values()) {
    const concedido = [...perfis].some((p) => e.concessoes.get(p)?.has(mod.id))
    if (!e.restrito.get(mod.id) || concedido) {
      permitidos.push({ id: mod.id, zona: mod.zona, rotulo: mod.rotulo, prefixo: mod.prefixo })
    }
  }
  return permitidos
}

/** D8: perfil de zona só concede módulo da própria zona; perfil de plataforma, qualquer um. */
export function concessaoValida(perfil, modulo) {
  return zonaDe(perfil) === 'plataforma' || zonaDe(perfil) === zonaDe(modulo)
}

export function registrarManifesto(e, manifesto) {
  const m = validarManifesto(manifesto)
  const novo = !e.manifestos.has(m.zona)
  e.manifestos.set(m.zona, m)
  for (const mod of m.modulos) {
    // restrição é administrada aqui depois do primeiro registro; o manifesto só dá o padrão
    if (!e.restrito.has(mod.id)) e.restrito.set(mod.id, mod.restritoPorPadrao)
  }
  if (novo) {
    for (const [perfil, mods] of Object.entries(m.concessoes)) {
      const s = e.concessoes.get(perfil) ?? new Set()
      for (const mod of mods) s.add(mod)
      e.concessoes.set(perfil, s)
    }
  }
  return m
}

export function criarGestaoDeAcesso(estado = criarEstadoDeAcesso()) {
  const e = estado
  const ehAdmin = (u) => e.atribuicoes.get(u)?.has(PERFIL_ADMIN) ?? false

  return criarDominio([
    ['GET', /^\/v1\/modulos-permitidos$/, ({ res, usuario }) => {
      if (!usuario) return json(res, 401, { codigo: 'SESSAO_EXPIRADA' })
      json(res, 200, modulosPermitidos(e, usuario))
    }],

    // Uma zona só registra o PRÓPRIO manifesto: o token de serviço nomeia a aplicação.
    ['POST', /^\/v1\/manifestos$/, async ({ req, res, servico }) => {
      const corpo = await lerCorpo(req)
      if (!servico) return json(res, 401, { codigo: 'SESSAO_EXPIRADA' })
      if (corpo?.zona !== servico) return json(res, 403, { codigo: 'OPERACAO_NAO_PERMITIDA' })
      try { registrarManifesto(e, corpo) } catch { return json(res, 422, { codigo: 'ERRO_INTERNO' }) }
      e.salvar?.()
      json(res, 204, undefined)
    }],

    // Administração: quem não é administrador recebe 404, como se a rota não existisse.
    ['GET', /^\/v1\/catalogo$/, ({ res, usuario }) => {
      if (!ehAdmin(usuario)) return naoEncontrado(res)
      const todos = [...perfisConhecidos(e)]
      const modulos = [...modulosConhecidos(e).values()].map((m) => ({
        id: m.id, zona: m.zona, rotulo: m.rotulo, prefixo: m.prefixo,
        restrito: e.restrito.get(m.id) ?? m.restritoPorPadrao,
        perfis: [...e.concessoes].filter(([, s]) => s.has(m.id)).map(([p]) => p).sort(),
        // A regra D8 mora aqui; a tela só mostra o que o domínio diz que é possível.
        perfisPossiveis: todos.filter((p) => concessaoValida(p, m.id)).sort(),
      }))
      const perfis = [
        ...PERFIS_DE_PLATAFORMA.map((p) => ({ ...p, zona: 'plataforma' })),
        ...[...e.manifestos.values()].flatMap((m) => m.perfis.map((p) => ({ ...p, zona: m.zona }))),
      ]
      const usuarios = [...e.atribuicoes].map(([u, s]) => ({ usuario: u, perfis: [...s].sort() }))
      json(res, 200, { zonas: [...e.manifestos.keys()].sort(), modulos, perfis, usuarios })
    }],

    ['POST', /^\/v1\/concessoes$/, async ({ req, res, usuario }) => {
      const c = await lerCorpo(req)
      if (!ehAdmin(usuario)) return naoEncontrado(res)
      const { perfil, modulo, conceder } = c ?? {}
      if (!perfisConhecidos(e).has(perfil) || !modulosConhecidos(e).has(modulo) || typeof conceder !== 'boolean') {
        return json(res, 422, { codigo: 'ERRO_INTERNO' })
      }
      if (!concessaoValida(perfil, modulo)) return json(res, 403, { codigo: 'OPERACAO_NAO_PERMITIDA' })
      const s = e.concessoes.get(perfil) ?? new Set()
      conceder ? s.add(modulo) : s.delete(modulo)
      e.concessoes.set(perfil, s)
      e.salvar?.()
      json(res, 204, undefined)
    }],

    ['POST', /^\/v1\/restricoes$/, async ({ req, res, usuario }) => {
      const c = await lerCorpo(req)
      if (!ehAdmin(usuario)) return naoEncontrado(res)
      if (!modulosConhecidos(e).has(c?.modulo) || typeof c?.restrito !== 'boolean') {
        return json(res, 422, { codigo: 'ERRO_INTERNO' })
      }
      // o módulo da própria administração não pode ficar livre: todo usuário viraria admin da tela
      if (c.modulo === 'acesso.admin' && !c.restrito) return json(res, 403, { codigo: 'OPERACAO_NAO_PERMITIDA' })
      e.restrito.set(c.modulo, c.restrito)
      e.salvar?.()
      json(res, 204, undefined)
    }],

    ['POST', /^\/v1\/atribuicoes$/, async ({ req, res, usuario }) => {
      const c = await lerCorpo(req)
      if (!ehAdmin(usuario)) return naoEncontrado(res)
      const { usuario: alvo, perfil, atribuir } = c ?? {}
      if (!e.atribuicoes.has(alvo) || !perfisConhecidos(e).has(perfil) || typeof atribuir !== 'boolean') {
        return json(res, 422, { codigo: 'ERRO_INTERNO' })
      }
      // um administrador não retira de si o próprio acesso: a tela ficaria sem ninguém
      if (alvo === usuario && perfil === PERFIL_ADMIN && !atribuir) {
        return json(res, 403, { codigo: 'OPERACAO_NAO_PERMITIDA' })
      }
      const s = e.atribuicoes.get(alvo)
      atribuir ? s.add(perfil) : s.delete(perfil)
      e.salvar?.()
      json(res, 204, undefined)
    }],
  ], { exigeUsuario: true })
}
