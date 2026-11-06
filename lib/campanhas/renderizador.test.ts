import { describe, expect, it } from "vitest";

import { spintaxValido } from "@/lib/texto/variacao";

import {
  MAX_VARIACOES_EXTRAS,
  camposUsadosNoTexto,
  renderizar,
  renderizarVariacao,
  resolverSaudacao,
  saudacaoDaHora,
  spintaxDasVariantes,
  variantesDaCampanha,
  variaveisUsadas,
} from "./renderizador";

const FUSO = "America/Sao_Paulo";
/** 15h em São Paulo (UTC-3). */
const TARDE = new Date("2026-09-18T18:00:00.000Z");
/** 9h em São Paulo. */
const MANHA = new Date("2026-09-18T12:00:00.000Z");

describe("renderizador da campanha", () => {
  it("substitui nome e primeiro nome", () => {
    const r = renderizar("Olá {{nome}}, tudo bem? Posso te chamar de {{primeiro_nome}}?", {
      nome: "Maria da Glória Prandini",
      });
    expect(r.texto).toBe("Olá Maria da Glória Prandini, tudo bem? Posso te chamar de Maria?");
    expect(r.faltando).toEqual([]);
  });

  it("tolera espaço dentro do token", () => {
    const r = renderizar("Oi {{  primeiro_nome  }}", { nome: "João Silva" });
    expect(r.texto).toBe("Oi João");
  });

  it("não envia texto com buraco: variável sem valor volta como FALTANDO e o literal fica", () => {
    const r = renderizar("Olá {{nome}}, tudo bem?", { nome: "   " });
    expect(r.faltando).toEqual(["nome"]);
    // O literal preservado é o que deixa o defeito visível na prévia em vez de
    // virar "Olá , tudo bem?" na conversa de um cliente.
    expect(r.texto).toBe("Olá {{nome}}, tudo bem?");
  });


  it("token desconhecido fica literal e é reportado, nunca vira vazio", () => {
    const r = renderizar("Oi {{sobrenome}}", { nome: "Ana Souza" });
    expect(r.texto).toBe("Oi {{sobrenome}}");
    expect(r.desconhecidas).toEqual(["sobrenome"]);
    expect(r.faltando).toEqual([]);
  });

  it("texto sem token passa intacto, unicode incluído", () => {
    const t = "Oferta 🍇 com acento: vinícola é ótimo — 100%";
    expect(renderizar(t, { nome: null }).texto).toBe(t);
  });

  it("a saudação é a da HORA DO ENVIO, não a do texto", () => {
    const manha = renderizar("{{saudacao}}!", { nome: null }, { agora: MANHA, fuso: FUSO });
    const tarde = renderizar("{{saudacao}}!", { nome: null }, { agora: TARDE, fuso: FUSO });
    expect(manha.texto).toBe("Bom dia!");
    expect(tarde.texto).toBe("Boa tarde!");
  });

  it("sem instante (prévia) a saudação fica literal — a prévia não inventa a hora do envio", () => {
    const r = renderizar("{{saudacao}}!", { nome: null });
    expect(r.texto).toBe("{{saudacao}}!");
    expect(r.faltando).toEqual([]);
  });

  it("os cortes da saudação são os do português falado, no fuso pedido", () => {
    expect(saudacaoDaHora(new Date("2026-09-18T14:59:00.000Z"), FUSO)).toBe("Bom dia"); // 11h59
    expect(saudacaoDaHora(new Date("2026-09-18T15:00:00.000Z"), FUSO)).toBe("Boa tarde"); // 12h
    expect(saudacaoDaHora(new Date("2026-09-18T21:00:00.000Z"), FUSO)).toBe("Boa noite"); // 18h
    // Mesmo instante, outro fuso: a régua é o fuso do canal, não o do servidor.
    expect(saudacaoDaHora(new Date("2026-09-18T15:00:00.000Z"), "UTC")).toBe("Boa tarde");
    expect(saudacaoDaHora(new Date("2026-09-18T11:00:00.000Z"), "UTC")).toBe("Bom dia");
  });

  it("lista as variáveis que o texto usa, sem repetir e sem inventar", () => {
    expect(variaveisUsadas("{{nome}} e {{nome}} e {{saudacao}} e {{xpto}}").sort()).toEqual([
      "nome",
      "saudacao",
    ]);
    expect(variaveisUsadas("texto seco")).toEqual([]);
  });

  it("não executa nada: chave com sintaxe de caminho não atravessa propriedade", () => {
    const r = renderizar("{{constructor.name}} {{__proto__}}", { nome: "Ana" });
    expect(r.texto).toBe("{{constructor.name}} {{__proto__}}");
  });
});

describe("variações da campanha", () => {
  /** A lista efetiva, como a preparação a monta. */
  const lista = (corpo: string, ...extras: string[]) => variantesDaCampanha(corpo, extras);

  it("a lista efetiva é [message_body, ...message_variants], e extra em branco cai fora", () => {
    expect(variantesDaCampanha("Oi", ["A", "   ", "B", null])).toEqual(["Oi", "A", "B"]);
    // Corpo nulo não some da lista: ele é a variante 0 e o gate de conteúdo é
    // que recusa campanha sem texto — aqui não se inventa lista vazia.
    expect(variantesDaCampanha(null, null)).toEqual([""]);
  });

  it("extra além do teto é descartada, não aceita em silêncio", () => {
    const seis = ["a", "b", "c", "d", "e", "f"];
    expect(variantesDaCampanha("corpo", seis)).toHaveLength(1 + MAX_VARIACOES_EXTRAS);
  });

  it("a MESMA pessoa recebe a MESMA variação, sempre (repreparar não troca o texto)", () => {
    const entrada = {
      variantes: lista("Oi {{primeiro_nome}}, tudo bem?", "Olá {{primeiro_nome}}!", "E aí {{primeiro_nome}}?"),
      semente: "11111111-1111-4111-8111-111111111111",
      valores: { nome: "Ana Souza" },
    };
    const a = renderizarVariacao(entrada);
    const b = renderizarVariacao(entrada);
    expect(a).toEqual(b);
    expect(a.varianteIndex).toBeGreaterThanOrEqual(0);
    expect(a.varianteIndex).toBeLessThan(3);
  });

  it("sementes diferentes espalham pelas três variantes — não caem todas na primeira", () => {
    const variantes = lista("um", "dois", "tres");
    const vistos = new Set<number>();
    for (let i = 0; i < 300; i += 1) {
      vistos.add(renderizarVariacao({ variantes, semente: `contato-${i}`, valores: { nome: "Ana" } }).varianteIndex);
    }
    expect(vistos).toEqual(new Set([0, 1, 2]));
  });

  it("campanha SEM variações continua exatamente como antes: índice 0 e o mesmo texto", () => {
    const corpo = "Olá {{nome}}, {{saudacao}}!";
    const r = renderizarVariacao({
      variantes: variantesDaCampanha(corpo, []),
      semente: "qualquer-contato",
      valores: { nome: "Ana Souza" },
    });
    expect(r.varianteIndex).toBe(0);
    // Byte-a-byte o que `renderizar` já devolvia — inclusive a saudação literal.
    expect(r.texto).toBe(renderizar(corpo, { nome: "Ana Souza" }).texto);
    expect(r.texto).toBe("Olá Ana Souza, {{saudacao}}!");
  });

  it("spintax ANINHADO resolve, e sempre para o mesmo lado na mesma semente", () => {
    const variantes = ["{Oi|{Olá|{Bom te ver|E aí}}} {{primeiro_nome}}"];
    const r = renderizarVariacao({ variantes, semente: "c-7", valores: { nome: "Ana Souza" } });
    expect(r.texto).toMatch(/^(Oi|Olá|Bom te ver|E aí) Ana$/);
    expect(renderizarVariacao({ variantes, semente: "c-7", valores: { nome: "Ana Souza" } }).texto).toBe(
      r.texto,
    );
  });

  it("a variável atravessa o spintax INTACTA — valor de cadastro não vira template", () => {
    // O nome tem `{a|b}` dentro: ele é DADO, e a passada de spintax já terminou
    // quando ele entra. Sai literal, nunca sorteado.
    const r = renderizarVariacao({
      variantes: ["{Oi|Olá} {{nome}}"],
      semente: "c-1",
      valores: { nome: "{Ana|Bia} Souza" },
    });
    // Sem instante (preparação) o valor sai BLINDADO (upstream #2404: word
    // joiner depois de cada `{`), e a passada final do envio tira a blindagem.
    expect(r.texto.replaceAll("\u2060", "")).toContain("{Ana|Bia} Souza");
    expect(resolverSaudacao(r.texto, { agora: new Date(), fuso: "America/Sao_Paulo" })).toContain("{Ana|Bia} Souza");
  });

  it("spintax INVÁLIDO não é mascarado: o gate acusa e o texto sai como foi escrito", () => {
    const quebradas = ["ok {a|b}", "chave {sem fechar", "fecha} sem abrir", "{a|{b|{c|{d|e}}}}"];
    // Índices 1, 2 e 3: chave aberta sem fechar, fechamento sem abertura e
    // aninhamento acima do teto.
    expect(spintaxDasVariantes(quebradas)).toEqual([1, 2, 3]);
    expect(spintaxDasVariantes(variantesDaCampanha("Oi {{nome}}", ["{a|b}"]))).toEqual([]);

    const r = renderizarVariacao({
      variantes: ["Oi {{nome}}, {promoção sem fechar"],
      semente: "c-1",
      valores: { nome: "Ana" },
    });
    // O texto cru atravessa (a prévia mostra o que o operador digitou); quem
    // impede o envio é `spintaxDasVariantes`, chamado na preparação.
    expect(r.texto).toBe("Oi Ana, {promoção sem fechar");
  });

  it("variável SEM valor é reportada como faltando, com o literal preservado", () => {
    const r = renderizarVariacao({
      variantes: lista("Oi {{primeiro_nome}}", "{Olá|Oi} {{nome}}, tudo bem?"),
      semente: "sem-nome",
      valores: { nome: "   " },
    });
    // Qualquer das duas variantes usa o nome: as duas têm de acusar a falta, e
    // é isso que vira `variavel_ausente` na lista — nunca "Oi , tudo bem?".
    expect(r.faltando.length).toBeGreaterThan(0);
    expect(r.texto).toMatch(/\{\{(primeiro_)?nome\}\}/);
  });

  it("a saudação segue sendo do ENVIO: a variação escolhida mantém o token congelado", () => {
    const variantes = lista("{{saudacao}}, {{primeiro_nome}}!", "{{saudacao}}! Aqui é a equipe.");
    const preparado = renderizarVariacao({
      variantes,
      semente: "c-42",
      valores: { nome: "Ana Souza" },
    });
    expect(preparado.texto).toContain("{{saudacao}}");
    // E o envio, que roda sobre o corpo CONGELADO, resolve a saudação sem
    // reinterpretar spintax nenhum.
    expect(renderizar(preparado.texto, { nome: "Ana Souza" }, { agora: MANHA, fuso: FUSO }).texto).toContain(
      "Bom dia",
    );
  });
});

/**
 * Os três P1 do parecer do @Cassio_SecRev na PR #94. Cada um saiu de medição,
 * não de leitura: o motor aceitava os três como válidos e a mensagem chegava
 * errada no WhatsApp de lojista real.
 */
describe("os buracos que o parecer de segurança mediu", () => {
  it("P1-1 · alternativa vazia no spintax não vira mensagem mutilada nem em branco", () => {
    // `{Olá|Oi|}` — um pipe sobrando. Era spintax VÁLIDO: 89 de 300 sementes
    // rendiam a frase sem a saudação, e `{Olá|}` rendia string vazia em 139.
    expect(spintaxValido("{Olá|Oi|} {{primeiro_nome}}, tudo bem?")).toBe(false);
    expect(spintaxValido("{Olá|}")).toBe(false);
    expect(spintaxValido("{|Oi}")).toBe(false);
    expect(spintaxValido("{a||b}")).toBe(false);
    // E o que é legítimo continua passando — inclusive variável dentro do grupo.
    expect(spintaxValido("{Olá|Oi} {{primeiro_nome}}")).toBe(true);
    expect(spintaxValido("{Oi {{primeiro_nome}}|Olá}")).toBe(true);
    expect(spintaxValido("sem spintax nenhum")).toBe(true);

    // Última linha de defesa: mesmo que um texto vazio entre por outro caminho,
    // o render o marca e a elegibilidade exclui a pessoa.
    const r = renderizar("", { nome: "Ana" });
    expect(r.vazio).toBe(true);
  });

  it("P1-3 · {{variavel|fallback}} não sai literal no WhatsApp", () => {
    // O operador aprende o fallback na cadência e escreve igual aqui. Antes, o
    // TOKEN não lia o pipe: não caía em `faltando`, não caía em `desconhecidas`,
    // e `{{nome|lojista}}` ia inteiro para o cliente.
    const semNome = renderizar("Olá {{nome|lojista}}, tudo bem?", { nome: null });
    expect(semNome.texto).toBe("Olá lojista, tudo bem?");
    expect(semNome.faltando).toEqual([]);
    expect(semNome.vazio).toBe(false);

    const comNome = renderizar("Olá {{nome|lojista}}, tudo bem?", { nome: "Ana Paula" });
    expect(comNome.texto).toBe("Olá Ana Paula, tudo bem?");

    // Sem fallback, a falta continua sendo falta — não vira texto vazio calado.
    const sem = renderizar("Olá {{nome}}", { nome: null });
    expect(sem.faltando).toContain("nome");
  });

  it("P2-1 · o nome do contato não é relido como template no envio", () => {
    // `resolverSaudacao` troca SÓ a saudação. Um cadastro chamado
    // `Loja {{saudacao}}` virava `Loja Boa tarde` quando o envio rodava o
    // render inteiro de novo sobre o corpo já congelado.
    const congelado = "Oi Loja {{saudacao}}! {{saudacao}}";
    const agora = new Date("2026-10-05T18:00:00Z"); // 15h em São Paulo
    const saida = resolverSaudacao(congelado, { agora, fuso: "America/Sao_Paulo" });
    // A segunda ocorrência (a do operador) resolve; a que veio do cadastro
    // também — mas nenhuma OUTRA variável do corpo é reinterpretada.
    expect(saida).not.toContain("{{saudacao}}");
    const comChaveDoCliente = resolverSaudacao("Oi {Ana|Bia} Souza, {{nome}}", {
      agora,
      fuso: "America/Sao_Paulo",
    });
    expect(comChaveDoCliente).toBe("Oi {Ana|Bia} Souza, {{nome}}");
  });
});

describe("campos personalizados na campanha", () => {
  it("resolve {{lead.gancho}} e {{contato.link_previa}} sem tocar no resto do texto", () => {
    const r = renderizar(
      "Olá {{nome}}, achamos {{lead.gancho}} — prévia em {{contato.link_previa}}. {{saudacao}}!",
      {
        nome: "Ana Souza",
        lead: { gancho: "nota 3.2 no Google" },
        contato: { link_previa: "https://previa/ana" },
      },
      { agora: TARDE, fuso: FUSO },
    );
    expect(r.texto).toBe(
      "Olá Ana Souza, achamos nota 3.2 no Google — prévia em https://previa/ana. Boa tarde!",
    );
    expect(r.faltando).toEqual([]);
    expect(r.desconhecidas).toEqual([]);
  });

  it("REPROVA quando o texto novo não resolve: campo sem valor é FALTA, não texto pela metade", () => {
    // Campo que não existe no mapa do lead…
    const semCampo = renderizar("Olá {{nome}}, seu gancho: {{lead.gancho}}", {
      nome: "Ana Souza",
      lead: {},
    });
    expect(semCampo.faltando).toEqual(["lead.gancho"]);
    expect(semCampo.texto).toBe("Olá Ana Souza, seu gancho: {{lead.gancho}}");

    // …contato sem negócio nenhum (nem mapa chegou)…
    const semMapa = renderizar("Gancho: {{lead.gancho}}", { nome: "Ana Souza" });
    expect(semMapa.faltando).toEqual(["lead.gancho"]);

    // …e campo gravado em branco: os três são a MESMA falta, e é ela que tira a
    // pessoa da lista (`variavel_ausente`) antes do operador apertar.
    const emBranco = renderizar("Link: {{contato.link_previa}}", {
      nome: "Ana Souza",
      contato: { link_previa: "   " },
    });
    expect(emBranco.faltando).toEqual(["contato.link_previa"]);
    expect(emBranco.texto).toBe("Link: {{contato.link_previa}}");
  });

  it("a lista do multiselect sai como a pessoa leria; número e booleano viram texto", () => {
    const r = renderizar("{{lead.tags}}|{{lead.score}}|{{lead.ativo}}", {
      nome: null,
      lead: { tags: ["agência", "reativação"], score: 0, ativo: false },
    });
    expect(r.texto).toBe("agência, reativação|0|false");
    expect(r.faltando).toEqual([]);
    // Objeto embutido não vira "[object Object]" na conversa de ninguém.
    const obj = renderizar("{{lead.endereco}}", { nome: null, lead: { endereco: { rua: "A" } } });
    expect(obj.faltando).toEqual(["lead.endereco"]);
  });

  it("aceita o caminho da automação ({{lead.custom_fields.x}}) e caixa trocada no nome do campo", () => {
    const r = renderizar("{{lead.custom_fields.gancho}} e {{Lead.Gancho}}", {
      nome: null,
      lead: { gancho: "oi" },
    });
    expect(r.texto).toBe("oi e oi");
    expect(r.faltando).toEqual([]);
  });

  it("campo personalizado não atravessa protótipo, nem com o jsonb gravado torto", () => {
    const r = renderizar("{{lead.__proto__}} {{lead.constructor}} {{contato.prototype}}", {
      nome: "Ana",
      lead: {},
      contato: {},
    });
    expect(r.texto).toBe("{{lead.__proto__}} {{lead.constructor}} {{contato.prototype}}");
    // Falta (a pessoa sai da lista), não desconhecida (que ficaria pra depois).
    expect(r.faltando).toEqual(["lead.__proto__", "lead.constructor", "contato.prototype"]);
    expect(r.desconhecidas).toEqual([]);
  });

  it("raiz que não é lead nem contato continua literal e desconhecida, como no Inbox", () => {
    const r = renderizar("Oi {{contact.name}} {{sobrenome}}", { nome: "Ana Souza" });
    expect(r.texto).toBe("Oi {{contact.name}} {{sobrenome}}");
    expect(r.desconhecidas).toEqual(["contact.name", "sobrenome"]);
    expect(r.faltando).toEqual([]);
  });

  it("lista as variáveis do texto incluindo o caminho do campo personalizado", () => {
    expect(variaveisUsadas("{{nome}} {{lead.gancho}} {{lead.gancho}} {{contato.link_previa}}").sort()).toEqual(
      ["contato.link_previa", "lead.gancho", "nome"],
    );
    expect(variaveisUsadas("{{sobrenome}}")).toEqual([]);
  });

  it("só puxa campo personalizado do banco quando o TEXTO usa a raiz", () => {
    expect(camposUsadosNoTexto("Olá {{nome}}, {{saudacao}}!")).toEqual({ lead: false, contato: false });
    expect(camposUsadosNoTexto("Olá {{nome}}, {{lead.gancho}}")).toEqual({ lead: true, contato: false });
    expect(camposUsadosNoTexto("{{  contato.link_previa  }}")).toEqual({ lead: false, contato: true });
    // `{{lead}}` sem ponto não é campo: não vale uma coluna de jsonb.
    expect(camposUsadosNoTexto("oi {{lead}}")).toEqual({ lead: false, contato: false });
  });
});

describe("o valor do cadastro sai LITERAL, mesmo com o corpo renderizado duas vezes", () => {
  // As duas passadas reais: a preparação congela (sem instante) e o envio
  // (`rodada.ts`) renderiza o congelado de novo, só com nome e instante.
  const VALOR = "{{saudacao}} {{nome}} {{lead.outro}} $& $1";
  const envio = (congelado: string) =>
    renderizar(congelado, { nome: "Ana Souza" }, { agora: TARDE, fuso: FUSO });

  it("campo com sintaxe de token chega ao contato como foi gravado", () => {
    const prep = renderizar("Oi {{nome}}, {{lead.gancho}}", { nome: "Ana Souza", lead: { gancho: VALOR } });
    expect(prep.faltando).toEqual([]);
    const saida = envio(prep.texto);
    expect(saida.texto).toBe(`Oi Ana Souza, ${VALOR}`);
    expect(saida.faltando).toEqual([]);
    expect(saida.texto).not.toContain("⁠");
  });

  it("a saudação do TEXTO continua resolvida no envio — o par do 'não reinterprete'", () => {
    const prep = renderizar("{{saudacao}}, {{contato.link_previa}}", {
      nome: null,
      contato: { link_previa: "{{saudacao}}" },
    });
    expect(envio(prep.texto).texto).toBe("Boa tarde, {{saudacao}}");
  });

  it("nome do cadastro com sintaxe de token também sai literal", () => {
    const prep = renderizar("Oi {{nome}}!", { nome: "{{saudacao}}" });
    expect(renderizar(prep.texto, { nome: null }, { agora: TARDE, fuso: FUSO }).texto).toBe("Oi {{saudacao}}!");
  });

  it("no envio de teste (uma passada só, com instante) o valor também sai literal", () => {
    const r = renderizar("{{lead.gancho}}", { nome: null, lead: { gancho: VALOR } }, { agora: TARDE, fuso: FUSO });
    expect(r.texto).toBe(VALOR);
  });
});

describe('texto de reserva: {{variavel|"reserva"}}', () => {
  it("sem o dado, sai a reserva — e não conta como falta", () => {
    const r = renderizar('Olá {{primeiro_nome|"aluno"}}, tudo bem?', { nome: null });
    expect(r.texto).toBe("Olá aluno, tudo bem?");
    expect(r.faltando).toEqual([]);
    expect(r.desconhecidas).toEqual([]);
  });

  it("com o dado, a reserva é ignorada", () => {
    expect(renderizar('Olá {{primeiro_nome|"aluno"}}', { nome: "Ana Souza" }).texto).toBe("Olá Ana");
    expect(renderizar('{{nome|"aluno"}}', { nome: "Ana Souza" }).texto).toBe("Ana Souza");
  });

  it("vale para nome e campos do contato e do negócio", () => {
    const r = renderizar('{{nome|"cliente"}} {{contato.link|"sem link"}} {{lead.gancho|"seu negócio"}}', {
      nome: "  ",
      contato: { link: "" },
      lead: null,
    });
    expect(r.texto).toBe("cliente sem link seu negócio");
    expect(r.faltando).toEqual([]);
  });

  it("aceita aspas tipográficas e espaço em volta", () => {
    expect(renderizar("Oi {{primeiro_nome|“aluno”}}", { nome: null }).texto).toBe("Oi aluno");
    expect(renderizar('Oi {{ primeiro_nome | " aluno " }}', { nome: null }).texto).toBe("Oi aluno");
  });

  it("regressão: sem `|` o texto e a falta são os de antes", () => {
    const r = renderizar("Olá {{primeiro_nome}}, {{lead.gancho}}", { nome: null });
    expect(r.texto).toBe("Olá {{primeiro_nome}}, {{lead.gancho}}");
    expect(r.faltando).toEqual(["primeiro_nome", "lead.gancho"]);
  });

  it("a saudação aceita reserva mas nunca a usa", () => {
    expect(renderizar('{{saudacao|"Olá"}}', { nome: null }).texto).toBe('{{saudacao|"Olá"}}');
    expect(renderizar('{{saudacao|"Olá"}}', { nome: null }, { agora: TARDE, fuso: FUSO }).texto).toBe("Boa tarde");
  });

  it("a reserva sai literal ($& e $1 incluídos), nas duas passadas do envio", () => {
    const prep = renderizar('{{saudacao}}, {{primeiro_nome|"aluno $& $1"}}', { nome: null });
    expect(prep.faltando).toEqual([]);
    const envio = renderizar(prep.texto, { nome: "Ana" }, { agora: TARDE, fuso: FUSO });
    expect(envio.texto).toBe("Boa tarde, aluno $& $1");
  });

  it("reserva torta não casa e o texto fica como foi escrito", () => {
    for (const expressao of [
      '{{nome|"a{b"}}',
      '{{nome|"um "aluno""}}',
      "{{nome|aluno}}",
      "{{nome|'aluno'}}",
      '{{nome|""}}',
      '{{nome|"   "}}',
      `{{nome|"${"x".repeat(101)}"}}`,
    ]) {
      expect(renderizar(expressao, { nome: null }).texto, expressao).toBe(expressao);
    }
  });

  it("reserva de até 100 caracteres é aceita", () => {
    const cem = "x".repeat(100);
    expect(renderizar(`{{nome|"${cem}"}}`, { nome: null }).texto).toBe(cem);
  });

  it("variável desconhecida com reserva fica literal (não vira a reserva)", () => {
    const r = renderizar('Oi {{sobrenome|"x"}}', { nome: "Ana" });
    expect(r.texto).toBe('Oi {{sobrenome|"x"}}');
    expect(r.desconhecidas).toEqual(["sobrenome"]);
  });

  it("variaveisUsadas e camposUsadosNoTexto enxergam a variável com reserva", () => {
    expect(variaveisUsadas('{{primeiro_nome|"aluno"}} {{lead.gancho|"x"}}')).toEqual(["primeiro_nome", "lead.gancho"]);
    expect(camposUsadosNoTexto('{{contato.link|"x"}}')).toEqual({ lead: false, contato: true });
  });
});
