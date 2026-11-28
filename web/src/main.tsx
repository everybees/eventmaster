import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { watchInstall } from "./install.ts";
import { startTracking } from "./track.ts";
// fonts served with the app, not from Google: no third party sees each visit, and they work offline
import "@fontsource-variable/inter";
import "@fontsource-variable/fredoka"; // rounded like the Meerkot wordmark: headings, dates
import "./styles.css";

startTracking();
watchInstall();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
