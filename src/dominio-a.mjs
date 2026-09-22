import { criarDominio, json, naoEncontrado } from './base.mjs'
import { criarArmazem } from './armazem.mjs'

/**
 * Domínio A: recursos. Mostra as duas regras que um domínio aplica sozinho:
 * - escopo: `r-3` só existe para quem é do grupo FINANCEIRO; o resto recebe o mesmo 404;
 * - projeção: o bloco `custo` só existe no objeto para o grupo FINANCEIRO. Ausência
 *   total, sem placeholder.
 * Nenhum perfil de plataforma concede grupo aqui: ser administrador de acesso (carla) não
 * dá acesso a dado.
 */
function projetar(r, usuario, gruposPorUsuario) {
  const grupos = gruposPorUsuario[usuario] ?? []
  if (r.escopo && !grupos.includes(r.escopo)) return null
  const p = { id: r.id, nome: r.nome, versao: r.versao }
  if (grupos.includes('FINANCEIRO')) p.custo = structuredClone(r.custo)
  return p
}

export function criarDominioA({ dir } = {}) {
  const { dados: { grupos, recursos } } = criarArmazem('dominio-a', { dir })
  return criarDominio([
    ['GET', /^\/v1\/recursos$/, ({ res, usuario }) =>
      json(res, 200, recursos.map((r) => projetar(r, usuario, grupos)).filter(Boolean))],
    ['GET', /^\/v1\/recursos\/([^/]+)$/, ({ res, usuario, params: [id] }) => {
      const r = recursos.find((x) => x.id === id)
      const p = r ? projetar(r, usuario, grupos) : null
      if (!p) return naoEncontrado(res)
      json(res, 200, p, { etag: `"${p.versao}"` })
    }],
  ])
}
