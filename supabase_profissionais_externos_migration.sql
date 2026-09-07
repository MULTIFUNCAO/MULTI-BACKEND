-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Feature "Match automático de Demanda x Profissional" (MULTI-CRM, 2026-09-06)
-- — sessão separada da Fase 4 (Vendas → Atendimento), sem mexer em nada do
-- que já está em produção lá.
--
-- Contexto: a equipe hoje mantém uma planilha manual de profissionais
-- (nome/telefone/categoria/cidade/estado) fora do MULTI, cruzada à mão com
-- os pedidos de cliente pra decidir quem chamar. Essa tabela existe pra
-- acabar com a planilha, guardando quem NÃO é usuário cadastrado do app —
-- só um contato manual da equipe, sem login, sem aprovação, sem CHECK de
-- categoria_servico_obrigatoria_para_professional (essa regra é só de
-- "usuarios").
--
-- Cruzamento inicial 2026-09-06: das 53 linhas da planilha real, 17 já
-- tinham telefone batendo com "usuarios" (16 profissional + 1 cliente) — não
-- entraram aqui, é a mesma pessoa, só teria duplicado. Só as 29 realmente
-- externas (com nome, telefone válido e pelo menos uma categoria mapeada)
-- foram inseridas nesta rodada — 3 ficaram de fora por dado incompleto
-- (telefone quebrado/sem DDD ou sem nome), aguardando confirmação.
--
-- categoria_servico é text[] (mesmo formato de usuarios.categoria_servico,
-- não o text único de demandas_clientes) porque um contato de planilha
-- costuma acumular mais de uma habilidade (ex.: "eletricista, hidraulica,
-- pintura") — reaproveita a mesma lógica de match por `contains` já usada
-- em /api/admin/demandas/:id/profissionais-sugeridos. IDs batem com a lista
-- canônica em MULTI/src/cats.js (23 grupos/157 profissões) — mapeados à mão
-- a partir do texto livre da planilha, não inventados.
--
-- telefone: só dígitos, sem DDI (mesmo formato de usuarios.whatsapp
-- normalizado, ver normalizarTelefone() em server.js) — pra comparar direto
-- com usuarios por telefone sem reformatar dos dois lados.
--
-- Só o backend (service_role) toca esta tabela — mesmo padrão de RLS
-- deny-all explícito já usado em suporte_tickets/crm_equipe/
-- demandas_clientes (só "enable row level security" sem policy já se
-- mostrou instável nesse projeto — ver supabase_multifuncao_project.md).
-- Script idempotente — seguro rodar de novo.

create table if not exists profissionais_externos (
  id                uuid primary key default gen_random_uuid(),
  criado_em         timestamptz not null default now(),
  nome              text not null,
  telefone          text not null,
  categoria_servico text[] not null default '{}',
  cidade            text,
  estado            text,
  -- 'planilha_manual' nesta rodada — outros valores previstos pra quando a
  -- equipe passar a cadastrar direto pelo CRM em vez de importar planilha.
  origem            text not null default 'planilha_manual',
  observacao        text
);

create index if not exists idx_profissionais_externos_telefone on profissionais_externos (telefone);
create index if not exists idx_profissionais_externos_categoria on profissionais_externos using gin (categoria_servico);

alter table profissionais_externos enable row level security;

drop policy if exists "Negar acesso publico" on profissionais_externos;
create policy "Negar acesso publico" on profissionais_externos for all to anon, authenticated using (false);

notify pgrst, 'reload schema';
