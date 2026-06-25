# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""Change-intelligence service - the thin database layer over the pure engines.

Gathers the current state of every change-family record for a project (change
orders, variation notices / requests / orders, MoC entries) and feeds it to the
pure :mod:`cycle_time` engine to produce the "waiting on whom" board. Only the
columns the engine needs are selected (no relationship loading), so a project
with many change records stays cheap to summarise.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.change_intelligence.clarifier import ClarifiedRequest, analyze_change_note
from app.modules.change_intelligence.coordination import (
    ActionItem,
    CoordinationPlan,
    build_plan,
)
from app.modules.change_intelligence.cycle_time import (
    KIND_CHANGE_ORDER,
    KIND_MOC_ENTRY,
    KIND_VARIATION_NOTICE,
    KIND_VARIATION_ORDER,
    KIND_VARIATION_REQUEST,
    UNASSIGNED,
    ChangeItem,
    CycleTimeBoard,
    build_board,
    is_open_status,
)
from app.modules.change_intelligence.impact_projection import (
    KIND_CHANGE_ORDER as IMPACT_KIND_CHANGE_ORDER,
)
from app.modules.change_intelligence.impact_projection import (
    KIND_VARIATION_ORDER as IMPACT_KIND_VARIATION_ORDER,
)
from app.modules.change_intelligence.impact_projection import (
    ApprovedChange,
    ImpactProjection,
    project_impacts,
)
from app.modules.change_intelligence.ownership_chain import (
    HandoffRow,
    OwnershipChain,
    build_ownership_chain,
)
from app.modules.change_intelligence.thread_digest import (
    DIRECTION_INBOUND,
    DIRECTION_OUTBOUND,
    CommsDigest,
    Message,
    build_digest,
)
from app.modules.changeorders.models import ChangeOrder
from app.modules.correspondence.models import Correspondence
from app.modules.moc.models import MoCEntry
from app.modules.variations.models import Notice, VariationOrder, VariationRequest

# Each change-family source table mapped to its engine kind token. Every model
# carries the same shape we read: id / code / title / status / ball_in_court /
# response_due_date plus created_at + updated_at from the shared Base.
_SOURCES: tuple[tuple[type, str], ...] = (
    (ChangeOrder, KIND_CHANGE_ORDER),
    (Notice, KIND_VARIATION_NOTICE),
    (VariationRequest, KIND_VARIATION_REQUEST),
    (VariationOrder, KIND_VARIATION_ORDER),
    (MoCEntry, KIND_MOC_ENTRY),
)


async def gather_change_items(session: AsyncSession, project_id: uuid.UUID) -> list[ChangeItem]:
    """Read every change-family record for *project_id* as engine ChangeItems."""
    items: list[ChangeItem] = []
    for model, kind in _SOURCES:
        stmt = select(
            model.id,
            model.code,
            model.title,
            model.status,
            model.ball_in_court,
            model.response_due_date,
            model.created_at,
            model.updated_at,
        ).where(model.project_id == project_id)
        result = await session.execute(stmt)
        for row in result.all():
            items.append(
                ChangeItem(
                    id=str(row.id),
                    kind=kind,
                    code=row.code or "",
                    title=(row.title or "").strip(),
                    status=row.status or "",
                    is_open=is_open_status(kind, row.status),
                    ball_in_court=row.ball_in_court,
                    response_due_date=row.response_due_date,
                    opened_at=row.created_at,
                    last_activity_at=row.updated_at,
                )
            )
    return items


async def build_project_board(
    session: AsyncSession,
    project_id: uuid.UUID,
    *,
    now: datetime | None = None,
) -> CycleTimeBoard:
    """Build the cycle-time board for one project from its live change records."""
    moment = now or datetime.now(UTC)
    items = await gather_change_items(session, project_id)
    return build_board(items, moment)


# --- Approved-change cost / schedule impact (materialized view) ------------

#: Change-order statuses whose cost and schedule impact is committed.
_CO_APPROVED_STATUSES = frozenset({"approved", "executed"})
#: Variation-order statuses that represent an agreed, in-force order.
_VO_AGREED_STATUSES = frozenset({"issued", "in_progress", "completed"})


async def gather_approved_changes(session: AsyncSession, project_id: uuid.UUID) -> list[ApprovedChange]:
    """Read the approved change orders and agreed variation orders for a project.

    Only changes whose cost is committed count toward the earned-value view: a
    change order that has been approved or executed, and a variation order that
    has been issued or beyond. Each is projected to an engine ApprovedChange.
    """
    changes: list[ApprovedChange] = []

    co_stmt = select(
        ChangeOrder.id,
        ChangeOrder.cost_impact,
        ChangeOrder.schedule_impact_days,
        ChangeOrder.currency,
        ChangeOrder.status,
        ChangeOrder.approved_at,
    ).where(ChangeOrder.project_id == project_id)
    for row in (await session.execute(co_stmt)).all():
        if (row.status or "").strip().lower() in _CO_APPROVED_STATUSES:
            changes.append(
                ApprovedChange(
                    ref_id=str(row.id),
                    kind=IMPACT_KIND_CHANGE_ORDER,
                    cost_impact=row.cost_impact if row.cost_impact is not None else Decimal("0"),
                    schedule_impact_days=row.schedule_impact_days or 0,
                    currency=row.currency or "",
                    status=row.status or "",
                    approved_at=row.approved_at,
                )
            )

    vo_stmt = select(
        VariationOrder.id,
        VariationOrder.final_cost_impact,
        VariationOrder.final_schedule_days,
        VariationOrder.currency,
        VariationOrder.status,
        VariationOrder.agreed_at,
    ).where(VariationOrder.project_id == project_id)
    for row in (await session.execute(vo_stmt)).all():
        if (row.status or "").strip().lower() in _VO_AGREED_STATUSES:
            changes.append(
                ApprovedChange(
                    ref_id=str(row.id),
                    kind=IMPACT_KIND_VARIATION_ORDER,
                    cost_impact=row.final_cost_impact if row.final_cost_impact is not None else Decimal("0"),
                    schedule_impact_days=row.final_schedule_days or 0,
                    currency=row.currency or "",
                    status=row.status or "",
                    approved_at=row.agreed_at,
                )
            )

    return changes


async def build_impact_projection(session: AsyncSession, project_id: uuid.UUID) -> ImpactProjection:
    """Project the committed cost and schedule impact of a project's changes."""
    changes = await gather_approved_changes(session, project_id)
    return project_impacts(changes)


# --- Change-request clarifier (co-pilot helper) ----------------------------


def clarify_change_note(note: str, contract_standard: str = "") -> ClarifiedRequest:
    """Turn a rough change note into a structured, well-formed request draft."""
    return analyze_change_note(note, contract_standard=contract_standard)


# --- Action coordination co-pilot ------------------------------------------


async def build_coordination_plan(
    session: AsyncSession,
    project_id: uuid.UUID,
    *,
    now: datetime | None = None,
) -> CoordinationPlan:
    """Rank a project's open change-family items into a "what to act on first" plan.

    Reuses :func:`gather_change_items`, keeps only the open ones, and feeds them
    to the pure :mod:`coordination` engine, which buckets each by urgency
    (overdue / due soon / upcoming / no date) against *now* and pairs it with a
    recommended action.
    """
    moment = now or datetime.now(UTC)
    items = await gather_change_items(session, project_id)
    actions = [
        ActionItem(
            ref_id=item.id,
            kind=item.kind,
            title=item.title,
            ball_in_court=(item.ball_in_court or "").strip() or UNASSIGNED,
            status=item.status,
            due_date=item.response_due_date,
        )
        for item in items
        if item.is_open
    ]
    return build_plan(actions, moment)


# --- Correspondence consolidator co-pilot ----------------------------------


async def build_comms_digest_for_project(
    session: AsyncSession,
    project_id: uuid.UUID,
    *,
    now: datetime | None = None,
) -> CommsDigest:
    """Group a project's correspondence into threads and flag who owes a reply.

    The correspondence module records direction as incoming / outgoing; that
    maps to the engine's inbound / outbound. A thread is keyed by a linked RFI
    when one is set so an RFI conversation folds together, otherwise by the
    normalized subject. Whether a message still expects a reply is read from its
    metadata (defaulting to true) so an informational item can be flagged as
    closing the loop.
    """
    moment = now or datetime.now(UTC)
    stmt = select(
        Correspondence.id,
        Correspondence.subject,
        Correspondence.direction,
        Correspondence.from_contact_id,
        Correspondence.date_sent,
        Correspondence.date_received,
        Correspondence.linked_rfi_id,
        Correspondence.metadata_.label("meta"),
    ).where(Correspondence.project_id == project_id)

    messages: list[Message] = []
    for row in (await session.execute(stmt)).all():
        is_incoming = (row.direction or "").strip().lower().startswith("in")
        direction = DIRECTION_INBOUND if is_incoming else DIRECTION_OUTBOUND
        meta = row.meta or {}
        requires_reply = bool(meta.get("requires_reply", True))
        messages.append(
            Message(
                ref_id=str(row.id),
                subject=row.subject or "",
                sender=row.from_contact_id or "",
                sent_at=row.date_sent or row.date_received,
                direction=direction,
                requires_reply=requires_reply,
                thread_key=row.linked_rfi_id or "",
            )
        )
    return build_digest(messages, moment)


# --- Ownership hand-off chain (accountability reconstruction) ---------------
#
# Each change-family record stores ``ball_in_court`` as one mutable string with
# no history. The service layer records every change of that field as an
# ``oe_activity_log`` row (``action="ownership_handoff"``) carrying the old and
# new holder; status moves are already recorded as ``action="status_changed"``.
# This read resolves both row sets for one record and feeds them to the pure
# :mod:`ownership_chain` engine, which rebuilds who held the ball, in what order,
# and for how long.
#
# The audit ``entity_type`` written for each family is identical to its engine
# kind token (``change_order`` / ``variation_notice`` / ``variation_request`` /
# ``variation_order`` / ``moc_entry``), so the same token resolves the source
# record and filters the activity rows - the read can never drift from the
# write.
_KIND_TO_MODEL: dict[str, type] = {kind: model for model, kind in _SOURCES}

#: Activity-log action verbs the chain reads back (kept in sync with the write
#: side: ``log_ownership_handoff`` and each module's status-transition audit).
_ACTION_OWNERSHIP_HANDOFF = "ownership_handoff"
_ACTION_STATUS_CHANGED = "status_changed"


async def build_ownership_chain_for(
    session: AsyncSession,
    kind: str,
    entity_id: uuid.UUID,
    *,
    now: datetime | None = None,
) -> tuple[OwnershipChain, uuid.UUID]:
    """Reconstruct the ownership chain for one change record.

    Resolves the record by ``kind`` + ``entity_id`` (to fetch its project for the
    caller's access check and its current ball-in-court), gathers the recorded
    hand-off and status-transition rows, and feeds them to the pure engine.

    Returns the :class:`OwnershipChain` together with the record's
    ``project_id`` so the router can run :func:`verify_project_access` against
    the resolved owner. Raises a 404-style :class:`KeyError` for an unknown kind
    and a 404 ``HTTPException`` (via the caller) is expected when the record is
    missing - here a missing record raises ``LookupError`` which the router maps
    to 404.

    Synthesis: when no hand-off rows exist yet but the record still names a
    current ball-in-court, a single open segment is synthesized from the record
    itself (opened at its ``created_at``) so a change that was assigned once and
    never handed off still reports its current holder rather than an empty chain.
    """
    moment = now or datetime.now(UTC)
    model = _KIND_TO_MODEL.get(kind)
    if model is None:
        raise KeyError(kind)

    # Resolve the source record: project (for access) + current holder + opened.
    rec_stmt = select(
        model.id,
        model.project_id,
        model.ball_in_court,
        model.created_at,
    ).where(model.id == entity_id)
    rec = (await session.execute(rec_stmt)).one_or_none()
    if rec is None:
        raise LookupError(kind)
    project_id: uuid.UUID = rec.project_id
    current_ball: str | None = rec.ball_in_court

    # Local import keeps the engine read decoupled from the audit model at import
    # time (mirrors the module services' lazy import of the audit helpers).
    from app.core.audit_log import ActivityLog

    rows = (
        await session.execute(
            select(
                ActivityLog.action,
                ActivityLog.from_status,
                ActivityLog.to_status,
                ActivityLog.actor_id,
                ActivityLog.reason,
                ActivityLog.created_at,
            )
            .where(ActivityLog.entity_type == kind)
            .where(ActivityLog.entity_id == str(entity_id))
            .where(ActivityLog.action.in_((_ACTION_OWNERSHIP_HANDOFF, _ACTION_STATUS_CHANGED)))
            .order_by(ActivityLog.created_at.asc())
        )
    ).all()

    handoffs: list[HandoffRow] = []
    status_transition_times: list[datetime] = []
    for row in rows:
        if row.action == _ACTION_OWNERSHIP_HANDOFF:
            handoffs.append(
                HandoffRow(
                    at=row.created_at,
                    from_party=row.from_status,
                    to_party=row.to_status,
                    set_by=str(row.actor_id) if row.actor_id is not None else None,
                    reason=row.reason,
                )
            )
        elif row.action == _ACTION_STATUS_CHANGED:
            status_transition_times.append(row.created_at)

    # Never handed off but currently assigned: synthesize one open segment from
    # the record so the current holder is still reported.
    if not handoffs and current_ball is not None:
        handoffs.append(
            HandoffRow(
                at=rec.created_at,
                from_party=None,
                to_party=current_ball,
                set_by=None,
                reason=None,
            )
        )

    chain = build_ownership_chain(
        handoffs,
        now=moment,
        status_transition_times=status_transition_times or None,
    )
    return chain, project_id
