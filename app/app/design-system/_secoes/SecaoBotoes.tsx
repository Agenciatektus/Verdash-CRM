"use client";

import { Button, type ButtonProps } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import type { IdDoMapa } from "@/lib/design-system/mapa";
import { Bell, DotsThree, Plus, Trash } from "@/lib/ui/icons";

import { Estados, Exemplo, Secao } from "../_componentes/Secao";
import type { Tema } from "../_componentes/tema";

type Variante = NonNullable<ButtonProps["variant"]>;

const VARIANTES: { variante: Variante; mapa: IdDoMapa }[] = [
  { variante: "primary", mapa: "comp:botao-primario" },
  { variante: "secondary", mapa: "comp:botao-secundario" },
  { variante: "outline", mapa: "comp:botao-secundario" },
  { variante: "ghost", mapa: "comp:botao-secundario" },
  { variante: "destructive", mapa: "comp:botao-perigo" },
  { variante: "link", mapa: "comp:botao-secundario" },
];

function LinhaDaVariante({ variante, mapa, tema }: { variante: Variante; mapa: IdDoMapa; tema: Tema }) {
  const t = useT();
  const rotulo = variante === "destructive" ? t("Excluir") : t("Salvar");
  const Icone = variante === "destructive" ? Trash : Plus;
  return (
    <Exemplo nome={`Button · ${variante}`} mapa={mapa} tema={tema}>
      <Estados
        itens={[
          { rotulo: t("Padrão"), no: <Button variant={variante}>{rotulo}</Button> },
          {
            rotulo: t("Passe o mouse, Tab e clique"),
            no: (
              <Button variant={variante}>
                <Icone aria-hidden />
                {rotulo}
              </Button>
            ),
          },
          { rotulo: t("Desativado"), no: <Button variant={variante} disabled>{rotulo}</Button> },
          {
            rotulo: t("Carregando"),
            no: (
              <Button variant={variante} loading>
                {t("Salvando…")}
              </Button>
            ),
          },
        ]}
      />
    </Exemplo>
  );
}

export function SecaoBotoes({ tema }: { tema: Tema }) {
  const t = useT();
  return (
    <Secao
      id={`botoes-${tema}`}
      titulo={t("Botões")}
      sub
      mapa="ds:botoes"
      tema={tema}
      apoio={t("Hover, foco e clique não podem ser congelados na tela: o segundo exemplo de cada linha é o vivo.")}
    >
      {VARIANTES.map((v) => (
        <LinhaDaVariante key={v.variante} variante={v.variante} mapa={v.mapa} tema={tema} />
      ))}
      <Exemplo nome={t("Tamanhos e botão de ícone")} mapa="comp:botao-icone" tema={tema}>
        <Estados
          itens={[
            { rotulo: "sm", no: <Button size="sm">{t("Salvar")}</Button> },
            { rotulo: "default", no: <Button>{t("Salvar")}</Button> },
            { rotulo: "lg", no: <Button size="lg">{t("Salvar")}</Button> },
            {
              rotulo: "icon · ghost",
              no: (
                <Button size="icon" variant="ghost" aria-label={t("Avisos")}>
                  <Bell aria-hidden />
                </Button>
              ),
            },
            {
              rotulo: "icon · secondary",
              no: (
                <Button size="icon" variant="secondary" aria-label={t("Mais ações")}>
                  <DotsThree aria-hidden />
                </Button>
              ),
            },
          ]}
        />
      </Exemplo>
    </Secao>
  );
}
