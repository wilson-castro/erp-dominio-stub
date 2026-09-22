# erp-dominio-stub

**Domínios falsos** para desenvolvimento e verificação. Substituem os serviços de negócio reais;
escutam só em `127.0.0.1` e recusam requisição com cabeçalho de navegador (`Origin`, `Sec-Fetch-*`).

| Domínio | Porta | O que simula |
|---|---|---|
| `dominio-a` | 4001 | recursos, com campo `custo` só para quem é do financeiro |
| `dominio-b` | 4002 | segundo domínio da zona 1 |
| `dominio-c` | 4003 | tarefas com versão (`If-Match`) |
| `plataforma` | 4004 | avisos do shell |
| `gestao-acesso` | 4010 | perfis, módulos, concessões, manifestos |

```bash
pnpm install
pnpm test
pnpm dev                 # sobe os cinco, com os dados da semente em memória (reiniciar apaga)
pnpm dev:persistente     # idem, gravando o estado em dados/estado/ (showcase)
pnpm resetar             # apaga dados/estado/: na próxima subida tudo volta à semente
```

## Dados

Cada domínio lê os próprios dados de `dados/semente/<dominio>.json` (atores, grupos, recursos,
tarefas, perfis e concessões). Para mudar o que o showcase mostra, edite a semente e rode `pnpm resetar`.
Com `DADOS_DIR`, o estado vai para `<DADOS_DIR>/<dominio>.json`, gravado por arquivo temporário +
rename. Sem ele (verificação ponta a ponta), cada subida parte da semente e nada é gravado.

Atores de desenvolvimento: `ana`, `bruno`, `carla`, `davi`.

A base inteira (subir, verificar ponta a ponta) é operada pelo repositório principal `nextjs-mfe`: veja o README de lá.
