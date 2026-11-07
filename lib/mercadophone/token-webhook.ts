import { createHash, timingSafeEqual } from "node:crypto";

const sha = (v: string) => createHash("sha256").update(v).digest();

/** Compara o `mp-auth-code` com o segredo guardado; ausente ou vazio nunca confere. */
export function tokenConfere(recebido: string | null | undefined, segredo: string): boolean {
  if (!recebido || !segredo) return false;
  return timingSafeEqual(sha(recebido), sha(segredo));
}
