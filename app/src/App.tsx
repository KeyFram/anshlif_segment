import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Hub } from "./routes/Hub";
import { ProjectView } from "./routes/ProjectView";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Hub />} />
        <Route path="/project/:id" element={<ProjectView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
