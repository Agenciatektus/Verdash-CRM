import { Aviso } from "@/components/ui/aviso";
import type { EstadoDaConexao } from "@/lib/conversoes/estado-da-conexao";
import type { RegraDeConversaoMeta } from "@/lib/conversoes/regras-meta";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

import { FormularioDeConversoes } from "./_form";
import { IdentidadeDaConversao } from "./_identidadeDaMeta";
import type { EtapaAberta } from "./_regrasGoogle";
import { RegrasDeConversaoMeta } from "./_regrasMeta";
import { VendaPeloCanal } from "./_vendaPeloCanal";

export function AbaMeta({
  estado,
  idioma,
  leituraConectada,
  vendaPeloCanal,
  identidade,
  etapasAbertas,
  podeListarEtapas,
  regrasMeta,
}: {
  estado: EstadoDaConexao;
  idioma: Idioma;
  leituraConectada: boolean;
  vendaPeloCanal: boolean;
  identidade: { pageId: string; whatsappBusinessAccountId: string };
  etapasAbertas: EtapaAberta[];
  /** A leitura das etapas não falhou. */
  podeListarEtapas: boolean;
  regrasMeta: RegraDeConversaoMeta[] | null;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  return (
    <>
      {estado.conectada && !estado.habilitada && (
        <Aviso tom="warn">
          {t(
            "O envio está pausado. As vendas continuam sendo registradas aqui, mas não vão para a plataforma enquanto isto estiver desligado.",
          )}
        </Aviso>
      )}

      {estado.testEventCode && (
        <Aviso tom="info">
          {t(
            "Modo de teste ligado: as vendas vão marcadas como teste e não contam para a otimização. Apague o código de teste quando terminar de conferir.",
          )}
        </Aviso>
      )}

      <FormularioDeConversoes estado={estado} idioma={idioma} leituraConectada={leituraConectada} />
      <VendaPeloCanal ligada={vendaPeloCanal} idioma={idioma} />
      {estado.conectada && (
        <IdentidadeDaConversao
          pageId={identidade.pageId}
          whatsappBusinessAccountId={identidade.whatsappBusinessAccountId}
          leituraConectada={leituraConectada}
          idioma={idioma}
        />
      )}
      {(estado.conectada || vendaPeloCanal) && podeListarEtapas && regrasMeta && (
        <RegrasDeConversaoMeta
          etapas={etapasAbertas}
          regras={regrasMeta}
          idioma={idioma}
          conexaoDireta={estado.conectada}
        />
      )}
    </>
  );
}
