---
description: Se a extensão mudou, subir o patch e gerar o zip antes de encerrar
---

# Atualização da extensão

A extensão fica na raiz do repositório (`manifest.json`, `popup.html`, `js/`, `css/`, `icons/`). Antes de encerrar qualquer tarefa, verifique se algum desses arquivos foi alterado nesta sessão.

Se não houve alteração na extensão, não suba versão e não gere zip.

Se houve alteração, faça estes passos antes de responder que terminou. Não peça confirmação.

1. Suba um patch em `manifest.json` (`1.0.4` → `1.0.5`). Uma vez por tarefa, mesmo com vários arquivos.
2. Na raiz de `fbot-bacbo-listas`, rode `node scripts/pack-extension.js`. A saída vai para `RELEASES_DIR` do `.env` (veja `.env.example`).
3. Confira que `listas-release.json` em `RELEASES_DIR` está com a mesma versão do manifest e que `fbot-listas.zip` existe.
4. Na resposta, diga a versão nova e que falta `bin/deploy.sh` no projeto do bot para o outro computador receber o zip.

A extensão no outro computador é carregada sem compactação. Não use Chrome Web Store nem `update_url`.
