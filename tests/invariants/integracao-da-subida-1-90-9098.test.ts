/**
 * 9098 — a subida do upstream 1.90 sem um lado apagar o outro.
 *
 * Cada objeto que as 47 migrations novas do upstream e as nossas 9xxx redefinem
 * tem de terminar com as DUAS marcas: a do upstream e a do fork. Mede-se no
 * catálogo (o que o banco aplicou), não no texto da migration.
 *
 * Previsão escrita antes de rodar (sabotagem): sem a 9098 a cadeia termina com a
 * versão da 0743/0657/0754/0731/0716/0764 (perde a marca do fork) ou com a da
 * 9058/9083/9094 (perde a do upstream), e o `it` do catálogo acusa o objeto; a
 * policy da 0726 não cita `fn_escopo_orgs`; a 9058 reconstrói o kind sem
 * `task_overdue` e a 0693 o motivo sem os três da cadência.
 */
import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

const corpo = (nome: string) =>
  sql(`select string_agg(prosrc, ' ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = '${nome}';`);

const MARCAS: Array<[string, string, string]> = [
  // [função, marca do upstream, marca do fork]
  ["emit_event", "lead.date_field_due", "ad\\_conversion.%"],
  ["fn_lgpd_cascade_redact_contact", "fn_lgpd_rotulo_anonimizado", "instagram_igsid = null"],
  ["fn_attendant_metrics", "median_first_response_seconds", "crm_desfechos_de_negocio"],
  ["fn_enfileirar_midia_vencida", "crm_lead_attachments", "media_thumb_path"],
  ["fn_google_appointment", "service_occurrence_id", "fn_agenda_lotada"],
  ["fn_service_inbound", "service_started_at=m.sent_at", "9094"],
  ["fn_agenda_respeita_capacidade", "service_occurrence_id", "simultaneous_appointments"],
];

describe("9098 — integração da subida 1.90", () => {
  it("catálogo: cada função redefinida pelos dois lados tem as duas marcas", () => {
    const faltando: string[] = [];
    for (const [fn, doUpstream, doFork] of MARCAS) {
      const texto = corpo(fn);
      if (!texto.includes(doUpstream)) faltando.push(`${fn}: sem a marca do upstream (${doUpstream})`);
      if (!texto.includes(doFork)) faltando.push(`${fn}: sem a marca do fork (${doFork})`);
    }
    expect(faltando).toEqual([]);
  });

  it("emit_event mantém o lead.* só de agent+ e a transcrição sai na anonimização", () => {
    expect(corpo("emit_event")).toContain("lead.* exige agent+");
    expect(corpo("fn_lgpd_cascade_redact_contact")).toContain("transcript = null");
  });

  it("fn_attendant_metrics existe numa assinatura só (a de 4 argumentos caiu)", () => {
    expect(sql("select count(*) from pg_proc where proname = 'fn_attendant_metrics';")).toBe("1");
  });

  it("conversations_select é a de conjunto da 9027", () => {
    const qual = sql(
      "select qual from pg_policies where schemaname = 'public' and tablename = 'conversations' and policyname = 'conversations_select';",
    );
    expect(qual).toContain("fn_escopo_orgs");
  });

  it("agenda: sem o índice único do mesmo instante (atendimentos simultâneos)", () => {
    expect(sql("select to_regclass('public.calendar_appointments_sem_duplicata_idx') is null;")).toBe("t");
  });

  it("CHECKs: a união dos dois vocabulários", () => {
    const kind = sql(
      "select pg_get_constraintdef(oid) from pg_constraint where conname = 'agent_inbox_items_kind_check';",
    );
    for (const v of ["task_overdue", "task_due", "canal_pausado", "cobranca"]) expect(kind).toContain(`'${v}'`);
    const motivo = sql(
      "select pg_get_constraintdef(oid) from pg_constraint where conname = 'passagens_de_atendimento_motivo_codigo_check';",
    );
    for (const v of ["verificacao_manual", "cadencia_lead_respondeu", "objetivo_atingido", "cadencia_ia_encerrou"]) {
      expect(motivo).toContain(`'${v}'`);
    }
  });
});
