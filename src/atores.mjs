/** Tabela de 00-caso.md §2. Grupos vivem no domínio, nunca na sessão do BFF. */
export const ATORES = {
  gabrigas: { sub: 'gabrigas', roles: ['OPERADOR'], grupos: ['OPS-NORDESTE'] },
  marina:   { sub: 'marina',   roles: ['OPERADOR'], grupos: ['OPS-NORDESTE', 'COMERCIAL-NORDESTE'] },
  rafael:   { sub: 'rafael',   roles: ['ADMIN'],    grupos: ['OPS-NORDESTE'] },
  carla:    { sub: 'carla',    roles: ['OPERADOR'], grupos: ['OPS-SUL'] },
}

/** C7 — acesso revogado durante a sessão. Muta a tabela em memória. */
export function revogar(usuario, grupo) {
  const a = ATORES[usuario]
  if (!a) return false
  a.grupos = a.grupos.filter((g) => g !== grupo)
  return true
}
