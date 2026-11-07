import { describe, expect, it } from "vitest";

import { ingestVerdashInbound } from "@/lib/channels/verdash/ingest";
import { limparCacheDoNumeroInterno } from "@/lib/escalacao/numero-interno-de-aviso";

/**
 * Canal nativo (Verdash/FZAP): o aviso que OUTRA conexão da própria org manda
 * para esta não vira contato (9231). Sem contato não há conversa, roteador,
 * agente, boas-vindas, follow-up, automação nem lead. É o mesmo corte do
 * `lib/waha/ingest-conexao-da-propria-org.test.ts`, no ingestor que não passa
 * pelo corte do número interno de avisos.
 *
 * CONTROLE: sem a flag, a MESMA mensagem chega ao `fn_upsert_wa_contact`.
 */

const ORG = "org-1";
const NUMERO_DA_CONEXAO_REMETENTE = "+5522981356551";

function bancoDeMentira(flag: boolean) {
  const rpcs: string[] = [];
  const consulta = (lista: unknown[]) => {
    const q: Record<string, unknown> = {
      eq: () => q,
      in: () => q,
      is: () => q,
      not: () => q,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve(ok({ data: lista, error: null })),
    };
    return q;
  };
  const admin = {
    from(tabela: string) {
      if (tabela === "organizations") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { aviso_para_conexao_propria: flag }, error: null }) }),
          }),
        };
      }
      return {
        select: () =>
          consulta(tabela === "channel_sessions" ? [{ phone_number: NUMERO_DA_CONEXAO_REMETENTE }] : []),
      };
    },
    rpc: async (fn: string) => {
      rpcs.push(fn);
      // Para o fluxo logo depois do upsert: o controle só precisa provar que chegou nele.
      return { data: null, error: { message: "parado no teste" } };
    },
  };
  return { admin, rpcs };
}

const AVISO = {
  type: "Message",
  token: "[redacted]",
  event: {
    Info: {
      ID: "3A0000000000AVISO9231",
      Chat: "5522981356551@s.whatsapp.net",
      Sender: "5522981356551@s.whatsapp.net",
      SenderAlt: "",
      RecipientAlt: "",
      IsFromMe: false,
      IsGroup: false,
      PushName: "Tektus Avisos",
      Timestamp: "2026-11-06T10:00:00-03:00",
      Type: "text",
      MediaType: "",
      Category: "",
      AddressingMode: "",
      Edit: "",
    },
    IsEdit: false,
    IsViewOnce: false,
    IsEphemeral: false,
    RawMessage: {},
    Message: { conversation: "Caso #123 aberto. Acompanhe pelo painel." },
  },
};

async function recebe(flag: boolean, payload: unknown = AVISO) {
  limparCacheDoNumeroInterno();
  const { admin, rpcs } = bancoDeMentira(flag);
  const r = await ingestVerdashInbound(admin as never, {
    organizationId: ORG,
    channelSessionId: "sessao-comercial",
    payload,
  });
  return { r, rpcs };
}

describe("canal nativo: aviso vindo de conexão da própria org (9231)", () => {
  it("com a exceção ligada: ignorado antes do contato, com rastro no contador", async () => {
    const { r, rpcs } = await recebe(true);
    expect(r).toEqual({ status: "ignored", reason: "conexao_da_propria_org" });
    expect(rpcs).not.toContain("fn_upsert_wa_contact");
    expect(rpcs).toContain("fn_contar_mensagem_ignorada");
  });

  it("CONTROLE: sem a flag, a MESMA mensagem chega ao upsert do contato", async () => {
    const { rpcs } = await recebe(false);
    expect(rpcs).toContain("fn_upsert_wa_contact");
  });

  it("CONTROLE: com a flag, número de FORA segue o caminho normal", async () => {
    const deFora = {
      ...AVISO,
      event: {
        ...AVISO.event,
        Info: { ...AVISO.event.Info, ID: "3A0000000000CLIENTE", Chat: "5521988887777@s.whatsapp.net", Sender: "5521988887777@s.whatsapp.net" },
      },
    };
    const { rpcs } = await recebe(true, deFora);
    expect(rpcs).toContain("fn_upsert_wa_contact");
    expect(rpcs).not.toContain("fn_contar_mensagem_ignorada");
  });
});
