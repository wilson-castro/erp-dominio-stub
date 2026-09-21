import { criarDominioA } from './dominio-a.mjs'
import { criarDominioB } from './dominio-b.mjs'
import { criarDominioC } from './dominio-c.mjs'
import { criarDominioPlataforma } from './dominio-plataforma.mjs'
import { criarGestaoDeAcesso } from './gestao-acesso.mjs'

/** Porta de cada domínio falso. Loopback apenas: domínio nunca fica exposto (invariante 10). */
export const DOMINIOS = {
  'dominio-a': { porta: 4001, criar: criarDominioA },
  'dominio-b': { porta: 4002, criar: criarDominioB },
  'dominio-c': { porta: 4003, criar: criarDominioC },
  plataforma: { porta: 4004, criar: criarDominioPlataforma },
  'gestao-acesso': { porta: 4010, criar: criarGestaoDeAcesso },
}

// `node src/servidor.mjs [nome...]` sobe só os domínios nomeados; sem nome, todos.
if (import.meta.main) {
  const pedidos = process.argv.slice(2)
  for (const [nome, { porta, criar }] of Object.entries(DOMINIOS)) {
    if (pedidos.length && !pedidos.includes(nome)) continue
    criar().listen(porta, '127.0.0.1', () => console.log(`${nome} em http://127.0.0.1:${porta}`))
  }
}
