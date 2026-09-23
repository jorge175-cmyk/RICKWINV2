# Recuperar a conexão com a IQ Option

## Objetivo
Restabelecer o canal ao vivo quando a IQ Option deixar de aceitar uma sessão salva, sem criar conexões ou tentativas de login em paralelo.

## Alterações
- Detectar quando o WebSocket abre, mas a autenticação não é confirmada dentro do prazo.
- Invalidar somente a sessão rejeitada, preservando uma sessão mais nova que outro processo possa ter criado.
- Fazer uma única renovação coordenada do login e reutilizar a nova sessão nas próximas conexões.
- Aplicar a mesma recuperação no canal do navegador e nas consultas de candles.
- Registrar apenas estado e motivo técnico, sem expor credenciais.

## Validação
- Confirmar nos logs que a sessão antiga é descartada uma vez e não gera rajadas de login.
- Testar candles e o canal ao vivo com uma sessão autenticada.
- Verificar o painel de trading e o indicador de conexão do Espelho OTC.
- Confirmar compilação sem erros.

## Detalhes técnicos
- A limpeza será condicional ao SSID atualmente salvo para evitar corrida entre processos.
- Falhas comuns de transporte não apagarão a sessão; somente falha durante a autenticação inicial acionará a renovação.
