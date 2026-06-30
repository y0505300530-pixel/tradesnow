import { useEffect } from "react";
import { toast } from "sonner";

/**
 * Detects when a new Service Worker is waiting to activate and shows
 * a persistent toast: "גרסה חדשה זמינה — לחץ לעדכון".
 * On tap, sends SKIP_WAITING to the waiting SW and reloads the page.
 */
export function useServiceWorkerUpdate() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    let refreshing = false;

    // When the new SW takes over (after skipWaiting), reload the page
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });

    navigator.serviceWorker.ready.then((registration) => {
      // If there's already a waiting SW when we load
      if (registration.waiting) {
        showUpdateToast(registration.waiting);
      }

      // Listen for new SW installations
      registration.addEventListener("updatefound", () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener("statechange", () => {
          // When the new SW is installed and waiting
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            showUpdateToast(newWorker);
          }
        });
      });
    });
  }, []);
}

function showUpdateToast(waitingSW: ServiceWorker) {
  toast("גרסה חדשה זמינה", {
    description: "לחץ לעדכון",
    duration: Infinity,
    action: {
      label: "עדכן עכשיו",
      onClick: () => {
        waitingSW.postMessage({ type: "SKIP_WAITING" });
      },
    },
  });
}
