import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";     // ← only this line
// DO NOT import "./app.css" or "./App.css"

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />
);
