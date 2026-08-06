-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Contexto: os planos pagos de empresa ("Multi Empresa" R$149,90 e "Multi
-- Empresa Plus" R$299,90) deixaram de existir. O profissional (titular_tipo
-- 'usuario') passa a ter 3 níveis: autonomo / pro / premium (novo).
--
-- Esta migração é ADITIVA: só libera 'premium' pro ramo 'usuario'. NÃO mexe
-- no ramo 'empresa' (empresa/empresa_plus continuam válidos na constraint —
-- assinantes legados que já pagavam não são cancelados por aqui, isso é ação
-- manual de ops via Asaas). A UI/backend simplesmente param de oferecer
-- esses planos pra gente nova (ver PLANOS_ASSINATURA em server.js).
--
-- IMPORTANTE (bug conhecido deste projeto): colunas/constraints já reverteram
-- sozinhas depois de confirmadas por Disk IO Budget. Rode o STEP 0 antes E
-- DEPOIS (esperando alguns minutos) de aplicar o STEP 1 pra confirmar que
-- persistiu — não presuma que "rodou sem erro" = "ficou".

-- STEP 0 — confirme o nome real da constraint antes de aplicar o STEP 1.
-- O arquivo supabase_assinaturas_migration.sql tem a constraint sem nome
-- explícito (Postgres teria nomeado algo como "assinaturas_check"), mas o
-- banco em produção pode ter sofrido deriva de schema — confirme aqui.
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'assinaturas'::regclass and contype = 'c';

-- STEP 1 — substitua "assinaturas_check" pelo nome real retornado acima,
-- caso seja diferente, antes de rodar.
do $$ begin
  alter table assinaturas drop constraint if exists assinaturas_check;
  alter table assinaturas add constraint assinaturas_check
    check (
      (titular_tipo = 'usuario' and plano in ('autonomo','pro','premium')) or
      (titular_tipo = 'empresa' and plano in ('empresa','empresa_plus'))
    );
exception when duplicate_object then null; end $$;

-- STEP 2 — reconfirme (rode de novo depois de alguns minutos) que a
-- definição da constraint realmente inclui 'premium'.
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'assinaturas'::regclass and contype = 'c';

-- STEP 3 (manual, opcional) — teste de sanidade: insira e depois apague uma
-- linha de teste pra confirmar que o banco aceita o novo plano.
-- insert into assinaturas (titular_tipo, titular_email, plano, status)
--   values ('usuario', 'teste-premium@example.com', 'premium', 'trial');
-- delete from assinaturas where titular_email = 'teste-premium@example.com';
