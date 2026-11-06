import { Aviso } from "@/components/ui/aviso";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { RegraDeConversaoGoogle } from "@/lib/conversoes/regras-google";
import {
  faltaParaConectarOGoogleAds,
  googleAdsEstaConfigurado,
} from "@/lib/plataformas-de-anuncio/google/config";
import type { EstadoDaConexaoGoogle } from "@/lib/plataformas-de-anuncio/google/estado-da-conexao";

import { FormularioDeConversoesGoogle } from "./_formGoogle";
import { RegrasDeConversaoGoogle, type EtapaAberta } from "./_regrasGoogle";

/** O que a volta do OAuth do Google Ads diz, traduzido — ver o callback. */
const ERRO_DO_GOOGLE_EM_PORTUGUES: Record<string, string> = {
  cancelado: "Você cancelou a autorização no Google. Nada foi conectado.",
  estado_invalido:
    'O link de conexão expirou ou é inválido. Clique em "Conectar com Google" de novo.',
  sem_codigo: "O Google não devolveu o código esperado. Tente de novo.",
  google_ads_nao_configurado:
    "Esta instalação ainda não tem as credenciais do Google Ads configuradas. Fale com quem administra o servidor.",
  troca_falhou: "Não consegui trocar o código pelo token de acesso. Tente conectar de novo.",
  sem_refresh_token:
    "O Google não devolveu a autorização de longa duração esperada. Tente conectar de novo.",
  cifra_indisponivel:
    "Esta instalação está sem a chave mestra de criptografia, e o token não foi gravado. Quem instalou o sistema precisa configurá-la.",
  erro_ao_gravar: "Não consegui gravar a conexão agora. Tente de novo em instantes.",
};

export function AbaGoogle({
  estado,
  idioma,
  erro,
  ok,
  etapasAbertas,
  podeListarEtapas,
  regras,
}: {
  estado: EstadoDaConexaoGoogle;
  idioma: Idioma;
  erro?: string;
  ok?: string;
  etapasAbertas: EtapaAberta[];
  /** A leitura das etapas não falhou. */
  podeListarEtapas: boolean;
  regras: RegraDeConversaoGoogle[] | null;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  return (
    <>
      {erro && (
        <Aviso tom="crit">
          {t(ERRO_DO_GOOGLE_EM_PORTUGUES[erro] ?? "Não consegui conectar com o Google Ads.")}
        </Aviso>
      )}
      {ok && (
        <Aviso tom="ok">
          {t("Google Ads autorizado. Agora informe a conta e a ação de conversão abaixo.")}
        </Aviso>
      )}

      <FormularioDeConversoesGoogle
        estado={estado}
        idioma={idioma}
        configurado={googleAdsEstaConfigurado(estado.api)}
        dataManagerConfigurado={googleAdsEstaConfigurado("data_manager")}
        falta={faltaParaConectarOGoogleAds(estado.api)}
        podeCriarAcao={googleAdsEstaConfigurado("google_ads")}
      />
      {googleAdsEstaConfigurado(estado.api) && podeListarEtapas && regras && (
        <RegrasDeConversaoGoogle
          etapas={etapasAbertas}
          regras={regras}
          idioma={idioma}
          podeCriarAcao={
            googleAdsEstaConfigurado("google_ads") &&
            estado.temRefreshToken &&
            Boolean(estado.customerId)
          }
        />
      )}
    </>
  );
}
