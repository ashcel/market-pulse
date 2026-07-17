import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";

import AppLayout from "@/components/layout/AppLayout";
import Dashboard from "@/pages/Dashboard";
import Markets from "@/pages/Markets";
import Regime from "@/pages/Regime";
import Rotation from "@/pages/Rotation";
import Rankings from "@/pages/Rankings";
import Technical from "@/pages/Technical";
import Tracker from "@/pages/Tracker";
import News from "@/pages/News";
import Settings from "@/pages/Settings";
import TokenDetail from "@/pages/TokenDetail";
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
            <Route path="/markets" element={<Markets />} />
            <Route path="/regime" element={<Regime />} />
            <Route path="/rotation" element={<Rotation />} />
            <Route path="/rankings" element={<Rankings />} />
            <Route path="/technical" element={<Technical />} />
            <Route path="/tracker" element={<Tracker />} />
            <Route path="/news" element={<News />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/token/:symbol" element={<TokenDetail />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);