import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Set before React renders so the very first paint is already themed: the
// preload bridge reads this synchronously from a value the main process
// resolved before creating the window (see resolveAppearance in
// src/main/index.ts). "system" means no attribute — theme.css already
// follows prefers-color-scheme for that case.
const initialTheme = window.poundlockDispatch?.initialAppearanceTheme;
if (initialTheme && initialTheme !== "system") {
  document.documentElement.dataset.theme = initialTheme;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
