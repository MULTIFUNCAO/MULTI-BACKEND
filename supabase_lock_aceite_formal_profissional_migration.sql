-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Contexto: pedidos.aceite_formal_profissional_em é o momento em que a cota
-- mensal do plano do profissional é consumida (ver
-- POST /api/pedidos/confirmar-servico em server.js). A RLS de "pedidos" é
-- permissiva (using(true)/with check(true) — ver supabase_pedidos_migration.sql),
-- então sem uma trava a mais, o frontend poderia escrever essa coluna direto
-- via chave anon e pular a checagem de plano/valor/cota inteira. Este trigger
-- espelha o mesmo padrão já usado (e comprovado) pra travar
-- doc_*_status em supabase_pendencias_doc_pagamento_migration.sql:
-- só quem escreve como service_role (o backend, com a service key) consegue
-- mudar o valor dessa coluna; qualquer outra sessão que tente tem o valor
-- silenciosamente revertido pro que já estava salvo.
--
-- IMPORTANTE (bug conhecido deste projeto): triggers/policies já reverteram
-- sozinhos depois de confirmados, por Disk IO Budget. Rode o teste de sanidade
-- no fim, espere alguns minutos, e rode de novo antes de considerar concluído.

create or replace function pedidos_lock_aceite_formal_profissional()
returns trigger as $$
begin
  if auth.role() is distinct from 'service_role' then
    if new.aceite_formal_profissional_em is distinct from old.aceite_formal_profissional_em then
      new.aceite_formal_profissional_em := old.aceite_formal_profissional_em;
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_lock_aceite_formal_profissional on pedidos;
create trigger trg_lock_aceite_formal_profissional
  before update on pedidos
  for each row execute function pedidos_lock_aceite_formal_profissional();

-- Confirme que o trigger existe:
select tgname, tgrelid::regclass, tgenabled
from pg_trigger
where tgname = 'trg_lock_aceite_formal_profissional';

-- Teste de sanidade (manual, opcional) — rode como anon/authenticated (não
-- como service_role) contra um pedido de teste e confirme que a coluna NÃO
-- muda:
-- update pedidos set aceite_formal_profissional_em = now() where id = '<id-de-teste>';
-- select aceite_formal_profissional_em from pedidos where id = '<id-de-teste>'; -- deve continuar null/valor anterior
