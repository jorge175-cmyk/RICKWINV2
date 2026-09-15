# Canal único e persistente da IQ Option

## Objetivo
Manter a conta logada como uma sessão normal e transportar todos os ativos disponíveis por um único canal em tempo real. Se a rede ou a corretora encerrar fisicamente o canal, a retomada será silenciosa, reutilizando a mesma sessão e sem refazer login.

## Alterações
- Transformar o proxy em um multiplexador: um único WebSocket autenticado recebe todas as assinaturas de candles e cotações da sessão do navegador.
- Carregar o catálogo de ativos uma vez e assinar todos os ativos disponíveis pelo mesmo canal, com envio controlado em lotes para não disparar proteção contra excesso de tráfego.
- Manter o canal ativo mesmo ao trocar de ativo, timeframe, aba ou tela; remover cancelamentos e encerramentos voluntários enquanto o usuário estiver logado.
- Reutilizar o SSID persistido por até 30 dias e separar recuperação de transporte de novo login; uma queda do WebSocket não invalidará a autenticação.
- Manter heartbeat e watchdog, mas usar retomada automática com backoff apenas quando o transporte realmente morrer, sem criar conexões paralelas.
- Fazer a store receber o fluxo global e conservar buffers limitados por ativo, evitando crescimento ilimitado de memória.
- Reduzir o fallback: consultas periódicas só serão usadas durante indisponibilidade real do canal e sem sobreposição.

## Limite técnico
Uma conexão de rede não pode ser matematicamente permanente: navegador, provedor ou infraestrutura podem encerrá-la. A experiência será de sessão continuamente logada; qualquer reconstrução inevitável do transporte ocorrerá em segundo plano, com a credencial já existente e sem nova autenticação na IQ Option.

## Validação
- Confirmar apenas um WebSocket do navegador para o proxy.
- Confirmar uma única autenticação upstream por canal e ausência de rajadas de login.
- Confirmar assinaturas de mercado real e OTC no mesmo canal.
- Confirmar que trocar ativo/timeframe não fecha nem cria outro WebSocket.
- Confirmar que uma interrupção forçada retoma o transporte com o mesmo SSID.
- Verificar painel, ticks, HFT e candles em desktop e mobile, além dos logs e da compilação.

## Detalhes técnicos
- O SSID continuará exclusivamente no servidor; uma conexão realmente direta do navegador exporia a credencial e seria insegura.
- A persistência física de um único socket global entre todas as instâncias não é garantida em infraestrutura serverless. A unidade segura será um canal por sessão ativa do navegador, reutilizando a mesma sessão coordenada da conta.
