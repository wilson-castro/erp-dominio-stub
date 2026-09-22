import { criarDominio, json } from './base.mjs'
import { criarArmazem } from './armazem.mjs'

/** Domínio do próprio shell (N7: o shell também tem domínio). */
export function criarDominioPlataforma({ dir } = {}) {
  const { dados } = criarArmazem('plataforma', { dir })
  return criarDominio([
    ['GET', /^\/v1\/avisos$/, ({ res }) => json(res, 200, dados.avisos)],
  ])
}
