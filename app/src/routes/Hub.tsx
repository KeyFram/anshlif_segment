import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Domain, ProjectSummary } from "../../shared/types";
import { api, origUrl } from "../api";
import { DomainTabs } from "../components/DomainTabs";

export function Hub() {
  const [domain, setDomain] = useState<Domain>("microscopy");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  const reload = (d: Domain) => {
    setLoading(true);
    api.listProjects(d)
      .then(setProjects)
      .catch((e) => console.error("list projects failed:", e))
      .finally(() => setLoading(false));
  };

  useEffect(() => { reload(domain); }, [domain]);

  const createProject = async () => {
    setCreating(true);
    try {
      const name = `Проект ${projects.length + 1}`;
      const p = await api.createProject(name, domain);
      navigate(`/project/${p.id}`);
    } catch (e) {
      console.error("create project failed:", e);
      setCreating(false);
    }
  };

  const onDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm("Удалить проект? Действие необратимо.")) return;
    await api.deleteProject(id).catch((err) => console.error(err));
    reload(domain);
  };

  return (
    <div className="hub">
      <header className="hub-header">
        <div className="hub-brand">
          <span className="hub-logo">◆</span>
          <div>
            <h1>Сегментация аншлифов</h1>
            <span className="hub-sub">Сегментация минеральных фаз аншлифов</span>
          </div>
        </div>
        <DomainTabs value={domain} onChange={setDomain} />
      </header>

      <main className="hub-main">
        {loading ? (
          <div className="hub-empty">Загрузка…</div>
        ) : projects.length === 0 ? (
          <div className="hub-empty">
            Пока нет проектов. Создайте первый — кнопка ниже.
          </div>
        ) : (
          <div className="project-grid">
            {projects.map((p) => (
              <div key={p.id} className="project-card" onClick={() => navigate(`/project/${p.id}`)}>
                <div className="project-cover">
                  {p.coverImageId ? (
                    <img src={origUrl(p.id, p.coverImageId)} alt="" />
                  ) : (
                    <div className="project-cover-empty">нет изображений</div>
                  )}
                </div>
                <div className="project-meta">
                  <div className="project-name">{p.name}</div>
                  <div className="project-info">
                    {p.imageCount} изобр. · {new Date(p.createdAt).toLocaleDateString("ru")}
                  </div>
                </div>
                <button className="project-del" title="Удалить" onClick={(e) => onDelete(e, p.id)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </main>

      <footer className="hub-footer">
        <button className="create-btn" onClick={createProject} disabled={creating}>
          {creating ? "Создаём…" : "+ Создать новый проект"}
        </button>
      </footer>
    </div>
  );
}
