"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useT } from "@/hooks/i18n/useT";
import { loginSchema, type LoginInput } from "@/lib/auth/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signInWithPassword } from "@/app/actions/auth/signInWithPassword";
import { Eye, EyeSlash } from "@/lib/ui/icons";
import { AvisoSemResposta, useEnvioComTeto } from "@/components/auth/teto-da-espera";

export function LoginForm({ next, email }: { next?: string; email?: string }) {
  const t = useT();
  const router = useRouter();
  const { pendente: isPending, semResposta, enviar } = useEnvioComTeto();
  const [serverError, setServerError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: email ?? "", password: "" },
  });

  const onSubmit = (values: LoginInput) => {
    setServerError(null);
      // Server Action redirects on success — no return value reaches here.
      // On failure, an error discriminator is returned and rendered inline.
    void enviar(() => signInWithPassword(values, next), (res) => {
      if (!res) {
        // Should be unreachable (redirect throws), but guard anyway.
        router.replace(next || "/app");
        return;
      }
      if (res.error === "mfa_required") {
        const params = new URLSearchParams();
        if (next) params.set("next", next);
        if (res.challengeId) params.set("factor", res.challengeId);
        router.replace(`/login/mfa${params.toString() ? `?${params}` : ""}`);
        return;
      }
      if (res.error === "invalid_credentials") {
        setServerError(t("Email ou senha incorretos."));
      } else if (res.error === "rate_limited") {
        setServerError(t("Muitas tentativas. Aguarde alguns minutos."));
      } else if (res.error === "validation_error") {
        setServerError(t("Dados inválidos. Confira os campos."));
      } else {
        setServerError(t("Erro inesperado. Tente novamente."));
      }
    });
  };

  return (
    <form method="post" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="email">{t("Email")}</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          autoFocus
          aria-invalid={errors.email ? true : undefined}
          {...register("email")}
        />
        {errors.email && (
          <p className="text-xs text-destructive">{t(errors.email.message ?? "")}</p>
        )}
      </div>
      {/*
        "Esqueci minha senha" aparece na linha do rótulo, mas vem DEPOIS do campo no
        DOM: a grade o põe em cima (`row-start-1`), e o Tab segue e-mail, senha,
        mostrar senha, esqueci, entrar — o link não fica entre os dois campos.
      */}
      <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-1.5">
        <Label htmlFor="password">{t("Senha")}</Label>
        <div className="relative col-span-2 row-start-2">
          <Input
            id="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            className="pr-12"
            aria-invalid={errors.password ? true : undefined}
            {...register("password")}
          />
          <button
            type="button"
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:outline-hidden focus-visible:ring-inset"
            aria-pressed={showPassword}
            onClick={() => setShowPassword((visible) => !visible)}
          >
            {/* Nome em sr-only, não aria-label: getByLabel(/senha/i) casa aria-label e acharia o botão junto do campo. */}
            <span className="sr-only">{t(showPassword ? "Ocultar senha" : "Mostrar senha")}</span>
            {showPassword ? <EyeSlash size={20} aria-hidden /> : <Eye size={20} aria-hidden />}
          </button>
        </div>
        <Link
          href="/login/forgot"
          className="col-start-2 row-start-1 rounded-xs text-label font-semibold text-accent-text underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:outline-hidden"
        >
          {t("Esqueci minha senha")}
        </Link>
        {errors.password && (
          <p className="col-span-2 row-start-3 text-xs text-destructive">
            {t(errors.password.message ?? "")}
          </p>
        )}
      </div>
      {serverError && (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {serverError}
        </div>
      )}
      {semResposta && <AvisoSemResposta />}
      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? t("Entrando...") : t("Entrar")}
      </Button>
    </form>
  );
}
