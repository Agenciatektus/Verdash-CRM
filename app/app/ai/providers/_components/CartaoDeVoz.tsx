"use client";

/** Portado do upstream 1.99 (o painel do fork é dividido em arquivos). */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

/**
 * A VOZ da organização — qual voz o agente usa quando uma versão liga
 * `voz_enabled` (editor de agente). Separado de `CartaoDoPadrao` porque é
 * outro eixo: aquele é modelo de CONVERSA por ponto; isto é um recurso
 * contratado uma vez (ElevenLabs), igual à chave em si.
 */
export function CartaoDeVoz({ podeEditar }: { podeEditar: boolean }) {
  const t = useT();
  const [carregando, setCarregando] = useState(true);
  const [voiceId, setVoiceId] = useState("");
  const [vozesDisponiveis, setVozesDisponiveis] = useState<string[]>([]);
  const [temCredencial, setTemCredencial] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [ouvindo, setOuvindo] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const carregar = useCallback(async () => {
    try {
      const res = await apiClient.get<{
        data: { voiceId: string | null; vozesDisponiveis: string[]; temCredencial: boolean };
      }>("/api/v1/ai/voz");
      setVoiceId(res.data.voiceId ?? "");
      // Resposta incompleta não derruba o painel inteiro: sem lista, sem vozes.
      setVozesDisponiveis(res.data.vozesDisponiveis ?? []);
      setTemCredencial(res.data.temCredencial === true);
    } catch (err) {
      showApiError(err);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function salvar() {
    setSalvando(true);
    try {
      const res = await apiClient.patch<{ data: { voiceId: string } }>("/api/v1/ai/voz", {
        voice_id: voiceId,
      });
      toast.success(`${t("Voz salva:")} ${res.data.voiceId}`);
    } catch (err) {
      showApiError(err);
    } finally {
      setSalvando(false);
    }
  }

  async function ouvirPrevia() {
    setOuvindo(true);
    try {
      const res = await apiClient.post<{ data: { audioBase64: string; mimeType: string } }>(
        "/api/v1/ai/voz/preview",
        { voice_id: voiceId },
      );
      if (audioRef.current) {
        audioRef.current.src = `data:${res.data.mimeType};base64,${res.data.audioBase64}`;
        await audioRef.current.play();
      }
    } catch (err) {
      showApiError(err);
    } finally {
      setOuvindo(false);
    }
  }

  if (carregando) return null;

  return (
    <Card className="mb-6 space-y-3 p-4" data-testid="cartao-de-voz">
      <h2 className="text-base font-semibold">{t("Voz do agente")}</h2>
      <p className="text-sm text-muted-foreground">
        {t(
          "Qual voz sai quando um agente responde em áudio — ligado por versão, no editor do agente. Precisa de uma credencial do ElevenLabs validada.",
        )}
      </p>

      {!temCredencial && (
        <p className="text-sm text-amber-600 dark:text-amber-500">
          {t("Sem credencial do ElevenLabs validada ainda.")}{" "}
          <Link className="underline underline-offset-4" href="/app/ai/credentials">
            {t("Cadastrar em Credenciais")}
          </Link>
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-64">
          <Label className="text-xs">{t("Voice ID")}</Label>
          {vozesDisponiveis.length === 0 ? (
            <Input
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
              placeholder="ex.: 21m00Tcm4TlvDq8ikWAM"
              data-testid="voz-voice-id"
              disabled={!podeEditar}
            />
          ) : (
            <Select value={voiceId} onValueChange={setVoiceId} disabled={!podeEditar}>
              <SelectTrigger data-testid="voz-voice-id">
                <SelectValue placeholder={t("escolha")} />
              </SelectTrigger>
              <SelectContent>
                {vozesDisponiveis.map((id) => (
                  <SelectItem key={id} value={id}>
                    {id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <Button
          size="sm"
          variant="outline"
          disabled={ouvindo || voiceId.trim() === ""}
          onClick={() => void ouvirPrevia()}
          data-testid="voz-ouvir-previa"
        >
          {ouvindo ? t("Gerando…") : t("Ouvir prévia")}
        </Button>

        {podeEditar && (
          <Button
            size="sm"
            disabled={salvando || voiceId.trim() === ""}
            onClick={() => void salvar()}
            data-testid="voz-salvar"
          >
            {salvando ? t("Salvando…") : t("Salvar voz")}
          </Button>
        )}
      </div>

      <audio ref={audioRef} data-testid="voz-audio-previa" />
    </Card>
  );
}
