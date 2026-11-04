/**
 * GET/POST /api/v1/cron/ia-plataforma-alerta — alerta no WhatsApp do dono da instalação quando o
 * gasto do dia ou o saldo da chave de IA da plataforma (OpenRouter) passa de um nível. A regra mora em
 * `lib/ai/plataforma/alerta-de-saldo.ts`. Só audita quando enviou (cron-audita-so-quando-ha-efeito).
 */
import { NextResponse, type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { rodadaDoAlertaDaPlataforma } from "@/lib/ai/plataforma/alerta-de-saldo";
import { criarEnviadorDeWhatsApp } from "@/lib/plataformas-de-anuncio/meta/alerta/whatsapp";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function executar(req: NextRequest): Promise<Response> {
  if (!autorizaCron(req)) {
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "cron secret inválido" } },
      { status: 401 },
    );
  }
  const admin = createAdminClient();
  const resumo = await rodadaDoAlertaDaPlataforma({
    db: getRequestPool(),
    enviar: async (org, texto) => (await criarEnviadorDeWhatsApp(admin))(org, texto),
    orgDoAviso: (process.env.AI_PLATAFORMA_ALERTA_ORG_ID ?? "").trim(),
    apiKey: (process.env.OPENROUTER_API_KEY ?? "").trim(),
    agora: new Date(),
  });
  if (resumo.enviados > 0) {
    await audit({ action: "ia.plataforma.alerta_enviado", metadata: { ...resumo } });
  }
  return NextResponse.json({ data: resumo });
}

export const GET = executar;
export const POST = executar;
