-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Fase 1 da monetização por moedas ("Multi Moeda"): fundação da carteira —
-- saldo, pacotes de compra (admin-configuráveis) e o ledger de transações.
-- Ainda NÃO mexe em propostas/confirmar-servico (isso é Fase 3, o gate de
-- aceite) — aqui só existe a capacidade de comprar e ver saldo, ninguém gasta
-- moeda nenhuma ainda.
--
-- IMPORTANTE (bug conhecido deste projeto Supabase): DDL/UPDATE já reverteram
-- sozinhos depois de "confirmados" (Disk IO Budget). Rode o teste de sanidade
-- no fim, espere alguns minutos, e rode de novo (reler com a chave anon)
-- antes de considerar concluído.

-- ─── 1. Saldo do usuário ──────────────────────────────────────────────────
alter table usuarios add column if not exists saldo_moedas integer not null default 0;

-- Trava saldo_moedas contra escrita direta via chave anon — mesmo padrão já
-- usado (e comprovado) pra pedidos.aceite_formal_profissional_em, ver
-- supabase_lock_aceite_formal_profissional_migration.sql. Só service_role
-- (o backend) consegue mudar o valor; qualquer outra sessão que tente tem o
-- valor silenciosamente revertido pro que já estava salvo. A única forma de
-- saldo_moedas subir de verdade é via creditar_moedas() abaixo.
create or replace function usuarios_lock_saldo_moedas()
returns trigger as $$
begin
  if auth.role() is distinct from 'service_role' then
    if new.saldo_moedas is distinct from old.saldo_moedas then
      new.saldo_moedas := old.saldo_moedas;
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_lock_saldo_moedas on usuarios;
create trigger trg_lock_saldo_moedas
  before update on usuarios
  for each row execute function usuarios_lock_saldo_moedas();

-- ─── 2. Pacotes de moeda (config admin-editável) ──────────────────────────
-- Mesmo padrão de "configuracoes_planos": edição direta na tabela pelo
-- admin (sem UI dedicada ainda), lido pelo backend com cache curto e pelo
-- front pra listar as opções de compra. "sem necessidade de alterar código".
create table if not exists moedas_pacotes (
  id              uuid primary key default gen_random_uuid(),
  nome            text not null,
  quantidade      integer not null check (quantidade > 0),
  preco_centavos  integer not null check (preco_centavos > 0),
  ativo           boolean not null default true,
  ordem           integer not null default 0,
  created_at      timestamptz not null default now()
);

insert into moedas_pacotes (nome, quantidade, preco_centavos, ordem)
select v.nome, v.quantidade, v.preco_centavos, v.ordem
from (values
  ('10 moedas',  10,  2500,  1),
  ('25 moedas',  25,  5990,  2),
  ('50 moedas',  50,  10990, 3),
  ('100 moedas', 100, 19990, 4)
) as v(nome, quantidade, preco_centavos, ordem)
where not exists (select 1 from moedas_pacotes);

alter table moedas_pacotes enable row level security;

drop policy if exists "Leitura publica de pacotes de moeda" on moedas_pacotes;
create policy "Leitura publica de pacotes de moeda"
  on moedas_pacotes
  for select
  to anon, authenticated
  using (true);
-- Sem policy de insert/update/delete pra anon/authenticated de propósito —
-- edição só pelo admin, direto na tabela (conexão com privilégio de owner,
-- que ignora RLS), nunca pelo app.

-- ─── 3. Ledger de transações de moeda ──────────────────────────────────────
-- Nunca editável pelo client (nem leitura) — só o backend (service_role) e a
-- função creditar_moedas() abaixo tocam aqui. Se um "ver extrato" precisar
-- existir no front, isso vira um endpoint no backend, não uma leitura direta
-- do client.
create table if not exists moedas_transacoes (
  id             uuid primary key default gen_random_uuid(),
  usuario_email  text not null,
  tipo           text not null check (tipo in ('compra','debito_oportunidade','credito_admin','estorno')),
  quantidade     integer not null, -- assinado: positivo = crédito, negativo = débito
  saldo_apos     integer not null,
  payment_id     text, -- id do pagamento na Asaas, quando tipo='compra'
  pedido_id      uuid references pedidos(id), -- nullable; usado só a partir da Fase 3 (débito por oportunidade)
  descricao      text,
  criado_em      timestamptz not null default now()
);

create index if not exists moedas_transacoes_usuario_email_idx on moedas_transacoes (usuario_email);

-- Idempotência: uma mesma cobrança Asaas nunca credita duas vezes, mesmo se
-- /api/moedas/confirmar-pix (polling do client) e o webhook chegarem quase
-- juntos pro mesmo paymentId.
create unique index if not exists moedas_transacoes_payment_id_compra_key
  on moedas_transacoes (payment_id) where tipo = 'compra';

alter table moedas_transacoes enable row level security;
-- Nenhuma policy pra anon/authenticated (nem select) — RLS habilitada sem
-- policy = acesso negado por padrão pra essas roles. service_role sempre
-- ignora RLS.

-- ─── 4. Função que credita moeda (única forma de saldo subir) ────────────
-- security definer + search_path fixo (evita hijack de search_path). Trava a
-- linha do usuário com "for update" antes de checar idempotência — serializa
-- créditos concorrentes pro mesmo usuário, então o check-then-insert de
-- idempotência não corre risco de corrida entre duas chamadas pro mesmo
-- email. O índice único acima é o backstop se isso um dia não valer.
create or replace function creditar_moedas(
  p_email       text,
  p_quantidade  int,
  p_payment_id  text default null,
  p_tipo        text default 'compra',
  p_descricao   text default null
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_saldo int;
begin
  if p_quantidade <= 0 then
    raise exception 'quantidade_invalida';
  end if;

  select saldo_moedas into v_saldo from usuarios where email = p_email for update;
  if not found then
    raise exception 'usuario_nao_encontrado';
  end if;

  if p_payment_id is not null and exists (
    select 1 from moedas_transacoes where payment_id = p_payment_id and tipo = p_tipo
  ) then
    return v_saldo; -- já creditado antes, não duplica
  end if;

  v_saldo := v_saldo + p_quantidade;
  update usuarios set saldo_moedas = v_saldo where email = p_email;
  insert into moedas_transacoes (usuario_email, tipo, quantidade, saldo_apos, payment_id, descricao)
  values (p_email, p_tipo, p_quantidade, v_saldo, p_payment_id, p_descricao);

  return v_saldo;
end;
$$;

-- Só o backend (service_role) pode chamar — sem isso, sendo security
-- definer, qualquer client com a chave anon poderia se autocreditar moeda de
-- graça via supabase.rpc('creditar_moedas', ...), ignorando pagamento e RLS.
revoke execute on function creditar_moedas(text, int, text, text, text) from public;
revoke execute on function creditar_moedas(text, int, text, text, text) from anon, authenticated;
grant execute on function creditar_moedas(text, int, text, text, text) to service_role;

-- ─── Confirme que tudo existe ──────────────────────────────────────────────
select column_name from information_schema.columns where table_name = 'usuarios' and column_name = 'saldo_moedas';
select tgname from pg_trigger where tgname = 'trg_lock_saldo_moedas';
select * from moedas_pacotes order by ordem;
select proname from pg_proc where proname = 'creditar_moedas';

-- Teste de sanidade (manual, opcional) — rode como anon/authenticated (não
-- como service_role) contra um usuário de teste e confirme que NÃO muda:
-- update usuarios set saldo_moedas = 999 where email = '<email-de-teste>';
-- select saldo_moedas from usuarios where email = '<email-de-teste>'; -- deve continuar 0
