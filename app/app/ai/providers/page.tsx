import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { leituraDeMidiaDasSettings } from "@/lib/messaging/media/leitura-da-org";
import { createClient } from "@/lib/supabase/server";

import { InterruptorLeituraDeMidia } from "./_components/InterruptorLeituraDeMidia";
import { PainelDeProvedores } from "./_components/PainelDeProvedores";

export const dynamic = "force-dynamic";

const ERRO_DE_LEITURA =
  "Não consegui ler agora se a IA lê a mídia desta empresa. Enquanto isso, a leitura segue ligada. Recarregue a página; se continuar, avise quem cuida da instalação.";

/**
 * Onde o dono do negócio vê e escolhe qual IA atende cada parte do sistema.
 *
 * O sistema chama modelo em 23 lugares. Até esta tela existir, a escolha estava
 * espalhada por três pilhas de código e sete variáveis de ambiente, e não havia
 * lugar nenhum onde a pergunta "quem usa IA aqui, e com qual chave?" tivesse
 * resposta — o que transformava qualquer falha de configuração em falha muda.
 *
 * Os dados vêm do endpoint (`/api/v1/ai/providers`) e não de uma consulta aqui:
 * a mesma resolução de precedência precisa valer para a tela e para o runtime,
 * e duas leituras diferentes da mesma configuração é como se cria a tela que
 * mente.
 *
 * O interruptor da leitura de mídia mora aqui porque é desta tela que saem os
 * pontos que ele governa (transcrição de áudio, visão de imagem). Ele lê com a
 * MESMA régua do worker (`leituraDeMidiaDasSettings`): só um `false` gravado
 * desliga.
 */
export default async function ProvedoresPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  const idioma = user.idioma;

  return (
    <PainelDeProvedores
      antesDosPontos={
        error ? (
          <p role="alert" className="rounded-md border border-destructive/40 p-4 text-sm text-destructive">
            {traduzir(ERRO_DE_LEITURA, idioma)}
          </p>
        ) : (
          <InterruptorLeituraDeMidia
            ligado={leituraDeMidiaDasSettings((data as { settings?: unknown } | null)?.settings)}
            idioma={idioma}
          />
        )
      }
    />
  );
}
