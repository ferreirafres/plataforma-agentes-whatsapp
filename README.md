# Plataforma Agentes WhatsApp

Plataforma em português para criar agentes de IA, organizar fluxos de atendimento em quadros e conectar o seu próprio WhatsApp. O projeto reúne o painel **Agentes**, o worker que executa as filas e uma implementação do **WhatsApp MCP** com pareamento, gestão de acesso e ferramentas de leitura, mídia e envio.

Cada instalação tem seu próprio banco, usuários, chaves e sessão de WhatsApp. A primeira abertura começa sem contatos, conversas, agentes ou credenciais de serviços externos. O envio só começa quando você configura e ativa um agente.

## Primeira instalação

1. Instale o Docker com Docker Compose v2. Em Windows e macOS, use Docker Desktop com contêineres Linux.
2. Baixe o projeto em **Code → Download ZIP** ou use **Code → HTTPS** para copiar o endereço e cloná-lo. No terminal, entre na pasta que contém `compose.yaml`.
3. Se quiser habilitar a IA agora, copie `.env.example` para `.env` e preencha `OPENAI_API_KEY` com uma chave de um projeto da sua conta. Escolha em `OPENAI_MODEL` um modelo com acesso à Responses API e suporte a saídas estruturadas. O painel e o QR funcionam sem essa chave.
4. Execute:

   ```sh
   docker compose up -d --build --wait
   docker compose exec agentes cat /data/initial-access.txt
   ```

5. Abra [127.0.0.1:8820](http://127.0.0.1:8820/), entre como `admin` com a senha gerada e altere-a em **Configurações → Segurança**. O arquivo da senha inicial é removido depois da troca.

O Compose mantém as duas portas acessíveis somente no seu computador. Em caso de conflito, ajuste `AGENTES_PORT` ou `MCP_PORT` no seu `.env`. Mantenha esse arquivo fora do Git. Depois de editar a configuração, rode `docker compose up -d --wait`.

## Parear e criar o primeiro agente

1. Em **Configurações → WhatsApps**, abra o QR de **Meu WhatsApp**. No celular, vá a **Aparelhos conectados → Conectar um aparelho** e escaneie o código. A autorização entre o painel e a instância MCP já é preparada na primeira inicialização. Se necessário, use **Reconectar** para gerar outro QR.
2. Crie um quadro vinculado à conta e adicione uma coluna. Na coluna, crie um **Modal de Agente**. Preencha identidade e base de conhecimento, adicione uma etapa e escreva seu objetivo e as instruções.
3. Para filas por etiqueta, crie no WhatsApp Business as etiquetas de entrada e de saída e use esses nomes no agente. A lista de contatos também permite selecionar os contatos que entram no fluxo.
4. Em **Configurações → Cérebro dos agentes**, use **Verificar** para testar a sua chave. Crie uma fila pequena com um contato de teste que concordou em receber mensagens. Revise a lista e as regras de saída antes de ativar.

O painel permite organizar várias etapas e rotas de saída, conversar com o agente para revisar seu comportamento, acompanhar o estado da fila e pausar a execução. O worker confirma as mudanças de etiqueta e registra o resultado das operações para ajudar a evitar reenvios. O painel também pode ser instalado como aplicativo pelo navegador em uma origem compatível.

## O que vem no MCP

- Sessão por QR, reconexão e estado da instância.
- Autorização OAuth, identidades por escopo, gestão e revogação de acesso.
- Histórico, busca, etiquetas, contatos e relatórios de conversas não lidas.
- Envio de texto, encaminhamento e trabalho com arquivos e anexos.
- Transcrição com chave OpenAI própria e integração opcional com Google Drive.

O endpoint local de transporte Streamable HTTP fica em `http://127.0.0.1:3000/mcp`. Ele exige autorização. A senha da identidade administrativa do MCP é separada da senha do painel e fica no volume da instalação. Para administrá-lo localmente:

```sh
docker compose exec whatsapp-mcp cat /data/.oauth-data/initial-admin-password.txt
docker compose exec whatsapp-mcp node admin.js list-users
```

Prefira uma identidade com apenas os escopos necessários para cada cliente externo. Para acesso remoto, use um proxy HTTPS ou uma rede privada; mantenha a ligação direta às portas bloqueada. Configure `MCP_PUBLIC_URL` para o endereço HTTPS externo da raiz do MCP, `COOKIE_SECURE=1` para o painel HTTPS e os valores de `*_PROXY_HOPS` de acordo com os proxies que você controla. Este projeto é uma instalação administrada por você; o painel usa uma conta administrativa local.

Para habilitar o Drive, configure seu próprio cliente OAuth no Google, com o retorno `<MCP_PUBLIC_URL>/oauth/google/callback`, preencha `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e uma chave aleatória de 32 bytes em hexadecimal em `DRIVE_TOKEN_ENCRYPTION_KEY`. Depois conecte uma conta pelo endereço `/admin/drive` da sua instância. Sem essas variáveis a conexão ao Drive fica indisponível.

O conector usa [whatsapp-web.js](https://github.com/wwebjs/whatsapp-web.js), uma biblioteca não oficial. O pareamento depende do WhatsApp Web; mudanças no serviço podem afetar a conexão, e contas podem sofrer restrições pelo uso de clientes não oficiais. Se você habilitar IA ou transcrição, as informações necessárias a essas operações são enviadas à conta de API que você configurou.

## Operação e estrutura

| Pasta ou serviço | Função |
| --- | --- |
| `agentes/` | Painel Flask, interface, banco SQLite, cliente MCP e worker. |
| `whatsapp-mcp/` | Serviço Node, Chromium, OAuth, ferramentas MCP e sessão do WhatsApp. |
| `compose.yaml` | Rede privada, verificações de saúde, credenciais iniciais e volumes. |

Use `docker compose ps` para ver o estado dos serviços e `docker compose logs --tail=100` para diagnosticar a sua instalação. `docker compose down` para os serviços e preserva os volumes. Faça backups privados dos volumes `agentes-data`, `whatsapp-data` e `mcp-bootstrap` antes de atualizações. Eles guardam dados e segredos da sua instalação. Nunca os inclua em commits ou em relatórios públicos.

O código do projeto está sob a [licença MIT](LICENSE). As dependências continuam sob suas respectivas licenças.
