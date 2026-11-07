"use client";
import { useState } from "react";
import { toast } from "sonner";

import { ParticipantesDoGrupo } from "@/components/inbox/grupo/ParticipantesDoGrupo";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/hooks/i18n/useT";
import { useAcaoDoGrupo, useInfoDoGrupo } from "@/hooks/inbox/useGrupo";
import type { InfoDoGrupo } from "@/lib/grupos/acoes";
import { csvDeParticipantes } from "@/lib/grupos/painel";
import { Configuracoes, Convite, EditarInfo, Foto, type Rodar } from "@/components/inbox/grupo/SecoesDoGrupo";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { useIdioma } from "@/lib/i18n/IdiomaProvider";

type Secao = "info" | "foto" | "config" | "link" | null;
type Confirmacao = { titulo: string; texto: string; rotulo: string; fazer: () => void } | null;

export function PainelDoGrupo({
  aberto, onFechar, channelSessionId, groupChatId, meuTelefone, podeGerir,
}: {
  aberto: boolean;
  onFechar: () => void;
  channelSessionId: string;
  groupChatId: string;
  /** Telefone do número do canal, para marcar "Você" na lista. */
  meuTelefone: string | null;
  /** Gerente+ no CRM: sem isso o servidor recusa as ações de administrador. */
  podeGerir: boolean;
}) {
  const t = useT();
  const idioma = useIdioma();
  const info = useInfoDoGrupo(channelSessionId, groupChatId, aberto);
  const acao = useAcaoDoGrupo(channelSessionId, groupChatId);
  const [secao, setSecao] = useState<Secao>(null);
  const [confirmar, setConfirmar] = useState<Confirmacao>(null);
  const d = info.data;
  const souAdmin = d?.souAdmin ?? null;
  const adminLiberado = podeGerir && souAdmin === true;
  // Quem comprovadamente NÃO é admin (ou não gere no CRM) nem vê o bloco; "não deu para saber" mostra desabilitado.
  const mostrarAdmin = podeGerir && souAdmin !== false;

  // `mutateAsync` rejeita no erro (o toast já saiu no hook); aqui vira `undefined`.
  const rodar: Rodar = async (corpo, ok) => {
    try {
      const r = await acao.mutateAsync(corpo);
      if (ok) toast.success(ok);
      return r ?? true;
    } catch {
      return undefined;
    }
  };
  const botoes = [
    ["info", t("Editar info")], ["foto", t("Foto")], ["config", t("Configurações")], ["link", t("Link de convite")],
  ] as const;

  return (
    <>
      <Dialog open={aberto} onOpenChange={(v) => !v && onFechar()}>
        <DialogContent className="max-w-4xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t("Detalhes do grupo")}</DialogTitle>
          </DialogHeader>
          {info.isLoading && <p className="text-sm text-text-muted">{t("Carregando...")}</p>}
          {info.isError && <p className="text-sm text-error-fg">{t("Não foi possível carregar o grupo. Tente de novo.")}</p>}
          {d && (
            <div className="grid gap-6 md:grid-cols-2">
              <div className="min-w-0 space-y-4">
                <Resumo d={d} jid={groupChatId} tag={tagDeIdioma(idioma)} />
                <Bloco titulo={t("Ações básicas")}>
                  <Button type="button" size="sm" variant="outline" onClick={() => document.getElementById("participantes-do-grupo")?.scrollIntoView?.({ behavior: "smooth" })}>
                    {t("Participantes")}
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => baixarCsv(d, t, groupChatId)}>
                    {t("Baixar CSV")}
                  </Button>
                </Bloco>
                {mostrarAdmin && (
                  <Bloco titulo={t("Ações de administrador")}>
                    {souAdmin === null && <p className="w-full text-xs text-text-muted">{t("Não foi possível confirmar se este número é admin")}</p>}
                    {botoes.map(([s, rotulo]) => (
                      <Button key={s} type="button" size="sm" variant={secao === s ? "secondary" : "outline"} disabled={!adminLiberado} onClick={() => setSecao(secao === s ? null : s)}>
                        {rotulo}
                      </Button>
                    ))}
                  </Bloco>
                )}
                {adminLiberado && secao && (
                  <div className="space-y-3 rounded-xl border border-border p-3" data-testid={`secao-${secao}`}>
                    {secao === "info" && <EditarInfo d={d} ocupado={acao.isPending} rodar={rodar} />}
                    {secao === "foto" && (
                      <Foto ocupado={acao.isPending} rodar={rodar} pedirRemover={() => setConfirmar({
                        titulo: t("Remover a foto do grupo?"), texto: t("O grupo fica sem foto."), rotulo: t("Remover foto"),
                        fazer: () => void rodar({ acao: "remover_foto" }, t("Foto removida.")),
                      })} />
                    )}
                    {secao === "config" && <Configuracoes d={d} ocupado={acao.isPending} rodar={rodar} fechar={() => setSecao(null)} />}
                    {secao === "link" && (
                      <Convite ocupado={acao.isPending} rodar={rodar} pedirRedefinir={(fazer) => setConfirmar({
                        titulo: t("Redefinir o link de convite?"), texto: t("O link atual deixa de funcionar."), rotulo: t("Redefinir"), fazer,
                      })} />
                    )}
                  </div>
                )}
                <Bloco titulo={t("Zona de perigo")}>
                  <Button type="button" size="sm" variant="destructive" disabled={acao.isPending} onClick={() => setConfirmar({
                    titulo: t("Sair do grupo?"),
                    texto: t("Este número deixa o grupo e ele sai da lista de grupos ligados."),
                    rotulo: t("Sair do grupo"),
                    fazer: () => void rodar({ acao: "sair" }, t("Você saiu do grupo.")).then((r) => r !== undefined && onFechar()),
                  })}>
                    {t("Sair do grupo")}
                  </Button>
                </Bloco>
              </div>
              <ParticipantesDoGrupo
                participantes={d.participantes}
                total={d.total}
                meuTelefone={meuTelefone}
                admin={adminLiberado}
                ocupado={acao.isPending}
                onOperar={(operacao, telefones) => {
                  const fazer = () => void rodar({ acao: "participantes", operacao, telefones });
                  if (operacao === "remove") {
                    setConfirmar({ titulo: t("Remover participante?"), texto: t("Ele deixa o grupo."), rotulo: t("Remover"), fazer });
                  } else fazer();
                }}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmar !== null} onOpenChange={(v) => !v && setConfirmar(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmar?.titulo}</AlertDialogTitle>
            <AlertDialogDescription>{confirmar?.texto}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmar?.fazer()}>{confirmar?.rotulo}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function Bloco({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">{titulo}</h3>
      <div className="flex flex-wrap gap-2">{children}</div>
    </section>
  );
}

function Resumo({ d, jid, tag }: { d: InfoDoGrupo; jid: string; tag: string }) {
  const t = useT();
  const tipo = { grupo: t("Grupo"), comunidade: t("Comunidade"), grupo_da_comunidade: t("Grupo da comunidade") }[d.tipo];
  const criado = d.criadoEm && !Number.isNaN(Date.parse(d.criadoEm))
    ? new Date(d.criadoEm).toLocaleDateString(tag, { day: "numeric", month: "long", year: "numeric" })
    : "—";
  const linhas: Array<[string, string]> = [
    [t("Nome"), d.subject ?? "—"], ["JID", jid], [t("Descrição"), d.descricao ?? t("Sem descrição")],
    [t("Membros"), String(d.total)], [t("Criado em"), criado], [t("Tipo"), tipo],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      {linhas.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-text-muted">{k}</dt>
          <dd className="min-w-0 break-words text-text">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function baixarCsv(d: InfoDoGrupo, t: (s: string) => string, jid: string) {
  const csv = csvDeParticipantes(d.participantes, (p) => (p.dono ? "Super Admin" : p.admin ? "Admin" : t("Membro")));
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `participantes-${jid.split("@")[0]}.csv` });
  a.click();
  URL.revokeObjectURL(url);
}
