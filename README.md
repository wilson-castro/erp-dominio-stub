# erp-dominio-stub

**Domínios falsos** para desenvolvimento e verificação. Substituem os serviços de negócio reais;
escutam só em `127.0.0.1` e recusam requisição com cabeçalho de navegador (`Origin`, `Sec-Fetch-*`).

| Domínio | Porta | O que simula |
|---|---|---|
| `dominio-a` | 4001 | recursos, com campo `custo` só para quem é do financeiro |
| `dominio-b` | 4002 | segundo domínio da zona 1 |
| `dominio-c` | 4003 | tarefas com versão (`If-Match`) |
| `plataforma` | 4004 | avisos do shell |
| `gestao-acesso` | 4010 | perfis, módulos, concessões, manifestos (o que as apps usam hoje) |
| `gestao-acesso-v2` | 4020 | **mock da API proposta** de gestão de acesso: unidades, pessoas, papéis com escopo, módulos direto/validado, validação, painel, auditoria. Contrato em `contratos/gestao-acesso-v2.openapi.yaml`; modelo em `docs/gestao-acesso/MODELO.md` do repositório principal. Pessoas próprias: `Bearer dev.<login>` com os logins de `dados/semente/gestao-acesso-v2.json` (ex.: `admin1`, `gnorte1`, `gmod1`, `auditor1`, `norte1`) |

```bash
pnpm install
pnpm test
pnpm dev                 # sobe os cinco, com os dados da semente em memória (reiniciar apaga)
pnpm dev:persistente     # idem, gravando o estado em dados/estado/ (showcase)
pnpm resetar             # apaga dados/estado/: na próxima subida tudo volta à semente
```

## Responsabilidades

O que esta parte faz, o que nunca faz e o vocabulário usado aqui (BFF, zona, Server Action…), explicados
do zero: [`docs/RESPONSABILIDADES.md`](https://github.com/ArtroxGabriel/nextjs-mfe/blob/bff-multizone/docs/RESPONSABILIDADES.md)
no repositório principal, seção 6.

## Dados

Cada domínio lê os próprios dados de `dados/semente/<dominio>.json` (atores, grupos, recursos,
tarefas, perfis e concessões). Para mudar o que o showcase mostra, edite a semente e rode `pnpm resetar`.
Com `DADOS_DIR`, o estado vai para `<DADOS_DIR>/<dominio>.json`, gravado por arquivo temporário +
rename. Sem ele (verificação ponta a ponta), cada subida parte da semente e nada é gravado.

Atores de desenvolvimento: `ana`, `bruno`, `carla`, `davi`, `eva`.

## Identificação: um modo por processo

- **Sem `IDP_EMISSOR`** (padrão): só o token de desenvolvimento (`Bearer dev.<ator>.<uuid>`); todo JWT é recusado.
- **Com `IDP_EMISSOR`** (showcase com Keycloak): só o access token do IdP, verificado em `src/jwt.mjs` com
  `node:crypto` (RS256, chave do JWKS do emissor por `kid`, `iss`, `aud` com `erp-dominios`, `exp`/`nbf`); o ator
  é o `preferred_username`. O token dev é recusado.
- `Bearer svc.<aplicacao>` (token de serviço, **sem segredo**):
  - sem `IDP_EMISSOR`: vale em toda rota que o aceita, simulando os serviços da gestão de acesso
    (`svc.idp` no `primeiro-acesso`, qualquer serviço em `decisoes` e `eventos`) e o registro de manifesto;
  - com `IDP_EMISSOR`: vale **só** para registrar o manifesto do próprio módulo (`svc.zona1` registra só `zona1`;
    outro id é 403). Em toda outra rota, inclusive `svc.idp`, é 401. Motivo e risco residual: ADR-0013, adendo 1.

Toda recusa é `401 { codigo: 'SESSAO_EXPIRADA' }`, sem motivo. Timeout, cache do JWKS e tolerância de relógio:
`docs/CONFIGURACAO.md` §4 do repositório principal (ADR-0013, decisão 7).

A base inteira (subir, verificar ponta a ponta) é operada pelo repositório principal `nextjs-mfe`: veja o README de lá.
