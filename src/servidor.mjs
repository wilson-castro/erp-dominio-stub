import { criarDominioA } from './dominio-a.mjs'
import { criarDominioB } from './dominio-b.mjs'
import { criarDominioC } from './dominio-c.mjs'
import { criarDominioPlataforma } from './dominio-plataforma.mjs'
import { criarEstadoDeAcesso, criarGestaoDeAcesso } from './gestao-acesso.mjs'
import { criarGestaoDeAcessoV2 } from './gestao-acesso-v2/servidor.mjs'

/** Porta de cada domínio falso. Loopback apenas: domínio nunca fica exposto (invariante 10). */
export const DOMINIOS = {
  'dominio-a': { porta: 4001, criar: criarDominioA },
  'dominio-b': { porta: 4002, criar: criarDominioB },
  'dominio-c': { porta: 4003, criar: criarDominioC },
  plataforma: { porta: 4004, criar: criarDominioPlataforma },
  // v2: mock da API proposta de gestão de acesso (contratos/gestao-acesso-v2.openapi.yaml)
  'gestao-acesso-v2': { porta: 4020, criar: criarGestaoDeAcessoV2 },
  'gestao-acesso': { porta: 4010, criar: ({ dir } = {}) => criarGestaoDeAcesso(criarEstadoDeAcesso({ dir })) },
}

// `node src/servidor.mjs [nome...]` sobe só os domínios nomeados; sem nome, todos.
// Com DADOS_DIR, cada domínio grava o próprio estado em <DADOS_DIR>/<nome>.json (showcase);
// sem ele, parte da semente em memória a cada subida (verificação ponta a ponta).
if (import.meta.main) {
  const pedidos = process.argv.slice(2)
  for (const [nome, { porta, criar }] of Object.entries(DOMINIOS)) {
    if (pedidos.length && !pedidos.includes(nome)) continue
    criar({ dir: process.env.DADOS_DIR }).listen(porta, '127.0.0.1', () => console.log(`${nome} em http://127.0.0.1:${porta}`))
  }
}
