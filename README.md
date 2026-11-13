# Gestão de Frete – Proloplast

Calculadora de frete fracionado com origem em Nova Santa Rita/RS. Compara as tabelas das transportadoras e lista os valores do menor para o maior, com o prazo de entrega.

Site estático: não tem servidor nem banco de dados. Todo o cálculo roda no navegador, a partir dos arquivos JSON da pasta `dados/`.

## Estrutura

```
wrangler.jsonc                            configuração do Cloudflare Workers (site + API + banco)
package.json                              dependências do servidor (driver PostgreSQL "pg")
src/index.js                              servidor: API do histórico de cotações e do Bling (/api/*)
src/bling.js                              integração com o Bling (OAuth, tokens, chamadas à API)
src/sync.js                               importação do Bling (pedidos, propostas, NF-e, produtos e kits)
src/braspress.js                          cotação online da Braspress (API)
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

## Braspress: cotação online (API)

A Braspress é sempre cotada online pela API (`POST https://api.braspress.com/v1/cotacao/calcular/json`, autenticação Basic). O valor online substitui o da tabela no ranking; a tabela só é usada quando a API não responde ou dá erro (a linha mostra "cotação online indisponível"). A cotação salva registra os dois valores (`valor_online`, `valor_tabela`, `fonte_valor`, `cotacao_online`, `erro_online` em `resultados`), e a Análise de divergências compara online × tabela por UF e por praça.

- **Credenciais:** secret `BRASPRESS_CONTAS` no Cloudflare (tipo Secret), JSON com uma conta por CNPJ: `[{"cnpj":"…","usuario":"…_PRD","senha":"…"}]`. Campos opcionais: `"cepOrigem"` e `"nome"`. Sem `cepOrigem`, o CEP vem do cadastro do CNPJ (BrasilAPI), guardado em `braspress_contas`.
- **Remetente:** a calculadora mostra a lista de CNPJs. O padrão é `BRASPRESS_CNPJ_PADRAO` (variável opcional), ou o CNPJ de Nova Santa Rita, ou o primeiro.
- **Requisição:** CIF (`tipoFrete` 1), rodoviário, CEP de destino, valor da NF, peso, volumes e dimensões (ou um cubo equivalente ao m³). Destinatário: CPF/CNPJ do pedido do Bling ou digitado; sem ele, vai um CPF genérico não cadastrado e a Braspress cota só pelo CEP.
- **Cache e registro:** a cotação vale até 23:59 do dia; a mesma consulta no mesmo dia não chama a Braspress de novo. Todas as consultas (inclusive erros) ficam em `braspress_cotacoes`.
- **API interna:** `GET /api/braspress/status` · `POST /api/braspress/cotar`.
- **Testes:** `node tests/braspress.test.mjs` (Braspress simulada, PostgreSQL local).

## Valores cotados manualmente (divergências)

Quando a transportadora informa um valor diferente do calculado (site, e-mail, telefone, CT-e), o valor é registrado para análise posterior.

- **Onde registrar:** no painel "Salvar cotação" (gravado junto com a cotação) ou depois, no detalhe da cotação no Histórico. Dá para registrar mais de uma transportadora por cotação, inclusive uma que o sistema não cotou.
- **Campos:** transportadora, valor informado, prazo, referência (nº da cotação, CT-e), motivo provável e observação. O valor calculado pelo sistema naquela cotação fica gravado junto, para a diferença não mudar quando as tabelas forem atualizadas.
- **Motivos:** Não identificado; Tabela desatualizada / reajuste; Taxa não prevista (TDE, TDA, agendamento…); Praça ou cidade diferente; ICMS; Peso ou cubagem diferente; Valor da NF diferente; Desconto ou negociação; Outro.
- **Análise:** Histórico → "Análise de divergências". Mostra a diferença média (R$ e %), a menor e a maior, e quantas vezes ficou acima ou abaixo, por transportadora, por motivo, por transportadora e UF e por transportadora e faixa de peso, além da lista de casos. "Baixar planilha (CSV)" exporta os casos com o contexto da cotação (praça, peso, NF, ICMS).
- **Tabela:** `cotacao_valores_manuais` (cotacao_id, transportadora, valor_calculado, valor_manual, prazo_manual, referencia, motivo, observacao, usuario, criado_em).
- **API:** `POST /api/cotacoes` aceita `valores_manuais: [...]`; `POST /api/cotacoes/{id}/manual`; `PATCH|DELETE /api/manuais/{id}`; `GET /api/cotacoes?manual=1`; `GET /api/divergencias?de=&ate=&transportadora=`.

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

## Dados importados do Bling (aba "Bling")

A aba tem quatro listas: **Pedidos, Propostas, Notas fiscais e Produtos**. Clicar numa linha mostra os itens com o peso de cada um e, nos kits, os componentes.

- **Importação automática a cada 5 minutos** (`triggers.crons` no `wrangler.jsonc`, código em `src/sync.js`). Cada recurso guarda o próprio estado em `bling_sync_recurso`.
  - Pedidos de venda (todos os canais, inclusive Mercado Livre), propostas comerciais e NF-e: últimos 30 dias. Depois, só os alterados.
  - NF-e: só notas de saída (`tipo=1`), sem o XML.
  - Produtos: o cadastro inteiro na primeira vez, depois os alterados. Produtos usados em pedidos, propostas, notas ou kits e ainda não importados são buscados primeiro.
  - Cada execução faz no máximo 40 chamadas ao Bling, divididas entre os recursos, e o que sobrar fica para a execução seguinte. A carga inicial leva algumas execuções.
  - Documentos sem mudança (assinatura: situação, valor, data de alteração) não são relidos. Se o Bling recusar um filtro de data (HTTP 400), a importação usa um filtro mais simples.
- **Canal do pedido** (`pedidos_bling.canal`), pelo CNPJ do intermediador: Mercado Livre (03.007.331/0001-41), Shopee, Amazon, Magazine Luiza. Outro intermediador vira "Marketplace"; pedido com loja e sem intermediador, "Loja virtual"; o resto, "Venda direta". Também são gravados o nº do pedido na loja, o custo de frete do marketplace e o ID da NF ligada ao pedido.
- **Peso pelos itens:** a view `produtos_peso` usa o peso bruto do produto e, quando ele é zero, a soma dos componentes do kit (peso × quantidade). As listas mostram o peso do documento e o peso calculado pelos itens. O botão "Cotar" usa o peso do pedido e, se estiver zerado (comum no Mercado Livre), o peso pelos itens.
- **Tabelas:**
  - `pedidos_bling`, `propostas_bling`, `notas_bling`, `produtos_bling`: campos principais e a resposta completa do Bling (`dados`, JSONB).
  - `pedido_itens`, `proposta_itens`, `nota_itens`: itens de cada documento.
  - `produtos_estrutura`: componentes dos kits (produto, componente, quantidade). É a base da análise de custo por item do kit.
  - `bling_situacoes`: nomes das situações.
- **Cotação ligada:** a cotação salva a partir de um pedido grava `bling_pedido_id`; a partir de uma proposta, `bling_proposta_id`.
- **Permissões do aplicativo no Bling:** Pedidos de Venda, Propostas Comerciais, Notas Fiscais (NF-e), Produtos, Contatos e Situações. Depois de mudar as permissões, use "Reconectar ao Bling".
- **API:**
  - `GET /api/bling/pedidos?busca=&filtro=&canal=&limite=` (canal: `direta`, `marketplace` ou o nome, ex. `Mercado Livre`)
  - `GET /api/bling/propostas?busca=&filtro=sem_cotacao`
  - `GET /api/bling/notas?busca=&filtro=autorizadas|sem_pedido`
  - `GET /api/bling/produtos?busca=&filtro=kits|sem_peso`
  - `GET /api/bling/itens?tipo=pedido|proposta|nota|produto&id=`
  - `POST /api/bling/sincronizar`
- **Testes:**
  - `npm test`: lógica do Bling.
  - `npm run test:sync`: importação dos quatro recursos e API contra um PostgreSQL local, via `psql` (`tests/pgpsql.mjs`, com um módulo `pg` de teste que repassa as consultas a ele).

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
