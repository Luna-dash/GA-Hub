"""Shared runtime-status vocabulary for hub-side session runtimes.

These constants describe the lifecycle of a ``SessionCoordinator`` runtime
state.  They previously lived in ``conversation_repository`` (a storage
implementation that never shipped and has been removed); the vocabulary
survives because the runtime layer still owns these states.
"""

STATUS_IDLE = "idle"
STATUS_STARTING = "starting"
STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_ABORTING = "aborting"
STATUS_ERROR = "error"

# States in which a runtime still holds or is acquiring resources.
RUNNING_STATUSES = {STATUS_QUEUED, STATUS_RUNNING, STATUS_ABORTING}
