import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { DialogProvider } from "./dialog";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode><DialogProvider><App /></DialogProvider></StrictMode>,
);
