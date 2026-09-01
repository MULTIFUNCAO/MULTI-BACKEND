-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Admin/CRM Fase 4 (MULTI-CRM, projeto separado — ver memória do projeto):
-- login por pessoa (Thiago administrador, Ana vendedora), substituindo a senha
-- única compartilhada só DENTRO do MULTI-CRM. Não mexe no login do Admin
-- antigo (ADMIN_PASSWORD/ADMIN_TOKEN_SECRET, AdminDashboard.jsx) — continua
-- funcionando exatamente como está, esta tabela é usada só pelas rotas novas
-- em server.js.
--
-- Só o backend (service_role) toca esta tabela — nenhuma tela do app
-- cliente/profissional nem o MULTI-CRM leem direto no Supabase, tudo passa
-- por /api/admin/equipe/*. RLS habilitado COM policy de negação explícita
-- (não só "enable row level security" sozinho — isso já se mostrou instável
-- nesse projeto, revertia sozinho, ver supabase_multifuncao_project.md /
-- supabase_rls_deny_publico_migration.sql, mesmo padrão usado aqui).
-- Script idempotente — seguro rodar de novo.

create table if not exists crm_equipe (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null,
  email       text not null unique,
  senha_hash  text not null,
  role        text not null check (role in ('administrador','gerente','vendedor','atendimento','operacao')),
  ativo       boolean not null default true,
  created_at  timestamptz not null default now()
);

create unique index if not exists crm_equipe_email_idx on crm_equipe (lower(email));

alter table crm_equipe enable row level security;

drop policy if exists "Negar acesso publico" on crm_equipe;
create policy "Negar acesso publico" on crm_equipe for all to anon, authenticated using (false);
