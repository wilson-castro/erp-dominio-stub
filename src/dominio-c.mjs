import { criarDominio, json, naoEncontrado, lerCorpo } from './base.mjs'

/**
 * Domínio C: tarefas, da zona 2. Tem a única mutação da base: concluir uma tarefa, com
 * `If-Match` obrigatório (invariante 6) e autorização decidida aqui (grupo OPERACAO).
 */
const GRUPOS = { ana: ['OPERACAO'] }

export function criarDominioC() {
  const tarefas = new Map([
    ['t-1', { id: 't-1', titulo: 'Revisar cadastro', concluida: false, versao: 1 }],
    ['t-2', { id: 't-2', titulo: 'Conferir inventário', concluida: false, versao: 1 }],
  ])
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
      json(res, 200, t, { etag: `"${t.versao}"` })
    }],
  ])
}
