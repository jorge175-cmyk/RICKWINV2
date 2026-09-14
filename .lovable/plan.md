# Estabilizar a conexão com a IQ Option

## Objetivo
Manter uma única sessão reutilizável, reduzir chamadas paralelas e retomar o canal apenas quando ele realmente cair.

## Alterações
- Restaurar o registro único que coordena login, sessão persistida e bloqueio compartilhado entre processos.
- Tornar a inicialização desse registro defensiva para projetos remixados.
- Remover o aquecimento simultâneo de quatro ativos; manter somente o ativo selecionado conectado.
- Não fechar um WebSocket saudável ao voltar para a aba ou ganhar foco.
- Evitar fallback de candles em paralelo enquanto a conexão estiver em recuperação.
- Preservar a sessão salva quando apenas o transporte WebSocket falhar.

## Validação
- Conferir que apenas um ativo inicia consultas.
- Confirmar ausência de novas rajadas de login.
- Verificar compilação, logs e retomada do painel após o período de bloqueio atual.

## Observação
O bloqueio 429 já aplicado pela IQ Option precisa expirar; a correção impede que novas tentativas prolonguem esse bloqueio.
