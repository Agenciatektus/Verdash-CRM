"use client";
import { useT } from "@/hooks/i18n/useT";
import {
  forwardRef, useEffect, useId, useImperativeHandle, useRef, useState,
  type ClipboardEvent, type KeyboardEvent,
} from "react";
import { BarraDoComposer } from "@/components/inbox/composer/BarraDoComposer";
import { FolhaDeRespostasRapidas } from "@/components/mobile/telas/FolhaDeRespostasRapidas";
import { useEhCelular } from "@/lib/mobile/useEhCelular";
import { DialogosDoComposer } from "@/components/inbox/composer/DialogosDoComposer";
import { CaixaOuFaixaDoDono } from "@/components/inbox/composer/FaixaDoDono";
import { FaixaDeContatoBloqueado, FaixaDeConversaFechada } from "@/components/inbox/composer/FaixaDeEstado";
import { AbasDoComposer, AvisoDoRascunho, FaixaDaCitacao } from "@/components/inbox/composer/FaixasDoComposer";
import { ReplyReviewPanel } from "@/components/inbox/composer/ReplyReviewPanel";
import { anexoLevaLegenda, indiceDaLegenda } from "@/components/inbox/media/legenda-do-anexo";
import { BarraDeRecursos } from "@/components/inbox/composer/BarraDeRecursos";
import { type Recurso } from "@/lib/inbox/recursos";
import {
  MentionMenu,
  opcoesDeMencao,
  resolverMencao,
  type OpcaoDeMencao,
} from "@/components/inbox/composer/MentionMenu";
import { resolveSlash, TemplateMenu } from "@/components/inbox/composer/TemplateMenu";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useSugestaoDeResposta } from "@/components/inbox/composer/useSugestaoDeResposta";
import { useCreateNote } from "@/hooks/inbox/useCreateNote";
import { useMessageTemplates } from "@/hooks/inbox/useMessageTemplates";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { useSendMessage } from "@/hooks/inbox/useSendMessage";
import { useUploadMedia, type DestinoDoUpload } from "@/hooks/inbox/useUploadMedia";
import { imagemDoClipboard } from "@/lib/inbox/clipboard-image";
import { toast } from "sonner";
import {
  interpolateTemplate,
  motivoDoCuringaLiteral,
  payloadDeUso,
  type TemplateContact,
} from "@/lib/inbox/template-vars";
import { ApiError } from "@/lib/api/types";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { mimeDaMidia, type MidiaDeTemplate } from "@/lib/templates/midias";
import type { Message } from "@/lib/types/messaging";
import type { AvisoDeRascunho } from "@/lib/inbox/rascunho-sugerido";
import { apiClient } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { embutirMencoes, podarMencoes, type MencaoEscolhida } from "@/lib/notifications/mentions";

export interface ComposerHandle { focus: () => void }

interface Props {
  conversationId: string;
  initialDraft?: string;
  initialMode?: "reply" | "note";
  onDraftChange?: (text: string, mode: "reply" | "note") => void;
  active?: boolean;
  disabled?: boolean;
  /** Contato bloqueado ou anonimizado: a faixa diz o motivo no lugar da caixa. */
  blockedReason?: string | null;
  /** Janela de 24h fechada: barra a RESPOSTA, e só ela (a nota nunca chega ao cliente). */
  janelaFechada?: string | null;
  /**
   * A caixa travada até alguém ASSUMIR a conversa (#3012). Entra pela MESMA porta
   * do bloqueio de canal (`isDisabled`) e trava a caixa INTEIRA, nota inclusive:
   * é regra da organização, já resolvida de fora (`composerBloqueadoAteAssumir`).
   */
  aguardandoAssumir?: boolean;
  /** A mensagem que esta resposta CITA (escolhida no fio). `null` = envio solto. */
  respondendo?: Pick<Message, "id" | "body" | "direction" | "type" | "metadata"> | null;
  /** Desfaz a escolha — o `x` da faixa de citação. */
  onCancelarResposta?: () => void;
  /** Nome do contato da conversa, para interpolar {{nome}}/{{primeiro_nome}} do template escolhido. */
  contactName?: string | null;
  /**
   * Rótulo do canal (`contacts.display_name`), fallback quando `contactName`
   * é vazio (issue #2744). Contato criado pela ingestão do canal ainda não tem
   * `name` gravado, e o template não podia mandar `{{nome}}` literal pro cliente.
   */
  contactDisplayName?: string | null;
  /** Contato da conversa — excluído do seletor de cartão compartilhado. */
  currentContactId?: string | null;
  /** Texto sugerido por integração (issue #1611): o AVISO de origem e o `draft_id`. */
  rascunho?: AvisoDeRascunho | null;
  /** Para a faixa de quem atende; sem ela o composer não afirma nada sobre o dono. */
  conversa?: ConversationWithContact | null;
  /** Conversa fechada: a faixa com "Reabrir" no lugar da caixa (C7). */
  fechada?: boolean;
  /** Contato bloqueado (id dele): a faixa ganha "Desbloquear" para quem pode (C8). */
  contatoBloqueadoId?: string | null;
  /** O usuário logado (#3282): a barra de recursos lembra o recolhimento POR usuário. */
  usuarioId?: string | null;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  {
    conversationId, initialDraft = "", initialMode = "reply", active = true, onDraftChange, disabled,
    blockedReason, janelaFechada, aguardandoAssumir = false, contactName, contactDisplayName, currentContactId, respondendo, onCancelarResposta,
    rascunho = null, conversa = null, fechada = false, contatoBloqueadoId = null, usuarioId = null,
  },
  ref,
) {
  const t = useT();
  const dicaId = useId();
  const [text, setText] = useState(initialDraft);
  // O aviso some no primeiro ENVIO: depois do clique o rascunho foi usado, e
  // deixar a faixa prometendo texto que já saiu seria mentira de tela.
  const [rascunhoUsado, setRascunhoUsado] = useState(false);
  /**
   * A FILA de anexos (#2526): o "+" escolhe uma, a resposta rápida traz as
   * várias que o operador carregou no template. Uma lista e não um arquivo é o
   * que permite o preview das duas antes de qualquer byte sair.
   */
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  /**
   * O texto da resposta rápida escolhida, guardado como LEGENDA.
   *
   * `null` no caminho do "+", onde a legenda nasce vazia; com o corpo
   * interpolado quando a escolha veio de um template com imagem — o texto não
   * pode estar nos dois lugares (campo E legenda), senão a mensagem sairia
   * duplicada.
   */
  const [legendaInicial, setLegendaInicial] = useState<string | null>(null);
  /**
   * O modo em que o arquivo foi ESCOLHIDO, congelado na escolha. Sem isto, um
   * anexo escolhido em "Nota interna" que o operador troque para "Responder"
   * antes de clicar Enviar subiria em `whatsapp-media` e iria para o cliente
   * (o defeito que a F3 da #1863 existe para não ter).
   */
  const [pendingEm, setPendingEm] = useState<"reply" | "note">("reply");
  const [contactPickerOpen, setContactPickerOpen] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [mode, setMode] = useState<"reply" | "note">(initialMode);
  // C4: enquanto você não é o dono, a faixa substitui a caixa de RESPOSTA. A
  // saída "Responder sem assumir" devolve a caixa (a regra do servidor não
  // mudou). O composer é remontado por conversa, então a escolha não vaza.
  const [semAssumir, setSemAssumir] = useState(false);
  const [focarAoVoltar, setFocarAoVoltar] = useState(false);
  /**
   * Menção de atendente (#2372, upstream 1.76). `caret` porque o gatilho `@` é
   * relativo à POSIÇÃO do cursor; `mencoes` é o que foi ESCOLHIDO na lista (o
   * campo mostra o nome, o id entra só no corpo que sai, por `embutirMencoes`);
   * `mencaoDispensada` (Esc) e `mencaoIndice` (setas) seguem o slash-menu.
   */
  const [caret, setCaret] = useState(initialDraft.length);
  const [mencoes, setMencoes] = useState<MencaoEscolhida[]>([]);
  const [mencaoDispensada, setMencaoDispensada] = useState(false);
  const [mencaoIndice, setMencaoIndice] = useState(0);
  useEffect(() => {
    onDraftChange?.(text, mode);
  }, [text, mode, onDraftChange]);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const send = useSendMessage();
  const upload = useUploadMedia();
  const createNote = useCreateNote();
  const templates = useMessageTemplates();
  const celular = useEhCelular();
  const [folhaDeRespostas, setFolhaDeRespostas] = useState(false);
  const sugestao = useSugestaoDeResposta(conversationId, mode === "reply");
  const slash = resolveSlash(text);
  // O Esc/escolha vale só para o `/` em curso: saiu do `/` por QUALQUER caminho
  // (digitado ou escrito pelo `applyTemplate`, inclusive o clique da barra), o
  // próximo `/` volta a abrir o menu.
  if (menuDismissed && !slash.open) setMenuDismissed(false);
  const menuOpen = mode === "reply" && slash.open && !menuDismissed;
  // SÓ em nota: a menção é assunto interno; no campo de resposta ela sairia
  // para o cliente como texto solto.
  const gatilho = mode === "note" && !mencaoDispensada ? resolverMencao(text, caret) : null;
  const membros = useAssignableMembers(gatilho !== null);
  const opcoes = gatilho ? opcoesDeMencao(membros.data ?? [], gatilho.query, t) : [];
  const mencaoAberta = gatilho !== null;
  const opcaoAtual = opcoes[mencaoIndice] ?? opcoes[0];

  useImperativeHandle(ref, () => ({ focus: () => taRef.current?.focus() }));
  // Depois de "Assumir e responder" (ou de escolher responder sem assumir), o
  // foco vai para a caixa que acabou de aparecer. Sem lista de dependências de
  // propósito: a caixa só monta quando a conversa volta do servidor com você
  // como dono, um render depois do pedido; o `if` encerra o ciclo.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!focarAoVoltar || !taRef.current) return;
    taRef.current.focus();
    setFocarAoVoltar(false);
  });

  // send/createNote fora do disable: o texto some na hora do envio; travar o campo
  // até a API voltar impedia digitar a próxima mensagem com o campo ainda cheio.
  // `aguardandoAssumir` (#3012) entra AQUI: um termo a mais na trava de sempre,
  // nunca um desabilitar paralelo que pudesse divergir dela.
  const isDisabled = disabled || !!blockedReason || upload.isPending || aguardandoAssumir;
  // A janela só alcança o que SAI. Em modo nota o composer segue liberado.
  const respostaBarrada = isDisabled || (mode === "reply" && !!janelaFechada);
  const campoBarrado = mode === "note" ? isDisabled : respostaBarrada;

  /**
   * O contato da conversa, do jeito que a interpolação e o gate do curinga
   * (#2744) precisam: o `name` do CRM e o `display_name` do canal. Um objeto,
   * um lugar — o `applyTemplate` e a trava leem da MESMA fonte.
   */
  const contato: TemplateContact = {
    name: contactName ?? null,
    displayName: contactDisplayName ?? null,
  };

  /**
   * O curinga literal (#2744, opção A) — um SINAL IRMÃO do `janelaFechada`, e
   * não um termo a mais no `respostaBarrada`.
   *
   * A diferença é o CAMPO: `respostaBarrada` desabilita o `<textarea>` (a janela
   * fechada não tem o que editar), mas o curinga literal PEDE edição — o motivo
   * que a faixa mostra é "edite antes de enviar". Travar o campo aqui seria
   * negar a própria instrução. Então só o ENVIO é barrado; o operador continua
   * digitando, apaga o `{{nome}}` e manda.
   *
   * Só em RESPOSTA: a nota interna nunca chega ao cliente e passa — a mesma
   * fronteira do `janelaFechada`. Contato com nome não entra (o curinga resolve);
   * `{{codigo}}` cru também não (chave desconhecida não é problema de nome).
   */
  const motivoCuringa = mode === "reply" ? motivoDoCuringaLiteral(text, contato) : null;
  // O que trava o ENVIO: o de sempre, mais o curinga. O que trava o CAMPO
  // (`respostaBarrada`) NÃO recebe o curinga — ver acima.
  const envioBarrado = respostaBarrada || !!motivoCuringa;
  // O que trava o BOTÃO e o Enter (o campo segue em `campoBarrado`).
  const envioBloqueado = mode === "note" ? isDisabled : envioBarrado;

  /** Escolhe o arquivo e MARCA o modo da escolha (ver `pendingEm`). */
  function escolherArquivo(file: File) {
    setPendingFiles([file]);
    setLegendaInicial(null);
    setPendingEm(mode);
  }

  function autoresize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }

  /** Põe `trecho` no cursor (ou no fim) e devolve o foco ao campo. */
  function inserir(trecho: string) {
    const ta = taRef.current;
    if (!ta) {
      setText((atual) => atual + trecho);
      return;
    }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    setText(text.slice(0, start) + trecho + text.slice(end));
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = start + trecho.length;
      autoresize();
    });
  }

  /** Escolhe da lista e escreve o NOME no campo (`@Ana Lima `), do `@` até o cursor. */
  function escolherMencao(opcao: OpcaoDeMencao): void {
    const gatilhoAqui = resolverMencao(text, caret);
    if (!gatilhoAqui) return;
    const inserido = `@${opcao.rotulo} `;
    setText(text.slice(0, gatilhoAqui.start) + inserido + text.slice(caret));
    setMencoes((atual) => [...atual, { id: opcao.membro.user_id, nome: opcao.rotulo }]);
    const pos = gatilhoAqui.start + inserido.length;
    setCaret(pos);
    setMencaoIndice(0);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(pos, pos);
      autoresize();
    });
  }

  function handleSubmit() {
    const legivel = text.trim();
    if (!legivel || (mode === "note" ? isDisabled : envioBarrado)) return;

    // A menção vira token AQUI, na saída do campo (#2372): o que fica no
    // rascunho, no `onDraftChange` e no `restoreOnError` é o nome legível, e
    // o id só viaja no corpo que sai para o banco. Em modo RESPOSTA não há
    // token nenhum — menção é assunto de nota interna, e uma menção no campo
    // de resposta sairia para o cliente.
    // O curinga DIGITADO interpola como o template aplicado (#2891): quem escreve
    // `{{primeiro_nome}}` à mão quer o nome do cliente, não o token cru — e até
    // 14/10/2026 esse texto saía literal para o contato, sem faixa e com o
    // Enviar habilitado. A fonte é a MESMA do `applyTemplate` e da trava: o
    // `contato` montado uma linha acima, e a MESMA `interpolateTemplate`. Só a
    // RESPOSTA passa por aqui: a nota interna não vai ao cliente e continua
    // levando o texto como escrito (fronteira do `janelaFechada`, #2744).
    const corpo =
      mode === "note" ? embutirMencoes(legivel, mencoes) : interpolateTemplate(legivel, contato);

    setText("");
    requestAnimationFrame(() => autoresize());
    // Se a pessoa já começou a próxima resposta, preserve os dois textos.
    const restaurar = (current: string) => (current ? `${legivel}\n${current}` : legivel);
    const restoreOnError = () => {
      setText(restaurar);
      requestAnimationFrame(() => autoresize());
    };
    if (mode === "note") {
      // As escolhas DESTA nota: a 1ª tecla durante o envio poda `mencoes`, e o
      // retry voltaria sem o id (#2463).
      const mencoesEnviadas = mencoes;
      createNote.mutate(
        { conversation_id: conversationId, body: corpo },
        {
          onError: () => {
            restoreOnError();
            const restaurado = restaurar(taRef.current?.value ?? "");
            setMencoes((atual) =>
              podarMencoes(restaurado, [...mencoesEnviadas, ...atual.filter((m) => !mencoesEnviadas.includes(m))]),
            );
          },
          // Só as escolhas DESTA nota (#2463): a lista pode já ter a menção da
          // PRÓXIMA, escolhida enquanto esta ainda estava no ar.
          onSuccess: () =>
            setMencoes((atual) => atual.filter((m) => !mencoesEnviadas.includes(m))),
        },
      );
      return;
    }
    send.mutate(
      {
        conversation_id: conversationId,
        body: corpo,
        type: "text",
        ...(respondendo ? { reply_to_message_id: respondendo.id } : {}),
      },
      {
        onSuccess: () => {
          // A citação vale para UMA mensagem. Mantê-la depois do envio faria a
          // próxima frase sair citando algo que o atendente já respondeu.
          onCancelarResposta?.();
          consumirRascunhoEnviado();
          requestAnimationFrame(() => autoresize());
        },
        // Sem isto o texto some quando o envio falha, e quem escreveu um
        // parágrafo o perde sem ter como recuperá-lo.
        onError: restoreOnError,
      },
    );
  }

  /**
   * Marca o rascunho como usado — só depois do ENVIO humano dar certo.
   * Fire-and-forget de propósito: o texto já saiu, e a falha do consumo não
   * pode virar erro de envio. A proposta é de uso único.
   */
  function consumirRascunhoEnviado(): void {
    const leitura = rascunho?.leitura;
    if (rascunhoUsado || leitura?.estado !== "sugerido") return;
    setRascunhoUsado(true);
    void apiClient
      .post(`/api/v1/conversations/${conversationId}/drafts/consume`, { draft_id: leitura.draftId })
      .catch(() => {
        /* silêncio: ver docstring */
      });
  }

  /**
   * Escreve no campo e poe o cursor no fim — o de sempre, isolado para reuso.
   * `focar: false` é de quem devolve texto com o diálogo de anexos ABERTO (#3151):
   * o foco pertence ao diálogo.
   */
  function escreverNoCampo(conteudo: string, focar = true) {
    setText(conteudo);
    const ta = taRef.current;
    if (!ta) return;
    requestAnimationFrame(() => {
      if (focar) {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = conteudo.length;
      }
      autoresize();
    });
  }

  /**
   * A escolha de um recurso na barra (#2833) — o MESMO caminho do `/`: entrega ao
   * `applyTemplate`, que separa texto (campo editável) de mídia (fila de anexos).
   * Nada é enviado aqui.
   */
  function escolherRecurso(recurso: Recurso) {
    void applyTemplate(recurso);
  }

  /**
   * Baixa os BYTES de uma imagem do template (#2526).
   *
   * Pela própria origem (`/midias/:indice` devolve o corpo, não um 302): o
   * compositor precisa do `Blob` para montar o `File` que o envio de mídia
   * consome, e um redirect cruzaria a origem dependendo do CORS do bucket —
   * que, em self-host, é do operador e não nosso.
   */
  async function arquivoDaMidia(
    templateId: string,
    midia: MidiaDeTemplate,
    indice: number,
  ): Promise<File> {
    const res = await fetch(`/api/v1/message-templates/${templateId}/midias/${indice}`);
    if (!res.ok) throw new ApiError(res.status, "midia_indisponivel", undefined, "", "");
    const blob = await res.blob();
    const nome = midia.storage_path.split("/").pop() ?? `imagem-${indice + 1}`;
    // O tipo sai do CAMINHO (que a rota de upload escolheu pelos bytes), não
    // do `media_mime` da linha, que é texto livre gravado pelo PATCH.
    return new File([blob], nome, { type: mimeDaMidia(midia.storage_path) });
  }

  /**
   * Escolhe a resposta rápida (#2526).
   *
   * SÓ TEXTO continua sendo o de sempre, byte por byte: o corpo interpolado
   * vai para o campo. Com IMAGEM, o texto sai como legenda da primeira imagem
   * e as imagens entram na fila de anexos — texto + mídia numa única mensagem
   * editável, que é o que a issue pede e o que o envio de mídia já faz. Nada
   * aqui cria caminho de envio novo: a saída é o `useUploadMedia` +
   * `useSendMessage` de sempre, então canal, janela, opt-out, limite e retry
   * continuam valendo exatamente como estão.
   *
   * Baixar os bytes NA ESCOLHA (e não na hora de enviar) é o que permite
   * preview: sem o Blob não há o que mostrar, e o operador só poderia aprovar
   * às cegas.
   */
  async function applyTemplate(template: Recurso) {
    const payload = payloadDeUso(template, contato);
    setMenuDismissed(true);

    // O contato sem `name` NEM `display_name` (#2744): o `{{nome}}` sobrevive
    // literal no corpo e iria pro cliente como `{{nome}}`. O toast é o primeiro
    // aviso; a faixa persistente (mais abaixo) é o que fica, porque o operador
    // precisa editar antes de mandar.
    if (motivoDoCuringaLiteral(template.body, contato)) {
      toast.warning(
        t("Contato sem nome no CRM: {{nome}}/{{primeiro_nome}} ficaram literais no texto. Edite antes de enviar."),
      );
    }

    // `respostaBarrada` cobre a resposta barrada (janela fechada, canal
    // bloqueado) — enfileirar um upload que o dispatcher vai recusar deixaria
    // arquivo órfão no bucket. O texto segue no campo, como sempre esteve.
    if (!payload.midias.length || respostaBarrada) {
      escreverNoCampo(payload.texto);
      return;
    }

    try {
      const arquivos = await Promise.all(
        payload.midias.map((midia, indice) => arquivoDaMidia(template.id, midia, indice)),
      );
      setPendingEm("reply");
      setPendingFiles(arquivos);
      // Áudio NÃO leva legenda em nenhum canal (#3151): sem anexo na fila que a
      // leve, o corpo volta para o CAMPO. Com anexo que a leve, vira a legenda.
      if (arquivos.some(anexoLevaLegenda)) {
        setLegendaInicial(payload.texto);
        setText("");
      } else {
        setLegendaInicial(null);
        // Sem foco: o diálogo de prévia está abrindo POR CIMA do campo.
        escreverNoCampo(payload.texto, false);
      }
    } catch (erro) {
      // Sem os bytes não há prévia nem envio. O caminho honesto é o de texto,
      // com o aviso de que a imagem não veio — sumir em silêncio seria entregar
      // metade do template sem ninguém perceber.
      showApiError(erro);
      escreverNoCampo(payload.texto);
    }
  }

  /**
   * A FILA de anexos (#2526) — e ela é um laço, não um tiro.
   *
   * Cada arquivo sobe pelo `useUploadMedia` e sai pelo `useSendMessage` /
   * `useCreateNote` de sempre; só a PRIMEIRA imagem leva a legenda, o mesmo
   * contrato de "texto + mídia numa mensagem" que o envio de mídia já pratica.
   * A recursão entra pelo `onSuccess`, então uma falha INTERROMPE a fila e o
   * diálogo fica aberto para o retry — como já ficava no caminho de um arquivo.
   */
  function enviarAnexos(caption: string, indice = 0): void {
    const arquivo = pendingFiles[indice];
    if (!arquivo) {
      setPendingFiles([]);
      setLegendaInicial(null);
      return;
    }
    const destino: DestinoDoUpload = pendingEm === "note" ? "nota" : "mensagem";
    // `-1` (fila só de áudio) não casa com índice nenhum: a legenda não sai com
    // anexo algum, em vez de sair com um áudio que a descarta (#3151).
    const indiceLegenda = indiceDaLegenda(pendingFiles);
    const legenda =
      destino === "nota" ? caption : indice === indiceLegenda ? caption || undefined : undefined;
    void upload
      .mutateAsync({ conversationId, file: arquivo, destino })
      .then((uploaded) => {
        // Cada arquivo que SAIU deixa a fila, e a legenda com ele: se o
        // próximo falhar, o retry do diálogo recomeça do que falhou, sem
        // reenviar o que já foi nem repetir o texto (#2526, critério "falha
        // no envio da mídia não causa duplicação do texto"). Zerar a
        // `legendaInicial` é o que faz o diálogo repor a legenda VAZIA quando
        // a fila encolhe.
        const proximo = () => {
          setPendingFiles((fila) => fila.slice(1));
          setLegendaInicial(null);
          enviarAnexos(caption, indice + 1);
        };
        if (destino === "nota") {
          createNote.mutate(
            {
              conversation_id: conversationId,
              body: legenda ?? "",
              anexo: {
                storage_path: uploaded.storage_path,
                media_mime: uploaded.media_mime,
                media_size_bytes: uploaded.media_size_bytes,
              },
            },
            { onSuccess: proximo },
          );
          return;
        }
        send.mutate(
          {
            conversation_id: conversationId,
            type: uploaded.kind,
            body: legenda,
            media_storage_path: uploaded.storage_path,
            media_mime: uploaded.media_mime,
            media_size_bytes: uploaded.media_size_bytes,
          },
          { onSuccess: proximo },
        );
      })
      .catch(() => {
        // toast já disparado pelo onError de useUploadMedia; diálogo fica aberto p/ retry
      });
  }

  /**
   * Ctrl/Cmd+V com imagem no clipboard cai no MESMO caminho do menu "+":
   * abre o preview com legenda e envia por ali. Nada de atalho paralelo — a
   * validação, o toast de erro e o retry já vivem lá.
   *
   * As DUAS guardas antes de olhar o clipboard não são zelo: com um anexo já em
   * preview a colagem substituiria em silêncio o que o operador escolheu, e
   * desabilitado é desabilitado. Em qualquer um desses casos o Ctrl+V precisa
   * continuar sendo o Ctrl+V de sempre.
   *
   * O MODO saiu da guarda (#1863, F3): "Nota interna" passou a aceitar anexo,
   * e a imagem colada ali vira exatamente o mesmo preview de sempre — com o
   * modo congelado na escolha (`escolherArquivo`), para ela não escapar para o
   * cliente se o operador trocar de aba no meio. `respostaBarrada` já cobre os
   * dois modos: em nota ele é só `isDisabled` (a janela fechada barra a
   * RESPOSTA, e só ela — a nota continua sendo o lugar onde se registra por que
   * a conversa esfriou).
   */
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (respostaBarrada || pendingFiles.length > 0) return;
    const imagem = imagemDoClipboard(e.clipboardData, new Date());
    if (!imagem) return; // colagem de texto segue o caminho normal do browser
    e.preventDefault();
    escolherArquivo(imagem);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // A lista de menções come as teclas ANTES do Enter salvar (a lei do slash-menu).
    if (mencaoAberta) {
      if (e.key === "Escape") {
        setMencaoDispensada(true);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMencaoIndice((i) => (opcoes.length ? (i + 1) % opcoes.length : 0));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMencaoIndice((i) => (opcoes.length ? (i - 1 + opcoes.length) % opcoes.length : 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (opcaoAtual) escolherMencao(opcaoAtual);
        return;
      }
      // Tab só é interceptado quando HÁ o que escolher.
      if (e.key === "Tab" && opcaoAtual) {
        e.preventDefault();
        escolherMencao(opcaoAtual);
        return;
      }
    }
    if (e.key === "Escape" && menuOpen) {
      setMenuDismissed(true);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (menuOpen) {
        e.preventDefault(); // deixa o Enter pro menu; não envia /query como mensagem
        return;
      }
      // No toque, a tecla de retorno do teclado virtual QUEBRA LINHA; quem envia é
      // o botão. Ctrl/Cmd+Enter envia sempre (iPad com teclado físico).
      const forcaEnvio = e.ctrlKey || e.metaKey;
      if (!forcaEnvio && window.matchMedia?.("(pointer: coarse)").matches) return;
      e.preventDefault();
      handleSubmit();
    }
  }

  if (blockedReason && contatoBloqueadoId) {
    return (
      <div className="bg-bg px-4 pb-3.5 pt-2.5">
        <FaixaDeContatoBloqueado contatoId={contatoBloqueadoId} conversationId={conversationId} motivo={blockedReason} />
      </div>
    );
  }
  if (fechada) {
    return (
      <div className="bg-bg px-4 pb-3.5 pt-2.5">
        <FaixaDeConversaFechada conversationId={conversationId} revisao={conversa?.service_revision} />
      </div>
    );
  }
  if (blockedReason) {
    return (
      <div className="bg-bg px-4 pb-3.5 pt-2.5">
        <p className="rounded-2xl border border-border bg-surface px-3.5 py-3 text-center text-sm text-text-muted">
          {blockedReason}
        </p>
      </div>
    );
  }

  const nota = mode === "note";
  return (
    <>
      <div className="relative bg-bg px-4 pb-3.5 pt-2.5" data-modo={mode}>
        {!nota && <ReplyReviewPanel sugestao={sugestao} disabled={isDisabled} />}
        {rascunho && !rascunhoUsado && !nota && <AvisoDoRascunho rascunho={rascunho} />}
        {/* O AVISO DO BLOQUEIO ATÉ ASSUMIR (#3012): o motivo junto da caixa travada. */}
        {aguardandoAssumir && (
          <div
            data-testid="aviso-assumir"
            className="mb-1.5 flex items-start gap-2 rounded-md border-l-2 border-primary bg-muted/60 px-2 py-1.5 text-xs"
          >
            <p className="min-w-0 flex-1 text-muted-foreground">
              {t("Assuma esta conversa para responder.")}
            </p>
          </div>
        )}
        <AbasDoComposer mode={mode} onMode={setMode} dicaId={dicaId} />
        <CaixaOuFaixaDoDono
          conversa={!nota && !semAssumir ? conversa : null}
          sugerir={isDisabled ? undefined : { onSugerir: () => void sugestao.generate(), ocupado: sugestao.busy }}
          onAssumiu={() => setFocarAoVoltar(true)}
          onResponderSemAssumir={() => {
            setSemAssumir(true);
            setFocarAoVoltar(true);
          }}
          onNota={() => {
            setMode("note");
            setFocarAoVoltar(true);
          }}
        >
        {/* O AVISO DO CURINGA LITERAL (#2744): persistente, só em resposta. */}
        {motivoCuringa && (
          <div
            data-testid="aviso-curinga-literal"
            className="mb-1.5 flex items-start gap-2 rounded-md border-l-2 border-warning bg-warning-bg px-2 py-1.5 text-xs text-warning-fg"
          >
            <p className="min-w-0 flex-1">
              {t("Contato sem nome no CRM: {{nome}}/{{primeiro_nome}} ficaram literais no texto. Edite antes de enviar.")}
            </p>
          </div>
        )}
        {respondendo && !nota && <FaixaDaCitacao respondendo={respondendo} onCancelar={onCancelarResposta} />}
        {/* A BARRA DE RECURSOS (#2833): o clique NÃO envia, entrega ao `applyTemplate`. */}
        {!nota && (
          <BarraDeRecursos
            recursos={templates.data ?? []}
            disabled={respostaBarrada}
            onEscolher={escolherRecurso}
            usuarioId={usuarioId}
          />
        )}
        <div
          // A caixa ganha a borda e o anel do accent no foco, e a nota interna
          // vira tracejada no tom de aviso: quem digita sabe, sem ler nada, se
          // aquilo vai para o cliente ou fica com o time.
          className={cn(
            "pele-ruido relative rounded-2xl border transition-[border-color,box-shadow]",
            nota
              ? "border-dashed border-warning/60 bg-warning-bg focus-within:border-warning focus-within:ring-3 focus-within:ring-warning/20"
              : "border-border-strong bg-surface focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/20",
          )}
        >
          <FolhaDeRespostasRapidas aberta={folhaDeRespostas} aoMudar={setFolhaDeRespostas} respostas={templates.data ?? []} aoEscolher={applyTemplate} />
          <TemplateMenu open={menuOpen} query={slash.query} templates={templates.data ?? []} onPick={applyTemplate} onClose={() => setMenuDismissed(true)} />
          {/* A lista de atendentes (#2372): só em nota, só com o `@` aberto. */}
          <MentionMenu
            open={mencaoAberta}
            opcoes={opcoes}
            indice={opcaoAtual ? opcoes.indexOf(opcaoAtual) : 0}
            onPick={escolherMencao}
          />
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              const pos = e.target.selectionStart ?? e.target.value.length;
              setCaret(pos);
              setMencaoIndice(0);
              // A escolha que sumiu do texto sai da lista agora (#2463); só na
              // edição à mão, para o retry da nota manter as menções.
              setMencoes((atual) => podarMencoes(e.target.value, atual));
              if (!resolverMencao(e.target.value, pos)) setMencaoDispensada(false);
              autoresize();
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            // "(só o time vê)" FICA no placeholder da nota: não é atalho, é
            // consequência. Quem escreve uma nota interna precisa saber que ela
            // não vai para o cliente sem depender de abrir um diálogo.
            placeholder={nota ? t("Escreva uma nota interna… (só o time vê)") : t("Escreva uma mensagem…")}
            aria-describedby={dicaId}
            className="block max-h-40 min-h-12 w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-sm mb:text-[16px] leading-normal text-text placeholder:text-text-subtle focus:outline-hidden disabled:cursor-not-allowed"
            disabled={campoBarrado}
            aria-label={t("Mensagem")}
          />
          <BarraDoComposer
            nota={nota}
            texto={text}
            conversationId={conversationId}
            active={active}
            isDisabled={isDisabled}
            respostaBarrada={respostaBarrada}
            campoBarrado={campoBarrado}
            envioBloqueado={envioBloqueado}
            sugestao={sugestao}
            onArquivo={escolherArquivo}
            onContato={() => setContactPickerOpen(true)}
            onEmoji={inserir}
            onRespostasRapidas={() => {
              // Celular (M2.3): a lista em folha, porque a ancorada fica atrás do teclado.
              if (celular) return setFolhaDeRespostas(true);
              setText("/");
              setMenuDismissed(false);
              requestAnimationFrame(() => taRef.current?.focus());
            }}
            onEnviar={handleSubmit}
          />
        </div>
        </CaixaOuFaixaDoDono>
      </div>
      <DialogosDoComposer
        conversationId={conversationId} currentContactId={currentContactId}
        files={pendingFiles} legendaInicial={legendaInicial} notaInterna={pendingEm === "note"}
        sending={upload.isPending || send.isPending || createNote.isPending}
        onCancelarAnexo={() => {
          const devolver = legendaInicial;
          setPendingFiles([]);
          setLegendaInicial(null);
          // Cancelar a prévia DEVOLVE o texto ao campo (#2526): ele estava ali
          // como legenda da imagem que não vai sair.
          if (devolver) escreverNoCampo(devolver);
        }}
        onRemoverAnexo={(indice, caption) => {
          const resto = pendingFiles.filter((_, i) => i !== indice);
          // Sobra SEM anexo que leve legenda (fila vazia ou só de áudio) é nada a
          // legendar: o texto volta para o campo (#3151). Na NOTA o texto é o corpo
          // dela e vale com áudio também: só a fila vazia o devolve.
          if (resto.length === 0 || (pendingEm !== "note" && indiceDaLegenda(resto) === -1)) {
            setPendingFiles(resto);
            setLegendaInicial(null);
            // Sem foco: o diálogo continua ABERTO com o áudio que sobrou.
            if (caption) escreverNoCampo(caption, false);
            return;
          }
          setLegendaInicial(caption);
          setPendingFiles(resto);
        }}
        onEnviarAnexos={enviarAnexos}
        contactPickerOpen={contactPickerOpen} setContactPickerOpen={setContactPickerOpen}
        send={send}
      />
    </>
  );
});
