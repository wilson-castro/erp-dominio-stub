/** Fixture completo, ANTES da projeção. Nenhum consumidor recebe isto inteiro. */
export const PEDIDO_8821 = {
  id: '8821',
  status: 'ABERTO',
  versao: 42,
  grupoDono: 'OPS-NORDESTE',
  fornecedor: { id: 'f-100', nome: 'Metalúrgica Aurora' },
  itens: [
    { id: 'i-1', descricao: 'Chapa de aço 2mm', quantidade: 120 },
    { id: 'i-2', descricao: 'Parafuso sextavado M8', quantidade: 4000 },
  ],
  remessas: [{ id: '4410', status: 'EM_TRANSITO' }],
  condicaoComercial: { precoNegociado: 184_500.0, margem: 0.17, contrato: 'CT-2026-0091' },
}
