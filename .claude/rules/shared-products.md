---
description: FBot e NeuroSports compartilham código e banco — toda mudança comum vai para os dois
---

# Produtos compartilhados: FBot e NeuroSports

FBot e NeuroSports (marca **Neuro Pro Auto**) são o mesmo sistema em repositórios separados. Usam o **mesmo banco** e os **mesmos workers** (só no FBot). Toda mudança de código comum vai para os dois.

| FBot | NeuroSports | Produção |
|---|---|---|
| `/home/felipe/bacbo-bot-entradas` | `/home/felipe/neuroweb` | `/var/www/fbot` · `/var/www/neurosports` |
| `/home/felipe/fbot-bacbo-listas` | `/home/felipe/neurolista` | zip em `releases/` de cada painel |

Bac Bo Automático (`bacbo-automatico`) só existe no FBot.

## Mudança comum (código, tela, API, regra de negócio)

1. Faça no repositório onde começou, no worktree da tarefa, com commit e push.
2. No par, crie um worktree próprio e aplique o mesmo commit: `git -C <par> fetch upstream` (no NeuroSports, `upstream` = FBot; no FBot, adicione `neuro` = repositório NeuroSports) e `git cherry-pick <sha>`. Conflito só em arquivo de marca: fique com a versão do lado de destino.
3. Merge, push e deploy **dos dois** (`bin/deploy.sh` de cada painel). Extensão Listas: patch de versão e `node scripts/pack-extension.js` nas duas.
4. Na resposta, diga que os dois foram atualizados. Se um ficou de fora, diga qual e por quê.

## Diferença de marca (fica de um lado só)

Só estes pontos podem diferir. Commit próprio com prefixo `brand:`, nunca misturado com mudança comum:

- `.env` de cada servidor: `APP_BRAND_NAME`, `APP_BRAND_TAGLINE`, `DISABLED_SCREENS`, `DISABLED_PRODUCTS`, `USER_STORAGE_PATH`, `APP_URL`, `SESSION_COOKIE`.
- Painel: `public/assets/brand/*` (logos, favicon, `brand.css`), `releases/*` (cada painel publica o seu).
- Listas: `js/brand.js`, `css/brand.css`, `icons/*`, `logo.png`, nome/descrição/versão no `manifest.json`.
- Regras e `CLAUDE.md` (caminhos e domínio de cada lado).

Precisa diferenciar outra coisa? Crie a chave no `.env` (`config/fbot.php`) como mudança comum, nos dois, em vez de editar o código de um lado só.

## Banco e workers

- Banco compartilhado: migration nova entra nos dois repositórios, mas `php8.5 artisan migrate --force` roda **só em `/var/www/fbot`**.
- Nunca subir cron, watchdog, game-feed, mesa-socket ou bot-worker em `/var/www/neurosports`. O `storage/<user_id>` do NeuroSports aponta para o do FBot (`USER_STORAGE_PATH`).
- Mudança que quebraria o FBot com a migration rodada (coluna removida, renomeada) precisa ir para os dois no mesmo deploy.

```bash
# ❌ BAD — corrige só no FBot e esquece o NeuroSports
git -C /home/felipe/bacbo-bot-entradas commit -m "fix: x" && bin/deploy.sh

# ✅ GOOD — mesmo commit nos dois, deploy nos dois
git -C /home/felipe/neuroweb fetch upstream
git -C /home/felipe/neuroweb worktree add /home/felipe/worktrees/neuroweb/fix-x -b fix/x
git -C /home/felipe/worktrees/neuroweb/fix-x cherry-pick <sha>
```
