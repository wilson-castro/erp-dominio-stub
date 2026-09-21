import { criarDominio, json, naoEncontrado } from './base.mjs'

/**
 * Domínio A: recursos. Mostra as duas regras que um domínio aplica sozinho:
 * - escopo: `r-3` só existe para quem é do grupo FINANCEIRO; o resto recebe o mesmo 404;
 * - projeção: o bloco `custo` só existe no objeto para o grupo FINANCEIRO. Ausência
 *   total, sem placeholder.
 * Nenhum perfil de plataforma concede grupo aqui: ser administrador de acesso (carla) não
 * dá acesso a dado.
 */
const GRUPOS = { bruno: ['FINANCEIRO'] }
const RECURSOS = [
  { id: 'r-1', nome: 'Recurso público 1', versao: 3, custo: { valor: 1200, centro: 'CC-10' } },
  { id: 'r-2', nome: 'Recurso público 2', versao: 1, custo: { valor: 80, centro: 'CC-20' } },
  { id: 'r-3', nome: 'Recurso do financeiro', versao: 7, escopo: 'FINANCEIRO', custo: { valor: 99000, centro: 'CC-99' } },
]

function projetar(r, usuario) {
  const grupos = GRUPOS[usuario] ?? []
  if (r.escopo && !grupos.includes(r.escopo)) return null
  const p = { id: r.id, nome: r.nome, versao: r.versao }
  if (grupos.includes('FINANCEIRO')) p.custo = structuredClone(r.custo)
  return p
}

export const criarDominioA = () => criarDominio([
  ['GET', /^\/v1\/recursos$/, ({ res, usuario }) =>
    json(res, 200, RECURSOS.map((r) => projetar(r, usuario)).filter(Boolean))],
  ['GET', /^\/v1\/recursos\/([^/]+)$/, ({ res, usuario, params: [id] }) => {
    const r = RECURSOS.find((x) => x.id === id)
    const p = r ? projetar(r, usuario) : null
    if (!p) return naoEncontrado(res)
    json(res, 200, p, { etag: `"${p.versao}"` })
  }],
])
