# erp-dominio-stub

**Domínios falsos** para desenvolvimento e verificação. Substituem os serviços de negócio reais;
escutam só em `127.0.0.1` e recusam requisição com cabeçalho de navegador (`Origin`, `Sec-Fetch-*`).

| Domínio | Porta | O que simula |
|---|---|---|
| `dominio-a` | 4001 | recursos, com campo `custo` só para quem é do financeiro |
| `dominio-b` | 4002 | segundo domínio da zona 1 |
| `dominio-c` | 4003 | tarefas com versão (`If-Match`) |
| `plataforma` | 4004 | avisos do shell |
| `gestao-acesso` | 4010 | perfis, módulos, concessões, manifestos (**em memória**: reiniciar apaga) |

```bash
pnpm install
pnpm test
pnpm dev          # sobe os cinco
```

Atores de desenvolvimento: `ana`, `bruno`, `carla`, `davi`.

A base inteira (subir, verificar ponta a ponta) é operada pelo repositório principal `nextjs-mfe`: veja o README de lá.
