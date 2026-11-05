import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import appCss from "../styles.css";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { PanelApp } from "./PanelApp";
import panelCss from "./panel.css";
import { bootExtension } from "./runtime";
import { injectStyles } from "./styles";

bootExtension();
injectStyles(appCss, panelCss);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <PanelApp />
      </ErrorBoundary>
    </StrictMode>,
  );
}
