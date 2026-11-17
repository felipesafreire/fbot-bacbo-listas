# Trabalhar em worktree

Toda tarefa que altera arquivos é feita num `git worktree` próprio, nunca direto no checkout principal. Outras sessões (Claude, Cursor) podem estar mexendo no checkout principal ao mesmo tempo, com alterações sem commit que não são suas.

## Começo da tarefa

1. Partir da branch atual do checkout principal (`git -C <repo> branch --show-current`).
2. Criar o worktree fora do repositório, em `/home/felipe/worktrees/<repo>/<slug>`, com branch nova `<tipo>/<slug>` (`feat/`, `fix/`, `chore/`):
   `git -C <repo> worktree add /home/felipe/worktrees/<repo>/<slug> -b <tipo>/<slug>`
3. Arquivos fora do git que a tarefa precisar (`.env`, `deploy.env`, `node_modules/`, `vendor/`) entram como symlink do checkout principal. Nunca commitar esses links.
4. Ler, editar e commitar só dentro do worktree.

## Fim da tarefa

1. Commit no worktree e `git push -u origin <tipo>/<slug>`.
2. No checkout principal, `git merge --no-edit <tipo>/<slug>` na branch de origem e `git push`. Se o merge conflitar com alteração sem commit de outra sessão, parar e avisar; não descartar nem commitar o que não é seu.
3. Zip da extensão (`node scripts/pack-extension.js`) e `bin/deploy.sh` rodam no checkout principal, depois do merge: os scripts procuram `.env`, `deploy.env` e a pasta `releases/` por caminho relativo.
4. Remover o worktree e a branch local: `git -C <repo> worktree remove <caminho>` e `git -C <repo> branch -d <tipo>/<slug>`.

```bash
# ❌ BAD — edita direto no checkout principal, misturado com o trabalho de outra sessão
cd /home/felipe/bacbo-bot-entradas && vim modules/...

# ✅ GOOD — worktree próprio, merge e deploy no fim
git -C /home/felipe/bacbo-bot-entradas worktree add /home/felipe/worktrees/bacbo-bot-entradas/login-unico -b feat/login-unico
# ...edita, commita e dá push em /home/felipe/worktrees/bacbo-bot-entradas/login-unico...
git -C /home/felipe/bacbo-bot-entradas merge --no-edit feat/login-unico && git -C /home/felipe/bacbo-bot-entradas push
git -C /home/felipe/bacbo-bot-entradas worktree remove /home/felipe/worktrees/bacbo-bot-entradas/login-unico
```

Pergunta só de leitura (sem alterar arquivo) não precisa de worktree.
