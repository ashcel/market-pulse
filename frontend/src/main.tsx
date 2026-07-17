import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";

import AppLayout from "@/components/layout/AppLayout";
import Dashboard from "@/pages/Dashboard";
import Tokens from "@/pages/Tokens";
import TokenDetail from "@/pages/TokenDetail";
import Regime from "@/pages/Regime";
import Trades from "@/pages/Trades";
import Settings from "@/pages/Settings";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000 },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/tokens" element={<Tokens />} />
            <Route path="/tokens/:symbol" element={<TokenDetail />} />
            <Route path="/regime" element={<Regime />} />
            <Route path="/trades" element={<Trades />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);