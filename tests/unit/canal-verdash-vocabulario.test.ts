import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * O vocabulário do canal hospedado — o que entra ANTES do transporte.
 *
 * O tipo, a matriz de capabilities, a coluna de ref e os CHECKs do banco nascem
 * JUNTOS: o caminho inverso obriga a uma migration de correção sobre dados que
 * já existem, e é onde clone quebra.
 *
 * Aqui se prova o vocabulário, o encanamento até o adapter e a LEITURA do
 * webhook — que é onde este canal tem o maior risco, porque o formato do
 * provedor já mudou três vezes e uma delas matou a atribuição de anúncio de
 * todos os clientes por quatro dias, em silêncio.
 */
import {
  CHANNEL_CAPABILITIES,
  CHANNEL_PROVIDER_VERDASH,
  capabilitiesOf,
} from "@/lib/channels/capabilities";
import { getAdapter } from "@/lib/channels";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "@/lib/channels/session-ref";
import { acceptsInboundWebhook } from "@/lib/channels/inbound";
import {
  lerEnvelopeVerdash,
  parseVerdashInbound,
  verifyVerdashToken,
} from "@/lib/channels/verdash/webhook";

const VERDASH = CHANNEL_PROVIDER_VERDASH;

describe("capabilities do canal hospedado", () => {
  it("descreve o WhatsApp comum — o mesmo permitido do canal por QR", () => {
    expect(capabilitiesOf(VERDASH)).toEqual({
      freeformOutsideWindow: true,
      requiresTemplates: false,
      canManageTemplates: false,
      banRisk: true,
      minIntervalMs: null,
      voiceNote: "server-convert",
      groups: "full",
      costPerMessage: false,
      // A plataforma permite editar/apagar para todos, mas o adapter do canal
      // hospedado ainda não implementa `editMessage`: prometer na tela seria
      // oferecer um botão que o envio recusa (capability nova do upstream v1.69).
      alteraMensagemEnviada: false,
      // A agenda do celular (`contacts/all`, #2736) é do canal por QR; o hospedado não a lê.
      phonebook: false,
    });
  });

  it("é igual ao canal por QR porque é o MESMO WhatsApp por baixo, não por cópia", () => {
    // Capability descreve o que a plataforma permite, não quem hospeda a
    // conexão. Divergir aqui afirmaria uma diferença que não existe.
    // Diferenças declaradas: `alteraMensagemEnviada` e `phonebook` (ver o caso acima) —
    // são do ADAPTER, não da plataforma, e somem quando o adapter implementar a edição e a agenda.
    expect({ ...capabilitiesOf(VERDASH), alteraMensagemEnviada: true, phonebook: true }).toEqual(
      CHANNEL_CAPABILITIES.waha,
    );
  });

  it("banRisk continua ARMADO — e aqui o número em risco é o principal do cliente", () => {
    // Este canal se pendura no WhatsApp que o cliente já usa para trabalhar.
    // Desarmar o anti-ban aqui não arrisca um número de teste: arrisca o número
    // da empresa dele.
    expect(capabilitiesOf(VERDASH).banRisk).toBe(true);
  });

  it("voiceNote é server-convert: MEDIDO no OpenAPI do provedor (ptt converte)", () => {
    // `ptt: true` gera ogg/opus, onda sonora e duração no servidor. Declarar
    // `opus-only` faria quem prepara a mídia converter de novo, do lado errado
    // e sem precisar.
    expect(capabilitiesOf(VERDASH).voiceNote).toBe("server-convert");
    expect(capabilitiesOf(VERDASH).voiceNote).not.toBe(CHANNEL_CAPABILITIES.zernio.voiceNote);
  });
});

describe("identificador da sessão", () => {
  it("resolve pelo NOME DA INSTÂNCIA, que é como o provedor endereça", () => {
    expect(
      resolveSessionRef({
        provider: VERDASH as "verdash",
        verdash_instance_name: "tektus-cliente",
      }),
    ).toBe("tektus-cliente");
  });

  it("a coluna entra no select — sem ela o ref volta indefinido em runtime", () => {
    expect(CHANNEL_SESSION_REF_COLUMNS).toContain("verdash_instance_name");
  });

  it("cada canal resolve pela SUA coluna — nenhum cai na do outro", () => {
    expect(resolveSessionRef({ provider: "waha", waha_session_name: "s1" })).toBe("s1");
    expect(resolveSessionRef({ provider: "meta_cloud", meta_phone_number_id: "pn1" })).toBe("pn1");
  });
});

describe("o canal tem transporte e recebe", () => {
  it("getAdapter devolve o adapter do canal, não o de outro", () => {
    // Cair no canal por QR por default seria pior que lançar: enviar pelo canal
    // errado é pior que não enviar.
    expect(getAdapter(VERDASH).provider).toBe(VERDASH);
  });

  it("os códigos de erro nomeiam o canal — o operador precisa saber qual falhou", () => {
    expect(getAdapter(VERDASH).codes.sendFailed).toContain("verdash");
  });

  it("a rota de entrada aceita este canal — sem isso ele envia e nunca recebe", () => {
    expect(acceptsInboundWebhook(VERDASH)).toBe(true);
  });

  it("implementa checkHealth, porque quem mantém a conexão é OUTRO sistema", () => {
    // Sem sonda, um número que o outro sistema desconectou ficaria `WORKING`
    // para sempre: silêncio e saúde ficam idênticos.
    expect(typeof getAdapter(VERDASH).checkHealth).toBe("function");
  });

  it("implementa fetchInboundMedia — sem ele a mídia vira linha sem bytes", () => {
    expect(typeof getAdapter(VERDASH).fetchInboundMedia).toBe("function");
  });
});

describe("endereçamento", () => {
  const a = getAdapter(VERDASH);

  it("pessoa vai em dígitos, sem máscara", () => {
    expect(
      a.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: "+55 (66) 8127-6920",
        waIdentity: null,
      }),
    ).toBe("556681276920");
  });

  it("grupo vai pelo JID, não pelo telefone", () => {
    expect(
      a.resolveRecipient({
        isGroup: true,
        groupChatId: "120363123456789012@g.us",
        phoneNumber: "+5566812769 20",
        waIdentity: null,
      }),
    ).toBe("120363123456789012@g.us");
  });

  it("contato só com identidade opaca NÃO vira null — acabamos de receber mensagem dele", () => {
    // Devolver `null` diria "não há como falar com esta pessoa", e é falso.
    expect(
      a.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: "lid:123456789",
      }),
    ).toBe("123456789@lid");
  });
});

describe("o endereço de resposta é a THREAD, não o telefone recalculado", () => {
  // Falha real em produção, 16/09: a atendente respondeu pelo CRM e tomou
  //   500 "no LID found for 5566984057837@s.whatsapp.net from server"
  // O contato estava certo; o ENDEREÇO é que era inventado. Duas causas somadas:
  // o chat vinha em LID mode (`…@lid`, que não é telefone nenhum) e o telefone
  // guardado passa por `canonicalPhoneBR`, que ACRESCENTA o nono dígito — e a
  // linha dela é conhecida pelo WhatsApp sem ele.
  const evento = (chat: string) => ({
    type: "Message",
    event: {
      Info: {
        ID: "3EB0XYZ",
        Chat: chat,
        Sender: chat,
        SenderAlt: "556684057837@s.whatsapp.net",
        PushName: "Luzimar",
        IsFromMe: false,
      },
      Message: { conversation: "oi" },
    },
  });

  it("o parser preserva o JID do chat como veio — inclusive em LID mode", () => {
    const m = parseVerdashInbound(evento("162379946016868@lid"));
    expect(m?.chat).toBe("162379946016868@lid");
  });

  it("em LID mode o telefone vem do SenderAlt, SEM o nono dígito inventado", () => {
    const m = parseVerdashInbound(evento("162379946016868@lid"));
    // 12 dígitos: é o número que o WhatsApp conhece. Quem acrescenta o nono é a
    // canonicalização do cadastro, e ela não pode decidir endereço de envio.
    expect(m?.identity.phone).toBe("+556684057837");
  });

  it("chat de telefone continua vindo inteiro", () => {
    const m = parseVerdashInbound(evento("556684057837@s.whatsapp.net"));
    expect(m?.chat).toBe("556684057837@s.whatsapp.net");
  });
});

describe("autenticação do webhook", () => {
  it("aceita o segredo correto", () => {
    expect(verifyVerdashToken("a".repeat(32), "a".repeat(32))).toBe(true);
  });

  it("recusa segredo errado, ausente, ou de tamanho diferente", () => {
    expect(verifyVerdashToken("a".repeat(32), "b".repeat(32))).toBe(false);
    expect(verifyVerdashToken(null, "a".repeat(32))).toBe(false);
    expect(verifyVerdashToken("a".repeat(32), null)).toBe(false);
    // Tamanhos diferentes NÃO podem estourar: `timingSafeEqual` lança nesse
    // caso, e uma exceção aqui viraria 500 — reentrega infinita do provedor.
    expect(verifyVerdashToken("a", "a".repeat(32))).toBe(false);
  });
});

describe("leitura do webhook", () => {
  const evento = (message: unknown, extra: Record<string, unknown> = {}) => ({
    type: "Message",
    ...extra,
    event: {
      Info: {
        ID: "3EB0ABC123",
        Chat: "556681276920@s.whatsapp.net",
        Sender: "556681276920@s.whatsapp.net",
        PushName: "Paciente",
        IsFromMe: false,
      },
      Message: message,
    },
  });

  it("lê o texto simples", () => {
    const m = parseVerdashInbound(evento({ conversation: "Bom dia, doutor" }));
    expect(m?.text).toBe("Bom dia, doutor");
    expect(m?.direction).toBe("inbound");
    expect(m?.externalId).toBe("3EB0ABC123");
    expect(m?.identity.phone).toBe("+556681276920");
    expect(m?.identity.displayName).toBe("Paciente");
  });

  it("lê o texto estendido, que é onde ele está quando há citação ou link", () => {
    const m = parseVerdashInbound(evento({ extendedTextMessage: { text: "com link" } }));
    expect(m?.text).toBe("com link");
  });

  it("desembrulha mensagem efêmera — senão some justamente a que some sozinha", () => {
    const m = parseVerdashInbound(
      evento({ ephemeralMessage: { message: { conversation: "some depois" } } }),
    );
    expect(m?.text).toBe("some depois");
  });

  it("a saída (fromMe) TAMBÉM é lida — senão o histórico fica pela metade", () => {
    const base = evento({ conversation: "resposta do celular" });
    base.event.Info.IsFromMe = true;
    expect(parseVerdashInbound(base)?.direction).toBe("outbound");
  });

  it("mensagem que SAIU não batiza o contato com o nome do dono da linha", () => {
    // O `PushName` é de quem escreveu. Numa mensagem nossa, quem escreveu é o
    // consultório — e usá-lo como nome do contato fez duas conversas de
    // pacientes diferentes aparecerem no inbox como "Dr Paulo Torres", com o
    // telefone certo e o nome de outra pessoa. Medido no primeiro número
    // conectado, visto na tela, não nos testes.
    const saida = evento({ conversation: "retorno agendado" });
    saida.event.Info.IsFromMe = true;
    saida.event.Info.PushName = "Dr Paulo Torres";
    const m = parseVerdashInbound(saida);
    expect(m?.direction).toBe("outbound");
    expect(m?.identity.displayName).toBeNull();
    // O telefone continua vindo: é ele que endereça, e está certo.
    expect(m?.identity.phone).toBe("+556681276920");
  });

  it("mensagem que ENTROU usa o nome de quem escreveu", () => {
    const m = parseVerdashInbound(evento({ conversation: "bom dia" }));
    expect(m?.identity.displayName).toBe("Paciente");
  });

  it("evento que não é mensagem devolve null, e isso NÃO é falha", () => {
    // Recibo e presença são a maioria do tráfego.
    expect(parseVerdashInbound({ type: "ReadReceipt", event: {} })).toBeNull();
    expect(parseVerdashInbound({ type: "Presence", event: {} })).toBeNull();
  });

  it("mensagem sem ID é descartada — sem ele não há idempotência possível", () => {
    const semId = evento({ conversation: "x" });
    semId.event.Info.ID = "";
    expect(parseVerdashInbound(semId)).toBeNull();
  });

  describe("mídia", () => {
    it("usa a URL que o provedor resolveu, NUNCA a do protobuf", () => {
      // A `url` de dentro do protobuf aponta para o arquivo CRIPTOGRAFADO
      // (.enc), que não abre em lugar nenhum sem a mediaKey. Gravá-la faria o
      // atendente ver anexo quebrado.
      const m = parseVerdashInbound(
        evento(
          { imageMessage: { mimetype: "image/jpeg", caption: "exame", url: "https://x/y.enc" } },
          { downloadURL: "https://fzap/baixar/abc", downloadFileName: "exame.jpg" },
        ),
      );
      expect(m?.attachments[0]?.url).toBe("https://fzap/baixar/abc");
      expect(m?.attachments[0]?.url).not.toContain(".enc");
      expect(m?.attachments[0]?.type).toBe("image");
      expect(m?.attachments[0]?.caption).toBe("exame");
      expect(m?.attachments[0]?.mime).toBe("image/jpeg");
    });

    it("reconhece áudio, vídeo e documento pelo campo do protobuf", () => {
      expect(parseVerdashInbound(evento({ audioMessage: { mimetype: "audio/ogg" } }))?.attachments[0]?.type).toBe("audio");
      expect(parseVerdashInbound(evento({ videoMessage: {} }))?.attachments[0]?.type).toBe("video");
      expect(
        parseVerdashInbound(evento({ documentMessage: { fileName: "receita.pdf" } }))
          ?.attachments[0]?.fileName,
      ).toBe("receita.pdf");
    });
  });

  describe("contrato do fio", () => {
    it("JSON inválido é distinguido de contrato violado", () => {
      const a = lerEnvelopeVerdash("{isto não é json");
      expect(a.ok).toBe(false);
      if (!a.ok) expect(a.motivo).toBe("json_invalido");
    });

    it("payload sem tipo é RECUSADO, não ignorado em silêncio", () => {
      // Ignorar devolveria 200 `evento_sem_interesse` — idêntico à resposta de
      // um evento que de fato não interessa. A mensagem do cliente sumiria com
      // carimbo de normalidade.
      const r = lerEnvelopeVerdash(JSON.stringify({ event: { Info: {} } }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.campos).toContain("type");
    });

    it("payload bom passa", () => {
      expect(lerEnvelopeVerdash(JSON.stringify({ type: "Message" })).ok).toBe(true);
    });
  });
});

describe("a exceção da guarda de saída compara ORIGEM, não prefixo", () => {
  // Achado do @Cassio_SecRev: `url.startsWith(baseUrl)` deixava passar três
  // formas em que o hostname REAL é outro — e o fetch da mídia leva o token da
  // instância no header. Os casos abaixo são os que ele mediu no parser.
  const base = new URL("https://fzap.verdash.com.br");
  const mesmaOrigem = (bruta: string): boolean => {
    let alvo: URL;
    try {
      alvo = new URL(bruta);
    } catch {
      return false;
    }
    return alvo.origin === base.origin && alvo.username === "" && alvo.password === "";
  };

  it("a base de verdade continua dispensada da guarda", () => {
    expect(mesmaOrigem("https://fzap.verdash.com.br/baixar/abc")).toBe(true);
  });

  it("userinfo NÃO engana: o host real é outro", () => {
    expect(mesmaOrigem("https://fzap.verdash.com.br@evil.com/x")).toBe(false);
    expect(mesmaOrigem("https://fzap.verdash.com.br:8081@169.254.169.254/latest/meta-data/")).toBe(
      false,
    );
  });

  it("sufixo de domínio NÃO engana", () => {
    expect(mesmaOrigem("https://fzap.verdash.com.br.evil.com/x")).toBe(false);
  });

  it("porta e esquema diferentes são origem diferente", () => {
    expect(mesmaOrigem("http://fzap.verdash.com.br/x")).toBe(false);
    expect(mesmaOrigem("https://fzap.verdash.com.br:9999/x")).toBe(false);
  });
});

describe("banco e TypeScript falam o mesmo vocabulário", () => {
  // O `pnpm test:db` prova isto contra um Postgres real; aqui é a leitura do
  // artefato que o self-hoster de fato aplica — o baseline, não as migrations.
  const baseline = readFileSync("supabase/baseline.sql", "utf8");

  it("o CHECK de provider do baseline conhece o canal novo", () => {
    expect(baseline).toMatch(/channel_sessions_provider_check[\s\S]{0,400}'verdash'/);
  });

  it("o CHECK de ref exige a coluna do canal novo", () => {
    expect(baseline).toMatch(/provider = 'verdash'\s+and verdash_instance_name is not null/);
  });

  it("o baseline preserva os quatro providers anteriores", () => {
    // Um canal novo que apaga o vocabulário dos outros derruba toda instalação
    // que já usa um deles.
    for (const p of ["waha", "meta_cloud", "zernio", "wacalls"]) {
      expect(baseline).toContain(`'${p}'::text`);
    }
  });

  it("a coluna nasce antes do CHECK que a referencia", () => {
    const col = baseline.indexOf("add column if not exists verdash_instance_name");
    // A ÚLTIMA (e única) reconstrução do CHECK de ref — é ela que referencia a coluna.
    const check = baseline.lastIndexOf("add constraint channel_sessions_provider_ref_check");
    expect(col).toBeGreaterThan(-1);
    expect(col).toBeLessThan(check);
  });

  it("uma instância pertence a UMA organização — senão as caixas se misturam", () => {
    expect(baseline).toContain("channel_sessions_verdash_instance_unique");
  });

  it("a migration versionada existe junto do apêndice — clone atualiza pelas duas vias", () => {
    const mig = readFileSync(
      "supabase/migrations/20260916120001_9001_canal_verdash_vocabulario.sql",
      "utf8",
    );
    expect(mig).toContain("verdash_instance_name");
    expect(mig).toContain("verdash_token_encrypted");
    expect(readFileSync("supabase/migrations/MANIFEST.md", "utf8")).toContain(
      "9001_canal_verdash_vocabulario",
    );
  });

  it("a migration é ADITIVA sobre o CHECK — um provider novo do upstream não some", () => {
    // Uma lista fixa aqui apagaria, no próximo merge, o provider que o upstream
    // tiver acrescentado — e o banco passaria a recusar as sessões dele.
    const mig = readFileSync(
      "supabase/migrations/20260916120001_9001_canal_verdash_vocabulario.sql",
      "utf8",
    );
    expect(mig).toContain("pg_get_constraintdef");
  });
});
