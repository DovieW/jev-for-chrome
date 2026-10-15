import "../ui/styles.css";
import "./history.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { History } from "./History";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <History />
  </React.StrictMode>,
);
