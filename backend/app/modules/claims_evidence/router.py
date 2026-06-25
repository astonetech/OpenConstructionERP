# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""Claims evidence-pack API routes (auto-mounted at /api/v1/claims-evidence).

Access control mirrors every other project-scoped router: the caller must be
authenticated and pass :func:`verify_project_access` for the requested project,
which 404s on both "missing" and "denied" so it never leaks project existence.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Query, status

from app.dependencies import CurrentUserId, SessionDep, verify_project_access
from app.modules.claims_evidence.provability_service import (
    SubjectNotFound,
    UnknownSubjectKind,
    score_subject_provability,
)
from app.modules.claims_evidence.schemas import (
    EvidencePackOut,
    ProvabilityScoreOut,
    ProvabilitySubScoreOut,
    ProvabilityWeaknessOut,
)
from app.modules.claims_evidence.service import assemble_evidence, reconstruct_subject

router = APIRouter(tags=["Claims Evidence"])

#: Subject kinds the provability endpoint accepts, surfaced in its 422 message.
_SUBJECT_KINDS = (
    "change_order",
    "variation_notice",
    "variation_request",
    "variation_order",
    "moc_entry",
)

#: Subject types the reconstruct endpoint accepts (the reconciliation record
#: types a thread can be seeded from), surfaced in its 422 message.
_RECONSTRUCT_KINDS = (
    "change_order",
    "variation_request",
    "variation_order",
    "notice",
    "moc",
    "correspondence",
)


@router.get("/projects/{project_id}/pack", response_model=EvidencePackOut)
async def get_evidence_pack(
    project_id: uuid.UUID,
    session: SessionDep,
    subject_ref: str = Query(description="Identifier of the claim or dispute the pack supports."),
    basis: str = Query(default="dispute", description="The basis the pack is assembled under."),
    limit: int = Query(default=500, ge=1, le=2000, description="Max activity rows to include."),
    user_id: CurrentUserId = None,  # type: ignore[assignment]
) -> EvidencePackOut:
    """Assemble a deterministic evidence pack for a project's claim or dispute."""
    await verify_project_access(project_id, user_id or "", session)

    pack = await assemble_evidence(
        session,
        project_id=project_id,
        subject_ref=subject_ref,
        basis=basis,
        activity_limit=limit,
    )
    return EvidencePackOut.model_validate(pack)


@router.get(
    "/projects/{project_id}/reconstruct/{subject_type}/{subject_id}",
    response_model=EvidencePackOut,
)
async def reconstruct_change(
    project_id: uuid.UUID,
    subject_type: str,
    subject_id: uuid.UUID,
    session: SessionDep,
    basis: str = Query(default="dispute", description="The basis the pack is assembled under."),
    user_id: CurrentUserId = None,  # type: ignore[assignment]
) -> EvidencePackOut:
    """Reconstruct one change or dispute as a scoped, deterministic evidence pack.

    Unlike the project-wide pack, this grows the cross-channel thread around the
    single subject (its reconciled, linked records) and assembles only those
    into the ordered, SHA-256-digested pack a claim needs. ``subject_type`` must
    be one of the reconcilable record types in :data:`_RECONSTRUCT_KINDS`; an
    unknown type is a 422. A subject that resolves to no records yields a valid
    empty pack rather than an error.
    """
    await verify_project_access(project_id, user_id or "", session)

    if subject_type not in _RECONSTRUCT_KINDS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unknown subject type '{subject_type}'. Expected one of: {', '.join(_RECONSTRUCT_KINDS)}.",
        )

    pack = await reconstruct_subject(
        session,
        project_id=project_id,
        subject_type=subject_type,
        subject_id=subject_id,
        basis=basis,
    )
    return EvidencePackOut.model_validate(pack)


@router.get(
    "/projects/{project_id}/changes/{subject_kind}/{subject_id}/provability",
    response_model=ProvabilityScoreOut,
)
async def get_change_provability(
    project_id: uuid.UUID,
    subject_kind: str,
    subject_id: uuid.UUID,
    session: SessionDep,
    user_id: CurrentUserId = None,  # type: ignore[assignment]
) -> ProvabilityScoreOut:
    """Grade how provable one change / claim is from the evidence on the project.

    Gathers the change record's notice timeliness, acknowledgement, linked
    instruction, ownership-chain continuity and dated-record signals and scores
    them with the pure provability engine, returning the 0-100 score, its band
    and the per-signal breakdown (present vs missing) plus the ordered cure list
    so the UI can show exactly what to fix. Read-only; nothing is persisted.

    ``subject_kind`` must be one of the change families in :data:`_SUBJECT_KINDS`;
    an unknown kind is a 422. A subject that does not exist in this project is a
    404 (it never reveals another project's records).
    """
    await verify_project_access(project_id, user_id or "", session)

    try:
        result = await score_subject_provability(
            session,
            project_id=project_id,
            subject_kind=subject_kind,
            subject_id=subject_id,
        )
    except UnknownSubjectKind as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unknown subject kind '{subject_kind}'. Expected one of: {', '.join(_SUBJECT_KINDS)}.",
        ) from exc
    except SubjectNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Change record not found.") from exc

    score = result.score
    sub_scores = [
        ProvabilitySubScoreOut(
            signal=s.signal,
            weight=s.weight,
            earned=s.earned,
            fraction=s.fraction,
            present=s.earned >= s.weight,
        )
        for s in score.sub_scores
    ]
    weaknesses = [
        ProvabilityWeaknessOut(
            token=w.token,
            message=w.message,
            signal=w.signal,
            points_lost=w.points_lost,
        )
        for w in score.weaknesses
    ]

    return ProvabilityScoreOut(
        subject_kind=result.subject_kind,
        subject_id=result.subject_id,
        subject_ref=result.subject_ref,
        score=score.score,
        band=score.band,
        sub_scores=sub_scores,
        weaknesses=weaknesses,
        entry_count=result.entry_count,
        date_from=result.date_from.isoformat() if result.date_from is not None else None,
        date_to=result.date_to.isoformat() if result.date_to is not None else None,
    )
