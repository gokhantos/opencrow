"""Standalone self-check for write-time rel-type normalization (app.py).

The OpenCrow repo's CI test lanes are Bun (TypeScript); the mem0 sidecar has no
pytest/CI-wired python test lane. This is a focused, dependency-light script to
verify the pure helper + the monkeypatch behavior. Run it with the staged venv:

    ~/.opencrow/mem0/app/.venv/bin/python mem0-server/test_reltype_normalization.py

It exercises:
  1. `_canonicalize_rel_type` (pure helper) — UPPERCASE.
  2. The patch applied to mem0's real `sanitize_relationship_for_cypher`, asserting
     the binding line 612 resolves against (`mem0.memory.graph_memory`) is wrapped.
  3. Idempotence — applying the patch twice does not double-wrap.

Importing app.py is side-effect-free for the patch: the Memory instances are built
lazily from the FastAPI startup hook, not at import.
"""
import app


def _check(name: str, got, want) -> None:
    assert got == want, f"{name}: expected {want!r}, got {got!r}"
    print(f"  OK  {name}: {got!r}")


def main() -> None:
    print("1) pure helper _canonicalize_rel_type")
    _check("_canonicalize_rel_type('complained_about')",
           app._canonicalize_rel_type("complained_about"), "COMPLAINED_ABOUT")
    _check("_canonicalize_rel_type('hosted_on')",
           app._canonicalize_rel_type("hosted_on"), "HOSTED_ON")

    print("2) patched mem0 sanitize_relationship_for_cypher (line-612 binding)")
    import mem0.memory.graph_memory as gm
    import mem0.memory.utils as utils
    # The patch was already applied at app import; assert the graph_memory binding
    # (what _remove_spaces_from_entities resolves) is the wrapped one.
    assert getattr(gm.sanitize_relationship_for_cypher, "_reltype_upper_wrapped", False), \
        "graph_memory.sanitize_relationship_for_cypher is NOT wrapped"
    assert getattr(utils.sanitize_relationship_for_cypher, "_reltype_upper_wrapped", False), \
        "utils.sanitize_relationship_for_cypher is NOT wrapped"
    _check("gm.sanitize('complained_about')",
           gm.sanitize_relationship_for_cypher("complained_about"), "COMPLAINED_ABOUT")
    _check("gm.sanitize('hosted_on')",
           gm.sanitize_relationship_for_cypher("hosted_on"), "HOSTED_ON")

    print("3) idempotence — re-applying the patch does not double-wrap")
    before = gm.sanitize_relationship_for_cypher
    app._enable_reltype_write_normalization()
    after = gm.sanitize_relationship_for_cypher
    assert before is after, "re-applying the patch re-wrapped the function (not idempotent)"
    _check("gm.sanitize('uses') after re-apply",
           gm.sanitize_relationship_for_cypher("uses"), "USES")

    print("\nALL CHECKS PASSED")


if __name__ == "__main__":
    main()
