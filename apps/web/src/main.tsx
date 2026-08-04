import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AppRecoveryBoundary } from "./AppRecoveryBoundary";
import { installPreloadRecovery } from "./bootstrapRecovery";
import "./styles.css";
import { ThemeProvider } from "./theme";

installPreloadRecovery();

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <AppRecoveryBoundary>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </AppRecoveryBoundary>
    </StrictMode>,
  );
}
