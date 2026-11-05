import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../App";
import appCss from "../styles.css";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import extensionCss from "./extension.css";
import { bootExtension } from "./runtime";
import { injectStyles } from "./styles";

bootExtension();
injectStyles(appCss, extensionCss);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}
