/**
 * Convite de time e e-mail de compra confirmada, em PT-BR. Devolve subject/html/text.
 * O visual é o do `montarEmail` (identidade fixa do produto); a marca da
 * instalação (`marcaDaSaida(organizationId)`) entra só nos textos e no assunto.
 */
import { rotuloDoPapel } from "@/lib/auth/types";
import { montarEmail } from "@/lib/email/layout";
import type { MarcaDeSaida } from "@/lib/branding/saida";

/** WhatsApp da Tektus (o mesmo de `site/lib/conteudo.ts`). */
export const WHATSAPP_TEKTUS = "https://wa.me/5521977357727";

export interface InviteEmailOptions {
  inviterName: string;
  orgName: string;
  acceptUrl: string;
  role: string;
  expiresAt: Date;
  /** A marca de quem convidou. Obrigatória: sem ela o e-mail não tem dono. */
  marca: MarcaDeSaida;
  /** "compra" = pós-pagamento da venda direta. Padrão: "equipe". */
  origem?: "equipe" | "compra";
}

export function buildInviteEmail(opts: InviteEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const validade = opts.expiresAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const marca = opts.marca.nome;
  const botaoHref = opts.acceptUrl;

  if (opts.origem === "compra") {
    const subject = `Sua empresa ${opts.orgName} está pronta no ${marca}`;
    const { html, text } = montarEmail({
      assunto: subject,
      eyebrow: "Compra confirmada",
      titulo: "Sua empresa está pronta",
      subtitulo: `Recebemos o pagamento e criamos a conta da ${opts.orgName} com os dados da compra.`,
      paragrafos: [],
      preheader: `A conta da ${opts.orgName} já está criada. Defina sua senha para entrar.`,
      passos: ["Defina sua senha e entre.", "Conecte o WhatsApp e o Instagram.", "Convide a equipe e comece a atender."],
      botao: { rotulo: "Definir senha e entrar", href: botaoHref },
      aviso: `Este link vale até ${validade}. Se você não fez esta compra, é só ignorar este e-mail.`,
      rodape: ["Dúvidas? Fale com a Tektus no WhatsApp."],
      rodapeLink: { rotulo: WHATSAPP_TEKTUS.replace("https://", ""), href: WHATSAPP_TEKTUS },
    });
    return { subject, html, text };
  }

  const subject = `${opts.inviterName} convidou você para a ${opts.orgName} no ${marca}`;
  const { html, text } = montarEmail({
    assunto: subject,
    eyebrow: "Convite",
    titulo: `Você foi convidado para a ${opts.orgName}`,
    paragrafos: [`${opts.inviterName} convidou você como ${rotuloDoPapel(opts.role)} no ${marca}.`],
    botao: { rotulo: "Aceitar convite", href: botaoHref },
    aviso: `Este link vale até ${validade}. Se você não esperava este convite, pode ignorá-lo.`,
  });
  return { subject, html, text };
}
