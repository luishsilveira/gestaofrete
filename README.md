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
src/acesso.js                             usuários, perfis de acesso, permissões por rota e conferência do login do Cloudflare Access
src/marketplace.js                        resultado das vendas em marketplace (rateio do líquido por produto)
src/credenciais.js                        credenciais das integrações cadastradas na tela (criptografadas)
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

## Usuários e perfis de acesso (menu Configurações)

O Cloudflare Access só confirma o e-mail (código enviado por e-mail). Quem entra e o que vê é decidido pela aplicação:

- **Usuários** (`usuarios`): e-mail (em minúsculas), nome, perfil, ativo/inativo, último acesso. Quem não está cadastrado ou está inativo vê "Acesso não autorizado".
- **Perfis** (`perfis`): criados, alterados e excluídos pelo administrador, com as permissões marcadas. O perfil **Administrador** é fixo: tem sempre todas as permissões (inclusive as criadas depois) e não pode ser excluído. Perfil com usuários não pode ser excluído.
- **Permissões** (catálogo em `src/acesso.js`):
  - Menus: Calcular frete, Bling, Resultado no marketplace, Histórico, Divergências, Tabelas, Integrações, Empresa remetente, Modelo de dados.
  - Ações: salvar cotações, valores manuais, sincronizar/reconectar o Bling, ligar e testar integrações, alterar configurações.
  - Administração: cadastrar usuários e perfis.
- **Servidor:** cada rota da API exige a permissão correspondente (`permissaoDaRota`). O menu e os botões só escondem o que o servidor já bloqueia. Sempre resta pelo menos um administrador ativo.
- **Carga inicial:** perfis Administrador (luish.silveira@gmail.com, proloplasticos@gmail.com) e Comercial (vendasproloplast@gmail.com).
- **Mudanças** valem em até 30 s (cache do usuário por instância; alterações feitas na tela limpam o cache).
- **Cloudflare Access:** a política deve aceitar qualquer e-mail (regra **Everyone**), com login por código. Assim, incluir alguém é só cadastrar na aplicação.
- **Conferência do login:** com a variável `ACCESS_AUD` (Application Audience Tag da aplicação no Access), cada chamada confere o token `Cf-Access-Jwt-Assertion` (assinatura RS256 com as chaves do time, audiência, emissor e validade). `ACCESS_TEAM` é opcional (padrão `odd-salad-41a5.cloudflareaccess.com`). Sem `ACCESS_AUD`, vale o cabeçalho de e-mail.
- **API:** `GET /api/eu` · `GET /api/admin/acesso` · `POST|DELETE /api/admin/usuarios` · `POST /api/admin/perfis` · `DELETE /api/admin/perfis/{id}`.
- **Testes:** `node tests/acesso.test.mjs` e `node tests/jwt.test.mjs`.

## Cotação online nas transportadoras (APIs)

Para cada transportadora com integração ativa, a calculadora consulta a API e usa o valor online. A tabela só entra quando a API não responde ou dá erro. Cada linha do resultado mostra a etiqueta **online** ou **tabela**. A cotação salva registra os dois valores (`valor_online`, `valor_tabela`, `fonte_valor`, `cotacao_online`, `erro_online` em `resultados`), e a página Divergências compara online × tabela por transportadora, UF e praça.

- **Conectores** (`src/apis/`): cada arquivo exporta `tipo`, `integracoes(env)` (lê as credenciais nos secrets) e `cotar(integracao, pedido)` → `{ total, prazo, id }`. Para incluir um conector novo, crie o arquivo e acrescente-o em `CONECTORES` (`src/online.js`).
  - **Braspress** (`braspress.js`): `POST https://api.braspress.com/v1/cotacao/calcular/json`, Basic auth. Secret `BRASPRESS_CONTAS`: `[{"cnpj":"…","usuario":"…_PRD","senha":"…"}]`, uma conta por CNPJ. Usa a conta do CNPJ remetente. Compara com a tabela `bp`.
  - **SSW** (`ssw.js`): web service SOAP `https://ssw.inf.br/ws/sswCotacao/index.php`, operação `cotar`. Atende qualquer transportadora do sistema SSW (Expresso Leomar e outras). Secret `SSW_TRANSPORTADORAS`: `[{"transportadora":"Expresso Leomar","dominio":"…","login":"…","senha":"…","cnpjPagador":"…"}]`. Opcionais: `id`, `tabela` (id da tabela de frete da mesma transportadora), `senhaPagador`, `mercadoria` (padrão 1), `extras` (outros parâmetros do web service).
- **Pedido enviado:** CEP de origem e CNPJ da empresa remetente, CEP de destino, valor da NF, peso, volumes, dimensões (ou um cubo equivalente ao m³) e o CPF/CNPJ do destinatário (do Bling ou digitado; sem ele, só pelo CEP).
- **Credenciais pela tela** (Integrações → "Credenciais das integrações", permissão "Ligar, desligar e testar integrações"): transportadoras SSW (nome, domínio, usuário, senha, CNPJ pagador, tabela para comparar) e contas da Braspress. Ficam em `integracoes_credenciais`, criptografadas com AES-GCM; a chave é derivada (HKDF) do secret `CHAVE_CRIPTOGRAFIA` ou, sem ele, de `BLING_CLIENT_SECRET`. Se essa chave mudar, a tela avisa para cadastrar de novo. A senha nunca volta para a tela; em branco, mantém a gravada. Os secrets antigos (`BRASPRESS_CONTAS`, `SSW_TRANSPORTADORAS`) continuam valendo; quando a mesma entrada existe nos dois, vale a da tela. API: `GET|POST|DELETE /api/online/credenciais`. Teste: `node tests/credenciais.test.mjs`.
- **Empresa remetente** (menu Configurações): CNPJ e CEP de origem, gravados em `app_config`. Sem configuração: CNPJ de Nova Santa Rita (cadastro em `cnpj_cadastro`, consultado em BrasilAPI, CNPJ.ws ou ReceitaWS) e CEP 92480-000.
- **Integrações** (menu Transportadoras): situação de cada integração, consultas e taxa de sucesso em 30 dias, tempo médio, última consulta, chave "Usar cotação online" e botão "Testar conexão" (São Paulo/SP, 50 kg, NF R$ 1.000).
- **Nº da cotação da transportadora:** quando a API devolve o número (Braspress e SSW), ele aparece ao lado da etiqueta "online" na calculadora (visão simplificada e detalhada) e no detalhe da cotação no Histórico (coluna "Origem do valor"), com link "copiar". Fica gravado em `resultados[].cotacao_online` e em `api_consultas`.
- **Registro e cache:** todas as consultas, inclusive as que dão erro e os testes, ficam em `api_consultas`, sem senhas. A mesma consulta no mesmo dia vem do registro, sem chamar a transportadora. Tempo limite: 15 s por transportadora; as consultas rodam em paralelo.
- **API interna:** `POST /api/online/cotar` · `GET /api/online/status` · `POST /api/online/ativar` · `POST /api/online/testar` · `GET|POST /api/config`.
- **Testes:** `npm run test:online` (Braspress e SSW simulados, PostgreSQL local).

## Resultado no marketplace (menu Vendas)

Mostra quanto a Proloplast recebe de fato pelos produtos vendidos no Mercado Livre (ou em outro marketplace), a partir dos pedidos importados do Bling.

- **Por pedido:** líquido = valor base do marketplace (`taxas.valorBase`, o que o comprador pagou; sem ele, o total do pedido) − taxa do marketplace (`taxas.taxaComissao`) − custo do frete (`taxas.custoFrete`). Com "Descontar IPI" (desmarcado por padrão; o usuário marca se quiser), o IPI (`tributacao.totalIPI`) também sai, porque está no total mas é imposto. O resultado é a **mercadoria**.
- **Rateio:** a mercadoria é dividida entre os itens do pedido pelo valor de cada item. Dentro de um kit, os componentes com **valor fixo** (ex.: lacre a R$ 0,18, configurado em "Itens com valor fixo" pelo código do produto ou por parte do nome, que pega todas as variações; `app_config.valores_fixos`) ficam com esse valor; o restante é dividido entre os outros componentes **pelo peso** (peso bruto do cadastro × quantidade). Componente sem peso cadastrado fica fora do rateio (aviso na tela); só quando nenhum tem peso, pela quantidade.
- **Telas:** indicadores do período (vendido, comissão + frete, líquido, mercadoria, peso, recebido por kg); faixa "de cada R$ 100 vendidos"; tabela por produto (componente) com recebido por unidade e por kg (4 casas decimais) e % do preço de cadastro; tabela por anúncio (produto vendido), com a coluna "Lacres (valor fixo)" (qtd × valor fixo), o saldo sem lacres, o peso só dos itens rateados pelo peso e o por kg = saldo ÷ esse peso; pedidos com o rateio de cada um; exportação em Excel (abas Pedidos, Rateio por componente e Por produto, gerado no navegador) e CSV.
- **Acesso:** permissão "Resultado no marketplace" do perfil (ver Usuários e perfis).
- **API:** `GET /api/marketplace?de=&ate=&canal=Mercado Livre|Shopee|…|marketplace&ipi=0|1` · `GET|POST /api/marketplace/fixos`.
- **Testes:** `node tests/marketplace.test.mjs`.

## Regras ajustadas pelas divergências (16/11/2026)

- **Expresso São Miguel:** sem ICMS em entregas dentro do RS (`semIcmsUf: ["RS"]` na tabela). Conferido em Sobradinho, Vacaria, Ipiranga do Sul e Panambi. Para fora do RS o ICMS continua (Cascavel/PR bate).
- **Bento Brasil:** sem pedágio quando vale o frete mínimo (`pedagioNoMinimo: false`). Conferido em Dianópolis/TO e São Miguel do Araguaia/GO.
- **Braspress:** tabela marcada como desatualizada (`tabelaDesatualizada: true`; 34% a 44% abaixo em Naviraí/MS, Belo Horizonte/MG e Nova Olinda do Maranhão/MA). Vale a cotação online. O botão "Salvar cotação" espera a cotação online terminar (até 20 s) antes de gravar.
- **Pendente:** na cotação online da Braspress falta uma taxa fixa de cerca de R$ 6,20 (Itápolis/SP, 36 e 70,8 kg; R$ 7,32 em Heliópolis/BA). Perguntar à Braspress que taxa é e se a API permite incluí-la.

## Valores cotados manualmente (divergências)

Quando a transportadora informa um valor diferente do calculado (site, e-mail, telefone, CT-e), o valor é registrado para análise posterior.

- **Onde registrar:** no painel "Salvar cotação" (gravado junto com a cotação) ou depois, no detalhe da cotação no Histórico. Dá para registrar mais de uma transportadora por cotação, inclusive uma que o sistema não cotou.
- **Campos:** transportadora, valor informado, prazo, referência (nº da cotação, CT-e), motivo provável e observação. O valor calculado pelo sistema naquela cotação fica gravado junto, para a diferença não mudar quando as tabelas forem atualizadas.
- **Motivos:** Não identificado; Tabela desatualizada / reajuste; Taxa não prevista (TDE, TDA, agendamento…); Praça ou cidade diferente; ICMS; Peso ou cubagem diferente; Valor da NF diferente; Desconto ou negociação; Outro.
- **Análise:** Histórico → "Análise de divergências". Mostra a diferença média (R$ e %), a menor e a maior, e quantas vezes ficou acima ou abaixo, por transportadora, por motivo, por transportadora e UF e por transportadora e faixa de peso, além da lista de casos. "Baixar planilha (CSV)" exporta os casos com o contexto da cotação (praça, peso, NF, ICMS).
- **Tabela:** `cotacao_valores_manuais` (cotacao_id, transportadora, valor_calculado, valor_manual, prazo_manual, referencia, motivo, observacao, usuario, criado_em).
- **API:** `POST /api/cotacoes` aceita `valores_manuais: [...]`; `POST /api/cotacoes/{id}/manual`; `PATCH|DELETE /api/manuais/{id}`; `GET /api/cotacoes?manual=1`; `GET /api/divergencias?de=&ate=&transportadora=`.

## Integração com o Bling (leitura; gravação só em propostas comerciais)

**Decisões (18/11/2026):** pedidos de venda e notas fiscais são só de leitura: nada é gravado neles pela API. A única gravação é o **envio da cotação para a proposta comercial** (abaixo), sempre por um usuário, com prévia e confirmação. O vínculo entre cotação e documento existe no banco da aplicação.

### Envio da cotação para a proposta comercial (`src/propostaBling.js`)
- **Onde:** botão "Enviar para a proposta no Bling" depois de salvar uma cotação feita a partir de uma proposta, e no detalhe da cotação no Histórico. Permissão "Enviar cotação para a proposta no Bling" (`acao.bling_proposta`).
- **Prévia:** lê a proposta atual no Bling e mostra antes × depois (valor do frete, transportador, observação interna). Só grava ao confirmar.
- **O que muda na proposta:**
  - `observacaoInterna`: bloco entre `--- Frete cotado (Gestão de Frete) ---` e `--- fim do frete cotado ---` com transportadora, nº da cotação (quando online), valor do frete (custo real) e prazo. O texto que já existia é mantido; num novo envio só o bloco é trocado.
  - `observacoes` (sai na proposta impressa): linha compacta `cotação/valor.prazo`, ex.: `23569/18715.4` = cotação online 23569, custo R$ 187,15 (só os dígitos, sem acréscimo), prazo 4 dias. Sem nº de cotação: `/18715.4`. O resto do campo é mantido; num novo envio a linha enviada antes (guardada em `bling_envios.obs_cliente`) é trocada.
  - `transporte.frete`: valor da transportadora escolhida + acréscimo % do cadastro de transportadoras.
  - transportador (`transporte.contato`): contato do Bling informado no cadastro, quando houver.
- **Como grava:** a API (PUT `/propostas-comerciais/{id}`) exige a proposta inteira; a aplicação lê a atual, troca só esses campos e devolve o resto. Depois lê de novo e confere campo a campo (observações, observação interna, frete, transportador, quantidade de itens); a tela mostra o resultado.
- **Registro:** tabela `bling_envios` (usuário, data, valores, transportador, texto, ok/erro, conferência), inclusive envios recusados.
- **Liga/desliga:** Transportadoras → Cadastro de transportadoras → "Envio de cotações para o Bling": desligado, **modo de teste** (só a proposta de teste; padrão, proposta 159504) ou ligado.
- **Cadastro de transportadoras** (tabela `transportadoras_cadastro`, chave = nome da transportadora como aparece na cotação): acréscimo % no frete da proposta e código do contato transportador no Bling (botão "Buscar no Bling" pesquisa em `/contatos`). Alteração com a permissão de configurações.
- **Escopo no Bling:** Propostas Comerciais com edição. Depois de mudar os escopos do aplicativo, "Reconectar ao Bling".
- API: `GET|POST /api/transportadoras/cadastro` · `GET /api/transportadoras/contatos-bling?q=` · `GET|POST /api/bling/envio-config` · `POST /api/bling/proposta/previa` e `/enviar` (`{cotacao_id}`). Teste: `node tests/proposta.test.mjs`.

1. **Busca:** o usuário digita o nº do pedido. O servidor busca no Bling (API v3) o CEP de entrega (etiqueta de transporte; se faltar, o endereço do cliente), o peso bruto, a quantidade de volumes, o valor dos produtos e o nome do cliente, e preenche a calculadora.
2. **Volta para o Bling:** em pedidos é manual (botão "Copiar valor do frete"); em propostas comerciais, pelo envio descrito acima. O botão "Copiar valor do frete" copia o valor da transportadora escolhida para colar no pedido. A cotação salva guarda o ID do pedido, a transportadora escolhida e o valor.
   - **Vínculo cotação × documento:** a cotação salva depois de buscar um pedido, proposta ou NF fica ligada a esse documento (`bling_pedido_id`, `bling_proposta_id` ou `bling_nota_id`). Entre pedido e NF o vínculo vale para os dois lados (pela `nota_fiscal_id` do pedido), mesmo se a NF for emitida depois da cotação.
   - **Na calculadora:** ao buscar o documento aparecem as cotações já vinculadas a ele; o painel "Salvar cotação" mostra a que documento a cotação vai ficar ligada (link "Não vincular"). Se o nº do pedido do painel for trocado, a cotação não é vinculada.
   - **Nas telas do Bling:** Pedidos, Propostas e Notas fiscais mostram a última cotação vinculada, o nº dela (com "+N" quando há mais de uma) e um link para o Histórico; o detalhe do documento lista todas as cotações vinculadas. Notas fiscais ganharam o botão "Cotar" e o filtro "Sem cotação".
   - **No Histórico:** a lista e o detalhe mostram os documentos ligados (pedido, proposta, NF, inclusive a NF do pedido e o pedido da NF); a busca acha a cotação pelo nº de qualquer um deles.
   - API: `GET /api/bling/pedido` e `GET /api/bling/itens` devolvem `cotacoes`; `GET /api/cotacoes` e `GET /api/cotacoes/{id}` devolvem `documentos`. Teste: `npm run test:sync`.
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
