"use client";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import type { InfoDoGrupo } from "@/lib/grupos/acoes";
import { copyToClipboard } from "@/lib/clipboard";
import { imagemParaJpeg } from "@/lib/grupos/painel";

const FOTO_ORIGINAL_MAX = 2 * 1024 * 1024;
export type Rodar = (corpo: { acao: string } & Record<string, unknown>, ok?: string) => Promise<unknown>;

export function EditarInfo({ d, ocupado, rodar }: { d: InfoDoGrupo; ocupado: boolean; rodar: Rodar }) {
  const t = useT();
  const [nome, setNome] = useState(d.subject ?? "");
  const [desc, setDesc] = useState(d.descricao ?? "");
  return (
    <>
      <div className="space-y-1">
        <Label htmlFor="grupo-nome">{t("Nome do grupo")}</Label>
        <Input id="grupo-nome" value={nome} maxLength={100} onChange={(e) => setNome(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="grupo-desc">{t("Descrição")}</Label>
        <Textarea id="grupo-desc" value={desc} maxLength={2048} rows={3} onChange={(e) => setDesc(e.target.value)} />
      </div>
      <Button type="button" size="sm" disabled={ocupado || !nome.trim()} onClick={async () => {
        if (nome.trim() !== (d.subject ?? "")) await rodar({ acao: "nome", nome: nome.trim() }, t("Nome atualizado."));
        if (desc !== (d.descricao ?? "")) await rodar({ acao: "descricao", descricao: desc }, t("Descrição atualizada."));
      }}>
        {t("Salvar")}
      </Button>
    </>
  );
}

export function Foto({ ocupado, rodar, pedirRemover }: { ocupado: boolean; rodar: Rodar; pedirRemover: () => void }) {
  const t = useT();
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap gap-2">
      <input ref={ref} type="file" accept="image/*" hidden data-testid="grupo-foto-arquivo" onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (!f) return;
        if (f.size > FOTO_ORIGINAL_MAX) return void toast.error(t("A imagem passa de 2 MB."));
        try {
          await rodar({ acao: "foto", imagem: await imagemParaJpeg(f) }, t("Foto atualizada."));
        } catch {
          toast.error(t("Não foi possível ler essa imagem."));
        }
      }} />
      <Button type="button" size="sm" disabled={ocupado} onClick={() => ref.current?.click()}>{t("Trocar foto")}</Button>
      <Button type="button" size="sm" variant="outline" disabled={ocupado} onClick={pedirRemover}>{t("Remover foto")}</Button>
    </div>
  );
}

export function Configuracoes({ d, ocupado, rodar, fechar }: { d: InfoDoGrupo; ocupado: boolean; rodar: Rodar; fechar: () => void }) {
  const t = useT();
  const [enviam, setEnviam] = useState(d.soAdminsEnviam);
  const [editam, setEditam] = useState(d.soAdminsEditam);
  const [temp, setTemp] = useState<string>(d.mensagensTemporarias);
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="grupo-enviam">{t("Apenas administradores podem enviar mensagens")}</Label>
        <Switch id="grupo-enviam" checked={enviam} onCheckedChange={setEnviam} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="grupo-editam">{t("Somente admins podem editar as informações do grupo")}</Label>
        <Switch id="grupo-editam" checked={editam} onCheckedChange={setEditam} />
      </div>
      <div className="space-y-1">
        <Label>{t("Mensagens temporárias")}</Label>
        <Select value={temp} onValueChange={setTemp}>
          <SelectTrigger aria-label={t("Mensagens temporárias")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="off">{t("Desativado")}</SelectItem>
            <SelectItem value="24h">{t("24 horas")}</SelectItem>
            <SelectItem value="7d">{t("7 dias")}</SelectItem>
            <SelectItem value="90d">{t("90 dias")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={fechar}>{t("Fechar")}</Button>
        <Button type="button" size="sm" disabled={ocupado} onClick={async () => {
          if (enviam !== d.soAdminsEnviam && !(await rodar({ acao: "so_admins_enviam", ligado: enviam }))) return;
          if (editam !== d.soAdminsEditam && !(await rodar({ acao: "so_admins_editam", ligado: editam }))) return;
          if (temp !== d.mensagensTemporarias && !(await rodar({ acao: "mensagens_temporarias", duracao: temp }))) return;
          toast.success(t("Configurações salvas."));
        }}>{t("Salvar")}</Button>
      </div>
    </>
  );
}

export function Convite({ ocupado, rodar, pedirRedefinir }: { ocupado: boolean; rodar: Rodar; pedirRedefinir: (fazer: () => void) => void }) {
  const t = useT();
  const [link, setLink] = useState<string | null>(null);
  const buscar = async (reset: boolean) => {
    const r = (await rodar({ acao: "link", ...(reset ? { reset: true } : {}) })) as { link: string | null } | undefined;
    if (r && typeof r === "object") setLink(r.link);
  };
  return (
    <>
      {link && <Input readOnly value={link} aria-label={t("Link de convite")} onFocus={(e) => e.currentTarget.select()} />}
      <div className="flex flex-wrap gap-2">
        {!link && <Button type="button" size="sm" disabled={ocupado} onClick={() => void buscar(false)}>{t("Mostrar link")}</Button>}
        {link && (
          <Button type="button" size="sm" variant="outline" onClick={() => void copyToClipboard(link).then((ok) => ok && toast.success(t("Link copiado.")))}>
            {t("Copiar")}
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" disabled={ocupado} onClick={() => pedirRedefinir(() => void buscar(true))}>{t("Redefinir")}</Button>
      </div>
    </>
  );
}
