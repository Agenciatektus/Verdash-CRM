import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MediaRenderer } from "@/components/inbox/media/MediaRenderer";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import { MARCADOR_NAO_LIDA } from "@/lib/messaging/media/derivable";
import type { Message } from "@/lib/types/messaging";

function msg(over: Partial<Message>): Message {
  return {
    id: "m1",
    conversation_id: "c1",
    contact_id: "ct1",
    channel_session_id: "s1",
    external_id: "x1",
    type: "text",
    direction: "inbound",
    status: "delivered",
    ack: null,
    body: null,
    media_url: "http://waha/file",
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "external_device",
    sent_at: "2026-07-21T20:00:00.000Z",
    delivered_at: null,
    read_at: null,
    error_code: null,
    error_message: null,
    metadata: {},
    created_at: "2026-07-21T20:00:00.000Z",
    ...over,
  } as Message;
}

describe("MediaRenderer", () => {
  it("image → ImageMedia", () => {
    render(<MediaRenderer message={msg({ type: "image" })} />);
    expect(screen.getByAltText("Imagem recebida")).toBeInTheDocument();
  });
  it("sticker → StickerMedia", () => {
    render(<MediaRenderer message={msg({ type: "sticker" })} />);
    expect(screen.getByAltText("Figurinha")).toBeInTheDocument();
  });
  it("audio → AudioPlayer", () => {
    render(<MediaRenderer message={msg({ type: "audio" })} />);
    expect(screen.getByRole("button", { name: /reproduzir/i })).toBeInTheDocument();
  });
  it("video → VideoMedia", () => {
    const { container } = render(<MediaRenderer message={msg({ type: "video" })} />);
    expect(container.querySelector("video")).not.toBeNull();
  });
  it("document (e tipos desconhecidos) → DocumentCard", () => {
    render(<MediaRenderer message={msg({ type: "document", media_mime: "application/pdf" })} />);
    expect(screen.getByRole("link", { name: /baixar documento pdf/i })).toBeInTheDocument();
  });
});

// Fork Tektus: a transcrição do áudio é da bolha (`bolha/CorpoDaBolha` +
// `TranscricaoDoAudio`, #138), não do `MediaRenderer`. Os casos do upstream
// (#2057/#2133) estão em tests/unit/transcricao-no-inbox.test.tsx, contra a bolha.

describe("MessageBubble com mídia", () => {
  it("renderiza mídia E caption juntos", () => {
    render(<MessageBubble message={msg({ type: "image", body: "olha isso" })} />);
    expect(screen.getByAltText("Imagem recebida")).toBeInTheDocument();
    expect(screen.getByText("olha isso")).toBeInTheDocument();
  });
  it("mensagem só-texto não renderiza mídia", () => {
    render(<MessageBubble message={msg({ type: "text", body: "oi", media_url: null })} />);
    expect(screen.queryByAltText("Imagem recebida")).not.toBeInTheDocument();
  });
});

describe("mídia expirada (#13 da auditoria): diz que expirou em vez de nada", () => {
  it("anexo antigo do Instagram, sem arquivo e sem ponteiro: a bolha mostra 'Mídia expirada'", () => {
    render(
      <MessageBubble
        message={msg({ type: "text", body: null, media_url: null, metadata: { instagram_tem_anexo: true } })}
      />,
    );
    expect(screen.getByText("Mídia expirada")).toBeInTheDocument();
  });

  it("o worker desistiu (media_status failed): 'Mídia expirada', sem pedir a rota", () => {
    const { container } = render(
      <MediaRenderer message={msg({ type: "image", metadata: { media_status: "failed" } })} />,
    );
    expect(screen.getByText("Mídia expirada")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("CONTROLE: texto comum não ganha aviso de mídia", () => {
    render(<MessageBubble message={msg({ type: "text", body: "oi", media_url: null })} />);
    expect(screen.queryByText("Mídia expirada")).not.toBeInTheDocument();
  });
});

describe("Instagram (#13): permalink, anexos extras e mídia temporária", () => {
  it("permalink de post vira 'Ver no Instagram' (só instagram.com; link de fora é ignorado)", () => {
    render(
      <MessageBubble
        message={msg({
          type: "text",
          body: null,
          media_url: null,
          metadata: {
            instagram_links: [
              { tipoNaMeta: "ig_post", url: "https://www.instagram.com/p/FICTICIO/", titulo: "legenda" },
              { tipoNaMeta: "ig_post", url: "https://phishing.example/p/x", titulo: "golpe" },
            ],
          },
        })}
      />,
    );
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://www.instagram.com/p/FICTICIO/");
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("anexos extras: avisa que a mensagem tinha mais anexos", () => {
    render(
      <MessageBubble
        message={msg({
          type: "image",
          metadata: { instagram_anexos_extras: [{ tipo: "ig_reel", url: "https://lookaside.fbsbx.com/x" }] },
        })}
      />,
    );
    expect(screen.getByText("Esta mensagem tinha mais anexos no Instagram.")).toBeInTheDocument();
  });

  it("mídia temporária: diz que o CRM não guarda (e não 'expirada')", () => {
    render(
      <MessageBubble
        message={msg({
          type: "text",
          body: null,
          media_url: null,
          metadata: { instagram_tem_anexo: true, instagram_anexo_temporario: true },
        })}
      />,
    );
    expect(screen.getByText("Mídia temporária: o CRM não guarda")).toBeInTheDocument();
    expect(screen.queryByText("Mídia expirada")).not.toBeInTheDocument();
  });
});
