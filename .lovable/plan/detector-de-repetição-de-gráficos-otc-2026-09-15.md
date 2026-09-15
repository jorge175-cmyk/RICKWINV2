# Detector de repetição de gráficos OTC

Nova página que investiga se um ativo OTC ao vivo está repetindo um trecho de gráfico já ocorrido — no mesmo ativo em outro dia/mês, em outro ativo, ou com o desenho invertido (de trás pra frente e/ou de cima pra baixo). Quando encontra uma repetição, mostra qual seria a próxima vela dessa sequência.

## O que o usuário vai ver

Nova página "Espelho OTC" (`/mirror`), acessível pelo mesmo menu logado:

1. Seleção do ativo OTC ao vivo e do timeframe (M1, M5, M15).
2. Botão "Procurar repetição". Enquanto roda, mostra progresso (quantos ativos e períodos já comparados).
3. Lista das melhores coincidências encontradas, cada uma com:
   - ativo e data/hora do trecho antigo;
   - tipo de repetição: igual, espelhado no tempo, invertido no preço, ou os dois;
   - grau de semelhança em porcentagem;
   - miniatura comparando o trecho ao vivo e o trecho antigo;
   - **próxima vela prevista**: alta ou baixa, com tamanho estimado em relação às velas atuais.
4. Card de veredito da IA abaixo: recebe as melhores coincidências e os dados brutos, avalia se a semelhança é real ou coincidência estatística e devolve direção (compra/venda), confiança e justificativa.
5. Estado vazio claro quando nenhuma repetição relevante é encontrada.

O alerta sonoro e o botão liga/desliga seguem o mesmo padrão da tela de análises.

## Como a busca funciona

- Trecho ao vivo: as últimas 24 velas fechadas do ativo escolhido (janela configurável 16/24/40).
- Histórico: para cada ativo candidato, baixamos vários blocos de velas voltando no tempo (por padrão até ~30 dias no timeframe escolhido), respeitando o mesmo cuidado com limite de acessos da corretora que já existe hoje.
- Comparação: cada trecho é normalizado (retornos percentuais em z-score), então o formato importa e o nível de preço não. Deslizamos a janela por todo o histórico e calculamos correlação em quatro variantes:
  - direta;
  - invertida no tempo (de trás pra frente);
  - invertida no preço (de cima pra baixo);
  - invertida nas duas.
- Só entram no resultado janelas com correlação acima de um limite (padrão 0,93) e com corpo/amplitude compatíveis, evitando "casamentos" de ruído.
- Previsão: a vela seguinte à janela antiga é convertida de volta para a escala atual, respeitando a inversão aplicada (no espelho de tempo, a "próxima" é a vela anterior à janela; na inversão de preço, o sinal do movimento é trocado).
- Ranking por correlação e por quantidade de coincidências independentes que apontam para a mesma direção.

## Detalhes técnicos

- `src/lib/iqoption/iqoption.server.ts`: adicionar parâmetro `to` (fim do intervalo) em `fetchCandles`, incluí-lo na chave de cache e permitir cache mais longo para blocos antigos (imutáveis).
- `src/lib/analysis/mirror.ts` (puro, testável): normalização, correlação em janelas deslizantes, as quatro transformações, cálculo da próxima vela projetada e tipos `MirrorMatch`.
- `src/lib/analysis/mirror.functions.ts`: server function autenticada `findMirrorMatches` — recebe ativo, timeframe, tamanho de janela, dias de histórico e a lista de ativos candidatos; busca blocos em série com espaçamento, roda o matcher e devolve as melhores coincidências (com as janelas de velas necessárias para desenhar as miniaturas).
- `src/lib/analysis/mirrorVerdict.functions.ts`: server function que envia as melhores coincidências + a janela ao vivo ao serviço de IA (mesma integração e tratamento de erro já usados), com prompt próprio focado em validar repetição e prever a próxima vela; resposta em JSON estrito (`direction`, `confidence`, `verdict`, `reasoning`, `risks`).
- `src/routes/_layout/mirror.tsx`: página com `head()` próprio (título/descrição/og), seletores, `useQuery` sob demanda, progresso, lista de resultados e card da IA.
- `src/components/trading/MirrorMatchCard.tsx` e `MiniCandles.tsx`: apresentação e miniatura em SVG, usando tokens semânticos existentes.
- Link para a nova página no cabeçalho de `/trading`.

## Limites conhecidos

- A profundidade de histórico depende do que a corretora entrega por ativo; em M1 costuma ser bem menor que em M15. A varredura é feita em blocos com espaçamento para não disparar bloqueio por excesso de acessos, então uma busca ampla leva alguns segundos por ativo.
- Repetição encontrada não é garantia de continuidade: o resultado é apresentado como probabilidade, com a IA sinalizando quando a semelhança é provavelmente coincidência.
