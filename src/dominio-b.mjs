import { criarDominio, json } from './base.mjs'

/** Domínio B: indicadores. Segundo domínio da zona 1 (N7: uma zona, vários domínios). */
export const criarDominioB = () => criarDominio([
  ['GET', /^\/v1\/indicadores$/, ({ res }) => json(res, 200, [
    { nome: 'Recursos ativos', valor: 3 },
    { nome: 'Disponibilidade', valor: 99.2 },
  ])],
])
