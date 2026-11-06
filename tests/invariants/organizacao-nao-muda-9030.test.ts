import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Migration 9030: a linha não troca de organização (trigger em toda tabela cuja
 * `for all` só exige tenancy) e contato só é escrito por agent+.
 *
 * O furo: quem tinha vínculo em A e em B passava nas duas pontas da `for all`
 * (USING e WITH CHECK) e movia um contato de A para B com um UPDATE direto.
 *
 * Zero PII: e-mails @invariant.test e nomes sintéticos.
 */

const id = (n: number) => `93000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const ORG_A = id(1);
const ORG_B = id(2);
const MIX = id(11); // agent em A + manager em B
const VW_A = id(12);
const AG_A = id(13);
const PA = id(14);
const CT = id(21);
const DEM = id(31);
const AG_AB = id(15); // agent em A e em B
const VW_AB = id(16); // viewer em A e em B
const SA = id(41);
const CONV = id(42);
const MSG = id(43);
const PIPE = id(44);
const STAGE = id(45);
const LEAD = id(46);

const seed = `
begin;
insert into auth.users(id,email) values
 ('${MIX}','o9030-mix@invariant.test'),('${VW_A}','o9030-vw@invariant.test'),
 ('${AG_A}','o9030-ag@invariant.test'),('${PA}','o9030-pa@invariant.test'),
 ('${AG_AB}','o9031-agab@invariant.test'),('${VW_AB}','o9031-vwab@invariant.test');
insert into organizations(id,slug,display_name,legal_name) values
 ('${ORG_A}','o9030-a','O9030 A','O9030 A'),('${ORG_B}','o9030-b','O9030 B','O9030 B');
insert into user_organizations(organization_id,user_id,role,accepted_at) values
 ('${ORG_A}','${MIX}','agent',now()),('${ORG_B}','${MIX}','manager',now()),
 ('${ORG_A}','${VW_A}','viewer',now()),('${ORG_A}','${AG_A}','agent',now()),
 ('${ORG_A}','${AG_AB}','agent',now()),('${ORG_B}','${AG_AB}','agent',now()),
 ('${ORG_A}','${VW_AB}','viewer',now()),('${ORG_B}','${VW_AB}','viewer',now());
insert into platform_admins(user_id,granted_by,scope,mfa_required,reason) values('${PA}','${PA}','full',false,'Local test');
insert into contacts(id,organization_id,display_name) values ('${CT}','${ORG_A}','O9030 Contato');
insert into demandas(id,organization_id,contact_id) values ('${DEM}','${ORG_A}','${CT}');
insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values ('${SA}','${ORG_A}','o9031-a','\\x00'::bytea);
insert into conversations(id,organization_id,contact_id,channel_session_id,status) values ('${CONV}','${ORG_A}','${CT}','${SA}','open');
insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,body)
  values ('${MSG}','${ORG_A}','${CONV}','${SA}','${CT}','text','inbound','o9031 m');
insert into crm_pipelines(id,organization_id,name,slug) values ('${PIPE}','${ORG_A}','O9031','o9031');
insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values ('${STAGE}','${ORG_A}','${PIPE}','Novo','novo',1000);
insert into crm_leads(id,organization_id,pipeline_id,stage_id,title) values ('${LEAD}','${ORG_A}','${PIPE}','${STAGE}','o9031 lead');
`;

const como = (user: string) =>
  `reset role; select set_config('request.jwt.claims', '${JSON.stringify({ sub: user, role: "authenticated", aal: "aal1" })}', true); set local role authenticated;`;

/** Roda o comando num subtransação e devolve `n=<linhas>` ou o SQLSTATE. */
function tenta(prefixo: string, comando: string): string {
  const out = sql(`${seed}
create temp table r9030(v text); grant all on r9030 to authenticated, service_role;
${prefixo}
do $t$ declare n bigint; begin
  begin
    ${comando}
    get diagnostics n = row_count;
    raise exception using errcode = 'P0001', message = 'n=' || n;
  exception when others then
    insert into pg_temp.r9030 values (case when sqlstate = 'P0001' then sqlerrm else sqlstate end);
  end;
end $t$;
reset role;
select 'v=' || v from pg_temp.r9030;
rollback;`);
  const linha = out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("v="));
  return linha?.slice(2) ?? `sem resultado: ${out}`;
}

const MOVE_CONTATO = `update public.contacts set organization_id = '${ORG_B}' where id = '${CT}';`;
const SEM_TRIGGER = ["contacts", "demandas", "conversations", "messages", "crm_leads"]
  .map((t) => `drop trigger trg_organizacao_nao_muda on public.${t};`)
  .join(" ");
const MOVE_CONVERSA = `update public.conversations set organization_id = '${ORG_B}' where id = '${CONV}';`;
const MOVE_MENSAGEM = `update public.messages set organization_id = '${ORG_B}' where id = '${MSG}';`;
const MOVE_LEAD = `update public.crm_leads set organization_id = '${ORG_B}' where id = '${LEAD}';`;

describe("9030: a linha não troca de organização", () => {
  it("quem tem vínculo em A e em B não move o contato de A para B (42501)", () => {
    expect(tenta(como(MIX), MOVE_CONTATO)).toBe("42501");
  });

  it("CONTROLE: sem a trigger o mesmo UPDATE passa (o furo que ela fecha)", () => {
    expect(tenta(`${SEM_TRIGGER}\n${como(MIX)}`, MOVE_CONTATO)).toBe("n=1");
  });

  it("vale para service_role e platform admin, que não dependem da RLS", () => {
    expect(tenta("reset role; set local role service_role;", MOVE_CONTATO)).toBe("42501");
    expect(tenta(como(PA), MOVE_CONTATO)).toBe("42501");
  });

  it("vale nas outras tabelas tenant-only (demandas)", () => {
    const move = `update public.demandas set organization_id = '${ORG_B}' where id = '${DEM}';`;
    expect(tenta(como(MIX), move)).toBe("42501");
    expect(tenta(`${SEM_TRIGGER}\n${como(MIX)}`, move)).toBe("n=1");
  });

  it("fluxo legítimo passa: UPDATE comum e upsert que regrava a MESMA organização", () => {
    expect(tenta(como(AG_A), `update public.contacts set display_name = 'O9030 novo' where id = '${CT}';`)).toBe("n=1");
    expect(
      tenta(
        "reset role; set local role service_role;",
        `insert into public.contacts(id,organization_id,display_name) values ('${CT}','${ORG_A}','O9030 upsert')
           on conflict (id) do update set organization_id = excluded.organization_id, display_name = excluded.display_name;`,
      ),
    ).toBe("n=1");
  });

  it("toda tabela de public com organization_id tem a trigger (9031)", () => {
    // A 9030 cobria só as tabelas cuja for all exigia apenas tenancy; papel nas
    // DUAS organizações também movia linha (P1 do Cassio na #69). A regra agora
    // não depende de policy: tabela nova com organization_id sem a trigger
    // reprova aqui.
    const semTrigger = sql(`
      select coalesce(string_agg(c.relname, ',' order by c.relname), '')
        from pg_class c
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
         and not exists (
           select 1 from pg_trigger t
            where t.tgrelid = c.oid and t.tgname = 'trg_organizacao_nao_muda' and not t.tgisinternal
              -- presente E valendo (9032, P2-1 do Cassio na #71): desabilitada ou
              -- com WHEN não protege nada
              and t.tgenabled in ('O', 'A') and t.tgqual is null
              and t.tgfoid = 'public.fn_organizacao_da_linha_nao_muda()'::regprocedure);`);
    expect(semTrigger).toBe("");
    const comTrigger = sql(`select count(*) from pg_trigger where tgname = 'trg_organizacao_nao_muda' and not tgisinternal;`);
    expect(Number(comTrigger)).toBeGreaterThan(52);
  });

  it("agent de A+B não move a conversa, viewer de A+B não move a mensagem, e o lead não muda de org (42501)", () => {
    expect(tenta(como(AG_AB), MOVE_CONVERSA)).toBe("42501");
    expect(tenta(como(VW_AB), MOVE_MENSAGEM)).toBe("42501");
    expect(tenta(como(MIX), MOVE_LEAD)).toBe("42501");
  });

  it("CONTROLE: sem a trigger a RLS sozinha deixava mover os três", () => {
    expect(tenta(`${SEM_TRIGGER}
${como(AG_AB)}`, MOVE_CONVERSA)).toBe("n=1");
    // Desde o atendimento conjunto (0661, subida 1.95) a restritiva de mensagem também
    // exige a conversa na MESMA org da linha. Ela sai junto, para o controle medir só a
    // policy permissiva de messages, que é o que a trigger protege.
    expect(tenta(`${SEM_TRIGGER} drop policy message_participant_reply_is_not_history_update on public.messages;
${como(VW_AB)}`, MOVE_MENSAGEM)).toBe("n=1");
    expect(tenta(`${SEM_TRIGGER}
${como(MIX)}`, MOVE_LEAD)).toBe("n=1");
  });
});

describe("9030: contato só é escrito por agent+", () => {
  it("viewer não grava contato (42501 no INSERT; UPDATE e DELETE não alcançam linha)", () => {
    expect(
      tenta(como(VW_A), `insert into public.contacts(organization_id,display_name) values ('${ORG_A}','O9030 do viewer');`),
    ).toBe("42501");
    expect(tenta(como(VW_A), `update public.contacts set display_name = 'x' where id = '${CT}';`)).toBe("n=0");
    expect(tenta(como(VW_A), `delete from public.contacts where id = '${CT}';`)).toBe("n=0");
  });

  it("viewer continua LENDO o contato", () => {
    expect(tenta(como(VW_A), `perform 1 from public.contacts where id = '${CT}';`)).toBe("n=1");
  });

  it("agent e platform admin gravam", () => {
    expect(
      tenta(como(AG_A), `insert into public.contacts(organization_id,display_name) values ('${ORG_A}','O9030 do agent');`),
    ).toBe("n=1");
    expect(tenta(como(PA), `update public.contacts set display_name = 'y' where id = '${CT}';`)).toBe("n=1");
  });
});

describe("9031: FK on delete set null continua funcionando", () => {
  it("apagar a organização zera api_audit_log.organization_id (o FK roda dentro de outro gatilho)", () => {
    const out = sql(`${seed}
insert into public.api_audit_log(organization_id, action) values ('${ORG_B}', 'o9031.teste');
delete from public.organizations where id = '${ORG_B}';
select 'nulos=' || count(*) from public.api_audit_log where action = 'o9031.teste' and organization_id is null;
rollback;`);
    expect(out).toContain("nulos=1");
  });

  it("UPDATE direto para NULL continua recusado, até como service_role", () => {
    expect(
      tenta(
        "reset role; set local role service_role;",
        `update public.contacts set organization_id = null where id = '${CT}';`,
      ),
    ).not.toMatch(/^n=/);
    const audit = `insert into public.api_audit_log(organization_id, action) values ('${ORG_A}', 'o9031.direto');`;
    expect(
      tenta(`${audit}\nreset role; set local role service_role;`, `update public.api_audit_log set organization_id = null where action = 'o9031.direto';`),
    ).toBe("42501");
  });
});

describe("9031: a atividade do negócio move o relógio de quem a registrou", () => {
  const ATIVIDADE = `insert into public.crm_lead_activities(organization_id,lead_id,source_module,type,actor_kind)
    values ('${ORG_A}','${LEAD}','crm','note','user');`;
  const relogio = (prefixo: string) => {
    const out = sql(`${seed}
${prefixo}
${como(VW_A)}
${ATIVIDADE}
reset role;
select 'r=' || coalesce(last_activity_at::text, 'nulo') from public.crm_leads where id = '${LEAD}';
rollback;`);
    return out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("r="))?.slice(2);
  };

  it("nota registrada por um viewer carimba last_activity_at do negócio", () => {
    expect(relogio("")).not.toBe("nulo");
  });

  it("CONTROLE: com a função invoker de antes, o relógio não andava (em silêncio)", () => {
    expect(relogio("alter function public.fn_update_last_activity_at() security invoker;")).toBe("nulo");
  });

  it("a função é definer, com search_path fixo e sem EXECUTE para anon/authenticated", () => {
    const out = sql(`
      select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%',
             has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('authenticated', p.oid, 'EXECUTE')
        from pg_proc p where p.oid = 'public.fn_update_last_activity_at()'::regprocedure;`);
    expect(out).toBe("t|t|f|f");
  });
});

describe("9032: a exceção da cascata vale só em api_audit_log", () => {
  // Uma trigger de teste (criada e desfeita na transação) faz, de DENTRO de outro
  // gatilho, o mesmo UPDATE para NULL que um FK `on delete set null` faria.
  const cascata = (alvo: string) => `
create function public.t9032_anula() returns trigger language plpgsql as $f$
begin
  update public.${alvo} set organization_id = null where organization_id = old.organization_id;
  return old;
end $f$;
create trigger t9032_anula after delete on public.demandas for each row execute function public.t9032_anula();`;

  it("em skill_versions (org NULL = catálogo global) a cascata é recusada (42501)", () => {
    expect(
      tenta(
        `${cascata("skill_versions")}
insert into public.skill_versions(organization_id, name, description, body) values ('${ORG_A}', 'o9032', 'd', 'b');`,
        `delete from public.demandas where id = '${DEM}';`,
      ),
    ).toBe("42501");
  });

  it("CONTROLE: a mesma cascata em api_audit_log passa", () => {
    expect(
      tenta(
        `${cascata("api_audit_log")}
insert into public.api_audit_log(organization_id, action) values ('${ORG_A}', 'o9032');`,
        `delete from public.demandas where id = '${DEM}';`,
      ),
    ).toBe("n=1");
  });
});

describe("9032: campanha perde só a referência quando o canal ou o funil some", () => {
  const SB2 = id(51);
  const CAMP = id(52);
  const REC = id(53);
  const campanha = `
insert into public.channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values ('${SB2}','${ORG_A}','o9032-a2','\\x00'::bytea);
insert into public.campaigns(id,organization_id,name,channel_session_id,base_legal,pipeline_id) values ('${CAMP}','${ORG_A}','o9032','${SA}','consent','${PIPE}');
insert into public.campaign_recipients(id,organization_id,campaign_id,contact_id,channel_session_id) values ('${REC}','${ORG_A}','${CAMP}','${CT}','${SB2}');`;

  function depoisDe(apagar: string, leitura: string): string {
    const out = sql(`${seed}
${campanha}
${apagar}
select 'r=' || (${leitura});
rollback;`);
    return out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("r="))?.slice(2) ?? out;
  }

  it("apagar o canal usado pelo destinatário zera só channel_session_id; a org fica", () => {
    expect(
      depoisDe(
        `delete from public.channel_sessions where id = '${SB2}';`,
        `select coalesce(channel_session_id::text,'nulo') || '|' || organization_id from public.campaign_recipients where id = '${REC}'`,
      ),
    ).toBe(`nulo|${ORG_A}`);
  });

  it("apagar o funil da campanha zera só pipeline_id; a org fica", () => {
    expect(
      depoisDe(
        `delete from public.crm_leads where pipeline_id = '${PIPE}'; delete from public.crm_pipelines where id = '${PIPE}';`,
        `select coalesce(pipeline_id::text,'nulo') || '|' || organization_id from public.campaigns where id = '${CAMP}'`,
      ),
    ).toBe(`nulo|${ORG_A}`);
  });

  it("os quatro FKs têm a lista de colunas", () => {
    expect(
      sql(`select count(*) from pg_constraint
            where conname in ('campaign_recipients_channel_org_fk','campaigns_pipeline_org_fk','campaigns_stage_org_fk','campaigns_agent_org_fk')
              and cardinality(confdelsetcols) = 1;`),
    ).toBe("4");
  });
});

describe("9032: o relógio da atividade nunca vai para o futuro", () => {
  it("performed_at daqui a 10 dias carimba no máximo agora", () => {
    const out = sql(`${seed}
insert into public.crm_lead_activities(organization_id,lead_id,source_module,type,actor_kind,performed_at)
  values ('${ORG_A}','${LEAD}','crm','note','user', now() + interval '10 days');
select 'r=' || (last_activity_at <= now())::text from public.crm_leads where id = '${LEAD}';
rollback;`);
    expect(out).toContain("r=true");
  });
});
