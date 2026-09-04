-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Especificação "Fila de Demandas de Clientes + Triagem do WhatsApp" (2026-09-03).
-- Tabela NOVA e SEPARADA de "demandas_pessoais" (lista pessoal de tarefas da
-- equipe, sem relação com clientes — continua existindo sem mudanças, ver
-- supabase_demandas_pessoais_migration.sql). Esta aqui guarda demandas de
-- CLIENTES reais (pedido de serviço/venda/suporte) triadas manualmente a
-- partir de uma conversa do WhatsApp (whatsapp_mensagens) para uma de três
-- filas — 'demanda' (pedido de serviço, tela "Atendimentos"), 'vendas' ou
-- 'suporte' (ambas reaproveitam a lista de conversas do WhatsApp filtrada).
--
-- Sem tabela de "conversa" formal (mesmo motivo de whatsapp_mensagens não
-- ter uma) — o vínculo com a conversa de origem é feito por telefone_cliente,
-- casando com whatsapp_mensagens.telefone.
--
-- atribuido_para é uma referência solta pra crm_equipe.id (uuid), SEM
-- constraint de foreign key formal — decisão explícita da especificação,
-- não descuido (padrão já usado em boa parte do schema deste projeto pra
-- vínculos que não precisam de integridade referencial rígida).
--
-- Só o backend (service_role) toca esta tabela — mesmo padrão de RLS
-- deny-all explícito já usado em whatsapp_mensagens/suporte_tickets/
-- crm_equipe (só "enable row level security" sem policy já se mostrou
-- instável nesse projeto — ver supabase_multifuncao_project.md). Script
-- idempotente — seguro rodar de novo.

create table if not exists demandas_clientes (
  id                uuid primary key default gen_random_uuid(),
  criado_em         timestamptz not null default now(),
  -- 'whatsapp' | 'site' | 'manual' — de onde a demanda entrou. Só 'whatsapp'
  -- é usado nesta fase (triagem manual de conversa), os outros dois ficam
  -- previstos pro schema não precisar de outra migration quando existirem.
  origem            text not null,
  fila              text not null check (fila in ('demanda', 'vendas', 'suporte')),
  -- Telefone normalizado (só dígitos, com DDI — mesmo formato de
  -- whatsapp_mensagens.telefone) da conversa de origem, quando origem='whatsapp'.
  -- Nullable porque 'site'/'manual' (futuro) não necessariamente têm uma
  -- conversa de WhatsApp por trás.
  telefone_cliente  text,
  nome_cliente      text,
  -- Cidade/bairro informado ou detectado na triagem — texto livre nesta fase
  -- (sem geolocalização/distância, ver Fase 2 do endpoint de matching).
  regiao            text,
  -- Deve bater com os valores usados em usuarios.categoria_servico (mesma
  -- convenção de string, ver supabase_categorias_23_grupos_migration.sql) —
  -- não é enum aqui de propósito, pra não duplicar a lista de categorias em
  -- dois lugares que podem dessincronizar.
  categoria_servico text,
  descricao         text,
  status            text not null default 'aberta'
                       check (status in ('aberta', 'em_andamento', 'resolvida', 'cancelada')),
  atribuido_para    uuid,
  resolvido_em      timestamptz
);

create index if not exists idx_demandas_clientes_fila on demandas_clientes (fila, status);
create index if not exists idx_demandas_clientes_telefone_cliente on demandas_clientes (telefone_cliente);

alter table demandas_clientes enable row level security;

drop policy if exists "Negar acesso publico" on demandas_clientes;
create policy "Negar acesso publico" on demandas_clientes for all to anon, authenticated using (false);

notify pgrst, 'reload schema';
