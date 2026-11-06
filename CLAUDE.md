# Bac Bo Listas (Claude Code)

Extensão Chrome MV3 na raiz (`manifest.json`, `popup.html`, `js/`). Entradas por lista de horários, login no painel. Zip publicado pelo painel (`/home/felipe/bacbo-bot-entradas`).

- Nunca criar, alterar ou executar testes, salvo pedido explícito.
- Nunca rodar nada localmente. Publicação do zip só via `bin/deploy.sh` do painel.
- Não commitar `.env`.

## Regras

Em `.claude/rules/`. Sempre carregada: `extension-update` — patch no manifest + `node scripts/pack-extension.js` ao alterar a extensão.
