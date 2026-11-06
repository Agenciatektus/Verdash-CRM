/** A leitura de `GET /api/v1/ai/jev` e o hook que a mantém. */
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/hooks/i18n/useT";

import { DadosDoJev } from "./jev-dados";

export type Resposta = { data?: DadosDoJev; error?: { message?: string } };

/**
 * Uma leitura da rota. A recusa dela já vem escrita para leigo; o que o
 * navegador diz numa falha de rede ("Failed to fetch") é inglês e não diz nada,
 * e um corpo sem mensagem (proxy) não tem o que mostrar além do fato.
 */
export async function buscarDadosDoJev(
  t: (texto: string) => string,
): Promise<{ dados: DadosDoJev } | { erro: string }> {
  try {
    const res = await fetch("/api/v1/ai/jev");
    const json = (await res.json().catch(() => null)) as Resposta | null;
    if (res.ok && json?.data) return { dados: json.data };
    return { erro: json?.error?.message ? t(json.error.message) : t("Não consegui carregar o cartão agora.") };
  } catch {
    return { erro: t("Não consegui falar com o servidor. Confira a internet e tente de novo.") };
  }
}

/** Carrega o cartão. Mora no painel porque o cartão do ponto também o lê. */
export function useDadosDoJev() {
  const t = useT();
  const [dados, setDados] = useState<DadosDoJev | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const aplicar = useCallback((r: { dados: DadosDoJev } | { erro: string }) => {
    if ("erro" in r) {
      setErro(r.erro);
      return;
    }
    setErro(null);
    setDados(r.dados);
  }, []);

  const recarregar = useCallback(async () => aplicar(await buscarDadosDoJev(t)), [aplicar, t]);

  useEffect(() => {
    // A primeira leitura resolve DEPOIS do efeito (nada de setState no corpo
    // dele), e a resposta de um cartão já desmontado é descartada.
    let vivo = true;
    void buscarDadosDoJev(t).then((r) => {
      if (vivo) aplicar(r);
    });
    return () => {
      vivo = false;
    };
  }, [aplicar, t]);

  return { dados, erro, recarregar };
}
