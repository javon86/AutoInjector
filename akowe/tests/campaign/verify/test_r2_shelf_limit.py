"""Round-2 review: shelf() applied finished_books' limit to finished AND archived books together, then split them,
so many (newer) archived books could push finished books off the Shelf. Each list now keeps its own newest books."""
from __future__ import annotations

from bookforge import shelf as shelf_mod


def test_archived_books_never_push_finished_ones_off_the_shelf(monkeypatch):
    rows = ([{"project_id": f"arch-{i}", "archived": True, "exported_at": f"2026-10-{20 + i:02d}"} for i in range(3)]
            + [{"project_id": "active-old", "archived": False, "exported_at": "2026-01-01"}])

    def fake_finished_books(app, *, verify=True, limit=200, principal=None, include_archived=False):
        out = [r for r in rows if include_archived or not r["archived"]]
        out.sort(key=lambda b: b["exported_at"], reverse=True)
        return out[:limit]
    monkeypatch.setattr(shelf_mod, "finished_books", fake_finished_books)
    page = shelf_mod.shelf(object(), limit=2)
    assert [b["project_id"] for b in page["books"]] == ["active-old"]
    assert [b["project_id"] for b in page["archived"]] == ["arch-2", "arch-1"]
