-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Corrige um bug real achado investigando o caso do Jhonatan (login
-- jhonatanreidosfogoes@gmail.com, conta confirmada e OK, mas "esqueci
-- senha"/"trocar senha" falhando com erro de código): os códigos de 6
-- dígitos de /api/auth/solicitar-codigo e /api/auth/verificar-codigo
-- viviam só em memória do processo Node (`const resetCodes = {}` em
-- server.js) — qualquer restart do backend no Render (deploy, crash, sleep)
-- apagava todos os códigos pendentes na hora, sem aviso nenhum pro
-- usuário. No dia desse achado (2026-08-18) o backend teve 4 deploys
-- seguidos, aumentando bastante a chance de qualquer um pedindo código
-- nesse intervalo cair nesse buraco.
--
-- IMPORTANTE (bug conhecido deste projeto Supabase): DDL já reverteu
-- sozinho depois de "confirmado". Rode o teste de sanidade no fim e
-- reconfira via chave anon antes de considerar concluído.

create table if not exists password_reset_codes (
  email      text primary key,
  code       text not null,
  expires_at timestamptz not null,
  criado_em  timestamptz not null default now()
);

alter table password_reset_codes enable row level security;
-- Sem nenhuma policy pra anon/authenticated (nem select) — RLS habilitada
-- sem policy nega acesso por padrão. Só o backend (service_role) toca
-- aqui, mesmo padrão de moedas_transacoes.

-- ─── Confirme que existe ────────────────────────────────────────────────
select tablename from pg_tables where tablename = 'password_reset_codes';
select relrowsecurity from pg_class where relname = 'password_reset_codes';
