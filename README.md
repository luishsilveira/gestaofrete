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
src/online.js                             cotação online: integrações ativas, empresa remetente, registro das consultas
src/marketplace.js                        resultado das vendas em marketplace (rateio do líquido por produto)
src/apis/comum.js                         utilidades e o contrato dos conectores
src/apis/braspress.js                     conector Braspress (API própria)
src/apis/ssw.js                           conector SSW (Expresso Leomar e outras transportadoras do sistema SSW)
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

## Cotação online nas transportadoras (APIs)

Para cada transportadora com integração ativa, a calculadora consulta a API e usa o valor online. A tabela só entra quando a API não responde ou dá erro. Cada linha do resultado mostra a etiqueta **online** ou **tabela**. A cotação salva registra os dois valores (`valor_online`, `valor_tabela`, `fonte_valor`, `cotacao_online`, `erro_online` em `resultados`), e a página Divergências compara online × tabela por transportadora, UF e praça.

- **Conectores** (`src/apis/`): cada arquivo exporta `tipo`, `integracoes(env)` (lê as credenciais nos secrets) e `cotar(integracao, pedido)` → `{ total, prazo, id }`. Para incluir um conector novo, crie o arquivo e acrescente-o em `CONECTORES` (`src/online.js`).
  - **Braspress** (`braspress.js`): `POST https://api.braspress.com/v1/cotacao/calcular/json`, Basic auth. Secret `BRASPRESS_CONTAS`: `[{"cnpj":"…","usuario":"…_PRD","senha":"…"}]`, uma conta por CNPJ. Usa a conta do CNPJ remetente. Compara com a tabela `bp`.
  - **SSW** (`ssw.js`): web service SOAP `https://ssw.inf.br/ws/sswCotacao/index.php`, operação `cotar`. Atende qualquer transportadora do sistema SSW (Expresso Leomar e outras). Secret `SSW_TRANSPORTADORAS`: `[{"transportadora":"Expresso Leomar","dominio":"…","login":"…","senha":"…","cnpjPagador":"…"}]`. Opcionais: `id`, `tabela` (id da tabela de frete da mesma transportadora), `senhaPagador`, `mercadoria` (padrão 1), `extras` (outros parâmetros do web service).
- **Pedido enviado:** CEP de origem e CNPJ da empresa remetente, CEP de destino, valor da NF, peso, volumes, dimensões (ou um cubo equivalente ao m³) e o CPF/CNPJ do destinatário (do Bling ou digitado; sem ele, só pelo CEP).
- **Empresa remetente** (menu Configurações): CNPJ e CEP de origem, gravados em `app_config`. Sem configuração: CNPJ de Nova Santa Rita (cadastro em `cnpj_cadastro`, consultado em BrasilAPI, CNPJ.ws ou ReceitaWS) e CEP 92480-000.
- **Integrações** (menu Transportadoras): situação de cada integração, consultas e taxa de sucesso em 30 dias, tempo médio, última consulta, chave "Usar cotação online" e botão "Testar conexão" (São Paulo/SP, 50 kg, NF R$ 1.000).
- **Registro e cache:** todas as consultas, inclusive as que dão erro e os testes, ficam em `api_consultas`, sem senhas. A mesma consulta no mesmo dia vem do registro, sem chamar a transportadora. Tempo limite: 15 s por transportadora; as consultas rodam em paralelo.
- **API interna:** `POST /api/online/cotar` · `GET /api/online/status` · `POST /api/online/ativar` · `POST /api/online/testar` · `GET|POST /api/config`.
- **Testes:** `npm run test:online` (Braspress e SSW simulados, PostgreSQL local).

## Resultado no marketplace (menu Vendas)

Mostra quanto a Proloplast recebe de fato pelos produtos vendidos no Mercado Livre (ou em outro marketplace), a partir dos pedidos importados do Bling.

- **Por pedido:** líquido = valor base do marketplace (`taxas.valorBase`, o que o comprador pagou; sem ele, o total do pedido) − taxa do marketplace (`taxas.taxaComissao`) − custo do frete (`taxas.custoFrete`). Com "Descontar IPI" (padrão), o IPI (`tributacao.totalIPI`) também sai, porque está no total mas é imposto. O resultado é a **mercadoria**.
- **Rateio:** a mercadoria é dividida entre os itens do pedido pelo valor de cada item. Dentro de um kit, os componentes com **valor fixo** (ex.: lacre a R$ 0,18, configurado em "Itens com valor fixo" pelo código do produto ou por parte do nome, que pega todas as variações; `app_config.valores_fixos`) ficam com esse valor; o restante é dividido entre os outros componentes **pelo peso** (peso bruto do cadastro × quantidade). Componente sem peso cadastrado fica fora do rateio (aviso na tela); só quando nenhum tem peso, pela quantidade.
- **Telas:** indicadores do período (vendido, comissão + frete, líquido, mercadoria, peso, recebido por kg); faixa "de cada R$ 100 vendidos"; tabela por produto (componente) com recebido por unidade, por kg e % do preço de cadastro; tabela por anúncio (produto vendido); pedidos com o rateio de cada um; exportação em Excel (abas Pedidos, Rateio por componente e Por produto, gerado no navegador) e CSV.
- **Acesso restrito:** só luish.silveira@gmail.com e proloplasticos@gmail.com veem o menu e a API (os outros recebem 403). Para mudar a lista sem mexer no código, crie a variável `ACESSO_RESULTADO` no Cloudflare com os e-mails separados por vírgula.
- **API:** `GET /api/marketplace?de=&ate=&canal=Mercado Livre|Shopee|…|marketplace&ipi=0|1` · `GET|POST /api/marketplace/fixos`.
- **Testes:** `node tests/marketplace.test.mjs`.

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
