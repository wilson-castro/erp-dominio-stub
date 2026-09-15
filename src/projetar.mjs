const GRUPO_COMERCIAL = 'COMERCIAL-NORDESTE'

/**
 * A projeção acontece AQUI, no domínio. O BFF não filtra e não mascara: se ele
 * precisasse filtrar, o campo teria existido em memória no processo errado.
 *
 * Devolve `null` quando o ator não conhece o pedido — o servidor traduz para 404.
 */
export function projetar(pedido, ator) {
  if (!ator) return null
  if (!ator.grupos.includes(pedido.grupoDono)) return null

  const podeComercial = ator.grupos.includes(GRUPO_COMERCIAL)

  const projetado = {
    id: pedido.id,
    status: pedido.status,
    versao: pedido.versao,
    // cópias: `projetar` é exportado, e mutar o resultado não pode vazar para o fixture
    fornecedor: structuredClone(pedido.fornecedor),
    itens: structuredClone(pedido.itens),
    remessas: structuredClone(pedido.remessas),
    _permissoes: {
      // Record COMPLETO. Fatia 1 é somente leitura, então tudo nega — mas as
      // quatro chaves existem, e é isso que o contrato exige.
      editar: false,
      remover_remessa: false,
      excluir: false,
      aprovar: false,
    },
  }

  // ausência total, sem placeholder: a chave só é criada quando autorizada
  if (podeComercial) projetado.condicaoComercial = structuredClone(pedido.condicaoComercial)

  return projetado
}
