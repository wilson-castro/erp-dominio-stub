import { test as testNode, after } from 'node:test'

const abertos = []
after(() => { for (const s of abertos) { s.closeAllConnections(); s.close() } })

export async function subir(servidor) {
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok))
  abertos.push(servidor)
  return `http://127.0.0.1:${servidor.address().port}`
}

// Uma exceção no listener não responde a requisição: sem timeout a suíte trava em vez de reprovar.
export const test = (nome, fn) => testNode(nome, { timeout: 3000 }, fn)

export const como = (usuario, extra = {}) =>
  ({ headers: { authorization: `Bearer dev.${usuario}.x`, ...extra } })

export const post = (usuario, corpo, auth = `Bearer dev.${usuario}.x`) =>
  ({ method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(corpo) })
