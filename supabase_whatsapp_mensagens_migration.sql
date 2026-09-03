-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Handoff MULTI-CRM 2026-09-03 — segunda metade da Caixa de Entrada (a
-- primeira, "Módulo de Suporte", já foi feita em supabase_suporte_tickets_migration.sql).
-- Provedor escolhido: Z-API (WhatsApp via QR code, sem aprovação da Meta),
-- decisão do usuário pra MVP em fase de validação.
--
-- Guarda TODO o histórico de mensagens (entrada e saída) de um número de
-- WhatsApp conectado via Z-API. Não existe tabela de "conversas" separada
-- de propósito — a lista de conversas na tela é derivada agrupando esta
-- tabela por telefone (poucas mensagens esperadas nessa fase, não precisa
-- de tabela dedicada ainda; se o volume crescer, revisitar).
--
-- Só o backend (service_role) toca esta tabela — mesmo padrão de RLS
-- deny-all explícito já usado em suporte_tickets/crm_equipe/config_monetizacao
-- (só "enable row level security" sem policy já se mostrou instável nesse
-- projeto — ver supabase_multifuncao_project.md). Script idempotente —
-- seguro rodar de novo.

create table if not exists whatsapp_mensagens (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  -- Telefone normalizado (só dígitos, com DDI — formato que a Z-API manda/
  -- espera, ex: "5511999998888"). Chave de agrupamento da "conversa".
  telefone       text not null,
  nome_contato   text,
  direcao        text not null check (direcao in ('entrada','saida')),
  conteudo       text not null,
  -- id da mensagem na Z-API (messageId) — guardado pra dedup e pra casar
  -- com callback de status (entregue/lido) numa fase futura, não usado
  -- ainda no MVP.
  zaapi_message_id text,
  -- Quem mandou pelo CRM (null pra mensagem de entrada, ou pra mensagem de
  -- saída que a pessoa mandou direto pelo celular fora do CRM — a Z-API
  -- também notifica isso via fromMe:true, e a gente grava pra manter o
  -- histórico completo mesmo sem saber quem digitou).
  enviado_por    uuid references crm_equipe(id),
  -- Pra badge de "não lida" na lista de conversas — só relevante pra
  -- direcao='entrada'. Marcado true quando alguém abre a conversa no CRM.
  lida           boolean not null default false
);

create index if not exists whatsapp_mensagens_telefone_idx on whatsapp_mensagens (telefone, created_at desc);
create index if not exists whatsapp_mensagens_nao_lidas_idx on whatsapp_mensagens (telefone) where direcao = 'entrada' and lida = false;

alter table whatsapp_mensagens enable row level security;

drop policy if exists "Negar acesso publico" on whatsapp_mensagens;
create policy "Negar acesso publico" on whatsapp_mensagens for all to anon, authenticated using (false);
