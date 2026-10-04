// ADR-0013, adendo 2, no stub: a mesma regra do núcleo (`borda/http-local.ts`), espelhada porque o stub não
// depende do núcleo. `http://` no emissor em produção só com ERP_PERMITIR_HTTP_LOCAL=1 e host de loopback.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configuracaoJwt, verificadorDoAmbiente, ehLoopback } from '../src/jwt.mjs'

const LOOPBACK = ['http://127.0.0.1:8080/realms/erp', 'http://localhost:8080/realms/erp', 'http://[::1]:8080/realms/erp', 'http://LOCALHOST/realms/erp']
const FORA = [
  'http://idp.exemplo/realms/erp', 'http://127.0.0.1.evil.example/realms/erp', 'http://localhost.example/realms/erp',
  'http://localhost./realms/erp', 'http://[::ffff:127.0.0.1]/realms/erp', 'http://[::2]/realms/erp', 'http://0.0.0.0/realms/erp',
  'http://10.0.0.1/realms/erp', 'http://127.0.0.2.nip.io/realms/erp',
]

test('ehLoopback: so localhost, 127.0.0.1 e ::1, no host ja normalizado', () => {
  for (const u of LOOPBACK) assert.equal(ehLoopback(new URL(u).hostname), true, u)
  for (const u of FORA) assert.equal(ehLoopback(new URL(u).hostname), false, u)
  assert.equal(ehLoopback(new URL('http://[0:0:0:0:0:0:0:1]').hostname), true)
})

test('em producao com httpLocal: loopback aceito, o resto recusado; credencial continua recusada', () => {
  for (const emissor of LOOPBACK) assert.equal(configuracaoJwt({ emissor, producao: true, httpLocal: true }).emissor, emissor)
  for (const emissor of FORA) assert.throws(() => configuracaoJwt({ emissor, producao: true, httpLocal: true }), /https em producao/, emissor)
  assert.throws(() => configuracaoJwt({ emissor: 'http://localhost@evil.example/realms/erp', producao: true, httpLocal: true }), /IDP_EMISSOR/)
  assert.throws(() => configuracaoJwt({ emissor: 'http://u:s@localhost/realms/erp', producao: true, httpLocal: true }), /IDP_EMISSOR/)
})

test('em producao sem httpLocal: nem loopback passa; fora de producao, http vale', () => {
  for (const emissor of LOOPBACK) assert.throws(() => configuracaoJwt({ emissor, producao: true }), /https em producao/, emissor)
  assert.doesNotThrow(() => configuracaoJwt({ emissor: 'http://idp.exemplo/realms/erp' }))
})

test('verificadorDoAmbiente: a flag e lida do ambiente, so o valor exato 1', () => {
  const antes = { ...process.env }
  try {
    process.env.NODE_ENV = 'production'
    process.env.IDP_EMISSOR = 'http://127.0.0.1:8080/realms/erp'
    delete process.env.ERP_PERMITIR_HTTP_LOCAL
    assert.throws(() => verificadorDoAmbiente(), /https em producao/)
    process.env.ERP_PERMITIR_HTTP_LOCAL = 'true'
    assert.throws(() => verificadorDoAmbiente(), /https em producao/)
    process.env.ERP_PERMITIR_HTTP_LOCAL = '1'
    assert.ok(verificadorDoAmbiente())
    process.env.IDP_EMISSOR = 'http://idp.exemplo/realms/erp'
    assert.throws(() => verificadorDoAmbiente(), /https em producao/)
  } finally {
    for (const k of ['NODE_ENV', 'IDP_EMISSOR', 'ERP_PERMITIR_HTTP_LOCAL']) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k] }
  }
})
