import { criarDominio, json } from './base.mjs'

/** Domínio do próprio shell (N7: o shell também tem domínio). */
export const criarDominioPlataforma = () => criarDominio([
  ['GET', /^\/v1\/avisos$/, ({ res }) => json(res, 200, [
    { id: 'a-1', texto: 'Manutenção programada no sábado, das 2h às 4h.' },
  ])],
])
