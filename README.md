# Gestão de Frete – Proloplast

Calculadora de frete fracionado com origem em Nova Santa Rita/RS. Compara as tabelas das transportadoras e lista os valores do menor para o maior, com o prazo de entrega.

Site estático: não tem servidor nem banco de dados. Todo o cálculo roda no navegador, a partir dos arquivos JSON da pasta `dados/`.

## Estrutura

```
wrangler.jsonc                            configuração do Cloudflare Workers (site + API + banco)
package.json                              dependências do servidor (driver PostgreSQL "pg")
src/index.js                              servidor: API do histórico de cotações e do Bling (/api/*)
src/bling.js                              integração com o Bling (OAuth, tokens, busca de pedido)
public/index.html                         página
public/css/app.css                        estilos
public/js/app.js                          motor de cálculo e telas
public/dados/transportadoras/index.json   lista das tabelas ativas (ordem de carregamento)
public/dados/transportadoras/*.json       uma tabela por transportadora
public/dados/cidades/*.json               listas de cidades por transportadora (praça, CEP, prazo)
public/_headers                           cache (dados sempre atualizados)
```

### Transportadoras e listas de cidades

| Arquivo da tabela | Modelo de cálculo | Lista de cidades |
|---|---|---|
| transito-brasil.json | Faixas de peso + tonelada | cidades/transito-brasil.json |
| tjb.json | Faixas de peso + tonelada | cidades/tjb.json |
| bento-brasil.json | R$/kg com frete mínimo | — (pendente) |
| braspress.json | Faixas até 70 kg + R$/kg | — (pendente) |
| rodonaves.json | Maior entre mínimo, % NF e R$/kg | cidades/rodonaves.json + rodonaves-taxas-entrega.json + zonas-sp.json |
| sao-miguel.json | Taxa + R$/kg + % NF | cidades/sao-miguel.json |

## Como o destino é identificado

1. **CEP:** a cidade e a UF vêm dos Correios, pela [ViaCEP](https://viacep.com.br). Se ela não responder, a consulta vai para a [BrasilAPI](https://brasilapi.com.br). As listas das transportadoras servem só para achar a praça e o prazo de cada uma.
2. **Reserva:** se as duas consultas falharem, a cidade é estimada pelas faixas de CEP das listas, limitada à UF do CEP. A tela avisa quando isso acontece.
3. **Comparação de nomes:** a comparação ignora acentos e pontuação ("D'Oeste" = "D Oeste").
4. **Escolha automática da praça:** nas transportadoras sem lista de cidades, a ordem é: praça com o nome da cidade, capital e primeira praça do interior (marcada "a confirmar"). Praças com `"naoAuto": true` no JSON nunca são escolhidas automaticamente. É o caso da Braspress SP (Imp), que fica pendente de confirmação.

## Histórico de cotações (banco de dados)

- **Banco:** PostgreSQL no Aiven, acessado pelo **Cloudflare Hyperdrive** (configuração `gestaofrete-db`). Usuário e senha ficam só no Cloudflare. O `wrangler.jsonc` guarda apenas o ID da configuração, que não é segredo.
- **Tabela:** `cotacoes`, criada automaticamente no primeiro acesso. Cada linha guarda o usuário, o cliente, o pedido, o destino, a carga, as regras usadas, a melhor opção e o resultado completo de cada transportadora (coluna `resultados`, JSONB, com o detalhamento das cobranças).
- **Usuário:** o e-mail do login do Cloudflare Access, enviado pelo cabeçalho `cf-access-authenticated-user-email`.
- **API:**
  - `GET /api/eu`: usuário logado
  - `POST /api/cotacoes`: salva uma cotação
  - `GET /api/cotacoes?busca=&limite=`: lista as mais recentes
  - `GET /api/cotacoes/{id}`: detalhe completo

## Integração com o Bling (etapa 1: busca do pedido)

1. **Busca:** o usuário digita o nº do pedido. O servidor busca no Bling (API v3) o CEP de entrega (etiqueta de transporte; se faltar, o endereço do cliente), o peso bruto, a quantidade de volumes, o valor dos produtos e o nome do cliente, e preenche a calculadora.
2. **Volta para o Bling:** por enquanto é manual. O botão "Copiar valor do frete" copia o valor da transportadora escolhida para colar no pedido. A cotação salva guarda o ID do pedido, a transportadora escolhida e o valor.
3. **Configuração:**
   - Secrets `BLING_CLIENT_ID` e `BLING_CLIENT_SECRET` no Cloudflare (Workers & Pages → gestaofrete → Settings → Variables and secrets).
   - Link de redirecionamento do aplicativo no Bling: `https://<domínio>/api/bling/callback`.
   - Escopos: Pedidos de Venda e Contatos.
4. **Tokens:** ficam na tabela `bling_tokens` (access token de cerca de 6 h; refresh token de 30 dias, trocado a cada renovação). A importação automática a cada 5 minutos renova o token sempre que preciso e mantém o banco do Aiven ativo. A conexão manual ("Conectar ao Bling") só volta a ser necessária se o aplicativo for revogado no Bling ou se o Client Secret for trocado. Os logs da tarefa ficam em Workers & Pages → gestaofrete → Observability.
5. **API:**
   - `GET /api/bling/status`
   - `GET /api/bling/conectar`
   - `GET /api/bling/callback`
   - `GET /api/bling/pedido?numero=`

## Pedidos importados do Bling (aba "Pedidos Bling")

- **Importação automática a cada 5 minutos** (`triggers.crons` no `wrangler.jsonc`): traz os pedidos alterados desde o último ciclo completo, com um dia de folga. Na primeira execução, traz os últimos 30 dias. Cada execução faz no máximo 40 chamadas ao Bling, por causa do limite do plano gratuito do Cloudflare, e o que sobrar fica para a execução seguinte. Pedidos novos ou alterados (situação ou valor) são lidos primeiro. Os demais só são relidos depois de 30 minutos.
- **Busca manual:** buscar um pedido na calculadora também grava o pedido.
- **Tabela `pedidos_bling`:** nº, data, situação, cliente, CPF/CNPJ, CEP/cidade/UF, peso bruto, volumes, valores, **frete lançado no Bling**, quem paga o frete, transportadora do pedido e a resposta completa do Bling (`dados`, JSONB). A tabela `bling_situacoes` guarda os nomes das situações, e a `bling_sync`, o estado da importação.
- **Tela:** lista os pedidos com o frete do Bling, a última cotação (escolhida ou melhor) e a **diferença**, em vermelho quando o frete lançado está acima da cotação. Filtros: sem cotação, sem frete lançado, frete acima da cotação. O botão "Cotar" leva o pedido para a calculadora, e "Sincronizar agora" roda a importação na hora.
- **API:**
  - `GET /api/bling/pedidos?busca=&filtro=&limite=`
  - `POST /api/bling/sincronizar`
- **Testes:**
  - `npm test`: lógica do Bling.
  - `npm run test:sync`: importação contra um PostgreSQL local, via `psql`.

## Como atualizar uma tabela

1. A transportadora envia a tabela nova (PDF ou Excel).
2. O arquivo é enviado ao Claude no projeto "Proloplast – Frete".
3. O Claude converte para o JSON da transportadora e gera um **relatório de conferência**: o que mudou, o reajuste médio por praça, os valores fora do padrão e as cotações de referência antes e depois.
4. Depois da aprovação, o Claude envia o arquivo para este repositório, por commit ou pull request.
5. O Cloudflare publica sozinho em cerca de 1 minuto.
6. Se algo der errado, basta reverter o commit no GitHub.

Para incluir uma transportadora nova, crie o JSON em `public/dados/transportadoras/` e acrescente o nome do arquivo em `index.json`.

## Testar localmente

O site carrega os dados com `fetch`, por isso não funciona abrindo o `index.html` direto do disco. Use um servidor local (sem a API, o histórico fica desativado):

```
cd public
python -m http.server 8000
```

Depois abra http://localhost:8000

## Publicação

- Hospedagem: Cloudflare Workers (site estático em `public/` + servidor em `src/index.js`), ligado a este repositório (branch `main`). Deploy command: `npx wrangler deploy`. As dependências do `package.json` são instaladas no build.
- Acesso: Cloudflare Access, com login por código enviado ao e-mail.
- Domínio: subdomínio do cliente (ex.: `frete.proloplast.com.br`).
