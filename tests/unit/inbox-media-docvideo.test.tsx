import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DocumentCard } from "@/components/inbox/media/DocumentCard";
import { VideoMedia } from "@/components/inbox/media/VideoMedia";

describe("VideoMedia", () => {
  it("renderiza <video> apontando pro endpoint; os controles nativos entram depois do play", () => {
    const { container } = render(<VideoMedia messageId="m4" />);
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute("src", "/api/v1/messages/m4/media");
    // Quadro DS: o quadro parado com o play redondo; controles só depois do clique.
    expect(video).not.toHaveAttribute("controls");
    fireEvent.click(screen.getByRole("button", { name: "Reproduzir vídeo" }));
    expect(container.querySelector("video")).toHaveAttribute("controls");
  });

  it("caixa estável aspect-video mantém proporção", () => {
    const { container } = render(<VideoMedia messageId="m4" />);
    const box = container.querySelector(".aspect-video");
    expect(box).not.toBeNull();
    // `.media` do quadro DS: 240 de largura e raio 14.
    expect(box).toHaveClass("relative", "w-60", "max-w-full", "overflow-hidden", "rounded-[14px]");
  });

  it("mostra skeleton enquanto carrega, desaparece após loadedmetadata", () => {
    const { container } = render(<VideoMedia messageId="m4" />);
    const video = container.querySelector("video")!;
    const skeleton = container.querySelector(".absolute.inset-0");

    // Skeleton deve estar presente antes do evento
    expect(skeleton).not.toBeNull();

    // Dispara loadedmetadata
    fireEvent(video, new Event("loadedmetadata"));

    // Skeleton deve desaparecer
    expect(container.querySelector(".absolute.inset-0")).toBeNull();
  });

  it("mostra fallback quando o vídeo falha (dentro do container)", () => {
    const { container } = render(<VideoMedia messageId="m4" />);
    const video = container.querySelector("video")!;

    fireEvent.error(video);

    const aspectVideoBox = container.querySelector(".aspect-video");
    expect(aspectVideoBox).not.toBeNull();
    expect(screen.getByText("Mídia indisponível")).toBeInTheDocument();

    // Verifica que o fallback está dentro do container aspect-video
    expect(aspectVideoBox?.contains(screen.getByText("Mídia indisponível"))).toBe(true);
  });
});

describe("DocumentCard", () => {
  it("mostra rótulo, tamanho e link de download", () => {
    render(
      <DocumentCard
        messageId="m5"
        mime="application/pdf"
        sizeBytes={3179614}
        storagePath="org/conv/m5.pdf"
        isOutbound={false}
      />,
    );
    // Sem nome do arquivo, o título é "Documento PDF" (#2613); embaixo, "tipo, tamanho".
    expect(screen.getByTitle("Documento PDF")).toBeInTheDocument();
    expect(screen.getByText("PDF, 3,0 MB")).toBeInTheDocument();
    // O botão de baixar pede o nome original (`?baixar=1`).
    const link = screen.getByRole("link", { name: /baixar documento pdf \(3,0 MB\)/i });
    expect(link).toHaveAttribute("href", "/api/v1/messages/m5/media?baixar=1");
    expect(link).toHaveAttribute("target", "_blank");
  });
});
