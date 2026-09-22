// Regras da gestão de acesso v2, sem HTTP: quem pode o quê e qual é o acesso efetivo.
// O contrato está em contratos/gestao-acesso-v2.openapi.yaml; as decisões de desenho, em
// docs/gestao-acesso/MODELO.md do repositório principal.

/** CPF com 11 dígitos e dígitos verificadores corretos. */
export function cpfValido(cpf) {
  if (typeof cpf !== 'string' || !/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false
  const d = [...cpf].map(Number)
  for (const n of [9, 10]) {
    const s = d.slice(0, n).reduce((a, v, i) => a + v * (n + 1 - i), 0)
    if (((s * 10) % 11) % 10 !== d[n]) return false
  }
  return true
}

/** Papéis de administração e de auditoria nunca se acumulam na mesma pessoa. */
export const PAPEIS_DE_ADMINISTRACAO = ['admin-geral', 'gestor-unidade', 'gestor-modulo']
export const PAPEIS_DE_AUDITORIA = ['auditor-plataforma', 'auditor-modulo']
/** Papel → tipo de escopo exigido (null = plataforma inteira). */
export const ESCOPO_DO_PAPEL = {
  'admin-geral': null, 'auditor-plataforma': null,
  'gestor-unidade': 'unidade', 'gestor-modulo': 'modulo', 'auditor-modulo': 'modulo',
}
/** Mínimo de gestores por unidade e por módulo validado: cobre férias e ausências. */
export const MINIMO_DE_GESTORES = 2

export const papeisDe = (e, pessoa) => e.atribuicoes.filter((a) => a.pessoa === pessoa)
export const tem = (e, pessoa, papel, escopo) =>
  papeisDe(e, pessoa).some((a) => a.papel === papel && (escopo === undefined || a.escopo === escopo))
export const ehAdmin = (e, p) => tem(e, p, 'admin-geral')
export const geriUnidade = (e, p, unidade) => tem(e, p, 'gestor-unidade', unidade)
export const geriModulo = (e, p, modulo) => tem(e, p, 'gestor-modulo', modulo)

/** Segregação: devolve o motivo da recusa ou null. */
export function motivoParaNaoAtribuir(e, { autor, pessoa, papel, escopo }) {
  if (!(papel in ESCOPO_DO_PAPEL)) return 'PAPEL_DESCONHECIDO'
  if (autor === pessoa) return 'AUTOATRIBUICAO'
  // só o administrador geral atribui papéis; o gestor de unidade não cria outros gestores
  if (!ehAdmin(e, autor)) return 'SEM_PERMISSAO'
  const tipo = ESCOPO_DO_PAPEL[papel]
  if (tipo === null && escopo != null) return 'ESCOPO_INVALIDO'
  if (tipo === 'unidade' && !e.unidades.some((u) => u.id === escopo)) return 'ESCOPO_INVALIDO'
  if (tipo === 'modulo' && !e.modulos.some((m) => m.id === escopo)) return 'ESCOPO_INVALIDO'
  const atuais = papeisDe(e, pessoa).map((a) => a.papel)
  const auditoria = PAPEIS_DE_AUDITORIA.includes(papel)
  if ((auditoria && atuais.some((x) => PAPEIS_DE_ADMINISTRACAO.includes(x))) ||
      (!auditoria && atuais.some((x) => PAPEIS_DE_AUDITORIA.includes(x)))) return 'SEGREGACAO_DE_FUNCOES'
  if (tem(e, pessoa, papel, escopo ?? null)) return 'JA_ATRIBUIDO'
  return null
}

const hoje = (agora) => agora().toISOString().slice(0, 10)

/** Unidade ativa e, se for parceira, com convênio vigente hoje. */
export function unidadeVigente(u, agora) {
  if (!u || u.situacao !== 'ativa') return false
  if (!u.convenio) return true
  const d = hoje(agora)
  return u.convenio.inicio <= d && d <= u.convenio.fim
}

/**
 * Acesso efetivo = interseção de todas as condições; basta uma falhar para negar. Nenhum papel
 * administrativo dá acesso a conteúdo de módulo: o administrador geral também precisa de acesso.
 * Devolve { permitido, motivo, funcionalidades }.
 */
export function acessoEfetivo(e, { pessoa, modulo, funcionalidade }, agora) {
  const p = e.pessoas.find((x) => x.id === pessoa)
  const negar = (motivo) => ({ permitido: false, motivo, funcionalidades: [] })
  if (!p || !['ativo', 'primeiro_acesso'].includes(p.status)) return negar('PESSOA_INATIVA')
  if (!unidadeVigente(e.unidades.find((u) => u.id === p.unidade), agora)) return negar('UNIDADE_SEM_VIGENCIA')
  const m = e.modulos.find((x) => x.id === modulo)
  if (!m) return negar('MODULO_DESCONHECIDO')
  const a = e.acessos.find((x) => x.pessoa === pessoa && x.modulo === modulo && x.situacao === 'ativo')
  if (!a) return negar('SEM_ACESSO_AO_MODULO')
  const funcionalidades = m.perfis.find((x) => x.id === a.perfil)?.funcionalidades ?? []
  if (funcionalidade !== undefined && !funcionalidades.includes(funcionalidade)) return { permitido: false, motivo: 'FUNCIONALIDADE_FORA_DO_PERFIL', funcionalidades }
  return { permitido: true, motivo: null, funcionalidades }
}

/** Situação de primeiro acesso para o painel: cadastrado, primeiro_acesso, ativo, inativo, desligado. */
export function painelDaUnidade(e, unidade) {
  const pessoas = e.pessoas.filter((p) => p.unidade === unidade)
  const porStatus = {}
  for (const p of pessoas) porStatus[p.status] = (porStatus[p.status] ?? 0) + 1
  const gestores = e.atribuicoes.filter((a) => a.papel === 'gestor-unidade' && a.escopo === unidade).length
  const contatos = new Set(e.contatosSegundoFator)
  return {
    unidade,
    porStatus,
    gestores,
    pendencias: [
      ...(gestores < MINIMO_DE_GESTORES ? [{ tipo: 'GESTORES_INSUFICIENTES', detalhe: `${gestores} de ${MINIMO_DE_GESTORES}` }] : []),
      ...pessoas.filter((p) => p.status === 'cadastrado').map((p) => ({ tipo: 'SEM_PRIMEIRO_ACESSO', pessoa: p.id })),
      ...pessoas.filter((p) => p.status !== 'desligado' && !contatos.has(p.emailFuncional)).map((p) => ({ tipo: 'CONTATO_DIVERGENTE_DO_SEGUNDO_FATOR', pessoa: p.id })),
    ],
    ultimaConfirmacao: e.confirmacoes.filter((c) => c.unidade === unidade).at(-1)?.em ?? null,
  }
}
