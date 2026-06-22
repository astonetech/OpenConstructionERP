# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""Construction-control permission definitions."""

from app.core.permissions import Role, permission_registry


def register_construction_control_permissions() -> None:
    """Register permissions for the construction-control module."""
    permission_registry.register_module_permissions(
        "construction_control",
        {
            # Acceptance criteria
            "cc.criterion.read": Role.VIEWER,
            "cc.criterion.create": Role.EDITOR,
            "cc.criterion.update": Role.EDITOR,
            "cc.criterion.delete": Role.MANAGER,
            # Inspections
            "cc.inspection.read": Role.VIEWER,
            "cc.inspection.create": Role.EDITOR,
            "cc.inspection.update": Role.EDITOR,
            "cc.inspection.delete": Role.MANAGER,
            # Recording a result can raise an NCR, so it sits at editor (not viewer).
            "cc.inspection.record_result": Role.EDITOR,
            # Material records (digital passport, EN 10204)
            "cc.material.read": Role.VIEWER,
            "cc.material.create": Role.EDITOR,
            "cc.material.update": Role.EDITOR,
            "cc.material.delete": Role.MANAGER,
            # Reviewing a material can raise an NCR, so it sits at editor (not viewer).
            "cc.material.review": Role.EDITOR,
            # Test results (ISO/IEC 17025 lab)
            "cc.test.read": Role.VIEWER,
            "cc.test.create": Role.EDITOR,
            "cc.test.update": Role.EDITOR,
            "cc.test.delete": Role.MANAGER,
            # Recording a test result can raise an NCR, so it sits at editor (not viewer).
            "cc.test.record_result": Role.EDITOR,
            # As-built records (Pillar 3)
            "cc.asbuilt.read": Role.VIEWER,
            "cc.asbuilt.create": Role.EDITOR,
            "cc.asbuilt.update": Role.EDITOR,
            "cc.asbuilt.delete": Role.MANAGER,
            # Verifying is a QA act (can raise an NCR) and signing is a legal attestation;
            # both sit at manager.
            "cc.asbuilt.verify": Role.MANAGER,
            "cc.asbuilt.sign": Role.MANAGER,
            # Hold/witness/surveillance/review gates (Pillar 5)
            "cc.gate.read": Role.VIEWER,
            "cc.gate.create": Role.EDITOR,
            "cc.gate.update": Role.EDITOR,
            "cc.gate.delete": Role.MANAGER,
            # Releasing / waiving a gate is a manager act (plus a service party-role check).
            "cc.gate.release": Role.MANAGER,
        },
    )
