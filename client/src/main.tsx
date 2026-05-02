import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { LocalDiagnosticErrorBoundary } from "./components/local-diagnostic-error-boundary";
import { APP_VERSION } from "./lib/version";
import {
  capturePwaRuntimeDiagnostics,
  getCurrentPwaDisplayMode,
  queuePwaDebugLog,
} from "./lib/pwa-debug";
import { initializeLocalDiagnostics } from "./lib/local-diagnostics";

function describeServiceWorkerRegistration(
  registration: ServiceWorkerRegistration,
): string {
  return [
    `scope=${registration.scope}`,
    `controller=${navigator.serviceWorker.controller ? "yes" : "no"}`,
    `installing=${registration.installing?.state ?? "none"}`,
    `waiting=${registration.waiting?.state ?? "none"}`,
    `active=${registration.active?.state ?? "none"}`,
  ].join(" | ");
}

function trackServiceWorkerState(
  label: string,
  worker: ServiceWorker | null,
): void {
  if (!worker) {
    return;
  }

  queuePwaDebugLog(label, `state=${worker.state} | script=${worker.scriptURL}`);
  worker.addEventListener("statechange", () => {
    queuePwaDebugLog(`${label} State Changed`, `state=${worker.state}`);
  });
}

function listenForDisplayModeChanges(): void {
  if (typeof window.matchMedia !== "function") {
    return;
  }

  const mediaQuery = window.matchMedia("(display-mode: standalone)");
  const handleChange = () => {
    queuePwaDebugLog("Display Mode Changed", `mode=${getCurrentPwaDisplayMode()}`);
  };
  const legacyMediaQuery = mediaQuery as MediaQueryList & {
    addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
  };

  if (typeof legacyMediaQuery.addEventListener === "function") {
    legacyMediaQuery.addEventListener("change", handleChange);
    return;
  }

  legacyMediaQuery.addListener?.(handleChange);
}

function initializePwaDebugLogging(): void {
  queuePwaDebugLog(
    "PWA Boot",
    [
      `version=${APP_VERSION}`,
      `mode=${getCurrentPwaDisplayMode()}`,
      `online=${navigator.onLine ? "yes" : "no"}`,
      `visibility=${document.visibilityState}`,
      `secure=${window.isSecureContext ? "yes" : "no"}`,
    ].join(" | "),
  );
  queuePwaDebugLog("PWA User Agent", navigator.userAgent);

  window.addEventListener("online", () => {
    queuePwaDebugLog("Network Online");
  });
  window.addEventListener("offline", () => {
    queuePwaDebugLog("Network Offline");
  });
  window.addEventListener("beforeinstallprompt", () => {
    queuePwaDebugLog("Install Prompt Available");
  });
  window.addEventListener("appinstalled", () => {
    queuePwaDebugLog("PWA Installed");
    void capturePwaRuntimeDiagnostics(APP_VERSION, "PWA Post-Install Snapshot");
  });
  document.addEventListener("visibilitychange", () => {
    queuePwaDebugLog("Visibility Changed", `state=${document.visibilityState}`);
  });
  listenForDisplayModeChanges();
  void capturePwaRuntimeDiagnostics(APP_VERSION, "PWA Initial Snapshot");

  if (!("serviceWorker" in navigator)) {
    queuePwaDebugLog("Service Worker Unsupported");
    return;
  }

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    queuePwaDebugLog("Service Worker Controller Changed");
  });
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== "pwa-debug-log" || typeof data.event !== "string") {
      return;
    }

    queuePwaDebugLog(
      data.event,
      typeof data.details === "string" ? data.details : undefined,
      typeof data.timestamp === "string" ? data.timestamp : undefined,
    );
  });
}

initializeLocalDiagnostics();
initializePwaDebugLogging();

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const serviceWorkerUrl =
      `${import.meta.env.BASE_URL}service-worker.js?v=${encodeURIComponent(APP_VERSION)}`;

    queuePwaDebugLog(
      "Service Worker Register Start",
      `url=${serviceWorkerUrl} | scope=${import.meta.env.BASE_URL}`,
    );

    void navigator.serviceWorker
      .register(serviceWorkerUrl, {
        scope: import.meta.env.BASE_URL,
      })
      .then((registration) => {
        queuePwaDebugLog(
          "Service Worker Registered",
          describeServiceWorkerRegistration(registration),
        );
        trackServiceWorkerState("Service Worker Installing", registration.installing);
        trackServiceWorkerState("Service Worker Waiting", registration.waiting);
        trackServiceWorkerState("Service Worker Active", registration.active);

        registration.addEventListener("updatefound", () => {
          queuePwaDebugLog("Service Worker Update Found");
          trackServiceWorkerState(
            "Service Worker Installing",
            registration.installing,
          );
        });

        void navigator.serviceWorker.ready
          .then((readyRegistration) => {
            queuePwaDebugLog(
              "Service Worker Ready",
              describeServiceWorkerRegistration(readyRegistration),
            );
          })
          .catch((error) => {
            queuePwaDebugLog(
              "Service Worker Ready Error",
              error instanceof Error ? error.message : "Unknown readiness error",
            );
          });

        void capturePwaRuntimeDiagnostics(APP_VERSION, "PWA Registered Snapshot");
      })
      .catch((error) => {
        queuePwaDebugLog(
          "Service Worker Registration Error",
          error instanceof Error ? error.message : "Unknown registration error",
        );
      });
  });
} else if (!import.meta.env.PROD) {
  queuePwaDebugLog("Service Worker Registration Skipped", "Development mode");
}

createRoot(document.getElementById("root")!).render(
  <LocalDiagnosticErrorBoundary>
    <App />
  </LocalDiagnosticErrorBoundary>,
);
