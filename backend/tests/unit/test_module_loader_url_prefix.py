# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
#
# Regression test for the module-loader URL-prefix derivation.
#
# Background: the recently-added 18 modules were shipped with frontend
# api.ts files that hit hyphenated paths like ``/api/v1/bi-dashboards``
# and ``/api/v1/hse-advanced``. The loader, however, derived the URL
# prefix straight from the Python package directory name (which uses
# underscores) — so the frontend got a 404 on every request and the
# user reported pages like /bi-dashboards and /hse-advanced as "не
# работает полностью" (completely broken).
#
# The fix mounts the router on the kebab-cased path AND mirrors it
# under the legacy underscore form for backward compatibility. This
# test pins both behaviours against the real on-disk ``bi_dashboards``
# and ``hse_advanced`` modules so a future loader refactor cannot
# silently regress the public URL surface.

from __future__ import annotations

import asyncio
import importlib
import sys
from collections.abc import Iterator

import pytest
from fastapi import FastAPI


def _mounted_paths(app: FastAPI, prefix: str) -> list[str]:
    return [getattr(route, "path", "") for route in app.routes if getattr(route, "path", "").startswith(prefix)]


# The three real modules this file mounts through the loader. Their router
# subtrees are the only ``sys.modules`` entries the tests below rebuild.
_TARGET_MODULES = ("oe_bi_dashboards", "oe_hse_advanced", "oe_schedule_advanced")


def _router_subtree_keys(module_name: str) -> list[str]:
    """``sys.modules`` keys that belong to a module's ``router`` submodule."""
    router_module_name = f"app.modules.{module_name.removeprefix('oe_')}.router"
    return [k for k in list(sys.modules) if k == router_module_name or k.startswith(router_module_name + ".")]


@pytest.fixture(autouse=True)
def _isolate_router_modules() -> Iterator[None]:
    """Snapshot and restore ONLY the target modules' ``router`` subtrees.

    The four tests below rebuild three real module router subtrees from source
    (see :func:`_pristine_import_router`). This fixture makes the file
    order-independent in BOTH directions, scoped tightly to the router modules
    it actually perturbs:

    * inbound - whatever an earlier test in the same ``pytest-split`` shard left
      in one of these ``...router`` entries (a half-imported router, an empty
      ``router``, a reloaded module) is dropped and re-imported from source by
      :func:`_pristine_import_router`, so it cannot bleed into the assertions;
    * outbound - on teardown each ``...router`` entry is put back exactly as it
      was before the test (restored to the original object, or removed if it was
      not present), so the next test in the shard sees an unperturbed router.

    Scope matters. We deliberately do NOT snapshot-and-restore the WHOLE
    ``sys.modules`` table: ``_load_module`` incidentally imports the modules'
    ``.models`` (and ``.events`` / ``.hooks`` / ``.kpis`` …) as a side effect,
    and a blanket ``sys.modules.clear() + update(snapshot)`` would EVICT any of
    those that were not already cached when the test started. A later test that
    then re-imports such a ``.models`` module would re-run ``class X(Base)`` and
    hit "Table already defined for this MetaData". Leaving correctly-imported
    modules in place is harmless and avoids planting that landmine, so we touch
    only the ``router`` subtrees here.
    """
    saved: dict[str, object] = {}
    for module_name in _TARGET_MODULES:
        for key in _router_subtree_keys(module_name):
            saved[key] = sys.modules[key]
    try:
        yield
    finally:
        # Remove every current router-subtree entry, then re-instate exactly the
        # objects that were present before the test (identity preserved).
        for module_name in _TARGET_MODULES:
            for key in _router_subtree_keys(module_name):
                del sys.modules[key]
        sys.modules.update(saved)


def _pristine_import_router(module_name: str) -> None:
    """Force a genuinely pristine import of the target module's ``router``.

    Why this is needed (CI-only, sharding-dependent):
    ``_load_module`` mounts ``app.modules.<dir>.router.router`` exactly as it
    finds it in ``sys.modules`` and never rebuilds it (correct for production,
    where every module is imported once at startup). Under ``pytest-split`` a
    different slice of the unit suite lands in each shard, so an unrelated test
    that ran earlier in the same worker can leave the router module cached in a
    perturbed state - missing ``router``, an empty ``routes`` list, or, worst,
    a half-initialised namespace from an import that was interrupted (a
    transitive import raised, then a later test re-imported a stub). In that
    last case ``importlib.reload`` is NOT enough: reload re-executes the body in
    the SAME, already-polluted module ``__dict__``, so any name the new body
    does not reassign survives from the broken run. We therefore drop the router
    submodule (and any of its own sub-submodules) from ``sys.modules`` and
    import it afresh, which builds a brand-new module object with a clean
    namespace and route objects created against the live ``fastapi`` /
    ``app.dependencies`` currently in the import table - exactly the state
    production builds them in.

    We deliberately pop ONLY ``<pkg>.router`` (and ``<pkg>.router.*``), never
    ``<pkg>.models`` or any other SQLAlchemy-mapped module: re-importing
    ``router.py`` only re-runs ``router = APIRouter()`` and the
    ``@router.<verb>`` decorators, and its ``from .models import ...`` lines
    re-bind names from the already-cached (untouched) models module, so no ORM
    ``class X(Base)`` is ever re-executed and "Table already defined for this
    MetaData" cannot fire. The surrounding ``_isolate_router_modules`` fixture
    restores the popped entries after the test.
    """
    dir_name = module_name.removeprefix("oe_")
    package_path = f"app.modules.{dir_name}"
    router_module_name = f"{package_path}.router"
    # Drop the router module and any sub-submodules so the next import rebuilds
    # them from source into fresh module objects (not a reload of a possibly
    # polluted namespace). Never touch .models / other mapped modules.
    for cached in list(sys.modules):
        if cached == router_module_name or cached.startswith(router_module_name + "."):
            del sys.modules[cached]
    # Importing the package is cheap (cached) and guarantees the parent exists
    # before we import its router submodule from source.
    importlib.import_module(package_path)
    router_mod = importlib.import_module(router_module_name)
    # Sanity: the freshly imported module must expose a populated router. If it
    # does not, something is wrong with the module itself (not stale cache) and
    # we want a clear failure rather than a misleading empty-routes assertion
    # downstream.
    assert getattr(getattr(router_mod, "router", None), "routes", None), (
        f"{router_module_name} did not import a populated router"
    )


def _load_real_module(module_name: str) -> FastAPI:
    """Load a real backend module into a fresh FastAPI app and return it."""
    from app.core.module_loader import ModuleLoader

    _pristine_import_router(module_name)
    loader = ModuleLoader()
    loader.discover()
    app = FastAPI()
    asyncio.run(loader._load_module(module_name, app))
    return app


def test_bi_dashboards_mounted_on_kebab_case() -> None:
    """``bi_dashboards`` package must serve under ``/api/v1/bi-dashboards``."""
    app = _load_real_module("oe_bi_dashboards")
    paths = _mounted_paths(app, "/api/v1/bi-dashboards/")
    assert paths, (
        "BI dashboards router must mount under /api/v1/bi-dashboards/* (frontend api.ts uses this kebab-case prefix)."
    )
    # Specifically the create endpoint that was failing for the user.
    assert any(p == "/api/v1/bi-dashboards/dashboards" for p in paths), (
        f"Missing POST /api/v1/bi-dashboards/dashboards: {paths!r}"
    )


def test_bi_dashboards_legacy_underscore_mirror() -> None:
    """The underscore form is mirrored for callers that haven't migrated."""
    app = _load_real_module("oe_bi_dashboards")
    paths = _mounted_paths(app, "/api/v1/bi_dashboards/")
    assert paths, (
        "Legacy /api/v1/bi_dashboards mirror is missing — third-party "
        "callers that have not migrated to the kebab-case URL would 404."
    )


def test_hse_advanced_mounted_on_kebab_case() -> None:
    """``hse_advanced`` package must serve under ``/api/v1/hse-advanced``."""
    app = _load_real_module("oe_hse_advanced")
    paths = _mounted_paths(app, "/api/v1/hse-advanced/")
    assert paths, paths
    # Investigations list endpoint added during the same fix.
    assert any(p == "/api/v1/hse-advanced/investigations/" for p in paths), (
        f"Missing GET /api/v1/hse-advanced/investigations/: {paths!r}"
    )


def test_schedule_advanced_mounted_on_kebab_case() -> None:
    """``schedule_advanced`` package must serve under
    ``/api/v1/schedule-advanced`` — the user's "create doesn't work"
    on /schedule-advanced was caused by this URL mismatch.
    """
    app = _load_real_module("oe_schedule_advanced")
    paths = _mounted_paths(app, "/api/v1/schedule-advanced/")
    assert paths, paths
    assert any(p == "/api/v1/schedule-advanced/master-schedules/" for p in paths), (
        f"Missing POST /api/v1/schedule-advanced/master-schedules/: {paths!r}"
    )
