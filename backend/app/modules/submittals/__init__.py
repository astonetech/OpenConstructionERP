"""‌⁠‍Submittals module.

Construction submittal management — shop drawings, product data, samples,
test reports, and certificates with multi-stage review/approval workflows.
"""


async def on_startup() -> None:
    """‌⁠‍Module startup hook — register permissions + approval-routes wiring."""
    from app.modules.submittals.approval_subscribers import (
        register_submittal_approval_subscribers,
    )
    from app.modules.submittals.permissions import register_submittals_permissions

    register_submittals_permissions()
    # Feature 06: drive the submittal FSM off terminal approval-routes
    # decisions when a project has a routed sign-off configured.
    register_submittal_approval_subscribers()
