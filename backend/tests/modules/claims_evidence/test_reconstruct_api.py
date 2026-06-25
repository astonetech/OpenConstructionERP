# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""Integration tests for self-serve change reconstruction (#16).

Reconstruction assembles an evidence pack scoped to ONE subject's reconciled
cross-channel thread (the reconciliation engine's connected component of linked
records), rather than the whole project. These tests seed real linked records on
PostgreSQL and assert the wiring: the pack contains the subject and its linked
records, excludes unrelated ones, is deterministic, and is fenced to its
project.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.changeorders.models import ChangeOrder
from app.modules.claims_evidence.service import reconstruct_subject
from app.modules.correspondence.models import Correspondence
from app.modules.projects.models import Project  # noqa: F401 - register ORM
from app.modules.users.models import User
from tests._pg import transactional_session


@pytest_asyncio.fixture
async def session() -> AsyncSession:
    async with transactional_session() as s:
        yield s


async def _project(session: AsyncSession) -> uuid.UUID:
    user = User(
        email=f"rec-{uuid.uuid4().hex[:8]}@example.com",
        hashed_password="x",
        full_name="REC",
        role="admin",
    )
    session.add(user)
    await session.flush()
    proj = Project(name=f"REC {uuid.uuid4().hex[:6]}", owner_id=user.id)
    session.add(proj)
    await session.flush()
    return proj.id


async def _change_order(
    session: AsyncSession,
    project_id: uuid.UUID,
    *,
    code: str,
    title: str = "Relocate the site access gate",
) -> uuid.UUID:
    co = ChangeOrder(
        project_id=project_id,
        code=code,
        title=title,
        description="Owner instruction to relocate the access gate.",
        submitted_at="2026-05-30T10:00:00+00:00",
    )
    session.add(co)
    await session.flush()
    return co.id


async def _correspondence(
    session: AsyncSession,
    project_id: uuid.UUID,
    *,
    reference_number: str,
    subject: str,
) -> uuid.UUID:
    cor = Correspondence(
        project_id=project_id,
        reference_number=reference_number,
        direction="incoming",
        subject=subject,
        correspondence_type="letter",
        date_sent="2026-05-31",
    )
    session.add(cor)
    await session.flush()
    return cor.id


def _refs(pack: object) -> set[str]:
    """The ref ids of every entry across the pack's sections."""
    return {entry.ref_id for section in pack.sections for entry in section.entries}  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_reconstruct_scopes_to_the_linked_thread(session: AsyncSession) -> None:
    """The pack carries the subject and its linked letter, not unrelated records."""
    pid = await _project(session)
    co_id = await _change_order(session, pid, code="CO-14")
    # The letter cites CO-14 in its subject, so the reconciliation engine's
    # shared-reference signal links it to the change order.
    cor_id = await _correspondence(
        session,
        pid,
        reference_number="COR-001",
        subject="Re: CO-14 relocate access gate",
    )
    # An unrelated change order: different code and subject, so it does not link.
    other_co = await _change_order(session, pid, code="CO-99", title="Unrelated lighting works")

    pack = await reconstruct_subject(session, project_id=pid, subject_type="change_order", subject_id=co_id)

    refs = _refs(pack)
    assert str(co_id) in refs
    assert str(cor_id) in refs
    assert str(other_co) not in refs
    assert pack.entry_count == 2
    assert pack.subject_ref == f"change_order:{co_id}"
    # The two records section into variations (the change order) and
    # correspondence (the letter).
    section_names = {section.name for section in pack.sections}
    assert "variations" in section_names
    assert "correspondence" in section_names


@pytest.mark.asyncio
async def test_reconstruct_is_deterministic(session: AsyncSession) -> None:
    """The same project state yields the same content digest (reproducible export)."""
    pid = await _project(session)
    co_id = await _change_order(session, pid, code="CO-14")
    await _correspondence(session, pid, reference_number="COR-001", subject="Re: CO-14 relocate access gate")

    first = await reconstruct_subject(session, project_id=pid, subject_type="change_order", subject_id=co_id)
    second = await reconstruct_subject(session, project_id=pid, subject_type="change_order", subject_id=co_id)

    assert first.content_digest == second.content_digest
    assert first.entry_count == second.entry_count == 2


@pytest.mark.asyncio
async def test_reconstruct_unknown_subject_is_empty(session: AsyncSession) -> None:
    """A subject that resolves to no records yields a valid empty pack."""
    pid = await _project(session)
    await _change_order(session, pid, code="CO-14")

    pack = await reconstruct_subject(session, project_id=pid, subject_type="change_order", subject_id=uuid.uuid4())
    assert pack.entry_count == 0
    assert pack.sections == []


@pytest.mark.asyncio
async def test_reconstruct_is_scoped_to_project(session: AsyncSession) -> None:
    """A subject in one project cannot be reconstructed under another (IDOR)."""
    pid = await _project(session)
    other = await _project(session)
    co_id = await _change_order(session, pid, code="CO-14")
    await _correspondence(session, pid, reference_number="COR-001", subject="Re: CO-14 relocate access gate")

    pack = await reconstruct_subject(session, project_id=other, subject_type="change_order", subject_id=co_id)
    assert pack.entry_count == 0
    assert pack.sections == []
