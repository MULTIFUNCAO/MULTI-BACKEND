-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Contexto: "Promoção de Inauguração" (2026-08-26) — profissional NOVO
-- (titular_tipo 'usuario', modelo de comissão, não grandfathered) passa a
-- pagar uma taxa de acesso obrigatória de R$9,90/mês (plano 'acesso'),
-- cobrada no cadastro, antes da aprovação, pelo mesmo motor de assinatura
-- recorrente via Asaas já usado pros planos autonomo/pro/premium — ver
-- PLANOS_ASSINATURA.acesso em server.js. Isso é ADITIVO à constraint que já
-- existe (não mexe nos valores existentes de nenhum dos dois ramos).
--
-- IMPORTANTE (bug conhecido deste projeto): colunas/constraints já
-- reverteram sozinhas depois de aparentar sucesso (ver
-- [[multi_modelo_comissao_pagamento_intermediado]] pro histórico completo —
-- Fase 1 desse mesmo projeto só foi confirmada persistida de verdade depois
-- de múltiplas rodadas com o suporte Supabase). Rode o STEP 0 antes E DEPOIS
-- (esperando alguns minutos) de aplicar o STEP 1 pra confirmar que persistiu
-- — não presuma que "rodou sem erro" = "ficou". Se reverter, NÃO re-rodar
-- cegamente por cima — reabrir o assunto com o suporte Supabase primeiro
-- (thread SU-451248/SU-451781 já tem histórico desse mesmo padrão).

-- STEP 0 — confirme o nome real da constraint antes de aplicar o STEP 1
-- (pode ter mudado desde a última migration desse tipo).
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'assinaturas'::regclass and contype = 'c';

-- STEP 1 — substitua "assinaturas_check" pelo nome real retornado acima,
-- caso seja diferente, antes de rodar.
do $$ begin
  alter table assinaturas drop constraint if exists assinaturas_check;
  alter table assinaturas add constraint assinaturas_check
    check (
      (titular_tipo = 'usuario' and plano in ('autonomo','pro','premium','acesso')) or
      (titular_tipo = 'empresa' and plano in ('empresa','empresa_plus'))
    );
exception when duplicate_object then null; end $$;

-- STEP 2 — reconfirme (rode de novo depois de alguns minutos) que a
-- definição da constraint realmente inclui 'acesso'.
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'assinaturas'::regclass and contype = 'c';

-- STEP 3 (manual, opcional) — teste de sanidade: insira e depois apague uma
-- linha de teste pra confirmar que o banco aceita o novo plano.
-- insert into assinaturas (titular_tipo, titular_email, plano, status)
--   values ('usuario', 'teste-acesso@example.com', 'acesso', 'trial');
-- delete from assinaturas where titular_email = 'teste-acesso@example.com';

-- STEP 4 (opcional, recomendado) — registra os limites do plano 'acesso' em
-- configuracoes_planos (fonte real que server.js/App.jsx leem em runtime via
-- getPlanoLimites()/carregarPlanoLimitesReais() — sem esta linha, os dois
-- caem no fallback hardcoded PLANO_LIMITES_USUARIO.acesso, que já espelha os
-- mesmos valores do Autônomo, então isto aqui é só pra manter a mesma fonte
-- de verdade que os outros planos usam, não é bloqueante). Não sei se
-- "plano" tem unique/PK nessa tabela (criada fora deste repo, sem migration
-- rastreada) — confira antes com um select se já existe linha 'acesso' em
-- vez de assumir "on conflict".
-- select * from configuracoes_planos where plano = 'acesso';
-- insert into configuracoes_planos (plano, max_categorias, max_servicos_mes, valor_max_servico)
--   values ('acesso', 1, 3, 5000);
