# Gestão de Frete – Proloplast

Calculadora de frete fracionado com origem em Nova Santa Rita/RS. Compara as tabelas das transportadoras e lista os valores do menor para o maior, com o prazo de entrega.

Site estático: não tem servidor nem banco de dados. Todo o cálculo roda no navegador, a partir dos arquivos JSON da pasta `dados/`.

## Estrutura

```
wrangler.jsonc                            configuração do Cloudflare Workers (publica a pasta public/)
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

## Como atualizar uma tabela

1. A transportadora envia a tabela nova (PDF ou Excel).
2. O arquivo é enviado ao Claude no projeto "Proloplast – Frete".
3. O Claude converte para o JSON da transportadora e gera um **relatório de conferência**: o que mudou, o reajuste médio por praça, os valores fora do padrão e as cotações de referência antes e depois.
4. Depois da aprovação, o Claude envia o arquivo para este repositório, por commit ou pull request.
5. O Cloudflare publica sozinho em cerca de 1 minuto.
6. Se algo der errado, basta reverter o commit no GitHub.

Para incluir uma transportadora nova, crie o JSON em `public/dados/transportadoras/` e acrescente o nome do arquivo em `index.json`.

## Testar localmente

O site carrega os dados com `fetch`, por isso não funciona abrindo o `index.html` direto do disco. Use um servidor local:

```
cd public
python -m http.server 8000
```

Depois abra http://localhost:8000

## Publicação

- Hospedagem: Cloudflare Workers (Static Assets), ligado a este repositório (branch `main`). Build command: vazio. Deploy command: `npx wrangler deploy`. O `wrangler.jsonc` publica a pasta `public/`.
- Acesso: Cloudflare Access, com login por código enviado ao e-mail.
- Domínio: subdomínio do cliente (ex.: `frete.proloplast.com.br`).
