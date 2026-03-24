import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { APP_VERSION } from "./lib/version";

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const serviceWorkerUrl =
      `${import.meta.env.BASE_URL}service-worker.js?v=${encodeURIComponent(APP_VERSION)}`;

    void navigator.serviceWorker.register(serviceWorkerUrl, {
      scope: import.meta.env.BASE_URL,
    });
  });
}

createRoot(document.getElementById("root")!).render(<App />);
