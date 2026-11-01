/**
 * PUBLICAR UMA CADÊNCIA — grafo e condução na MESMA transação.
 *
 * `fn_cadencia_publicar_versao` (migration 9018) chama a publicação de sempre
 * (`fn_publish_followup_flow_version`: versão nova + pointer ativo) e grava na
 * mesma versão o snapshot de quem atende quando o lead responde. Publicar em
 * dois passos deixaria uma janela com a versão no ar sem a condução, e a
 * primeira resposta cairia no atendente mesmo com a IA escolhida.
 *
 * EXECUTE só `service_role`: chamada com o admin client, org sempre explícita.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { FlowGraph } from "@/lib/followup/graph-schema";
import type { PublishFlowResult } from "@/lib/followup/publish";
import type { ConducaoDaCadencia } from "./conducao/settings";
import { rpc } from "@/lib/supabase/rpc";

export async function publicarVersaoDaCadencia(
  admin: SupabaseClient,
  params: {
    orgId: string;
    pointerId: string;
    graph: FlowGraph;
    createdBy: string;
    conducao: ConducaoDaCadencia;
  },
): Promise<PublishFlowResult> {
  const { data, error } = await rpc(admin, "fn_cadencia_publicar_versao", {
    p_org: params.orgId,
    p_pointer: params.pointerId,
    p_graph: params.graph,
    p_created_by: params.createdBy,
    p_conducao: params.conducao,
  });

  if (error) {
    const raw = (error.message ?? "").trim();
    if (raw === "pointer_not_found") return { ok: false, code: "pointer_not_found", message: raw };
    return { ok: false, code: "internal_error", message: raw || "publish_failed" };
  }
  if (typeof data !== "string") {
    return { ok: false, code: "internal_error", message: "no_version_id_returned" };
  }
  return { ok: true, version_id: data };
}
