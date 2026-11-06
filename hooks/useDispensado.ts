"use client";

import * as React from "react";

/**
 * "Dispensar" de um aviso, lembrado no navegador (localStorage). Lê com
 * `useSyncExternalStore`: o servidor pinta "não dispensado" e o cliente corrige
 * sem divergir da hidratação.
 */
export function useDispensado(chave: string): [boolean, () => void] {
  const dispensado = React.useSyncExternalStore(
    (aoMudar) => {
      window.addEventListener("storage", aoMudar);
      window.addEventListener(EVENTO, aoMudar);
      return () => {
        window.removeEventListener("storage", aoMudar);
        window.removeEventListener(EVENTO, aoMudar);
      };
    },
    () => {
      try {
        return window.localStorage.getItem(chave) === "1";
      } catch {
        return false; // armazenamento bloqueado: o aviso aparece, sem lembrar
      }
    },
    () => false,
  );
  const dispensar = React.useCallback(() => {
    try {
      window.localStorage.setItem(chave, "1");
    } catch {
      /* sem armazenamento, só some até recarregar */
    }
    window.dispatchEvent(new Event(EVENTO));
  }, [chave]);
  return [dispensado, dispensar];
}

const EVENTO = "aviso-dispensado";
