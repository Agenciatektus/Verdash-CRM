/**
 * O alerta da Meta no "Aviso no WhatsApp" da equipe (o mesmo número, conexão e
 * liga/desliga do aviso de caso, `lib/escalacao/aviso-ao-suporte.ts`).
 *
 * Reusa os guardas e o transporte do aviso de caso (conexão arquivada ou
 * pausada, sem mensagem livre, desconectada, número inválido, pacing/custo).
 * Aqui não há retentativa: o cron é diário e o marco já foi reivindicado, então
 * qualquer recusa vira um motivo no resumo. Nunca lança. Sem configuração ou
 * com o aviso desligado, ignora em silêncio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  CanalDoAviso,
  ConfigDoAviso,
  PacingDoAviso,
  TransporteDoAviso,
} from "@/lib/escalacao/aviso-ao-suporte";

export interface DepsDoWhatsApp {
  carregaConfig(orgId: string): Promise<ConfigDoAviso | null>;
  carregaCanal(orgId: string, canalId: string): Promise<CanalDoAviso | null>;
  /** O destino é número de conexão ativa da própria organização (laço robô com robô). */
  destinoEhDaPropriaOrganizacao(orgId: string, telefone: string): Promise<boolean>;
  transporte: TransporteDoAviso;
  pacing: PacingDoAviso;
  clock: () => Date;
}

export type DesfechoDoWhatsApp = "enviado" | "ignorado" | `falhou:${string}`;

/** Quem envia o texto à equipe da organização. */
export type EnviarWhatsApp = (orgId: string, texto: string) => Promise<DesfechoDoWhatsApp>;

export interface OpcoesDoWhatsApp {
  /** Pula só o guarda de laço robô com robô. O dono pediu: o destino do alerta é o canal Comercial da própria org. */
  permiteDestinoDaPropriaOrganizacao?: boolean;
}

export async function enviarAvisoNoWhatsApp(
  deps: DepsDoWhatsApp,
  orgId: string,
  texto: string,
  opcoes: OpcoesDoWhatsApp = {},
): Promise<DesfechoDoWhatsApp> {
  try {
    const cfg = await deps.carregaConfig(orgId);
    if (!cfg || !cfg.ligado || !cfg.channel_session_id) return "ignorado";
    const canal = await deps.carregaCanal(orgId, cfg.channel_session_id);
    if (!canal || canal.archived_at) return "falhou:canal_arquivado";
    if (canal.desativado) return "falhou:canal_desativado";
    if (!canal.aceitaMensagemLivre) return "falhou:canal_nao_aceita_aviso_livre";
    if (canal.status !== "WORKING") return "falhou:canal_desconectado";
    if (!(await deps.transporte.configurado(orgId, canal))) return "falhou:transporte_ausente";

    const agora = deps.clock();
    const pacing = await deps.pacing.decide(orgId, canal.id, agora);
    if (!pacing.liberado) return `falhou:pacing_${pacing.motivo}`;

    if (
      !opcoes.permiteDestinoDaPropriaOrganizacao &&
      (await deps.destinoEhDaPropriaOrganizacao(orgId, cfg.telefone_destino))
    ) {
      return "falhou:destino_da_propria_organizacao";
    }
    const to = await deps.transporte.resolveDestino(orgId, canal, cfg.telefone_destino);
    if (!to) return "falhou:destino_invalido";

    await deps.transporte.envia(orgId, canal, to, texto);
    // A mensagem já saiu: o ledger é best-effort.
    await deps.pacing.registraEnvio(orgId, canal.id, agora).catch(() => undefined);
    return "enviado";
  } catch {
    return "falhou:erro_no_envio";
  }
}

/** O enviador real, com os imports pesados só na hora de usar (como o handler do aviso de caso). */
export async function criarEnviadorDeWhatsApp(
  admin: SupabaseClient,
  opcoes: OpcoesDoWhatsApp = {},
): Promise<EnviarWhatsApp> {
  const [{ createSupabaseAvisoDb }, { criarTransporteDoAviso }, { criarPacingDoCanal }] = await Promise.all([
    import("@/lib/escalacao/aviso-ao-suporte"),
    import("@/lib/escalacao/aviso-ao-suporte.handler"),
    import("@/lib/agent-engine/pacing/ledger-supabase"),
  ]);
  const db = createSupabaseAvisoDb(admin);
  const transporte = await criarTransporteDoAviso(admin as never);
  const pacing = await criarPacingDoCanal(admin as never);
  return (orgId, texto) =>
    enviarAvisoNoWhatsApp(
      {
        carregaConfig: (o) => db.carregaConfig(o),
        carregaCanal: (o, c) => db.carregaCanal(o, c),
        destinoEhDaPropriaOrganizacao: (o, t) => db.destinoEhDaPropriaOrganizacao(o, t),
        transporte,
        pacing,
        clock: () => new Date(),
      },
      orgId,
      texto,
      opcoes,
    );
}
