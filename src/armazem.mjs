import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SEMENTES = join(import.meta.dirname, '..', 'dados', 'semente')
const NOME = /^[a-z][a-z0-9-]{0,31}$/

const semente = (nome) => JSON.parse(readFileSync(join(SEMENTES, `${nome}.json`), 'utf8'))

/**
 * Dados de um domínio falso, vindos de `dados/semente/<nome>.json`.
 * - Sem `dir`: cópia da semente em memória; `salvar()` não faz nada. É o modo da verificação
 *   ponta a ponta, que precisa de estado previsível a cada subida.
 * - Com `dir` (showcase): lê `<dir>/<nome>.json` se existir e grava nele a cada `salvar()`,
 *   por arquivo temporário + rename, para um processo derrubado no meio não deixar JSON pela metade.
 */
export function criarArmazem(nome, { dir } = {}) {
  if (!NOME.test(nome)) throw new Error(`nome de armazém inválido: ${nome}`)
  if (!dir) return { dados: semente(nome), salvar() {} }

  const arquivo = join(dir, `${nome}.json`)
  let dados
  try { dados = JSON.parse(readFileSync(arquivo, 'utf8')) } catch { dados = semente(nome) }
  return {
    dados,
    salvar() {
      mkdirSync(dir, { recursive: true })
      writeFileSync(`${arquivo}.tmp`, JSON.stringify(dados, null, 2))
      renameSync(`${arquivo}.tmp`, arquivo)
    },
  }
}

/** Apaga o estado gravado: na próxima subida cada domínio volta à semente. */
export function resetar(dir) {
  let arquivos = []
  try { arquivos = readdirSync(dir) } catch { return }
  for (const a of arquivos) if (a.endsWith('.json') || a.endsWith('.json.tmp')) rmSync(join(dir, a))
}

// `node src/armazem.mjs [pasta]`: volta os domínios à semente (padrão: DADOS_DIR ou dados/estado).
if (import.meta.main) resetar(process.argv[2] ?? process.env.DADOS_DIR ?? join(import.meta.dirname, '..', 'dados', 'estado'))
