import { Aviso } from "@/components/ui/aviso";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { CHAVES_DE_UTM, TAMANHO_MAXIMO_DO_CODIGO } from "@/lib/leads/origem-do-site";
import type { listarLinks, metricasLinks } from "@/lib/plataformas-de-anuncio/rastreio/links";
import type { EstadoDaCaptura } from "@/lib/plataformas-de-anuncio/landing-config";

import { FormularioDeCapturaDeUtm } from "./_formCapturaDeUtm";
import { LinksRastreaveis } from "./_linksRastreaveis";
import { ScriptDoSite } from "./_scriptDoSite";

export function AbaSite({
  slug,
  idioma,
  capturaGoogle,
  capturaMeta,
  numerosConectados,
  linkDeExemplo,
  links,
  metricas,
}: {
  slug: string | null;
  idioma: Idioma;
  capturaGoogle: EstadoDaCaptura | null;
  capturaMeta: EstadoDaCaptura | null;
  numerosConectados: string[];
  linkDeExemplo: string;
  /** null = a leitura falhou. */
  links: Awaited<ReturnType<typeof listarLinks>> | null;
  metricas: Awaited<ReturnType<typeof metricasLinks>> | null;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  return (
    <>
      {slug && (
        <FormularioDeCapturaDeUtm
          plataforma="google"
          estado={capturaGoogle}
          idioma={idioma}
          slug={slug}
          numerosConectados={numerosConectados}
        />
      )}

      {/*
        Condição 3 da decisão da #924: "quem opera encontra a explicação de como
        montar o link do WhatsApp com o código".

        Mora nesta tela porque esta é a tela da atribuição — a mesma que já
        responde "a Meta recebeu minhas vendas?". O mecanismo do site não tem
        outra superfície: sem este texto, o contrato do link existiria só no
        código, e quem monta o botão da landing page não teria onde descobrir o
        formato nem os limites.
      */}
      {slug ? (
        <ScriptDoSite slug={slug} google={capturaGoogle} meta={capturaMeta} idioma={idioma} />
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{t("Quem chegou pelo site")}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Quando a pessoa vê a campanha numa página sua e toca num botão que abre o WhatsApp, o link desse botão pode levar a origem junto. O código abaixo vai no texto da mensagem, e a conversa entra no CRM já com a origem do site.",
          )}
        </p>

        <div className="rounded-md border p-4 text-sm">
          <p className="font-medium">{t("Como montar o link do botão")}</p>
          <ol className="mt-2 flex list-decimal flex-col gap-2 pl-5">
            <li>
              {t(
                "Monte o texto que a pessoa vai enviar — uma saudação basta — e termine com o código.",
              )}
            </li>
            <li>
              {t(
                "Troque o número pelo WhatsApp da empresa e o texto pelo seu, mantendo o código no fim:",
              )}
            </li>
          </ol>
          <code className="mt-3 block overflow-x-auto rounded-md bg-muted/50 p-2 text-xs break-all">
            {linkDeExemplo}
          </code>
          {/*
            A LISTA DE CHAVES VEM DO MÓDULO, e não da frase — mesma razão que o
            exemplo logo acima é gerado e não escrito à mão. Enquanto os nomes
            moravam dentro do texto traduzido, acrescentar uma chave exigia
            lembrar de dois arquivos, e esquecer o segundo deixava a tela
            ensinando uma lista incompleta em português e em espanhol.

            O nome entra FORA do `t()` de propósito: `traduzir()` casa a string
            EXATA, e um template literal não casaria chave nenhuma.
          */}
          <p className="mt-3 text-xs text-muted-foreground">
            {t("Este exemplo foi gerado por esta tela. Os campos que o código aceita são:")}{" "}
            {CHAVES_DE_UTM.join(", ")}.
          </p>
        </div>

        {/*
          O endereço de captura é o caminho RECOMENDADO, e o código acima
          continua valendo: quem já montou link com ele não precisa mexer em
          nada. A diferença é quem monta o marcador — lá é a página, aqui é o
          servidor, e por isso só este dispensa script.
        */}
        {slug ? (
          <FormularioDeCapturaDeUtm
            estado={capturaMeta}
            idioma={idioma}
            slug={slug}
            numerosConectados={numerosConectados}
          />
        ) : (
          <Aviso tom="warn">
            {t(
              "Esta organização ainda não tem um apelido de URL, e o endereço de captura precisa de um. Fale com quem administra o servidor.",
            )}
          </Aviso>
        )}

        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-muted-foreground">
          <li>
            {t(
              "O código vale só na primeira mensagem do contato: quem recebe um link encaminhado não ganha a origem de quem encaminhou.",
            )}
          </li>
          <li>
            {t(
              "Ele nunca sobrescreve uma origem já gravada, inclusive a de anúncio: quem chegou do Meta ou do Google antes mantém o anúncio.",
            )}
          </li>
          <li>
            {t(
              "Só campos de campanha viajam no código, e nenhum dado pessoal: nome, telefone, e-mail e documento ficam de fora.",
            )}{" "}
            {t("O código inteiro tem um teto de")} {TAMANHO_MAXIMO_DO_CODIGO} {t("caracteres.")}
          </li>
          <li>
            {t(
              'A origem aparece na ficha do contato e no filtro "Site (landing page)" da lista de contatos.',
            )}
          </li>
        </ul>
      </section>

      {links ? (
        <LinksRastreaveis links={links} metricas={metricas} idioma={idioma} />
      ) : (
        <p role="alert">
          {t("Não foi possível ler os links. Atualize a página para tentar novamente.")}
        </p>
      )}
    </>
  );
}
