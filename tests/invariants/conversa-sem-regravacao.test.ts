// @vitest-environment node
/**
 * MENSAGEM RECEBIDA NÃO REGRAVA A CONVERSA À TOA (migration 9094).
 *
 * Cada UPDATE em `conversations` vira um evento do Supabase Realtime conferido
 * para cada pessoa conectada. Medido em produção (03/11/2026): ~5 updates por
 * mensagem recebida, Realtime = 60% do tempo do banco no pico. Dois deles não
 * mudavam nada útil:
 *
 *   - `fn_upsert_wa_conversation` fazia `on conflict do update set updated_at`
 *     só para o `returning id` devolver a linha existente;
 *   - `fn_service_inbound`, na conversa não reaberta, regravava a mesma
 *     demanda e o mesmo início de atendimento.
 *
 * A medida é o `xmin` da linha: qualquer UPDATE gera versão nova e troca o
 * `xmin`. O controle positivo (a primeira mensagem, que abre a demanda, TROCA o
 * `xmin`) prova que a medida mede.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG = randomUUID();
const SESS = randomUUID();
const CONTATO = randomUUID();

let regravou: boolean | null = null;
const xmin = (conv: string) => lastLine(sql(`select xmin::text from conversations where id = '${conv}';`));
const upsert = () =>
  lastLine(sql(`select public.fn_upsert_wa_conversation('${ORG}', '${CONTATO}', '${SESS}');`));

/**
 * `semGatilhos`: grava a mensagem com os gatilhos desligados e chama
 * `fn_service_inbound` à parte. Isola a função: o `trg_reply_inbound_revision`
 * também grava a conversa a cada inbound (`reply_context_revision`, mudança
 * real) e esconderia o que este arquivo mede.
 */
function receber(conv: string, semGatilhos = false): string {
  const id = randomUUID();
  sql(`
    ${semGatilhos ? "set session_replication_role = replica;" : ""}
    insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                          type, direction, status, sent_via, body, sent_at)
    values ('${id}', '${ORG}', '${conv}', '${SESS}', '${CONTATO}',
            'text', 'inbound', 'received', 'ai', 'Mensagem de teste', clock_timestamp());
  `);
  if (semGatilhos) {
    const antes = xmin(conv);
    sql(`select public.fn_service_inbound('${id}');`);
    regravou = xmin(conv) !== antes;
  }
  return id;
}

beforeAll(() => {
  sql(`
    insert into organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'sem-regravacao-${ORG.slice(0, 8)}', 'Sem Regravacao LTDA', 'Sem Regravacao');
    insert into channel_sessions (id, organization_id, webhook_secret_encrypted, waha_session_name)
      values ('${SESS}', '${ORG}', '\\x00', 'sem-regravacao-${ORG.slice(0, 8)}');
    insert into contacts (id, organization_id) values ('${CONTATO}', '${ORG}');
  `);
});

describe("fn_upsert_wa_conversation não regrava a conversa existente", () => {
  it("a primeira chamada cria; a repetida devolve o MESMO id sem UPDATE", () => {
    const id = upsert();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const antes = xmin(id);
    expect(upsert()).toBe(id);
    expect(xmin(id)).toBe(antes);
    expect(lastLine(sql(`select count(*) from conversations where organization_id = '${ORG}';`))).toBe("1");
  });
});

describe("fn_service_inbound com a mesma demanda não atualiza a conversa", () => {
  it("2ª mensagem: conversa intacta e a mensagem ganha revisão e demanda", () => {
    const conv = upsert();
    const x0 = xmin(conv);
    receber(conv);
    const x1 = xmin(conv);
    // Controle positivo: abrir a demanda grava a conversa — a medida enxerga UPDATE.
    expect(x1).not.toBe(x0);

    const m2 = receber(conv, true);
    expect(regravou).toBe(false);

    const linha = lastLine(
      sql(`
        select (m.service_revision = c.service_revision)::text || '|' ||
               (m.demanda_id = c.current_demanda_id)::text || '|' ||
               (m.demanda_revision is not null)::text
          from messages m join conversations c on c.id = m.conversation_id
         where m.id = '${m2}';
      `),
    );
    expect(linha).toBe("true|true|true");
  });

  it("controle: com a demanda encerrada, a próxima mensagem GRAVA a conversa (demanda nova)", () => {
    const conv = upsert();
    sql(`update demandas set fechada_em = clock_timestamp(), desfecho = 'resolvida' where id = (select current_demanda_id from conversations where id = '${conv}');`);
    receber(conv, true);
    expect(regravou).toBe(true);
  });
});
