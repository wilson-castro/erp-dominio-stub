import { criarDominio, json, naoEncontrado, lerCorpo } from './base.mjs'
import { criarArmazem } from './armazem.mjs'

/**
 * Domínio C: tarefas, da zona 2. Tem a única mutação da base: concluir uma tarefa, com
 * `If-Match` obrigatório (invariante 6) e autorização decidida aqui (grupo OPERACAO).
 */
export function criarDominioC({ dir } = {}) {
  const armazem = criarArmazem('dominio-c', { dir })
  const { grupos: GRUPOS, tarefas: lista } = armazem.dados
  const tarefas = new Map(lista.map((t) => [t.id, t]))
  return criarDominio([
    ['GET', /^\/v1\/tarefas$/, ({ res }) => json(res, 200, [...tarefas.values()])],
    ['POST', /^\/v1\/tarefas\/([^/]+)\/concluir$/, async ({ req, res, usuario, params: [id] }) => {
      await lerCorpo(req)
      const t = tarefas.get(id)
      if (!t) return naoEncontrado(res)
      if (!(GRUPOS[usuario] ?? []).includes('OPERACAO')) return json(res, 403, { codigo: 'OPERACAO_NAO_PERMITIDA' })
      const ifMatch = req.headers['if-match']
      if (!ifMatch) return json(res, 428, { codigo: 'ERRO_INTERNO' })
      if (ifMatch !== `"${t.versao}"`) return json(res, 409, { codigo: 'REGISTRO_DESATUALIZADO' })
      t.concluida = true
      t.versao += 1
      armazem.salvar()
      json(res, 200, t, { etag: `"${t.versao}"` })
    }],
  ])
}
