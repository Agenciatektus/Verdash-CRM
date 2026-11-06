/** Funções puras do painel do grupo na inbox (formatação, CSV, entrada de telefones, foto). */
import type { ParticipanteDoGrupo } from "./acoes";

/** +55 21 97735-7727 para número BR; o resto vira `+dígitos`. */
export function formatarTelefone(tel: string | null): string {
  const d = (tel ?? "").replace(/\D/g, "");
  if (!d) return "";
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(d);
  return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : `+${d}`;
}

/** Telefones separados por vírgula, ponto e vírgula ou quebra de linha; só dígitos, sem repetidos. */
export function lerTelefones(texto: string): string[] {
  const tels = texto.split(/[\n,;]+/).map((t) => t.replace(/\D/g, "")).filter(Boolean);
  return [...new Set(tels)];
}

// O nome vem do WhatsApp (o participante escolhe): `=`, `+`, `-`, `@`, tab ou CR no começo viraria fórmula na planilha.
const campoCsv = (bruto: string) => {
  const v = /^[=+\-@\t\r]/.test(bruto) ? `'${bruto}` : bruto;
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

export function csvDeParticipantes(lista: ParticipanteDoGrupo[], papel: (p: ParticipanteDoGrupo) => string): string {
  const linhas = lista.map((p) => [p.telefone ?? "", p.nome ?? "", papel(p)].map(campoCsv).join(","));
  return ["telefone,nome,papel", ...linhas].join("\n");
}

/** Lê a imagem escolhida e devolve um JPEG (data URL) de no máximo `maxLado` px, como o WhatsApp exige. */
export async function imagemParaJpeg(arquivo: File, maxLado = 640): Promise<string> {
  const bmp = await createImageBitmap(arquivo);
  const escala = Math.min(1, maxLado / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * escala);
  canvas.height = Math.round(bmp.height * escala);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas_indisponivel");
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}
