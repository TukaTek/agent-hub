import { StrictMode, useEffect, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { DesktopUpdatesProvider } from "./components/DesktopUpdates";
import { I18nBootstrap } from "./components/I18nBootstrap";
import { applyUiDirection } from "./lib/apply-ui-direction";
import { markAfterPaint, markOnce } from "./lib/performance";
import { installPreloadRecovery } from "./lib/preload-recovery";
import { applyUiAppearance, watchSystemAppearance } from "./lib/ui-appearance";
import { resolveUiLocale } from "./lib/ui-locale";
import "./styles.css";

markOnce("cortexai-agent-hub:renderer:module-evaluated");
installPreloadRecovery();
applyUiDirection(resolveUiLocale());
applyUiAppearance();

function PerformanceProbe() {
  useLayoutEffect(() => {
    markOnce("cortexai-agent-hub:renderer:first-react-commit");
    markAfterPaint("cortexai-agent-hub:renderer:first-react-painted");
  }, []);
  return null;
}

function AppearanceSync() {
  useEffect(() => watchSystemAppearance(), []);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PerformanceProbe />
    <AppearanceSync />
    <I18nBootstrap>
      <BrowserRouter>
        <DesktopUpdatesProvider>
          <App />
        </DesktopUpdatesProvider>
      </BrowserRouter>
    </I18nBootstrap>
  </StrictMode>,
);
