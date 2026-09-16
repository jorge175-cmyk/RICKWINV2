import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * A antiga página de análise HFT/tick foi removida.
 * A análise principal do sistema agora é o Espelho OTC (/mirror).
 */
export const Route = createFileRoute("/_layout/trading")({
  beforeLoad: async () => {
    throw redirect({ to: "/mirror" });
  },
});
