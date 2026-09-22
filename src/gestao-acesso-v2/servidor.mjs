import { criarDominio, json, naoEncontrado, lerCorpo } from '../base.mjs'
import { criarArmazem } from '../armazem.mjs'
import {
  cpfValido, ehAdmin, geriUnidade, geriModulo, tem, papeisDe, motivoParaNaoAtribuir,
  acessoEfetivo, painelDaUnidade,
} from './regras.mjs'

/**
 * Gestão de acesso v2 — mock da API proposta para a gestão de acesso da base (porta 4020).
 * Contrato: contratos/gestao-acesso-v2.openapi.yaml. Dados: dados/semente/gestao-acesso-v2.json.
 * Quem chama se identifica por `Bearer dev.<login>` (pessoa da semente) ou `Bearer svc.<aplicacao>`
 * (provedor de identidade `idp`, módulos, BFFs). É mock: o login real é do provedor de identidade.
 *
 * Respostas seguem as regras da base: 401 sem credencial, 404 para o que está fora do escopo de quem
 * pergunta (sem revelar que existe), 403 para ação negada sobre o que ele legitimamente vê,
 * If-Match em PATCH de recurso versionado, erro sempre `{ codigo }`.
 */
export function criarGestaoDeAcessoV2({ dir, agora = () => new Date() } = {}) {
  const armazem = criarArmazem('gestao-acesso-v2', { dir })
  const e = armazem.dados
  const pessoaDoLogin = (login) => e.pessoas.find((p) => p.login === login && p.status !== 'desligado')
  const identificar = (auth) => {
    const m = /^Bearer dev\.([a-z0-9.]+)$/.exec(auth ?? '')
    return m ? pessoaDoLogin(m[1])?.id ?? null : null
  }
  const novoId = (prefixo) => `${prefixo}-${++e.sequencia}`
  const pessoa = (id) => e.pessoas.find((p) => p.id === id)
  const unidade = (id) => e.unidades.find((u) => u.id === id)
  const modulo = (id) => e.modulos.find((m) => m.id === id)
  const erro = (res, status, codigo) => json(res, status, { codigo })

  /** Toda mudança vira evento de auditoria; `excecao` marca o administrador geral agindo numa unidade parceira. */
  function registrar(tipo, autor, alvo, extra = {}) {
    const alvoUnidade = extra.unidade ?? pessoa(alvo)?.unidade
    const excecao = !!autor && ehAdmin(e, autor) && unidade(alvoUnidade)?.categoria === 'parceira'
    e.eventos.push({ seq: e.eventos.length + 1, em: agora().toISOString(), tipo, autor, alvo, ...extra, ...(excecao ? { excecao: true } : {}) })
    armazem.salvar()
  }

  /** O que uma pessoa pode ver de outra: ela mesma, gestor da unidade dela, administrador, auditor da plataforma. */
  const podeVerPessoa = (autor, p) =>
    !!p && (autor === p.id || ehAdmin(e, autor) || geriUnidade(e, autor, p.unidade) || tem(e, autor, 'auditor-plataforma'))
  const podeGerirPessoa = (autor, p) => !!p && (ehAdmin(e, autor) || geriUnidade(e, autor, p.unidade))
  const ehGestorDeAlgumaUnidade = (autor) => papeisDe(e, autor).some((a) => a.papel === 'gestor-unidade')

  const vistaDaPessoa = (p) => ({
    id: p.id, nome: p.nome, cpf: p.cpf, unidade: p.unidade, emailFuncional: p.emailFuncional, status: p.status,
    contatoIntegroComSegundoFator: e.contatosSegundoFator.includes(p.emailFuncional),
  })

  function criarAcesso(p, m, autor) {
    const direto = m.categoria === 'direto'
    const a = {
      id: novoId('ac'), pessoa: p.id, modulo: m.id, situacao: direto ? 'ativo' : 'pendente',
      perfil: direto ? m.perfilPadrao : null, solicitadoPor: autor, validadoPor: null, justificativa: null,
    }
    e.acessos.push(a)
    registrar(direto ? 'ACESSO_CONCEDIDO' : 'ACESSO_SOLICITADO', autor, p.id, { modulo: m.id, acesso: a.id })
    return a
  }

  function revogarAcessosDe(p, autor, motivo) {
    for (const a of e.acessos.filter((x) => x.pessoa === p.id && ['ativo', 'pendente'].includes(x.situacao))) {
      a.situacao = 'revogado'
      registrar('ACESSO_REVOGADO', autor, p.id, { modulo: a.modulo, acesso: a.id, motivo })
    }
  }

  const exigeVersao = (req, res, recurso) => {
    const im = req.headers['if-match']
    if (!im) { erro(res, 428, 'VERSAO_OBRIGATORIA'); return false }
    if (im !== `"${recurso.versao}"`) { erro(res, 409, 'REGISTRO_DESATUALIZADO'); return false }
    return true
  }

  return criarDominio([
    // --- a própria pessoa ------------------------------------------------------------------
    ['GET', /^\/v2\/eu$/, ({ res, usuario }) => {
      if (!usuario) return erro(res, 401, 'SESSAO_EXPIRADA')
      const p = pessoa(usuario)
      const modulos = e.modulos.map((m) => ({ id: m.id, ...acessoEfetivo(e, { pessoa: p.id, modulo: m.id }, agora) }))
        .filter((m) => m.permitido).map(({ id, funcionalidades }) => ({ id, funcionalidades }))
      json(res, 200, { pessoa: vistaDaPessoa(p), papeis: papeisDe(e, p.id).map(({ papel, escopo }) => ({ papel, escopo })), modulos })
    }],

    // --- provedor de identidade e serviços -------------------------------------------------
    // Primeiro acesso: o provedor de identidade casa o CPF verificado com um pré-cadastro. Sem
    // cadastro (ou desligado), a resposta é a mesma e não revela se o CPF existe; a tentativa vira evento.
    ['POST', /^\/v2\/primeiro-acesso$/, async ({ req, res, servico }) => {
      const c = await lerCorpo(req)
      if (servico !== 'idp') return erro(res, 401, 'SESSAO_EXPIRADA')
      const p = e.pessoas.find((x) => x.cpf === c?.cpf && x.status !== 'desligado')
      if (!p || typeof c?.sub !== 'string') {
        registrar('TENTATIVA_SEM_CADASTRO', null, null, { cpfFinal: String(c?.cpf ?? '').slice(-2) })
        return erro(res, 403, 'ACESSO_NEGADO')
      }
      if (p.sub && p.sub !== c.sub) return erro(res, 403, 'ACESSO_NEGADO')
      p.sub = c.sub
      if (p.status === 'cadastrado') p.status = 'ativo'
      registrar('PRIMEIRO_ACESSO', p.id, p.id)
      json(res, 200, { pessoa: p.id, login: p.login })
    }],

    // Decisão para domínios e BFFs: a pessoa pode usar esta funcionalidade deste módulo agora?
    ['POST', /^\/v2\/decisoes$/, async ({ req, res, servico }) => {
      const c = await lerCorpo(req)
      if (!servico) return erro(res, 401, 'SESSAO_EXPIRADA')
      const p = c?.sub ? e.pessoas.find((x) => x.sub === c.sub) : pessoa(c?.pessoa)
      json(res, 200, acessoEfetivo(e, { pessoa: p?.id, modulo: c?.modulo, funcionalidade: c?.funcionalidade }, agora))
    }],

    // Eventos para quem precisa reagir (ex.: encerrar sessões de quem foi desligado).
    ['GET', /^\/v2\/eventos$/, ({ req, res, servico }) => {
      if (!servico) return erro(res, 401, 'SESSAO_EXPIRADA')
      const desde = Number(new URL(req.url, 'http://x').searchParams.get('desde') ?? 0)
      json(res, 200, e.eventos.filter((ev) => ev.seq > desde && ['PESSOA_DESLIGADA', 'ACESSO_REVOGADO', 'PESSOA_SUSPENSA'].includes(ev.tipo)))
    }],

    // O módulo declara as próprias funcionalidades; módulo novo nasce "validado" (restrito).
    ['POST', /^\/v2\/modulos\/manifesto$/, async ({ req, res, servico }) => {
      const c = await lerCorpo(req)
      if (!servico) return erro(res, 401, 'SESSAO_EXPIRADA')
      if (c?.id !== servico) return erro(res, 403, 'OPERACAO_NAO_PERMITIDA')
      if (!Array.isArray(c.funcionalidades) || !c.funcionalidades.every((f) => /^[a-z0-9-]+\.[a-z0-9-]+$/.test(f))) return erro(res, 422, 'MANIFESTO_INVALIDO')
      let m = modulo(c.id)
      if (!m) { m = { id: c.id, nome: String(c.nome ?? c.id), categoria: 'validado', perfilPadrao: null, funcionalidades: [], perfis: [] }; e.modulos.push(m) }
      m.funcionalidades = [...new Set(c.funcionalidades)]
      for (const perfil of m.perfis) perfil.funcionalidades = perfil.funcionalidades.filter((f) => m.funcionalidades.includes(f))
      registrar('MANIFESTO_REGISTRADO', null, null, { modulo: m.id })
      json(res, 200, m)
    }],

    // --- catálogo de módulos -----------------------------------------------------------------
    ['GET', /^\/v2\/modulos$/, ({ res, usuario }) => {
      if (!usuario) return erro(res, 401, 'SESSAO_EXPIRADA')
      json(res, 200, e.modulos.map(({ id, nome, categoria, funcionalidades, perfis }) => ({ id, nome, categoria, funcionalidades, perfis })))
    }],
    ['PATCH', /^\/v2\/modulos\/([^/]+)\/categoria$/, async ({ req, res, usuario, params: [id] }) => {
      const c = await lerCorpo(req)
      const m = modulo(id)
      if (!m || !ehAdmin(e, usuario)) return naoEncontrado(res)
      if (!['direto', 'validado'].includes(c?.categoria)) return erro(res, 422, 'CATEGORIA_INVALIDA')
      if (!c?.justificativa?.trim()) return erro(res, 422, 'JUSTIFICATIVA_OBRIGATORIA')
      if (c.categoria === 'direto' && !m.perfilPadrao) return erro(res, 422, 'PERFIL_PADRAO_OBRIGATORIO')
      m.categoria = c.categoria
      registrar('MODULO_RECATEGORIZADO', usuario, null, { modulo: m.id, categoria: m.categoria, justificativa: c.justificativa })
      json(res, 200, m)
    }],
    ['POST', /^\/v2\/modulos\/([^/]+)\/perfis$/, async ({ req, res, usuario, params: [id] }) => {
      const c = await lerCorpo(req)
      const m = modulo(id)
      if (!m || !ehAdmin(e, usuario)) return naoEncontrado(res)
      if (!/^[a-z0-9-]+\.[a-z0-9-]+$/.test(c?.id ?? '') || !c.id.startsWith(`${m.id}.`)) return erro(res, 422, 'PERFIL_INVALIDO')
      if (!Array.isArray(c.funcionalidades) || !c.funcionalidades.every((f) => m.funcionalidades.includes(f))) return erro(res, 422, 'FUNCIONALIDADE_NAO_DECLARADA')
      if (m.perfis.some((p) => p.id === c.id)) return erro(res, 409, 'JA_EXISTE')
      m.perfis.push({ id: c.id, funcionalidades: c.funcionalidades })
      registrar('PERFIL_DE_MODULO_CRIADO', usuario, null, { modulo: m.id, perfil: c.id })
      json(res, 201, m.perfis.at(-1))
    }],

    // --- unidades ------------------------------------------------------------------------------
    ['GET', /^\/v2\/unidades$/, ({ res, usuario }) => {
      if (!usuario) return erro(res, 401, 'SESSAO_EXPIRADA')
      const visiveis = ehAdmin(e, usuario) ? e.unidades : e.unidades.filter((u) => geriUnidade(e, usuario, u.id))
      json(res, 200, visiveis)
    }],
    ['POST', /^\/v2\/unidades$/, async ({ req, res, usuario }) => {
      const c = await lerCorpo(req)
      if (!ehAdmin(e, usuario)) return naoEncontrado(res)
      if (!/^[a-z][a-z0-9-]{1,31}$/.test(c?.id ?? '') || !c.nome) return erro(res, 422, 'CAMPOS_OBRIGATORIOS')
      if (unidade(c.id)) return erro(res, 409, 'JA_EXISTE')
      if (c.pai && !unidade(c.pai)) return erro(res, 422, 'UNIDADE_PAI_DESCONHECIDA')
      // unidade nova é de gestão exclusiva: a unidade-pai é informação de estrutura, não dá alcance
      const u = { id: c.id, nome: c.nome, categoria: c.categoria ?? 'parceira', pai: c.pai ?? null, exclusiva: true, situacao: 'ativa', convenio: c.convenio ?? null, versao: 1 }
      e.unidades.push(u)
      registrar('UNIDADE_CRIADA', usuario, null, { unidade: u.id })
      json(res, 201, u, { etag: `"${u.versao}"` })
    }],
    ['PATCH', /^\/v2\/unidades\/([^/]+)$/, async ({ req, res, usuario, params: [id] }) => {
      const c = await lerCorpo(req)
      const u = unidade(id)
      if (!u || !ehAdmin(e, usuario)) return naoEncontrado(res)
      if (!exigeVersao(req, res, u)) return
      for (const k of ['nome', 'convenio', 'situacao']) if (c && k in c) u[k] = c[k]
      u.versao++
      registrar('UNIDADE_ALTERADA', usuario, null, { unidade: u.id })
      json(res, 200, u, { etag: `"${u.versao}"` })
    }],
    ['GET', /^\/v2\/unidades\/([^/]+)\/painel$/, ({ res, usuario, params: [id] }) => {
      if (!unidade(id) || !(ehAdmin(e, usuario) || geriUnidade(e, usuario, id))) return naoEncontrado(res)
      json(res, 200, painelDaUnidade(e, id))
    }],
    // Confirmação periódica: quem o gestor não confirma fica suspenso (e perde as sessões).
    ['POST', /^\/v2\/unidades\/([^/]+)\/confirmacoes$/, async ({ req, res, usuario, params: [id] }) => {
      const c = await lerCorpo(req)
      if (!unidade(id) || !geriUnidade(e, usuario, id)) return naoEncontrado(res)
      if (!Array.isArray(c?.confirmadas)) return erro(res, 422, 'CAMPOS_OBRIGATORIOS')
      const suspensas = []
      for (const p of e.pessoas.filter((x) => x.unidade === id && x.status === 'ativo' && x.id !== usuario)) {
        if (!c.confirmadas.includes(p.id)) { p.status = 'suspenso'; suspensas.push(p.id); registrar('PESSOA_SUSPENSA', usuario, p.id, { motivo: 'nao confirmada' }) }
      }
      e.confirmacoes.push({ unidade: id, em: agora().toISOString().slice(0, 10), por: usuario })
      registrar('CONFIRMACAO_PERIODICA', usuario, null, { unidade: id })
      json(res, 200, { suspensas })
    }],

    // --- pessoas -------------------------------------------------------------------------------
    // A única consulta fora da própria unidade: saber, no cadastro, se CPF ou e-mail já existe.
    ['POST', /^\/v2\/pessoas\/verificacao$/, async ({ req, res, usuario }) => {
      const c = await lerCorpo(req)
      if (!(ehAdmin(e, usuario) || ehGestorDeAlgumaUnidade(usuario))) return naoEncontrado(res)
      const existe = e.pessoas.some((p) => p.status !== 'desligado' && ((c?.cpf && p.cpf === c.cpf) || (c?.emailFuncional && p.emailFuncional === c.emailFuncional)))
      json(res, 200, { existe })
    }],
    ['GET', /^\/v2\/pessoas$/, ({ req, res, usuario }) => {
      if (!usuario) return erro(res, 401, 'SESSAO_EXPIRADA')
      const u = new URL(req.url, 'http://x').searchParams.get('unidade')
      // sem busca geral: a lista é sempre de uma unidade que quem pergunta administra
      if (!u || !(ehAdmin(e, usuario) || geriUnidade(e, usuario, u))) return naoEncontrado(res)
      json(res, 200, e.pessoas.filter((p) => p.unidade === u).map(vistaDaPessoa))
    }],
    ['POST', /^\/v2\/pessoas$/, async ({ req, res, usuario }) => {
      const c = await lerCorpo(req)
      if (!usuario) return erro(res, 401, 'SESSAO_EXPIRADA')
      if (!unidade(c?.unidade) || !(ehAdmin(e, usuario) || geriUnidade(e, usuario, c.unidade))) return naoEncontrado(res)
      if (!c.nome?.trim() || !/^[^@\s]+@[^@\s]+$/.test(c.emailFuncional ?? '')) return erro(res, 422, 'CAMPOS_OBRIGATORIOS')
      if (!cpfValido(c.cpf)) return erro(res, 422, 'CPF_INVALIDO')
      if (e.pessoas.some((p) => p.status !== 'desligado' && (p.cpf === c.cpf || p.emailFuncional === c.emailFuncional))) return erro(res, 409, 'JA_POSSUI_CONTA')
      const solicitados = (c.modulosSolicitados ?? []).map(modulo)
      if (solicitados.some((m) => !m)) return erro(res, 422, 'MODULO_DESCONHECIDO')
      const p = {
        id: novoId('p'), login: c.emailFuncional.split('@')[0].toLowerCase().replace(/[^a-z0-9.]/g, ''), cpf: c.cpf, nome: c.nome.trim(),
        unidade: c.unidade, emailFuncional: c.emailFuncional, status: 'cadastrado', sub: null, versao: 1,
        historico: [{ unidade: c.unidade, email: c.emailFuncional, inicio: agora().toISOString().slice(0, 10), fim: null }],
      }
      e.pessoas.push(p)
      registrar('PESSOA_CADASTRADA', usuario, p.id)
      for (const m of solicitados) criarAcesso(p, m, usuario)
      json(res, 201, vistaDaPessoa(p), { etag: `"${p.versao}"` })
    }],
    ['GET', /^\/v2\/pessoas\/([^/]+)$/, ({ res, usuario, params: [id] }) => {
      const p = pessoa(id)
      if (!podeVerPessoa(usuario, p)) return naoEncontrado(res)
      json(res, 200, vistaDaPessoa(p), { etag: `"${p.versao}"` })
    }],
    ['GET', /^\/v2\/pessoas\/([^/]+)\/historico$/, ({ res, usuario, params: [id] }) => {
      const p = pessoa(id)
      if (!podeVerPessoa(usuario, p)) return naoEncontrado(res)
      json(res, 200, p.historico)
    }],
    // Troca de e-mail funcional fecha o registro anterior no histórico; CPF não muda nunca.
    ['PATCH', /^\/v2\/pessoas\/([^/]+)$/, async ({ req, res, usuario, params: [id] }) => {
      const c = await lerCorpo(req)
      const p = pessoa(id)
      if (!podeVerPessoa(usuario, p)) return naoEncontrado(res)
      if (!podeGerirPessoa(usuario, p) || usuario === p.id) return erro(res, 403, 'OPERACAO_NAO_PERMITIDA')
      if (!exigeVersao(req, res, p)) return
      if (c && 'cpf' in c) return erro(res, 422, 'CPF_IMUTAVEL')
      if (c?.nome) p.nome = String(c.nome).trim()
      if (c?.emailFuncional && c.emailFuncional !== p.emailFuncional) {
        if (e.pessoas.some((x) => x.id !== p.id && x.emailFuncional === c.emailFuncional)) return erro(res, 409, 'JA_POSSUI_CONTA')
        const d = agora().toISOString().slice(0, 10)
        p.historico.at(-1).fim = d
        p.historico.push({ unidade: p.unidade, email: c.emailFuncional, inicio: d, fim: null })
        p.emailFuncional = c.emailFuncional
      }
      p.versao++
      registrar('PESSOA_ALTERADA', usuario, p.id)
      json(res, 200, vistaDaPessoa(p), { etag: `"${p.versao}"` })
    }],
    // Mudança de unidade: os acessos anteriores são cancelados, não transferidos; o histórico fica.
    ['POST', /^\/v2\/pessoas\/([^/]+)\/transferencia$/, async ({ req, res, usuario, params: [id] }) => {
      const c = await lerCorpo(req)
      const p = pessoa(id)
      if (!podeVerPessoa(usuario, p)) return naoEncontrado(res)
      if (!ehAdmin(e, usuario) || usuario === p.id) return erro(res, 403, 'OPERACAO_NAO_PERMITIDA')
      if (!unidade(c?.unidade) || c.unidade === p.unidade || !/^[^@\s]+@[^@\s]+$/.test(c.emailFuncional ?? '')) return erro(res, 422, 'CAMPOS_OBRIGATORIOS')
      revogarAcessosDe(p, usuario, 'transferencia')
      e.atribuicoes = e.atribuicoes.filter((a) => a.pessoa !== p.id)
      const d = agora().toISOString().slice(0, 10)
      p.historico.at(-1).fim = d
      p.historico.push({ unidade: c.unidade, email: c.emailFuncional, inicio: d, fim: null })
      Object.assign(p, { unidade: c.unidade, emailFuncional: c.emailFuncional, versao: p.versao + 1 })
      registrar('PESSOA_TRANSFERIDA', usuario, p.id, { unidade: c.unidade })
      json(res, 200, vistaDaPessoa(p))
    }],
    // Desligamento: revoga tudo e pede o encerramento das sessões abertas (evento PESSOA_DESLIGADA).
    ['POST', /^\/v2\/pessoas\/([^/]+)\/desligamento$/, async ({ req, res, usuario, params: [id] }) => {
      await lerCorpo(req)
      const p = pessoa(id)
      if (!podeVerPessoa(usuario, p)) return naoEncontrado(res)
      if (!podeGerirPessoa(usuario, p) || usuario === p.id) return erro(res, 403, 'OPERACAO_NAO_PERMITIDA')
      revogarAcessosDe(p, usuario, 'desligamento')
      e.atribuicoes = e.atribuicoes.filter((a) => a.pessoa !== p.id)
      p.status = 'desligado'
      p.historico.at(-1).fim = agora().toISOString().slice(0, 10)
      registrar('PESSOA_DESLIGADA', usuario, p.id)
      json(res, 204, undefined)
    }],

    // --- atribuições (papéis acumuláveis, cada um com escopo) -----------------------------------
    ['GET', /^\/v2\/pessoas\/([^/]+)\/atribuicoes$/, ({ res, usuario, params: [id] }) => {
      const p = pessoa(id)
      if (!podeVerPessoa(usuario, p)) return naoEncontrado(res)
      json(res, 200, papeisDe(e, p.id))
    }],
    ['POST', /^\/v2\/pessoas\/([^/]+)\/atribuicoes$/, async ({ req, res, usuario, params: [id] }) => {
      const c = await lerCorpo(req)
      const p = pessoa(id)
      if (!podeVerPessoa(usuario, p)) return naoEncontrado(res)
      const motivo = motivoParaNaoAtribuir(e, { autor: usuario, pessoa: p.id, papel: c?.papel, escopo: c?.escopo ?? null })
      if (motivo) return erro(res, ['SEM_PERMISSAO', 'AUTOATRIBUICAO'].includes(motivo) ? 403 : motivo === 'JA_ATRIBUIDO' ? 409 : 422, motivo)
      const a = { id: novoId('at'), pessoa: p.id, papel: c.papel, escopo: c.escopo ?? null }
      e.atribuicoes.push(a)
      registrar('PAPEL_ATRIBUIDO', usuario, p.id, { papel: a.papel, escopo: a.escopo })
      json(res, 201, a)
    }],
    ['POST', /^\/v2\/atribuicoes\/([^/]+)\/retirada$/, async ({ req, res, usuario, params: [id] }) => {
      await lerCorpo(req)
      const a = e.atribuicoes.find((x) => x.id === id)
      if (!a || !podeVerPessoa(usuario, pessoa(a.pessoa))) return naoEncontrado(res)
      if (!ehAdmin(e, usuario) || a.pessoa === usuario) return erro(res, 403, 'OPERACAO_NAO_PERMITIDA')
      e.atribuicoes = e.atribuicoes.filter((x) => x !== a)
      registrar('PAPEL_RETIRADO', usuario, a.pessoa, { papel: a.papel, escopo: a.escopo })
      json(res, 204, undefined)
    }],

    // --- acessos a módulos ----------------------------------------------------------------------
    ['POST', /^\/v2\/acessos$/, async ({ req, res, usuario }) => {
      const c = await lerCorpo(req)
      const p = pessoa(c?.pessoa)
      if (!podeGerirPessoa(usuario, p)) return naoEncontrado(res)
      const m = modulo(c?.modulo)
      if (!m) return erro(res, 422, 'MODULO_DESCONHECIDO')
      if (usuario === p.id) return erro(res, 403, 'OPERACAO_NAO_PERMITIDA')
      if (e.acessos.some((a) => a.pessoa === p.id && a.modulo === m.id && ['ativo', 'pendente'].includes(a.situacao))) return erro(res, 409, 'JA_EXISTE')
      json(res, 201, criarAcesso(p, m, usuario))
    }],
    ['GET', /^\/v2\/acessos$/, ({ req, res, usuario }) => {
      if (!usuario) return erro(res, 401, 'SESSAO_EXPIRADA')
      const q = new URL(req.url, 'http://x').searchParams
      const visivel = (a) => ehAdmin(e, usuario) || geriModulo(e, usuario, a.modulo) || geriUnidade(e, usuario, pessoa(a.pessoa)?.unidade)
      json(res, 200, e.acessos.filter((a) => visivel(a) &&
        (!q.get('modulo') || a.modulo === q.get('modulo')) && (!q.get('situacao') || a.situacao === q.get('situacao'))))
    }],
    // Validação pelo gestor do módulo, pessoa a pessoa. Quem pediu não valida; ninguém valida o próprio.
    ['POST', /^\/v2\/acessos\/([^/]+)\/decisao$/, async ({ req, res, usuario, params: [id] }) => {
      const c = await lerCorpo(req)
      const a = e.acessos.find((x) => x.id === id)
      if (!a || !geriModulo(e, usuario, a.modulo)) return naoEncontrado(res)
      if (a.situacao !== 'pendente') return erro(res, 409, 'NAO_ESTA_PENDENTE')
      if (a.pessoa === usuario || a.solicitadoPor === usuario) return erro(res, 403, 'SEGREGACAO_DE_FUNCOES')
      if (c?.aprovar === true) {
        if (!modulo(a.modulo).perfis.some((p) => p.id === c.perfil)) return erro(res, 422, 'PERFIL_INVALIDO')
        Object.assign(a, { situacao: 'ativo', perfil: c.perfil, validadoPor: usuario })
        registrar('ACESSO_VALIDADO', usuario, a.pessoa, { modulo: a.modulo, acesso: a.id, perfil: c.perfil })
      } else if (c?.aprovar === false) {
        if (!c.justificativa?.trim()) return erro(res, 422, 'JUSTIFICATIVA_OBRIGATORIA')
        Object.assign(a, { situacao: 'recusado', validadoPor: usuario, justificativa: c.justificativa })
        registrar('ACESSO_RECUSADO', usuario, a.pessoa, { modulo: a.modulo, acesso: a.id })
      } else return erro(res, 422, 'CAMPOS_OBRIGATORIOS')
      json(res, 200, a)
    }],
    ['POST', /^\/v2\/acessos\/([^/]+)\/revogacao$/, async ({ req, res, usuario, params: [id] }) => {
      await lerCorpo(req)
      const a = e.acessos.find((x) => x.id === id)
      const p = a && pessoa(a.pessoa)
      if (!a || !(podeGerirPessoa(usuario, p) || geriModulo(e, usuario, a.modulo))) return naoEncontrado(res)
      if (!['ativo', 'pendente'].includes(a.situacao)) return erro(res, 409, 'NAO_ESTA_ATIVO')
      a.situacao = 'revogado'
      registrar('ACESSO_REVOGADO', usuario, a.pessoa, { modulo: a.modulo, acesso: a.id, motivo: 'revogacao' })
      json(res, 204, undefined)
    }],

    // --- auditoria (somente leitura) ------------------------------------------------------------
    ['GET', /^\/v2\/auditoria$/, ({ req, res, usuario }) => {
      const plataforma = tem(e, usuario, 'auditor-plataforma')
      const modulos = papeisDe(e, usuario).filter((a) => a.papel === 'auditor-modulo').map((a) => a.escopo)
      if (!plataforma && !modulos.length) return naoEncontrado(res)
      const desde = Number(new URL(req.url, 'http://x').searchParams.get('desde') ?? 0)
      json(res, 200, e.eventos.filter((ev) => ev.seq > desde && (plataforma || modulos.includes(ev.modulo))))
    }],
  ], { exigeUsuario: true, identificar })
}

