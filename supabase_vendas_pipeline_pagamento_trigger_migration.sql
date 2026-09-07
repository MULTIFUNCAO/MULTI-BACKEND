-- Rode este script no SQL Editor do painel do Supabase (Project > SQL Editor > New query).
--
-- Fase 4 do diagnóstico de estrutura do CRM (2026-09-06), "Automação Vendas
-- → Atendimento", item 1 + resposta explícita do usuário à pergunta (b):
-- trigger de banco (não polling, não webhook externo) na mudança de
-- assinaturas.status para 'ativa'.
--
-- A Fase 3 já sincronizava vendas_pipeline.estagio -> 'pagamento_confirmado'
-- de forma PASSIVA (só recalculava quando alguém abria GET
-- /api/admin/vendas-pipeline). Este trigger faz a MESMA verificação de
-- "pago de verdade" (replica statusPagamentoAssinatura() do server.js:
-- asaas_customer_id/cortesia + não vencida) só que PROATIVA, disparando na
-- hora que "assinaturas" muda — o profissional sai do funil ativo de Vendas
-- assim que o pagamento é confirmado, não só na próxima vez que alguém
-- abrir a tela. A sincronização passiva do GET continua existindo como
-- rede de segurança (nunca custa reconferir) — não foi removida.
--
-- Só ATUALIZA (nunca cria) — se não existe lead pra esse e-mail em
-- vendas_pipeline, não é criado um do zero aqui (mesma decisão da Fase 3:
-- vendas_pipeline continua opt-in, só quem a equipe/Triagem colocou lá).
-- Só AVANÇA (nunca reverte sozinho) — "is distinct from" evita update
-- desnecessário se já estiver no estágio certo.
--
-- Script idempotente — seguro rodar de novo (create or replace + drop
-- trigger if exists).

create or replace function sincronizar_vendas_pipeline_pagamento() returns trigger as $$
declare
  vinculo_real boolean;
  pago boolean;
begin
  vinculo_real := (new.asaas_customer_id is not null) or coalesce(new.cortesia, false);
  pago := new.status in ('ativa', 'trial')
          and vinculo_real
          and (new.proxima_cobranca is null or new.proxima_cobranca > now());

  if pago and new.titular_tipo = 'usuario' and new.titular_email is not null then
    update vendas_pipeline
      set estagio = 'pagamento_confirmado', atualizado_em = now()
      where lower(profissional_email) = lower(new.titular_email)
        and estagio is distinct from 'pagamento_confirmado';
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_sincronizar_vendas_pipeline_pagamento on assinaturas;
create trigger trg_sincronizar_vendas_pipeline_pagamento
  after insert or update of status, asaas_customer_id, cortesia, proxima_cobranca on assinaturas
  for each row execute function sincronizar_vendas_pipeline_pagamento();
