import "@fontsource-variable/inter";
import "./index.css";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { convex } from "./data/convex";

// После выкатки старые файлы удаляются: если вкладка открыта давно и не может догрузить экран,
// один раз перезагружаем страницу (не чаще раза в 30 секунд — без бесконечного цикла).
window.addEventListener("vite:preloadError", (event) => {
  try {
    const key = "hm:chunk-reload-at";
    if (Date.now() - Number(sessionStorage.getItem(key) ?? 0) < 30_000) return;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    /* sessionStorage недоступен — просто перезагружаем */
  }
  event.preventDefault();
  window.location.reload();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexAuthProvider client={convex}>
      <App />
    </ConvexAuthProvider>
  </StrictMode>,
);
