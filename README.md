# TELA DOS LISO

Aplicação de compartilhamento de tela em tempo real para participantes que acessam o mesmo endereço. Usa Node.js + Express para servir o site, WebSocket para sinalização e WebRTC para transportar vídeo/áudio diretamente entre navegadores.

## Requisitos

- Node.js 18 ou superior (recomendado uma versão LTS atual).
- Navegador atualizado. O compartilhamento de tela exige um contexto seguro: `localhost` funciona localmente; em produção, use HTTPS.
- Para conexões confiáveis entre redes diferentes, configure um servidor TURN (consulte abaixo).

## Executar localmente

1. Extraia o ZIP e abra a pasta `tela-dos-liso` no VS Code.
2. Instale as dependências:

   ```bash
   npm install
   ```

3. Inicie o servidor:

   ```bash
   npm start
   ```

4. Abra <http://localhost:3000>.

Para testar com mais de uma pessoa no mesmo computador, abra a página em janelas/perfis de navegador diferentes. Para outros dispositivos, publique o servidor em HTTPS e envie o mesmo link público. A sessão é global para a instância do servidor: quem acessar o mesmo endereço entra na mesma sessão, sem código ou sala.

## Como funciona

- `public/`: interface responsiva e lógica do navegador.
- `server.js`: servidor HTTP e sinalização WebSocket; mantém a lista de participantes e encaminha ofertas, respostas e candidatos ICE.
- WebRTC envia as faixas de áudio/vídeo entre os navegadores. O servidor não grava nem retransmite mídia.
- A grade é atualizada quando os participantes entram/saem e quando começam/param de compartilhar.
- O botão de áudio ativa/desativa as faixas de áudio capturadas pelo transmissor. O botão de volume em cada cartão controla a reprodução local para quem assiste.
- O controle de qualidade solicita uma resolução de captura; navegador, sistema operacional e fonte compartilhada podem limitar o resultado.
- A captura de áudio depende do navegador, sistema operacional e origem escolhida. Em geral, áudio de aba funciona melhor no Chrome/Edge; áudio do sistema não é universal. Se a seleção de compartilhamento não oferecer áudio, não haverá faixa de áudio para transmitir.
- Cada participante que compartilha envia sua mídia aos outros participantes por conexões WebRTC individuais (topologia mesh). Isso é adequado para grupos pequenos, mas consumo de upload cresce com o número de espectadores. Para grupos maiores, use uma arquitetura SFU (por exemplo, mediasoup, LiveKit ou Janus) em vez de mesh.

## Limitações e observações importantes

- A tela do computador só pode ser capturada após a pessoa clicar no botão e autorizar a captura no seletor nativo do navegador. Sites não podem selecionar silenciosamente a tela de alguém.
- O navegador pode bloquear áudio remoto até que a pessoa interaja com a página. Se não houver som automático, clique no cartão/vídeo e confira o controle de volume.
- Resoluções de 1440p e 4K dependem de tela, navegador, GPU, largura de banda e limitações de captura; selecionar uma opção é uma solicitação, não uma garantia.
- STUN ajuda a descobrir caminhos de conexão, mas não garante atravessar todos os NATs/firewalls. Configure TURN para redes restritas.
- Esta versão não inclui login, salas privadas, moderação ou gravação. Todos que acessam a mesma URL da instância podem participar. Não compartilhe conteúdo sensível em um link público.
- Um único servidor Node mantém uma única sessão em memória. Para escalar horizontalmente, é necessário um backend de sinalização compartilhado e gerenciamento de sessões.

## Configurar TURN (recomendado para uso público)

1. Obtenha um servidor TURN confiável, por exemplo uma instância coturn administrada por você ou um provedor de infraestrutura WebRTC.
2. Copie `.env.example` para `.env`.
3. Configure `TURN_URL`, `TURN_USERNAME` e `TURN_CREDENTIAL` com as credenciais fornecidas pelo servidor TURN. Não coloque segredos de TURN no JavaScript do cliente; este projeto os entrega por `/config` a participantes da sessão, portanto use credenciais temporárias/efêmeras se disponível.
4. Reinicie `npm start`.

Exemplo de URLs: `turn:turn.seudominio.com:3478` ou `turns:turn.seudominio.com:5349`. O firewall do servidor TURN deve liberar as portas configuradas e o intervalo de relay de mídia. Consulte a documentação do seu provedor/coturn para as portas corretas.

O projeto inclui STUN público do Google como fallback, mas não inclui um serviço TURN hospedado nem credenciais TURN. Sem TURN, algumas combinações de redes podem não conseguir estabelecer mídia.

## Publicar com HTTPS

Você pode hospedar em uma plataforma que aceite Node.js e WebSocket (por exemplo, um VPS com Node.js + Nginx/Caddy, ou uma plataforma Node compatível com WebSockets).

### Exemplo em VPS com domínio e Caddy

1. Aponte o DNS do domínio para o IP do VPS.
2. Instale Node.js 18+ e Caddy no servidor.
3. Envie a pasta do projeto para o servidor e execute `npm install --omit=dev`.
4. Configure variáveis de ambiente (`PORT=3000` e as variáveis TURN, se houver).
5. Execute o processo com um gerenciador como `systemd` ou `pm2`, para mantê-lo ativo.
6. Configure o Caddy para fazer proxy HTTP e WebSocket para `localhost:3000`. O Caddy pode emitir/renovar HTTPS automaticamente quando DNS e portas estiverem corretos.

Exemplo de `Caddyfile`:

```caddy
tela.seudominio.com {
    reverse_proxy 127.0.0.1:3000
}
```

O proxy do Caddy encaminha upgrade de WebSocket automaticamente. Depois acesse `https://tela.seudominio.com` e envie esse endereço aos participantes.

### Plataformas gerenciadas

Use uma plataforma que mantenha processos Node.js e suporte conexões WebSocket persistentes. Defina o comando de build/instalação como `npm install` e o comando de início como `npm start`. Configure as variáveis de ambiente no painel. O serviço precisa fornecer HTTPS e encaminhar WebSocket no mesmo domínio. Consulte as instruções atuais da plataforma escolhida.

## Verificações rápidas

- `http://localhost:3000/health` deve responder `{"ok":true,"service":"tela-dos-liso"}`.
- Se a página não conectar, verifique se o processo está ativo e se o proxy permite WebSocket em `/signal`.
- Se a mídia não conectar entre redes diferentes, configure TURN e confira o firewall.
- Se a captura não iniciar, use Chrome/Edge/Firefox atualizados e confira as permissões do sistema operacional.
