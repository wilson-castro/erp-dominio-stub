import { criarDominio, json } from './base.mjs'
import { criarArmazem } from './armazem.mjs'

/** Domínio B: indicadores. Segundo domínio da zona 1 (N7: uma zona, vários domínios). */
export function criarDominioB({ dir } = {}) {
  const { dados } = criarArmazem('dominio-b', { dir })
  return criarDominio([
    ['GET', /^\/v1\/indicadores$/, ({ res }) => json(res, 200, dados.indicadores)],
  ])
}
