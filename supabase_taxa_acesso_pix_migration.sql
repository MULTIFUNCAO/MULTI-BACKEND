-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Contexto: Pix como opção de pagamento pra Taxa de Acesso (plano
-- 'acesso'), ao lado do cartão já existente — ver
-- [[multi_modelo_comissao_pagamento_intermediado]] na memória pro desenho
-- completo. Cartão renova sozinho via assinatura recorrente da Asaas; Pix
-- não tem recorrência automática, então o cron /api/cron/lembretes
-- (server.js) passa a escanear diariamente quem pagou por Pix (identificado
-- por asaas_subscription_id nulo — não precisa de coluna pra guardar o
-- método) e: manda e-mail de lembrete 3 dias antes de proxima_cobranca, e
-- marca status='inadimplente' no dia do vencimento se não renovou.
--
-- Esta migration só adiciona UMA coluna nova: lembrete_pix_enviado_em,
-- timestamp nulo por padrão, pra o cron saber se já mandou o e-mail desse
-- ciclo antes de mandar de novo (mesmo padrão idempotente já usado em
-- pedidos.lembrete_vespera_enviado_em/lembrete_dia_enviado_em/etc.).
--
-- IMPORTANTE (bug conhecido deste projeto): colunas já reverteram sozinhas
-- depois de aparentar sucesso. Rode o STEP 0 antes E DEPOIS (esperando
-- alguns minutos) de aplicar o STEP 1 pra confirmar que persistiu — não
-- presuma que "rodou sem erro" = "ficou".

-- STEP 0 — confirme que a coluna ainda não existe (idempotência manual —
-- "add column if not exists" já cobre isso também, mas útil pra conferir
-- antes/depois sem ambiguidade).
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'assinaturas' and column_name = 'lembrete_pix_enviado_em';

-- STEP 1 — adiciona a coluna.
alter table assinaturas
  add column if not exists lembrete_pix_enviado_em timestamptz;

-- STEP 2 — reconfirme (rode de novo depois de alguns minutos) que a coluna
-- persistiu de verdade.
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'assinaturas' and column_name = 'lembrete_pix_enviado_em';
