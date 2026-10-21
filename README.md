# BacList — Extensão do Navegador

Extensão de automação de apostas para o jogo **BacBo**, com interface clara (fundo branco) e detalhes em azul e vermelho.

---

## Estrutura do Projeto

```
bacbo-autobet/
├── manifest.json          # Manifesto da extensão (MV3)
├── popup.html             # Interface principal da extensão
├── logo.png               # Logo BacList (raiz)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── css/
│   └── popup.css          # Estilos (tema claro BacList)
└── js/
    ├── popup.js           # Lógica da interface
    ├── content.js         # Script injetado na página do jogo
    └── background.js      # Service Worker
```

---

## Como Instalar

### Chrome / Edge / Brave

1. Acesse `chrome://extensions` (ou `edge://extensions`)
2. Ative o **Modo do desenvolvedor** (canto superior direito)
3. Clique em **"Carregar sem compactação"**
4. Selecione a pasta `bacbo-autobet`
5. A extensão aparecerá na barra de ferramentas

---

## Como Usar

### 1. Selecionar o Alvo

Na aba **Apostas**, escolha entre:
- 🔵 **Jogador** (Azul)
- 🟡 **Empate** (Amarelo)
- 🔴 **Casa** (Vermelho)

### 2. Configurar o Valor

- Digite o valor no campo **"Valor da Entrada"** ou use os botões de atalho
- Valores disponíveis: R$ 1, 2, 5, 10, 20, 50

### 3. Proteção no Empate (Opcional)

Ative a chave **"Apostar também no empate"** para cobrir simultaneamente o alvo principal e o empate. Configure o valor específico para o empate.

### 4. Executar

- **Executar Aposta**: executa uma única aposta imediata
- **Modo Auto**: executa apostas automaticamente no intervalo configurado

---

## Configurações Avançadas (Aba Config)

### Seletores de Clique

Configure os **seletores CSS** dos botões na página do jogo. Exemplos:

| Campo | Exemplo de Seletor |
|---|---|
| Jogador (Azul) | `.player-bet-btn` |
| Empate (Amarelo) | `.tie-bet-btn` |
| Casa (Vermelho) | `.banker-bet-btn` |
| Campo de Valor | `input.bet-amount` |
| Confirmar | `.confirm-bet` |

> **Dica**: Use o DevTools (F12) na página do jogo, inspecione o botão de aposta e copie o seletor CSS.

### Automação

| Campo | Descrição |
|---|---|
| Intervalo entre apostas | Tempo em segundos entre cada aposta no modo automático |
| Limite de apostas | Número máximo de apostas (0 = sem limite) |
| Stop Loss | Para automação ao atingir X reais de perda |
| Stop Win | Para automação ao atingir X reais de lucro |
| Martingale | Dobra o valor a cada derrota consecutiva |

---

## Histórico (Aba Histórico)

- Exibe as últimas 50 apostas da sessão
- Resumo com **ganhos**, **perdas**, **total** e **P&L**
- Botão para limpar histórico e zerar estatísticas

---

## Paleta de Cores

| Elemento | Cor |
|---|---|
| Fundo principal | `#ffffff` |
| Fundo secundário | `#f4f7fb` |
| Acento azul | `#0161EC` |
| Acento vermelho | `#E01519` |
| Jogador (Azul) | `#0161EC` |
| Empate (Amarelo) | `#d69e2e` |
| Casa (Vermelho) | `#E01519` |

---

## Notas Técnicas

- **Manifest V3** — compatível com Chrome 88+, Edge 88+, Brave
- Os seletores CSS dependem da estrutura HTML da plataforma do jogo
- A heurística automática tenta encontrar botões por texto/classe quando nenhum seletor está configurado
- Todas as configurações são salvas localmente via `chrome.storage.local`
