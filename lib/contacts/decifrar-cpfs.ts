/**
 * CPF em claro para o export de contatos, em BLOCOS (migration 9086).
 *
 * Antes era uma `decrypt_cpf` por contato, em série: até 10 mil idas ao banco
 * e 10 mil linhas de audit num export cheio. A `decrypt_cpf_lote` valida org +
 * papel (manager+) por dentro e grava uma linha de audit por organização do
 * bloco. Falha de um bloco degrada para coluna VAZIA naquele bloco, como antes:
 * CPF que não sai não pode derrubar o arquivo inteiro.
 */

/** Cabe folgado no teto de 1000 ids da função e na URL/corpo do PostgREST. */
export const TAMANHO_DO_BLOCO_DE_CPF = 500;

interface ClienteComRpc {
  rpc(
    fn: "decrypt_cpf_lote",
    args: { p_contact_ids: string[] },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export async function decifraCpfsEmLote(
  supabase: ClienteComRpc,
  contatos: readonly { id: string; cpf_hash?: string | null }[],
): Promise<Map<string, string>> {
  const cpfs = new Map<string, string>();
  const ids = contatos.filter((c) => c.cpf_hash).map((c) => c.id);

  for (let i = 0; i < ids.length; i += TAMANHO_DO_BLOCO_DE_CPF) {
    const bloco = ids.slice(i, i + TAMANHO_DO_BLOCO_DE_CPF);
    const { data, error } = await supabase.rpc("decrypt_cpf_lote", { p_contact_ids: bloco });
    if (error) {
      console.warn("[contacts.export] decrypt_cpf_lote RPC indisponível", error.message);
      continue;
    }
    for (const linha of (data ?? []) as { contact_id: string; cpf: string | null }[]) {
      if (typeof linha.cpf === "string" && linha.cpf !== "") cpfs.set(linha.contact_id, linha.cpf);
    }
  }
  return cpfs;
}
